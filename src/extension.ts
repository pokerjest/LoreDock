import * as vscode from "vscode";
import { exampleEmptyCapability } from "./capabilities/exampleEmptyCapability";
import { manuscriptCapability } from "./capabilities/manuscript/capability";
import { ProjectKernel } from "./kernel/projectKernel";

let kernel: ProjectKernel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  kernel = new ProjectKernel(context, [exampleEmptyCapability, manuscriptCapability]);
  kernel.activate();
}

export function deactivate(): void {
  kernel?.dispose();
  kernel = undefined;
}
