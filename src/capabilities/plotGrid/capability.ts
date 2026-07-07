import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { validateProjectManifest } from "../../kernel/manifest";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import type { Capability, KernelContext, OperationPlan, ProjectManifest } from "../../kernel/types";
import { MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import { MANUSCRIPT_CAPABILITY_ID, type ManuscriptService } from "../manuscript/types";
import { OUTLINE_SCENES_CAPABILITY_ID, type OutlineSceneService } from "../outlineScenes/types";
import { STORY_BIBLE_CAPABILITY_ID, type StoryBibleService } from "../storyBible/types";
import { PlotGridController } from "./controller";
import {
  createDefaultPlotGridConfig,
  isPlotGridCapabilityEnabled,
  readPlotGridConfig,
  stringifyPlotGridConfig
} from "./files";
import { openPlotGridWebview, type PlotGridOpenTarget } from "./plotGridWebview";
import {
  BOARDS_DIR,
  PLOT_GRID_CAPABILITY_ID,
  PLOT_GRID_CONFIG_PATH,
  PLOT_GRID_SCHEMA_ID,
  PLOT_GRID_CONFIG_SCHEMA_VERSION
} from "./types";

const PLOT_GRID_ACTIVE_CONTEXT = "loredock.plotGrid.active";
const DISABLED_COMMANDS = ["loredock.plotGrid.open"];

export const plotGridCapability: Capability = {
  id: PLOT_GRID_CAPABILITY_ID,
  bootstrapCommands: ["loredock.enablePlotGrid", ...DISABLED_COMMANDS],
  bootstrap(context) {
    const projectWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, ".loredock/project.json")
    );
    const refresh = () => {
      void updatePlotGridContext();
    };
    void updatePlotGridContext();
    return [
      context.registerCommand("loredock.enablePlotGrid", () => enablePlotGrid(context)),
      ...DISABLED_COMMANDS.map((command) => context.registerCommand(command, () => showDisabledMessage(context))),
      projectWatcher,
      projectWatcher.onDidCreate(refresh),
      projectWatcher.onDidChange(refresh),
      projectWatcher.onDidDelete(refresh)
    ];
  },
  activate(context) {
    const controller = new PlotGridController({
      workspaceFolder: context.workspaceFolder,
      output: context.output,
      diagnostics: context.diagnostics,
      confirmOperationPlan: context.confirmOperationPlan,
      getManuscriptService: () => context.getCapabilityService<ManuscriptService>(MANUSCRIPT_CAPABILITY_ID),
      getOutlineSceneService: () => context.getCapabilityService<OutlineSceneService>(OUTLINE_SCENES_CAPABILITY_ID),
      getStoryBibleService: () => context.getCapabilityService<StoryBibleService>(STORY_BIBLE_CAPABILITY_ID),
      now: context.now
    });
    const configWatcher = context.registerFileWatcher(new vscode.RelativePattern(context.workspaceFolder, PLOT_GRID_CONFIG_PATH));
    const upstreamDisposables = subscribeUpstream(context, controller);
    const disposables: vscode.Disposable[] = [
      controller,
      context.registerSchema({ id: PLOT_GRID_SCHEMA_ID, version: PLOT_GRID_CONFIG_SCHEMA_VERSION }),
      context.registerCapabilityService(PLOT_GRID_CAPABILITY_ID, controller),
      context.registerCommand("loredock.enablePlotGrid", () => controller.enablePlotGrid()),
      context.registerCommand("loredock.plotGrid.open", (target) => openPlotGridWebview(context, controller, asPlotGridOpenTarget(target))),
      configWatcher,
      configWatcher.onDidCreate((uri) => handleConfigChanged(context, controller, uri)),
      configWatcher.onDidChange((uri) => handleConfigChanged(context, controller, uri)),
      configWatcher.onDidDelete((uri) => handleConfigChanged(context, controller, uri)),
      ...upstreamDisposables
    ];

    void updatePlotGridContext();
    void controller.refreshDiagnostics();
    return disposables;
  }
};

