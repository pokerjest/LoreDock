import type * as vscode from "vscode";
import type { RegisteredSchema } from "./schemaRegistry";

export const MANIFEST_SCHEMA_VERSION = "0.0.0";
export const PROJECT_ID_PREFIX = "loredock_";
export const MANIFEST_RELATIVE_PATH = ".loredock/project.json";
export const LOREDOCK_DIR = ".loredock";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticItem {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  workspaceFolder: string;
  relativePath?: string;
}

export interface ProjectManifest {
  schemaVersion: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  capabilities: string[];
}

export interface OperationPlan {
  summary: string;
  directoriesToCreate: string[];
  filesToCreate: string[];
  filesToModify: string[];
  filesToMove?: FileMoveOperation[];
  filesToDelete?: string[];
  filesToBackup?: FileBackupOperation[];
  directoriesToMove?: FileMoveOperation[];
  directoriesToDelete?: string[];
}

export interface FileMoveOperation {
  from: string;
  to: string;
}

export interface FileBackupOperation {
  source: string;
  backup: string;
}

export interface Capability {
  id: string;
  bootstrapCommands?: string[];
  bootstrap?(context: KernelContext): vscode.Disposable[];
  activate(context: KernelContext): vscode.Disposable[];
}

export interface KernelContext {
  workspaceFolder: vscode.WorkspaceFolder;
  output: vscode.OutputChannel;
  diagnostics: {
    add(item: DiagnosticItem): void;
    clearMatching(workspaceFolderPath: string, predicate: (item: DiagnosticItem) => boolean): void;
    getForWorkspace(workspaceFolderPath: string): DiagnosticItem[];
  };
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
  registerFileWatcher(pattern: vscode.GlobPattern): vscode.FileSystemWatcher;
  registerTreeDataProvider<T>(viewId: string, provider: vscode.TreeDataProvider<T>): vscode.Disposable;
  registerSchema(schema: RegisteredSchema): vscode.Disposable;
  registerCapabilityService<T>(id: string, service: T): vscode.Disposable;
  getCapabilityService<T>(id: string): T | undefined;
  confirmOperationPlan(plan: OperationPlan): Promise<boolean>;
  refreshWorkspaceFolder(): Promise<void>;
  now(): Date;
}

export interface ManifestValidationResult {
  manifest?: ProjectManifest;
  diagnostics: DiagnosticItem[];
  isValid: boolean;
  degraded: boolean;
}
