import * as vscode from "vscode";
import { exampleEmptyCapability } from "./capabilities/exampleEmptyCapability";
import { ProjectKernel } from "./kernel/projectKernel";

let kernel: ProjectKernel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  kernel = new ProjectKernel(context, [exampleEmptyCapability]);
  kernel.activate();
}

export function deactivate(): void {
  kernel?.dispose();
  kernel = undefined;
}
