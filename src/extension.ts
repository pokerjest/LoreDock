import * as vscode from "vscode";
import { exampleEmptyCapability } from "./capabilities/exampleEmptyCapability";
import { manuscriptCapability } from "./capabilities/manuscript/capability";
import { outlineScenesCapability } from "./capabilities/outlineScenes/capability";
import { storyBibleCapability } from "./capabilities/storyBible/capability";
import { ProjectKernel } from "./kernel/projectKernel";

let kernel: ProjectKernel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  kernel = new ProjectKernel(context, [
    exampleEmptyCapability,
    manuscriptCapability,
    storyBibleCapability,
    outlineScenesCapability
  ]);
  kernel.activate();
}

export function deactivate(): void {
  kernel?.dispose();
  kernel = undefined;
}
