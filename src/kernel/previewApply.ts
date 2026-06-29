import * as vscode from "vscode";
import type { OperationPlan } from "./types";

export type ConfirmationProvider = (plan: OperationPlan) => Promise<boolean>;

export class PreviewApplyService {
  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly confirm: ConfirmationProvider = defaultConfirmation
  ) {}

  public async confirmPlan(plan: OperationPlan): Promise<boolean> {
    this.printPlan(plan);
    return this.confirm(plan);
  }

  public printPlan(plan: OperationPlan): void {
    this.output.appendLine("LoreDock 操作预览");
    this.output.appendLine("==========================");
    this.output.appendLine(plan.summary);
    this.printList("将创建的目录", plan.directoriesToCreate);
    this.printList("将创建的文件", plan.filesToCreate);
    this.printList("将修改的文件", plan.filesToModify);
    this.printList(
      "将移动的文件",
      (plan.filesToMove ?? []).map((operation) => `${operation.from} -> ${operation.to}`)
    );
    this.printList(
      "将移动的目录",
      (plan.directoriesToMove ?? []).map((operation) => `${operation.from} -> ${operation.to}`)
    );
    this.printList("将删除的文件", plan.filesToDelete ?? []);
    this.printList("将递归删除的目录", plan.directoriesToDelete ?? []);
    this.printList(
      "将备份的文件",
      (plan.filesToBackup ?? []).map((operation) => `${operation.source} -> ${operation.backup}`)
    );
  }

  private printList(label: string, values: string[]): void {
    this.output.appendLine(`${label}:`);

    if (values.length === 0) {
      this.output.appendLine("  - 无");
      return;
    }

    for (const value of values) {
      this.output.appendLine(`  - ${value}`);
    }
  }
}

async function defaultConfirmation(plan: OperationPlan): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    plan.summary,
    { modal: true },
    "应用"
  );
  return choice === "应用";
}
