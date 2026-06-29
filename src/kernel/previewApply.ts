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
    this.output.appendLine("LoreDock operation preview");
    this.output.appendLine("==========================");
    this.output.appendLine(plan.summary);
    this.printList("Directories to create", plan.directoriesToCreate);
    this.printList("Files to create", plan.filesToCreate);
    this.printList("Files to modify", plan.filesToModify);
  }

  private printList(label: string, values: string[]): void {
    this.output.appendLine(`${label}:`);

    if (values.length === 0) {
      this.output.appendLine("  - none");
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
    "Apply",
    "Cancel"
  );
  return choice === "Apply";
}
