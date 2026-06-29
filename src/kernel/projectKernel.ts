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
import { inspectExistingWorkspacePath, resolveExistingSafeWorkspacePath } from "./safeWorkspacePath";
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
  persistent: boolean;
}

interface RoutedCommandHandler {
  workspaceFolder: vscode.WorkspaceFolder;
  callback: (...args: unknown[]) => unknown;
}

type ManifestReadResult =
  | { status: "missing" }
  | { status: "unsafe" }
  | { status: "invalidJson"; text: string; error: unknown }
  | { status: "parsed"; text: string; value: unknown };

export class ProjectKernel implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly diagnostics: DiagnosticsService;
  private readonly schemaRegistry = new SchemaRegistry();
  private readonly migrationRunner = new MigrationRunner();
  private readonly previewApply: PreviewApplyService;
  private readonly capabilityMap = new Map<string, Capability>();
  private readonly activeBootstraps = new Map<string, Map<string, vscode.Disposable[]>>();
  private readonly activeCapabilities = new Map<string, Map<string, vscode.Disposable[]>>();
  private readonly capabilityCommandRoutes = new Map<string, RoutedCommand>();
  private readonly capabilityServices = new Map<string, Map<string, unknown>>();
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
    for (const capability of this.capabilityMap.values()) {
      for (const command of capability.bootstrapCommands ?? []) {
        this.ensureCapabilityCommandRoute(command, true);
      }
    }

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

    for (const folderDisposables of this.activeBootstraps.values()) {
      for (const disposables of folderDisposables.values()) {
        disposeAll(disposables, (error) => this.reportDisposeError(error));
      }
    }

    this.activeCapabilities.clear();
    this.activeBootstraps.clear();
    this.capabilityServices.clear();
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
      this.output.appendLine(`LoreDock 项目已存在：${manifestPath}`);
      const choice = await vscode.window.showInformationMessage(
        "LoreDock 项目已存在。",
        { modal: true },
        "打开清单",
        "修复清单"
      );

      if (choice === "打开清单") {
        await this.openProjectManifest(workspaceFolder);
      } else if (choice === "修复清单") {
        await this.repairProjectManifest(workspaceFolder);
      }
      return;
    }

    const manifest = createDefaultManifest(workspaceFolder.uri.fsPath, this.now());
    const plan: OperationPlan = {
      summary: "初始化 LoreDock 项目。",
      directoriesToCreate: [LOREDOCK_DIR],
      filesToCreate: [MANIFEST_RELATIVE_PATH],
      filesToModify: []
    };

    const confirmed = await this.previewApply.confirmPlan(plan);
    if (!confirmed) {
      this.output.appendLine("已取消初始化 LoreDock 项目，未写入文件。");
      return;
    }

    const writer = new SafeFileWriter(workspaceFolder.uri.fsPath, plan);
    await writer.ensureDirectory(LOREDOCK_DIR);
    await writer.writeFile(MANIFEST_RELATIVE_PATH, stringifyManifest(manifest));

    await this.refreshWorkspaceFolder(workspaceFolder);
    await this.verifyManifest(workspaceFolder);
    this.output.appendLine(`LoreDock 项目已初始化：${manifestPath}`);
    void vscode.window.showInformationMessage("LoreDock 项目已初始化。");
  }

  public async openProjectManifest(target?: vscode.WorkspaceFolder): Promise<void> {
    const workspaceFolder = target ?? (await this.getTargetWorkspaceFolder());
    if (!workspaceFolder) {
      return;
    }

    const manifestPath = this.absoluteManifestPath(workspaceFolder);
    if (!(await pathExists(manifestPath))) {
      this.output.appendLine(`未找到 LoreDock 项目清单：${manifestPath}。请先运行 loredock.initProject。`);
      void vscode.window.showWarningMessage("未找到 LoreDock 项目清单。请先运行 LoreDock：初始化项目。");
      return;
    }

    const safeManifestPath = await resolveExistingSafeWorkspacePath(workspaceFolder.uri.fsPath, MANIFEST_RELATIVE_PATH);
    if (!safeManifestPath) {
      this.output.appendLine(`LoreDock 项目清单路径不安全：${manifestPath}`);
      void vscode.window.showWarningMessage("LoreDock 项目清单路径不安全，已拒绝打开。");
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(safeManifestPath));
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
      this.output.appendLine("无法修复缺失的项目清单。请先运行 loredock.initProject。");
      void vscode.window.showWarningMessage("未找到 LoreDock 项目清单。请先运行 LoreDock：初始化项目。");
      return;
    }

    if (readResult.status === "unsafe") {
      this.output.appendLine("无法修复不安全的项目清单路径。请先移除越出工作区的符号链接。");
      void vscode.window.showWarningMessage("LoreDock 项目清单路径不安全，请先修复工作区文件结构。");
      return;
    }

    const parsedValue = readResult.status === "parsed" ? readResult.value : undefined;
    const nextManifest = repairManifestValue(parsedValue, workspaceFolder.uri.fsPath, this.now());
    const backupRelativePath = await this.createBackupRelativePath(workspaceFolder);
    const futureVersionWarning =
      readResult.status === "parsed" && isKnownFutureOrUnknownVersion(readResult.value)
        ? " 这会按 v0.0 重建清单，并不是版本迁移。"
        : "";

    const plan: OperationPlan = {
      summary: `修复 LoreDock 项目清单。${futureVersionWarning}`,
      directoriesToCreate: [],
      filesToCreate: [backupRelativePath],
      filesToModify: [MANIFEST_RELATIVE_PATH]
    };

    const confirmed = await this.previewApply.confirmPlan(plan);
    if (!confirmed) {
      this.output.appendLine("已取消修复 LoreDock 项目清单，未写入文件。");
      return;
    }

    const writer = new SafeFileWriter(workspaceFolder.uri.fsPath, plan);
    await writer.writeFile(backupRelativePath, readResult.text);
    await writer.writeFile(MANIFEST_RELATIVE_PATH, stringifyManifest(nextManifest));

    await this.refreshWorkspaceFolder(workspaceFolder);
    await this.verifyManifest(workspaceFolder);
    this.output.appendLine(`LoreDock 项目清单已修复。备份写入：${backupRelativePath}`);
    void vscode.window.showInformationMessage("LoreDock 项目清单已修复。");
  }

  public async refreshAllWorkspaceFolders(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      await this.refreshWorkspaceFolderSafely(folder);
    }
  }

  public async refreshWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    this.diagnostics.clear(workspaceFolder.uri.fsPath);
    this.activateBootstraps(workspaceFolder);

    const readResult = await this.readManifest(workspaceFolder);
    if (readResult.status === "missing") {
      this.disposeCapabilitiesForFolder(workspaceFolder);
      this.diagnostics.add({
        severity: "info",
        code: "manifest.missing",
        message: "LoreDock 项目清单不存在。请先运行 loredock.initProject。",
        workspaceFolder: workspaceFolder.uri.fsPath,
        relativePath: MANIFEST_RELATIVE_PATH
      });
      return;
    }

    if (readResult.status === "unsafe") {
      this.disposeCapabilitiesForFolder(workspaceFolder);
      this.diagnostics.add({
        severity: "error",
        code: "manifest.path.unsafe",
        message: "LoreDock 项目清单解析到了工作区之外，或经过了不安全的符号链接。",
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
        message: "LoreDock 项目清单不是有效 JSON。请运行 loredock.repairProjectManifest 重建。",
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
      throw new Error("写入后验证 LoreDock 项目清单失败。");
    }

    const validation = validateProjectManifest(
      readResult.value,
      workspaceFolder.uri.fsPath,
      new Set(this.capabilityMap.keys())
    );
    if (!validation.isValid) {
      throw new Error("写入后验证 LoreDock 项目清单失败。");
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
          message: `能力 "${capabilityId}" 激活失败：${message}`,
          workspaceFolder: workspaceFolder.uri.fsPath
        });
      }
    }

    this.activeCapabilities.set(folderKey, activeForFolder);
  }

  private activateBootstraps(workspaceFolder: vscode.WorkspaceFolder): void {
    const folderKey = workspaceFolder.uri.fsPath;
    const activeForFolder = this.activeBootstraps.get(folderKey) ?? new Map<string, vscode.Disposable[]>();

    for (const [capabilityId, capability] of this.capabilityMap.entries()) {
      if (activeForFolder.has(capabilityId) || !capability.bootstrap) {
        continue;
      }

      const activationDisposables: vscode.Disposable[] = [];
      try {
        const returnedDisposables = capability.bootstrap(
          this.createKernelContext(workspaceFolder, activationDisposables)
        );
        activeForFolder.set(capabilityId, uniqueDisposables([...activationDisposables, ...returnedDisposables]));
      } catch (error) {
        disposeAll(activationDisposables, (disposeError) => this.reportDisposeError(disposeError));
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[error] capability bootstrap ${capabilityId}: ${message}`);
        this.diagnostics.add({
          severity: "error",
          code: "capability.bootstrap.failed",
          message: `能力 "${capabilityId}" 引导失败：${message}`,
          workspaceFolder: workspaceFolder.uri.fsPath
        });
      }
    }

    this.activeBootstraps.set(folderKey, activeForFolder);
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

  private disposeBootstrapsForFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    const activeForFolder = this.activeBootstraps.get(workspaceFolder.uri.fsPath);
    if (!activeForFolder) {
      return;
    }

    for (const disposables of activeForFolder.values()) {
      disposeAll(disposables, (error) => this.reportDisposeError(error));
    }
    this.activeBootstraps.delete(workspaceFolder.uri.fsPath);
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
        trackDisposable(this.schemaRegistry.register(schema), activationDisposables),
      registerCapabilityService: <T>(id: string, service: T) =>
        trackDisposable(this.registerCapabilityService(workspaceFolder, id, service), activationDisposables),
      getCapabilityService: <T>(id: string) => this.getCapabilityService<T>(workspaceFolder, id),
      confirmOperationPlan: (plan: OperationPlan) => this.previewApply.confirmPlan(plan),
      refreshWorkspaceFolder: () => this.refreshWorkspaceFolder(workspaceFolder),
      now: () => this.now()
    };
  }

  private registerCapabilityService<T>(
    workspaceFolder: vscode.WorkspaceFolder,
    id: string,
    service: T
  ): vscode.Disposable {
    const folderKey = workspaceFolder.uri.fsPath;
    const services = this.capabilityServices.get(folderKey) ?? new Map<string, unknown>();

    if (services.has(id)) {
      throw new Error(`能力服务 "${id}" 已在 ${folderKey} 注册。`);
    }

    services.set(id, service);
    this.capabilityServices.set(folderKey, services);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        const currentServices = this.capabilityServices.get(folderKey);
        currentServices?.delete(id);
        if (currentServices?.size === 0) {
          this.capabilityServices.delete(folderKey);
        }
      }
    };
  }

  private getCapabilityService<T>(workspaceFolder: vscode.WorkspaceFolder, id: string): T | undefined {
    return this.capabilityServices.get(workspaceFolder.uri.fsPath)?.get(id) as T | undefined;
  }

  private registerCapabilityCommand(
    workspaceFolder: vscode.WorkspaceFolder,
    command: string,
    callback: (...args: unknown[]) => unknown
  ): vscode.Disposable {
    const folderKey = workspaceFolder.uri.fsPath;
    const route = this.ensureCapabilityCommandRoute(command);

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
        if (currentRoute.handlers.size === 0 && !currentRoute.persistent) {
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
    let route = this.capabilityCommandRoutes.get(command);
    if (!route || route.handlers.size === 0) {
      await this.refreshAllWorkspaceFolders();
      route = this.capabilityCommandRoutes.get(command);
      if (!route || route.handlers.size === 0) {
        this.output.appendLine(`LoreDock 命令 "${command}" 没有可用的工作区处理器。`);
        void vscode.window.showWarningMessage("当前没有可用的 LoreDock 工作区处理器。请先打开或刷新工作区。");
        return undefined;
      }
    }

    const explicitFolder = asWorkspaceFolder(args[0]) ?? asWorkspaceFolderFromNode(args[0]);
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
      this.output.appendLine(`LoreDock 命令 "${command}" 已取消：未选择工作区文件夹。`);
      return undefined;
    }

    const handler = route.handlers.get(workspaceFolder.uri.fsPath);
    if (!handler) {
      this.output.appendLine(`LoreDock 命令 "${command}" 没有对应 ${workspaceFolder.uri.fsPath} 的处理器。`);
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
        void vscode.window.showErrorMessage(`LoreDock 命令执行失败：${message}`);
      }
    });
  }

  private ensureCapabilityCommandRoute(command: string, persistent = false): RoutedCommand {
    let route = this.capabilityCommandRoutes.get(command);

    if (!route) {
      route = {
        disposable: this.registerCommand(command, (...args) => this.dispatchCapabilityCommand(command, args)),
        handlers: new Map(),
        persistent
      };
      this.capabilityCommandRoutes.set(command, route);
    } else if (persistent) {
      route.persistent = true;
    }

    return route;
  }

  private async getTargetWorkspaceFolder(
    candidates: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = [...candidates];

    if (folders.length === 0) {
      this.output.appendLine("当前没有打开工作区文件夹。LoreDock 命令需要工作区。");
      void vscode.window.showWarningMessage("请先打开一个工作区文件夹，再使用 LoreDock。");
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
        title: "选择 LoreDock 工作区文件夹",
        placeHolder: "LoreDock v0.0 需要明确选择目标工作区文件夹"
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
      message: `LoreDock 工作区刷新失败：${message}`,
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
    this.disposeBootstrapsForFolder(workspaceFolder);
    this.capabilityServices.delete(workspaceFolder.uri.fsPath);
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
    const inspection = await inspectExistingWorkspacePath(workspaceFolder.uri.fsPath, MANIFEST_RELATIVE_PATH);
    if (inspection.status === "missing") {
      return { status: "missing" };
    }
    if (inspection.status === "unsafe") {
      return { status: "unsafe" };
    }

    try {
      const text = await fs.readFile(inspection.absolutePath, "utf8");
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

function asWorkspaceFolderFromNode(value: unknown): vscode.WorkspaceFolder | undefined {
  if (typeof value !== "object" || value === null || !("workspaceFolder" in value)) {
    return undefined;
  }

  return asWorkspaceFolder(value.workspaceFolder);
}
