import * as vscode from "vscode";
import type { DiagnosticItem } from "./types";

export class DiagnosticsService {
  private readonly items = new Map<string, DiagnosticItem[]>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public add(item: DiagnosticItem): void {
    const existing = this.items.get(item.workspaceFolder) ?? [];
    existing.push(item);
    this.items.set(item.workspaceFolder, existing);
  }

  public addMany(items: DiagnosticItem[]): void {
    for (const item of items) {
      this.add(item);
    }
  }

  public clear(workspaceFolderPath: string): void {
    this.items.delete(workspaceFolderPath);
  }

  public clearMatching(workspaceFolderPath: string, predicate: (item: DiagnosticItem) => boolean): void {
    const remaining = (this.items.get(workspaceFolderPath) ?? []).filter((item) => !predicate(item));
    if (remaining.length === 0) {
      this.items.delete(workspaceFolderPath);
      return;
    }

    this.items.set(workspaceFolderPath, remaining);
  }

  public getForWorkspace(workspaceFolderPath: string): DiagnosticItem[] {
    return [...(this.items.get(workspaceFolderPath) ?? [])];
  }

  public getAll(): DiagnosticItem[] {
    return [...this.items.values()].flat();
  }

  public print(workspaceFolderPath?: string): void {
    const items = workspaceFolderPath ? this.getForWorkspace(workspaceFolderPath) : this.getAll();

    this.output.appendLine("LoreDock 诊断");
    this.output.appendLine("====================");

    if (items.length === 0) {
      this.output.appendLine("没有诊断。");
      return;
    }

    for (const item of items) {
      const location = item.relativePath ? `${item.workspaceFolder}/${item.relativePath}` : item.workspaceFolder;
      this.output.appendLine(`[${item.severity}] ${item.code}: ${item.message}`);
      this.output.appendLine(`  工作区：${location}`);
    }
  }
}
