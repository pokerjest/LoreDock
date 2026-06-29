import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { DiagnosticsService } from "./diagnostics";
import {
  createDefaultManifest,
  isKnownFutureOrUnknownVersion,
  repairManifestValue,
  validateProjectManifest
} from "./manifest";
import { MigrationRunner } from "./migrationRunner";
import { normalizeRelativePath } from "./operationPlan";
import { PreviewApplyService, type ConfirmationProvider } from "./previewApply";
import { SafeFileWriter } from "./safeFileWriter";
import { SchemaRegistry, type RegisteredSchema } from "./schemaRegistry";
import type { Capability, KernelContext, OperationPlan, ProjectManifest } from "./types";
import { LOREDOCK_DIR, MANIFEST_RELATIVE_PATH, MANIFEST_SCHEMA_VERSION } from "./types";

interface ProjectKernelOptions {
  confirm?: ConfirmationProvider;
  now?: () => Date;
  output?: vscode.OutputChannel;
}

interface RoutedCommand {
  disposable: vscode.Disposable;
  handlers: Map<string, RoutedCommandHandler>;
}

interface RoutedCommandHandler {
  workspaceFolder: vscode.WorkspaceFolder;
  callback: (...args: unknown[]) => unknown;
}

type ManifestReadResult =
  | { status: "missing" }
  | { status: "invalidJson"; text: string; error: unknown }
  | { status: "parsed"; text: string; value: unknown };