async function enablePlotGrid(context: KernelContext): Promise<void> {
  const workspaceRoot = context.workspaceFolder.uri.fsPath;
  const projectManifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
  const readProject = await readJsonFile(projectManifestPath);

  if (readProject.status === "missing") {
    void vscode.window.showWarningMessage("请先运行 LoreDock：初始化项目，再启用剧情矩阵。");
    return;
  }
  if (readProject.status === "invalidJson") {
    void vscode.window.showWarningMessage("项目清单不是有效 JSON，请先修复 LoreDock 项目清单。");
    return;
  }

  const validation = validateProjectManifest(
    readProject.value,
    workspaceRoot,
    new Set([PLOT_GRID_CAPABILITY_ID, MANUSCRIPT_CAPABILITY_ID, OUTLINE_SCENES_CAPABILITY_ID, STORY_BIBLE_CAPABILITY_ID])
  );
  for (const item of validation.diagnostics) {
    context.diagnostics.add(item);
  }
  if (!validation.isValid || !validation.manifest) {
    void vscode.window.showWarningMessage("项目清单处于异常状态，请先修复后再启用剧情矩阵。");
    return;
  }
  if (!validation.manifest.capabilities.includes(MANUSCRIPT_CAPABILITY_ID)) {
    void vscode.window.showWarningMessage("剧情矩阵需要先启用手稿。请先运行 LoreDock：启用手稿。");
    return;
  }
  if (!validation.manifest.capabilities.includes(OUTLINE_SCENES_CAPABILITY_ID)) {
    void vscode.window.showWarningMessage("剧情矩阵需要先启用结构规划。请先运行 LoreDock：启用结构规划。");
    return;
  }
  if (validation.manifest.capabilities.includes(PLOT_GRID_CAPABILITY_ID)) {
    await context.refreshWorkspaceFolder();
    await updatePlotGridContext();
    return;
  }

  const existing = await readPlotGridConfig(workspaceRoot);
  const blockingErrors = existing.diagnostics.filter((item) => item.severity === "error");
  if (existing.status !== "missing" && blockingErrors.length > 0) {
    for (const item of existing.diagnostics) {
      context.diagnostics.add(item);
    }
    void vscode.window.showWarningMessage("现有剧情矩阵配置需要修复后才能启用。");
    return;
  }

  const nextManifest: ProjectManifest = {
    ...validation.manifest,
    capabilities: [...validation.manifest.capabilities, PLOT_GRID_CAPABILITY_ID],
    updatedAt: context.now().toISOString()
  };
  const shouldCreateConfig = existing.status === "missing";
  const plan: OperationPlan = {
    summary: "启用剧情矩阵。",
    directoriesToCreate: [BOARDS_DIR],
    filesToCreate: shouldCreateConfig ? [PLOT_GRID_CONFIG_PATH] : [],
    filesToModify: [MANIFEST_RELATIVE_PATH]
  };
  const confirmed = await context.confirmOperationPlan(plan);
  if (!confirmed) {
    context.output.appendLine("已取消启用剧情矩阵。");
    return;
  }

  const writer = new SafeFileWriter(workspaceRoot, plan);
  await writer.ensureDirectory(BOARDS_DIR);
  if (shouldCreateConfig) {
    await writer.writeFile(PLOT_GRID_CONFIG_PATH, stringifyPlotGridConfig(createDefaultPlotGridConfig(context.now())));
  }
  await writer.writeFile(MANIFEST_RELATIVE_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`);
  await context.refreshWorkspaceFolder();
  await updatePlotGridContext();
}

function asPlotGridOpenTarget(value: unknown): PlotGridOpenTarget | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return {
    ...("workspaceFolder" in value ? { workspaceFolder: value.workspaceFolder as vscode.WorkspaceFolder } : {}),
    ...("sceneId" in value && typeof value.sceneId === "string" ? { sceneId: value.sceneId as PlotGridOpenTarget["sceneId"] } : {})
  };
}

function subscribeUpstream(context: KernelContext, controller: PlotGridController): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const manuscript = context.getCapabilityService<ManuscriptService>(MANUSCRIPT_CAPABILITY_ID);
  const outlineScenes = context.getCapabilityService<OutlineSceneService>(OUTLINE_SCENES_CAPABILITY_ID);
  const storyBible = context.getCapabilityService<StoryBibleService>(STORY_BIBLE_CAPABILITY_ID);

  if (manuscript) {
    disposables.push(manuscript.onDidChange((event) => controller.notifyProjectionChanged(event.path)));
  }
  if (outlineScenes) {
    disposables.push(outlineScenes.onDidChange((event) => controller.notifyProjectionChanged(event.path)));
  }
  if (storyBible) {
    disposables.push(storyBible.onDidChange((event) => controller.notifyProjectionChanged(event.path)));
  }
  return disposables;
}

function handleConfigChanged(
  context: KernelContext,
  controller: PlotGridController,
  uri: vscode.Uri
): void {
  const relativePath = path.relative(context.workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  controller.notifyConfigChanged(relativePath);
  void controller.refreshDiagnostics();
}

async function updatePlotGridContext(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeStates = await Promise.all(
    folders.map((folder) => isPlotGridCapabilityEnabled(folder.uri.fsPath).catch(() => false))
  );
  await vscode.commands.executeCommand("setContext", PLOT_GRID_ACTIVE_CONTEXT, activeStates.some(Boolean));
}

function showDisabledMessage(context: KernelContext): void {
  context.output.appendLine("当前工作区尚未启用剧情矩阵。请先运行 loredock.enablePlotGrid。");
  void vscode.window.showWarningMessage("当前工作区尚未启用剧情矩阵。请先运行 LoreDock：启用剧情矩阵。");
}

type JsonReadResult =
  | { status: "missing" }
  | { status: "invalidJson"; error: unknown }
  | { status: "parsed"; value: unknown };

async function readJsonFile(absolutePath: string): Promise<JsonReadResult> {
  try {
    return { status: "parsed", value: JSON.parse(await fs.readFile(absolutePath, "utf8")) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { status: "missing" };
    }
    if (error instanceof SyntaxError) {
      return { status: "invalidJson", error };
    }
    throw error;
  }
}