export class ProjectKernel implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly diagnostics: DiagnosticsService;
  private readonly schemaRegistry = new SchemaRegistry();
  private readonly migrationRunner = new MigrationRunner();
  private readonly previewApply: PreviewApplyService;
  private readonly capabilityMap = new Map<string, Capability>();
  private readonly activeCapabilities = new Map<string, Map<string, vscode.Disposable[]>>();
  private readonly capabilityCommandRoutes = new Map<string, RoutedCommand>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly now: () => Date;

  public constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    capabilities: Capability[] = [],
    options: ProjectKernelOptions = {}
  ) {
    this.output = options.output ?? vscode.window.createOutputChannel("LoreDock");
    this.diagnostics = new DiagnosticsService(this.output);
    this.previewApply = new PreviewApplyService(this.output, options.confirm);
    this.now = options.now ?? (() => new Date());
    this.subscriptions.push(this.output);

    for (const capability of capabilities) {
      this.capabilityMap.set(capability.id, capability);
    }
  }

  public activate(): void {
    this.schemaRegistry.register({ id: "projectManifest", version: MANIFEST_SCHEMA_VERSION });
    this.subscriptions.push(
      this.registerCommand("loredock.initProject", (target) => this.initProject(asWorkspaceFolder(target))),
      this.registerCommand("loredock.openProjectManifest", (target) =>
        this.openProjectManifest(asWorkspaceFolder(target))
      ),
      this.registerCommand("loredock.showDiagnostics", (target) => this.showDiagnostics(asWorkspaceFolder(target))),
      this.registerCommand("loredock.repairProjectManifest", (target) =>
        this.repairProjectManifest(asWorkspaceFolder(target))
      ),
      vscode.workspace.onDidChangeWorkspaceFolders((event) =>
        this.handleWorkspaceFoldersChanged(event)
      )
    );

    this.extensionContext.subscriptions.push(...this.subscriptions);
    void this.refreshAllWorkspaceFolders();
  }

  public dispose(): void {
    for (const folderDisposables of this.activeCapabilities.values()) {
      for (const disposables of folderDisposables.values()) {
        disposeAll(disposables, (error) => this.reportDisposeError(error));
      }
    }

    this.activeCapabilities.clear();
    for (const route of this.capabilityCommandRoutes.values()) {
      safeDispose(route.disposable, (error) => this.reportDisposeError(error));
    }
    this.capabilityCommandRoutes.clear();
    disposeAll(this.subscriptions, (error) => this.reportDisposeError(error));
  }

  public async initProject(target?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceFolder = target ?? (await this.getTargetWorkspaceFolder());
    if (!workspaceFolder) {
      return;
    }

    const manifestPath = this.absoluteManifestPath(workspaceFolder);
    if (await pathExists(manifestPath)) {
      this.output.appendLine(`LoreDock project already exists at ${manifestPath}.`);
      const choice = await vscode.window.showInformationMessage(
        "LoreDock project already exists.",
        { modal: true },
        "Open Manifest",
        "Repair Manifest",
        "Cancel"
      );

      if (choice === "Open Manifest") {
        await this.openProjectManifest(workspaceFolder);
      } else if (choice === "Repair Manifest") {
        await this.repairProjectManifest(workspaceFolder);
      }
      return;
    }

    const manifest = createDefaultManifest(workspaceFolder.uri.fsPath, this.now());
    const plan: OperationPlan = {
      summary: "Initialize LoreDock project.",
      directoriesToCreate: [LOREDOCK_DIR],
      filesToCreate: [MANIFEST_RELATIVE_PATH],
      filesToModify: []
    };

    const confirmed = await this.previewApply.confirmPlan(plan);
    if (!confirmed) {
      this.output.appendLine("LoreDock initProject canceled. No files were written.");
      return;
    }

    const writer = new SafeFileWriter(workspaceFolder.uri.fsPath, plan);
    await writer.ensureDirectory(LOREDOCK_DIR);
    await writer.writeFile(MANIFEST_RELATIVE_PATH, stringifyManifest(manifest));

    await this.refreshWorkspaceFolder(workspaceFolder);
    await this.verifyManifest(workspaceFolder);
    this.output.appendLine(`LoreDock project initialized at ${manifestPath}.`);
    void vscode.window.showInformationMessage("LoreDock project initialized.");
  }

  public async openProjectManifest(target?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceFolder = target ?? (await this.getTargetWorkspaceFolder());
    if (!workspaceFolder) {
      return;
    }

    const manifestPath = this.absoluteManifestPath(workspaceFolder);
    if (!(await pathExists(manifestPath))) {
      this.output.appendLine(`No LoreDock manifest found at ${manifestPath}. Run loredock.initProject first.`);
      void vscode.window.showWarningMessage("No LoreDock manifest found. Run LoreDock: Initialize Project first.");
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(manifestPath));
    await vscode.window.showTextDocument(document);
  }

  public async showDiagnostics(target?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceFolder = target ?? (await this.getTargetWorkspaceFolder());
    if (!workspaceFolder) {
      return;
    }

    await this.refreshWorkspaceFolder(workspaceFolder);
    this.output.show(true);
    this.diagnostics.print(workspaceFolder.uri.fsPath);
  }

  public async repairProjectManifest(target?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceFolder = target ?? (await this.getTargetWorkspaceFolder());
    if (!workspaceFolder) {
      return;
    }

    const readResult = await this.readManifest(workspaceFolder);
    if (readResult.status === "missing") {
      this.output.appendLine("Cannot repair missing manifest. Run loredock.initProject first.");
      void vscode.window.showWarningMessage("No LoreDock manifest found. Run LoreDock: Initialize Project first.");
      return;
    }

    const parsedValue = readResult.status === "parsed" ? readResult.value : undefined;
    const nextManifest = repairManifestValue(parsedValue, workspaceFolder.uri.fsPath, this.now());
    const backupRelativePath = await this.createBackupRelativePath(workspaceFolder);
    const futureVersionWarning =
      readResult.status === "parsed" && isKnownFutureOrUnknownVersion(readResult.value)
        ? " This rebuilds the manifest as v0.0; it is not a migration."
        : "";

    const plan: OperationPlan = {
      summary: `Repair LoreDock project manifest.${futureVersionWarning}`,
      directoriesToCreate: [],
      filesToCreate: [backupRelativePath],
      filesToModify: [MANIFEST_RELATIVE_PATH]
    };

    const confirmed = await this.previewApply.confirmPlan(plan);
    if (!confirmed) {
      this.output.appendLine("LoreDock repairProjectManifest canceled. No files were written.");
      return;
    }

    const writer = new SafeFileWriter(workspaceFolder.uri.fsPath, plan);
    await writer.writeFile(backupRelativePath, readResult.text);
    await writer.writeFile(MANIFEST_RELATIVE_PATH, stringifyManifest(nextManifest));

    await this.refreshWorkspaceFolder(workspaceFolder);
    await this.verifyManifest(workspaceFolder);
    this.output.appendLine(`LoreDock manifest repaired. Backup written to ${backupRelativePath}.`);
    void vscode.window.showInformationMessage("LoreDock manifest repaired.");
  }

  public async refreshAllWorkspaceFolders(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      await this.refreshWorkspaceFolderSafely(folder);
    }
  }

  public async refreshWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    this.diagnostics.clear(workspaceFolder.uri.fsPath);

    const readResult = await this.readManifest(workspaceFolder);
    if (readResult.status === "missing") {
      this.disposeCapabilitiesForFolder(workspaceFolder);
      this.diagnostics.add({
        severity: "info",
        code: "manifest.missing",
        message: "LoreDock manifest does not exist. Run loredock.initProject first.",
        workspaceFolder: workspaceFolder.uri.fsPath,
        relativePath: MANIFEST_RELATIVE_PATH
      });
      return;
    }

    if (readResult.status === "invalidJson") {
      this.disposeCapabilitiesForFolder(workspaceFolder);
      this.diagnostics.add({
        severity: "error",
        code: "manifest.json.invalid",
        message: "LoreDock manifest is not valid JSON. Run loredock.repairProjectManifest to rebuild it.",
        workspaceFolder: workspaceFolder.uri.fsPath,
        relativePath: MANIFEST_RELATIVE_PATH
      });
      return;
    }

    const result = validateProjectManifest(
      readResult.value,
      workspaceFolder.uri.fsPath,
      new Set(this.capabilityMap.keys())
    );
    this.diagnostics.addMany(result.diagnostics);

    if (!result.isValid || !result.manifest) {
      this.disposeCapabilitiesForFolder(workspaceFolder);
      return;
    }

    await this.migrationRunner.runNoop(result.manifest);
    this.activateCapabilities(workspaceFolder, result.manifest);
  }

  private async verifyManifest(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const readResult = await this.readManifest(workspaceFolder);
    if (readResult.status !== "parsed") {
      throw new Error("LoreDock manifest verification failed after write.");
    }

    const validation = validateProjectManifest(
      readResult.value,
      workspaceFolder.uri.fsPath,
      new Set(this.capabilityMap.keys())
    );
    if (!validation.isValid) {
      throw new Error("LoreDock manifest verification failed after write.");
    }
  }

  private activateCapabilities(workspaceFolder: vscode.WorkspaceFolder, manifest: ProjectManifest): void {
    const folderKey = workspaceFolder.uri.fsPath;
    const activeForFolder = this.activeCapabilities.get(folderKey) ?? new Map<string, vscode.Disposable[]>();
    const enabledIds = new Set(manifest.capabilities);

    for (const [capabilityId, disposables] of activeForFolder.entries()) {
      if (!enabledIds.has(capabilityId)) {
        disposeAll(disposables);
        activeForFolder.delete(capabilityId);
      }
    }

    for (const capabilityId of enabledIds) {
      if (activeForFolder.has(capabilityId)) {
        continue;
      }

      const capability = this.capabilityMap.get(capabilityId);
      if (!capability) {
        continue;
      }

      const activationDisposables: vscode.Disposable[] = [];
      try {
        const returnedDisposables = capability.activate(this.createKernelContext(workspaceFolder, activationDisposables));
        activeForFolder.set(capabilityId, uniqueDisposables([...activationDisposables, ...returnedDisposables]));
      } catch (error) {
        disposeAll(activationDisposables, (disposeError) => this.reportDisposeError(disposeError));
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[error] capability ${capabilityId}: ${message}`);
        this.diagnostics.add({
          severity: "error",
          code: "capability.activation.failed",
          message: `Capability "${capabilityId}" failed to activate: ${message}`,
          workspaceFolder: workspaceFolder.uri.fsPath
        });
      }
    }

    this.activeCapabilities.set(folderKey, activeForFolder);
  }

  private disposeCapabilitiesForFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    const activeForFolder = this.activeCapabilities.get(workspaceFolder.uri.fsPath);
    if (!activeForFolder) {
      return;
    }

    for (const disposables of activeForFolder.values()) {
      disposeAll(disposables, (error) => this.reportDisposeError(error));
    }
    this.activeCapabilities.delete(workspaceFolder.uri.fsPath);
  }

  private createKernelContext(
    workspaceFolder: vscode.WorkspaceFolder,
    activationDisposables?: vscode.Disposable[]
  ): KernelContext {
    return {
      workspaceFolder,
      output: this.output,
      diagnostics: this.diagnostics,
      registerCommand: (command, callback) =>
        trackDisposable(this.registerCapabilityCommand(workspaceFolder, command, callback), activationDisposables),
      registerFileWatcher: (pattern) =>
        trackDisposable(vscode.workspace.createFileSystemWatcher(pattern), activationDisposables),
      registerTreeDataProvider: (viewId, provider) =>
        trackDisposable(vscode.window.registerTreeDataProvider(viewId, provider), activationDisposables),
      registerSchema: (schema: RegisteredSchema) =>
        trackDisposable(this.schemaRegistry.register(schema), activationDisposables)
    };
  }

  private registerCapabilityCommand(
    workspaceFolder: vscode.WorkspaceFolder,
    command: string,
    callback: (...args: unknown[]) => unknown
  ): vscode.Disposable {
    const folderKey = workspaceFolder.uri.fsPath;
    let route = this.capabilityCommandRoutes.get(command);

    if (!route) {
      route = {
        disposable: this.registerCommand(command, (...args) => this.dispatchCapabilityCommand(command, args)),
        handlers: new Map()
      };
      this.capabilityCommandRoutes.set(command, route);
    }

    route.handlers.set(folderKey, { workspaceFolder, callback });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        const currentRoute = this.capabilityCommandRoutes.get(command);
        if (!currentRoute) {
          return;
        }

        currentRoute.handlers.delete(folderKey);
        if (currentRoute.handlers.size === 0) {
          try {
            currentRoute.disposable.dispose();
          } finally {
            this.capabilityCommandRoutes.delete(command);
          }
        }
      }
    };
  }

  private async dispatchCapabilityCommand(command: string, args: unknown[]): Promise<unknown> {
    const route = this.capabilityCommandRoutes.get(command);
    if (!route || route.handlers.size === 0) {
      this.output.appendLine(`LoreDock command "${command}" has no active workspace handler.`);
      return undefined;
    }

    const explicitFolder = asWorkspaceFolder(args[0]);
    if (explicitFolder) {
      const handler = route.handlers.get(explicitFolder.uri.fsPath);
      if (handler) {
        return handler.callback(...args);
      }
    }

    if (route.handlers.size === 1) {
      const handler = route.handlers.values().next().value;
      return handler?.callback(...args);
    }

    const workspaceFolder = await this.getTargetWorkspaceFolder(
      [...route.handlers.values()].map((handler) => handler.workspaceFolder)
    );
    if (!workspaceFolder) {
      this.output.appendLine(`LoreDock command "${command}" canceled. No workspace folder was selected.`);
      return undefined;
    }

    const handler = route.handlers.get(workspaceFolder.uri.fsPath);
    if (!handler) {
      this.output.appendLine(`LoreDock command "${command}" has no handler for ${workspaceFolder.uri.fsPath}.`);
      return undefined;
    }

    return handler.callback(...args);
  }

  private registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      try {
        await callback(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[error] ${command}: ${message}`);
        void vscode.window.showErrorMessage(`LoreDock command failed: ${message}`);
      }
    });
  }

  private async getTargetWorkspaceFolder(
    candidates: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = [...candidates];

    if (folders.length === 0) {
      this.output.appendLine("No workspace folder is open. LoreDock commands require a workspace.");
      void vscode.window.showWarningMessage("Open a workspace folder before using LoreDock.");
      return undefined;
    }

    if (folders.length === 1) {
      return folders[0];
    }

    const choice = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder
      })),
      {
        title: "Select LoreDock workspace folder",
        placeHolder: "LoreDock v0.0 requires an explicit target workspace folder"
      }
    );

    return choice?.folder;
  }

  private reportWorkspaceRefreshError(workspaceFolder: vscode.WorkspaceFolder, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[error] refresh ${workspaceFolder.uri.fsPath}: ${message}`);
    this.diagnostics.add({
      severity: "error",
      code: "workspace.refresh.failed",
      message: `LoreDock workspace refresh failed: ${message}`,
      workspaceFolder: workspaceFolder.uri.fsPath
    });
  }

  private reportDisposeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[error] dispose: ${message}`);
  }

  private handleWorkspaceFoldersChanged(event: vscode.WorkspaceFoldersChangeEvent): void {
    for (const folder of event.removed) {
      this.disposeWorkspaceFolder(folder);
    }

    for (const folder of event.added) {
      void this.refreshWorkspaceFolderSafely(folder);
    }
  }

  private disposeWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    this.disposeCapabilitiesForFolder(workspaceFolder);
    this.diagnostics.clear(workspaceFolder.uri.fsPath);
  }

  private async refreshWorkspaceFolderSafely(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    try {
      await this.refreshWorkspaceFolder(workspaceFolder);
    } catch (error) {
      this.reportWorkspaceRefreshError(workspaceFolder, error);
    }
  }

  private async readManifest(workspaceFolder: vscode.WorkspaceFolder): Promise<ManifestReadResult> {
    try {
      const text = await fs.readFile(this.absoluteManifestPath(workspaceFolder), "utf8");
      try {
        return { status: "parsed", text, value: JSON.parse(text) };
      } catch (error) {
        return { status: "invalidJson", text, error };
      }
    } catch (error) {
      if (isNotFound(error)) {
        return { status: "missing" };
      }
      throw error;
    }
  }

  private absoluteManifestPath(workspaceFolder: vscode.WorkspaceFolder): string {
    return path.join(workspaceFolder.uri.fsPath, MANIFEST_RELATIVE_PATH);
  }

  private async createBackupRelativePath(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const baseTimestamp = this.now().toISOString().replace(/[:.]/g, "-");
    let candidate = normalizeRelativePath(`${MANIFEST_RELATIVE_PATH}.${baseTimestamp}.bak`);
    let suffix = 1;

    while (await pathExists(path.join(workspaceFolder.uri.fsPath, candidate))) {
      candidate = normalizeRelativePath(`${MANIFEST_RELATIVE_PATH}.${baseTimestamp}.${suffix}.bak`);
      suffix += 1;
    }

    return candidate;
  }
}

function stringifyManifest(manifest: ProjectManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function disposeAll(disposables: vscode.Disposable[], onError?: (error: unknown) => void): void {
  while (disposables.length > 0) {
    const disposable = disposables.pop();
    if (disposable) {
      safeDispose(disposable, onError);
    }
  }
}

function safeDispose(disposable: vscode.Disposable, onError?: (error: unknown) => void): void {
  try {
    disposable.dispose();
  } catch (error) {
    onError?.(error);
  }
}

function trackDisposable<T extends vscode.Disposable>(
  disposable: T,
  activationDisposables: vscode.Disposable[] | undefined
): T {
  activationDisposables?.push(disposable);
  return disposable;
}

function uniqueDisposables(disposables: vscode.Disposable[]): vscode.Disposable[] {
  return [...new Set(disposables)];
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function asWorkspaceFolder(value: unknown): vscode.WorkspaceFolder | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "uri" in value &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value as vscode.WorkspaceFolder;
  }

  return undefined;
}
