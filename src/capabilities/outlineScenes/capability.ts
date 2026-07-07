import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { registerExclusiveCommand } from "../../kernel/commandRegistry";
import { validateProjectManifest } from "../../kernel/manifest";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import type { Capability, KernelContext, OperationPlan, ProjectManifest } from "../../kernel/types";
import { MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import { MANUSCRIPT_CAPABILITY_ID, type ManuscriptService } from "../manuscript/types";
import { STORY_BIBLE_CAPABILITY_ID, type StoryBibleService } from "../storyBible/types";
import { OutlineSceneController } from "./controller";
import { isOutlineScenesCapabilityEnabled, readOutlineScenes } from "./files";
import { OutlineScenesTreeProvider, type OutlineScenesTreeNode } from "./tree";
import {
  OUTLINE_SCENES_CAPABILITY_ID,
  OUTLINE_SCENES_SCHEMA_ID,
  OUTLINE_SCENES_SCHEMA_VERSION,
  OUTLINES_DIR,
  SCENES_DIR,
  type OutlineDraftScope,
  type OutlineImportOptions,
  type OutlineScenesTrashItemId,
  type SceneCardDto,
  type SceneStatus
} from "./types";

const VIEW_ID = "loredock.outlineScenes.tree";
const OUTLINE_SCENES_ACTIVE_CONTEXT = "loredock.outlineScenes.active";
const OUTLINE_SCENES_TRASH_MODE_CONTEXT = "loredock.outlineScenes.trashMode";
const DISABLED_COMMANDS = [
  "loredock.outlineScenes.createOutline",
  "loredock.outlineScenes.deleteOutline",
  "loredock.outlineScenes.importOutline",
  "loredock.outlineScenes.createSceneCard",
  "loredock.outlineScenes.createSceneCardFromChapter",
  "loredock.outlineScenes.bindScenesToChapter",
  "loredock.outlineScenes.bindSceneToChapters",
  "loredock.outlineScenes.createChapterAndBindScene",
  "loredock.outlineScenes.openSceneCard",
  "loredock.outlineScenes.editSceneMetadata",
  "loredock.outlineScenes.deleteSceneCard",
  "loredock.outlineScenes.restoreTrashItem",
  "loredock.outlineScenes.permanentlyDeleteTrashItem"
];

const sharedTreeWorkspaces = new Set<string>();
let sharedTreeProvider: OutlineScenesTreeProvider | undefined;
let sharedTreeRegistration: vscode.Disposable | undefined;
let sharedRefreshCommandRegistration: vscode.Disposable | undefined;
let sharedToggleTrashCommandRegistration: vscode.Disposable | undefined;

export const outlineScenesCapability: Capability = {
  id: OUTLINE_SCENES_CAPABILITY_ID,
  bootstrapCommands: ["loredock.enableOutlineScenes", ...DISABLED_COMMANDS],
  bootstrap(context) {
    const tree = getOrCreateTreeProvider();
    const projectWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, ".loredock/project.json")
    );
    const refresh = () => {
      void refreshOutlineScenesTree(tree);
    };

    void refreshOutlineScenesTree(tree);
    return [
      acquireSharedTreeRegistration(context, tree),
      context.registerCommand("loredock.enableOutlineScenes", () => enableOutlineScenes(context)),
      ...DISABLED_COMMANDS.map((command) => context.registerCommand(command, () => showDisabledMessage(context))),
      projectWatcher,
      projectWatcher.onDidCreate(refresh),
      projectWatcher.onDidChange(refresh),
      projectWatcher.onDidDelete(refresh)
    ];
  },
  activate(context) {
    const controller = new OutlineSceneController({
      workspaceFolder: context.workspaceFolder,
      output: context.output,
      diagnostics: context.diagnostics,
      confirmOperationPlan: context.confirmOperationPlan,
      confirmDestructiveDelete,
      getManuscriptService: () => context.getCapabilityService<ManuscriptService>(MANUSCRIPT_CAPABILITY_ID),
      getStoryBibleReader: () => context.getCapabilityService<StoryBibleService>(STORY_BIBLE_CAPABILITY_ID)?.reader,
      now: context.now
    });
    const tree = getOrCreateTreeProvider();
    const outlineWatcher = context.registerFileWatcher(new vscode.RelativePattern(context.workspaceFolder, "outlines/**"));
    const sceneWatcher = context.registerFileWatcher(new vscode.RelativePattern(context.workspaceFolder, "scenes/**"));
    const manuscriptManifestWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, "manuscript/manifest.json")
    );
    const trashWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, ".loredock/trash/resources/outline-scenes/**")
    );

    const disposables: vscode.Disposable[] = [
      controller,
      tree.registerReaderProvider(context.workspaceFolder, () => controller),
      context.registerSchema({ id: OUTLINE_SCENES_SCHEMA_ID, version: OUTLINE_SCENES_SCHEMA_VERSION }),
      context.registerCapabilityService(OUTLINE_SCENES_CAPABILITY_ID, controller),
      controller.onDidChange(() => {
        void refreshOutlineScenesTree(tree);
      }),
      outlineWatcher,
      sceneWatcher,
      manuscriptManifestWatcher,
      trashWatcher,
      outlineWatcher.onDidCreate((uri) => handleWatchedFile(context, controller, tree, uri, "outline")),
      outlineWatcher.onDidChange((uri) => handleWatchedFile(context, controller, tree, uri, "outline")),
      outlineWatcher.onDidDelete((uri) => handleWatchedFile(context, controller, tree, uri, "outline")),
      sceneWatcher.onDidCreate((uri) => handleWatchedFile(context, controller, tree, uri, "structure")),
      sceneWatcher.onDidChange((uri) => handleWatchedFile(context, controller, tree, uri, "content")),
      sceneWatcher.onDidDelete((uri) => handleWatchedFile(context, controller, tree, uri, "structure")),
      manuscriptManifestWatcher.onDidCreate(() => {
        void refreshOutlineScenesTree(tree);
      }),
      manuscriptManifestWatcher.onDidChange(() => {
        void refreshOutlineScenesTree(tree);
      }),
      manuscriptManifestWatcher.onDidDelete(() => {
        void refreshOutlineScenesTree(tree);
      }),
      trashWatcher.onDidCreate((uri) => handleWatchedFile(context, controller, tree, uri, "structure")),
      trashWatcher.onDidChange((uri) => handleWatchedFile(context, controller, tree, uri, "metadata")),
      trashWatcher.onDidDelete((uri) => handleWatchedFile(context, controller, tree, uri, "structure")),
      context.registerCommand("loredock.outlineScenes.createOutline", () => createOutline(controller)),
      context.registerCommand("loredock.outlineScenes.deleteOutline", (node) => deleteOutline(controller, node)),
      context.registerCommand("loredock.outlineScenes.importOutline", (node) => importOutline(controller, node)),
      context.registerCommand("loredock.outlineScenes.createSceneCard", () => createSceneCard(controller)),
      context.registerCommand("loredock.outlineScenes.createSceneCardFromChapter", (node) =>
        createSceneCardFromChapter(controller, node)
      ),
      context.registerCommand("loredock.outlineScenes.bindScenesToChapter", (node) =>
        bindScenesToChapter(controller, node)
      ),
      context.registerCommand("loredock.outlineScenes.bindSceneToChapters", (node) =>
        bindSceneToChapters(controller, node)
      ),
      context.registerCommand("loredock.outlineScenes.createChapterAndBindScene", (node) =>
        createChapterAndBindScene(controller, node)
      ),
      context.registerCommand("loredock.outlineScenes.openSceneCard", (node) => openSceneCard(context, controller, node)),
      context.registerCommand("loredock.outlineScenes.editSceneMetadata", (node) => editSceneMetadata(controller, node)),
      context.registerCommand("loredock.outlineScenes.deleteSceneCard", (node) => deleteSceneCard(controller, node)),
      context.registerCommand("loredock.outlineScenes.restoreTrashItem", (node) => restoreTrashItem(controller, node)),
      context.registerCommand("loredock.outlineScenes.permanentlyDeleteTrashItem", (node) =>
        permanentlyDeleteTrashItem(controller, node)
      )
    ];

    void controller.refreshDiagnostics().then(() => refreshOutlineScenesTree(tree));
    return disposables;
  }
};

function getOrCreateTreeProvider(): OutlineScenesTreeProvider {
  if (!sharedTreeProvider) {
    sharedTreeProvider = new OutlineScenesTreeProvider();
  }
  return sharedTreeProvider;
}

function acquireSharedTreeRegistration(context: KernelContext, tree: OutlineScenesTreeProvider): vscode.Disposable {
  const key = context.workspaceFolder.uri.fsPath;
  sharedTreeWorkspaces.add(key);

  if (!sharedTreeRegistration) {
    sharedTreeRegistration = vscode.window.registerTreeDataProvider(VIEW_ID, tree);
  }
  if (!sharedRefreshCommandRegistration) {
    sharedRefreshCommandRegistration = registerExclusiveCommand("loredock.outlineScenes.refreshTree", () =>
      refreshOutlineScenesTree(tree)
    );
  }
  if (!sharedToggleTrashCommandRegistration) {
    sharedToggleTrashCommandRegistration = registerExclusiveCommand("loredock.outlineScenes.toggleTrash", async () => {
      tree.toggleTrashMode();
      await refreshOutlineScenesTree(tree);
    });
  }

  tree.refresh();
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      sharedTreeWorkspaces.delete(key);
      tree.refresh();
      if (sharedTreeWorkspaces.size > 0) {
        return;
      }

      sharedTreeRegistration?.dispose();
      sharedRefreshCommandRegistration?.dispose();
      sharedToggleTrashCommandRegistration?.dispose();
      sharedTreeRegistration = undefined;
      sharedRefreshCommandRegistration = undefined;
      sharedToggleTrashCommandRegistration = undefined;
      sharedTreeProvider = undefined;
    }
  };
}

async function refreshOutlineScenesTree(tree: OutlineScenesTreeProvider): Promise<void> {
  await updateOutlineScenesContext();
  await vscode.commands.executeCommand("setContext", OUTLINE_SCENES_TRASH_MODE_CONTEXT, tree.isTrashMode);
  tree.refresh();
}

async function updateOutlineScenesContext(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeStates = await Promise.all(
    folders.map((folder) => isOutlineScenesCapabilityEnabled(folder.uri.fsPath).catch(() => false))
  );
  await vscode.commands.executeCommand("setContext", OUTLINE_SCENES_ACTIVE_CONTEXT, activeStates.some(Boolean));
}

async function enableOutlineScenes(context: KernelContext): Promise<void> {
  const workspaceRoot = context.workspaceFolder.uri.fsPath;
  const projectManifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
  const readProject = await readJsonFile(projectManifestPath);

  if (readProject.status === "missing") {
    void vscode.window.showWarningMessage("请先运行 LoreDock：初始化项目，再启用结构规划。");
    return;
  }
  if (readProject.status === "invalidJson") {
    void vscode.window.showWarningMessage("项目清单不是有效 JSON，请先修复 LoreDock 项目清单。");
    return;
  }

  const validation = validateProjectManifest(
    readProject.value,
    workspaceRoot,
    new Set([OUTLINE_SCENES_CAPABILITY_ID, MANUSCRIPT_CAPABILITY_ID, STORY_BIBLE_CAPABILITY_ID])
  );
  for (const item of validation.diagnostics) {
    context.diagnostics.add(item);
  }
  if (!validation.isValid || !validation.manifest) {
    void vscode.window.showWarningMessage("项目清单处于异常状态，请先修复后再启用结构规划。");
    return;
  }
  if (!validation.manifest.capabilities.includes(MANUSCRIPT_CAPABILITY_ID)) {
    void vscode.window.showWarningMessage("结构规划需要先启用手稿。请先运行 LoreDock：启用手稿。");
    return;
  }
  if (validation.manifest.capabilities.includes(OUTLINE_SCENES_CAPABILITY_ID)) {
    await context.refreshWorkspaceFolder();
    await refreshOutlineScenesTree(getOrCreateTreeProvider());
    return;
  }

  const existing = await readOutlineScenes(workspaceRoot);
  const blockingErrors = existing.diagnostics.filter((item) => item.severity === "error");
  if (existing.status !== "missing" && blockingErrors.length > 0) {
    for (const item of existing.diagnostics) {
      context.diagnostics.add(item);
    }
    void vscode.window.showWarningMessage("现有结构规划文件需要修复后才能启用。");
    return;
  }

  const nextManifest: ProjectManifest = {
    ...validation.manifest,
    capabilities: [...validation.manifest.capabilities, OUTLINE_SCENES_CAPABILITY_ID],
    updatedAt: context.now().toISOString()
  };
  const plan: OperationPlan = {
    summary: "启用结构规划。",
    directoriesToCreate: [OUTLINES_DIR, SCENES_DIR],
    filesToCreate: [],
    filesToModify: [MANIFEST_RELATIVE_PATH]
  };
  const confirmed = await context.confirmOperationPlan(plan);
  if (!confirmed) {
    context.output.appendLine("已取消启用结构规划。");
    return;
  }

  const writer = new SafeFileWriter(workspaceRoot, plan);
  await writer.ensureDirectory(OUTLINES_DIR);
  await writer.ensureDirectory(SCENES_DIR);
  await writer.writeFile(MANIFEST_RELATIVE_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`);
  await context.refreshWorkspaceFolder();
  await refreshOutlineScenesTree(getOrCreateTreeProvider());
}

function showDisabledMessage(context: KernelContext): void {
  context.output.appendLine("当前工作区尚未启用结构规划。请先运行 loredock.enableOutlineScenes。");
  void vscode.window.showWarningMessage("当前工作区尚未启用结构规划。请先运行 LoreDock：启用结构规划。");
}

async function createOutline(controller: OutlineSceneController): Promise<void> {
  const scope = await pickOutlineScope();
  if (!scope) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: `新建${outlineScopeLabel(scope)}`,
    prompt: "输入大纲草稿文件名",
    value: defaultOutlineName(scope)
  });
  if (title) {
    await controller.createOutlineTemplate(title, scope);
  }
}

async function importOutline(controller: OutlineSceneController, node: unknown): Promise<void> {
  const outlinePath = isOutlineNode(node) ? node.path : await pickOutline(controller);
  if (outlinePath) {
    const outline = await controller.parseOutline(outlinePath);
    const options = await pickImportOptions(controller, outline.scope);
    if (options) {
      await controller.importOutline(outlinePath, options);
    }
  }
}

async function deleteOutline(controller: OutlineSceneController, node: unknown): Promise<void> {
  const outlinePath = isOutlineNode(node) ? node.path : await pickOutline(controller);
  if (outlinePath) {
    await controller.deleteOutline(outlinePath);
  }
}

async function pickOutlineScope(): Promise<OutlineDraftScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "书籍大纲", description: "# 卷 / ## 章 / ### 场景", scope: "book" },
      { label: "卷大纲", description: "# 卷 / ## 章 / ### 场景", scope: "volume" },
      { label: "章大纲", description: "# 章 / ## 场景", scope: "chapter" },
      { label: "场景大纲", description: "# 场景 / - Beat", scope: "scene" }
    ] satisfies Array<{ label: string; description: string; scope: OutlineDraftScope }>,
    { title: "选择规划草稿粒度" }
  );
  return picked?.scope;
}

async function pickImportOptions(
  controller: OutlineSceneController,
  scope: OutlineDraftScope
): Promise<OutlineImportOptions | undefined> {
  if (scope === "book") {
    return {};
  }
  if (scope === "volume") {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "新建卷", description: "把草稿导入为一个新的卷", mode: "new" },
        { label: "追加到已有卷", description: "复用已有卷，只创建缺失章节和场景卡", mode: "existing" }
      ] as const,
      { title: "导入卷大纲" }
    );
    if (!mode) {
      return undefined;
    }
    if (mode.mode === "new") {
      return {};
    }
    const volume = await pickVolumeForChapter(controller);
    return volume ? { target: { volumeId: volume.volumeId, volumeTitle: volume.title } } : undefined;
  }
  if (scope === "chapter") {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "追加到已有章节", description: "只把场景卡绑定到已有章节", mode: "chapter" },
        { label: "在已有卷中新建章节", description: "创建章节，再绑定场景卡", mode: "volume" },
        { label: "新建卷和章节", description: "没有合适父级时使用", mode: "new" }
      ] as const,
      { title: "导入章大纲" }
    );
    if (!mode) {
      return undefined;
    }
    if (mode.mode === "chapter") {
      const chapter = await pickChapterForBinding(controller);
      return chapter ? { target: { chapterId: chapter.chapterId, chapterTitle: chapter.title } } : undefined;
    }
    if (mode.mode === "volume") {
      const volume = await pickVolumeForChapter(controller);
      return volume ? { target: { volumeId: volume.volumeId, volumeTitle: volume.title } } : undefined;
    }
    const volumeTitle = await vscode.window.showInputBox({ title: "新建卷", prompt: "输入新卷标题", value: "导入章节" });
    return volumeTitle ? { target: { volumeTitle } } : undefined;
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: "绑定到已有章节", description: "只创建场景卡并绑定章节", mode: "chapter" },
      { label: "在已有卷中新建章节", description: "创建章节，再绑定场景卡", mode: "volume" },
      { label: "新建卷和章节", description: "没有合适父级时使用", mode: "new" }
    ] as const,
    { title: "导入场景大纲" }
  );
  if (!mode) {
    return undefined;
  }
  if (mode.mode === "chapter") {
    const chapter = await pickChapterForBinding(controller);
    return chapter ? { target: { chapterId: chapter.chapterId, chapterTitle: chapter.title } } : undefined;
  }
  const chapterTitle = await vscode.window.showInputBox({ title: "新建章节", prompt: "输入章节标题", value: "新章节" });
  if (!chapterTitle) {
    return undefined;
  }
  if (mode.mode === "volume") {
    const volume = await pickVolumeForChapter(controller);
    return volume ? { target: { volumeId: volume.volumeId, volumeTitle: volume.title, chapterTitle } } : undefined;
  }
  const volumeTitle = await vscode.window.showInputBox({ title: "新建卷", prompt: "输入新卷标题", value: "导入场景" });
  return volumeTitle ? { target: { volumeTitle, chapterTitle } } : undefined;
}

async function createSceneCard(controller: OutlineSceneController): Promise<void> {
  const chapterRefs = await pickChapterRefsForScene(controller);
  if (chapterRefs === undefined) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: "新建场景卡",
    prompt: `绑定章节：${chapterRefs.map((chapter) => chapter.title).join(", ") || "未绑定章节"}`,
    value: "新场景"
  });
  if (title) {
    await controller.createSceneCard({ title, chapterRefs: chapterRefs?.map((chapter) => chapter.chapterId) ?? [] });
  }
}

async function createSceneCardFromChapter(controller: OutlineSceneController, node: unknown): Promise<void> {
  const chapterRefs = isChapterNode(node)
    ? [{ chapterId: node.chapterId, title: node.title }]
    : await pickChapterRefsForScene(controller);
  if (chapterRefs === undefined) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: "新建场景卡",
    prompt: `绑定章节：${chapterRefs?.map((chapter) => chapter.title).join(", ") || "未绑定章节"}`,
    value: "新场景"
  });
  if (title) {
    await controller.createSceneCard({ title, chapterRefs: chapterRefs?.map((chapter) => chapter.chapterId) ?? [] });
  }
}

async function bindScenesToChapter(controller: OutlineSceneController, node: unknown): Promise<void> {
  const chapter = isChapterNode(node) ? { chapterId: node.chapterId, title: node.title } : await pickChapterForBinding(controller);
  if (!chapter) {
    return;
  }
  const scenes = (await controller.listScenes()).filter((scene) => !(scene.chapterRefs as readonly string[]).includes(chapter.chapterId));
  if (scenes.length === 0) {
    void vscode.window.showInformationMessage(`没有可绑定到“${chapter.title}”的场景卡。`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    scenes.map((scene) => ({ label: scene.title, description: scene.path, detail: scene.chapterRefs.join(", ") || "未绑定章节", scene })),
    { title: `绑定已有场景卡到“${chapter.title}”`, canPickMany: true }
  );
  if (!picked || picked.length === 0) {
    return;
  }
  await controller.bindScenesToChapter(picked.map((item) => item.scene.id), chapter.chapterId);
}

async function bindSceneToChapters(controller: OutlineSceneController, node: unknown): Promise<void> {
  const scene = isSceneNode(node) ? await controller.getScene(node.id) : await pickScene(controller);
  if (!scene) {
    return;
  }
  const chapters = await pickChapterRefsForScene(controller);
  if (!chapters || chapters.length === 0) {
    return;
  }
  await controller.bindSceneToChapters(scene.id, chapters.map((chapter) => chapter.chapterId));
}

async function createChapterAndBindScene(controller: OutlineSceneController, node: unknown): Promise<void> {
  const scene = isSceneNode(node) ? await controller.getScene(node.id) : await pickScene(controller);
  if (!scene) {
    return;
  }
  const volume = await pickVolumeForChapter(controller);
  if (!volume) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: "新建章节并绑定场景卡",
    prompt: `新章节将创建在：${volume.title}`,
    value: scene.title
  });
  if (!title) {
    return;
  }
  await controller.createChapterAndBindScene(scene.id, volume.volumeId, title);
}

async function openSceneCard(
  context: KernelContext,
  controller: OutlineSceneController,
  node: unknown
): Promise<void> {
  const scene = isSceneNode(node) ? node : await pickScene(controller);
  if (!scene) {
    return;
  }
  const relativePath = scene.path;
  if (!relativePath) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(context.workspaceFolder.uri.fsPath, relativePath)));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function editSceneMetadata(controller: OutlineSceneController, node: unknown): Promise<void> {
  const scene = isSceneNode(node) ? await controller.getScene(node.id) : await pickScene(controller);
  if (!scene) {
    return;
  }
  const field = await vscode.window.showQuickPick(
    [
      { label: "标题", key: "title" },
      { label: "状态", key: "status" },
      { label: "章节绑定", key: "chapterRefs" },
      { label: "顺序", key: "order" },
      { label: "POV", key: "pov" },
      { label: "人物引用", key: "characterRefs" },
      { label: "地点引用", key: "locationRefs" },
      { label: "剧情线引用", key: "plotlineRefs" },
      { label: "冲突", key: "conflict" },
      { label: "转折", key: "turn" },
      { label: "结果", key: "outcome" }
    ] as const,
    { title: "编辑场景卡元数据" }
  );
  if (!field) {
    return;
  }
  if (field.key === "status") {
    const status = await vscode.window.showQuickPick(["idea", "outline", "draft", "revise", "done", "archived"], { title: "选择状态" });
    if (status) {
      await controller.updateSceneMetadata(scene.id, { status: status as SceneStatus });
    }
    return;
  }
  const value = await vscode.window.showInputBox({ title: field.label, value: currentSceneFieldValue(scene, field.key) });
  if (value === undefined) {
    return;
  }
  await controller.updateSceneMetadata(scene.id, scenePatch(field.key, value));
}

async function deleteSceneCard(controller: OutlineSceneController, node: unknown): Promise<void> {
  const scene = isSceneNode(node) ? node : await pickScene(controller);
  if (scene) {
    await controller.deleteSceneCard(scene.id);
  }
}

async function restoreTrashItem(controller: OutlineSceneController, node: unknown): Promise<void> {
  const id = isTrashNode(node) ? node.id : await pickTrashItem(controller);
  if (id) {
    await controller.restoreTrashItem(id);
  }
}

async function permanentlyDeleteTrashItem(controller: OutlineSceneController, node: unknown): Promise<void> {
  const id = isTrashNode(node) ? node.id : await pickTrashItem(controller);
  if (id) {
    await controller.permanentlyDeleteTrashItem(id);
  }
}

async function pickOutline(controller: OutlineSceneController): Promise<string | undefined> {
  const outlines = await controller.listOutlines();
  const picked = await vscode.window.showQuickPick(outlines.map((outline) => ({ label: outline.title, description: outline.path, path: outline.path })), { title: "选择要预览导入的规划草稿" });
  return picked?.path;
}

async function pickScene(controller: OutlineSceneController): Promise<SceneCardDto | undefined> {
  const scenes = await controller.listScenes();
  const picked = await vscode.window.showQuickPick(scenes.map((scene) => ({ label: scene.title, description: scene.path, scene })), { title: "选择场景卡" });
  return picked?.scene;
}

async function pickChapterRefsForScene(controller: OutlineSceneController): Promise<Array<{ chapterId: string; title: string }> | undefined> {
  const skeleton = await controller.getStructureSkeleton();
  const chapters = skeleton.volumes.flatMap((volume) =>
    volume.chapters.map((chapter) => ({
      label: chapter.title,
      description: volume.title,
      detail: chapter.id,
      chapterId: chapter.id,
      title: chapter.title
    }))
  );
  if (chapters.length === 0) {
    return [];
  }
  return vscode.window.showQuickPick(chapters, {
    title: "选择绑定章节",
    placeHolder: "可多选；不选则创建未绑定场景卡",
    canPickMany: true
  });
}

async function pickChapterForBinding(controller: OutlineSceneController): Promise<{ chapterId: string; title: string } | undefined> {
  const chapters = (await controller.getStructureSkeleton()).volumes.flatMap((volume) =>
    volume.chapters.map((chapter) => ({
      label: chapter.title,
      description: volume.title,
      detail: chapter.id,
      chapterId: chapter.id,
      title: chapter.title
    }))
  );
  const picked = await vscode.window.showQuickPick(chapters, { title: "选择章节" });
  return picked ? { chapterId: picked.chapterId, title: picked.title } : undefined;
}

async function pickVolumeForChapter(controller: OutlineSceneController): Promise<{ volumeId: string; title: string } | undefined> {
  const volumes = (await controller.getStructureSkeleton()).volumes.map((volume) => ({
    label: volume.title,
    description: `${volume.chapters.length} 章`,
    detail: volume.id,
    volumeId: volume.id,
    title: volume.title
  }));
  if (volumes.length === 0) {
    void vscode.window.showWarningMessage("当前没有可创建章节的卷。请先在手稿或大纲导入中创建卷。");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(volumes, { title: "选择新章节所属卷" });
  return picked ? { volumeId: picked.volumeId, title: picked.title } : undefined;
}

async function pickTrashItem(controller: OutlineSceneController): Promise<OutlineScenesTrashItemId | undefined> {
  const items = await controller.listTrashItems();
  const picked = await vscode.window.showQuickPick(items.map((item) => ({ label: item.title, description: item.originalPath, id: item.id })), { title: "选择垃圾桶项目" });
  return picked?.id;
}

async function handleWatchedFile(
  context: KernelContext,
  controller: OutlineSceneController,
  tree: OutlineScenesTreeProvider,
  uri: vscode.Uri,
  type: "outline" | "structure" | "metadata" | "content"
): Promise<void> {
  const relativePath = path.relative(context.workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  controller.notifyFileChanged(relativePath, type);
  void controller.refreshDiagnostics().then(() => refreshOutlineScenesTree(tree));
}

async function confirmDestructiveDelete(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, "永久删除");
  return choice === "永久删除";
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

function isOutlineNode(node: unknown): node is Extract<OutlineScenesTreeNode, { kind: "outline" }> {
  return isTreeNode(node, "outline");
}

function isSceneNode(node: unknown): node is Extract<OutlineScenesTreeNode, { kind: "scene" }> {
  return isTreeNode(node, "scene");
}

function isChapterNode(node: unknown): node is Extract<OutlineScenesTreeNode, { kind: "chapter" }> {
  return isTreeNode(node, "chapter");
}

function isTrashNode(node: unknown): node is Extract<OutlineScenesTreeNode, { kind: "trashItem" }> {
  return isTreeNode(node, "trashItem");
}

function isTreeNode<T extends OutlineScenesTreeNode["kind"]>(
  node: unknown,
  kind: T
): node is Extract<OutlineScenesTreeNode, { kind: T }> {
  return typeof node === "object" && node !== null && "kind" in node && node.kind === kind;
}

function currentSceneFieldValue(scene: SceneCardDto, key: string): string {
  const value = (scene as unknown as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
}

function scenePatch(key: string, value: string) {
  if (key === "order") {
    return { order: Number(value) };
  }
  if (key === "chapterRefs" || key === "characterRefs" || key === "locationRefs" || key === "plotlineRefs") {
    return { [key]: splitCommaList(value) };
  }
  return { [key]: value };
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function defaultOutlineName(scope: OutlineDraftScope): string {
  switch (scope) {
    case "book":
      return "main";
    case "volume":
      return "volume-outline";
    case "chapter":
      return "chapter-outline";
    case "scene":
      return "scene-outline";
  }
}

function outlineScopeLabel(scope: OutlineDraftScope): string {
  switch (scope) {
    case "book":
      return "书籍大纲";
    case "volume":
      return "卷大纲";
    case "chapter":
      return "章大纲";
    case "scene":
      return "场景大纲";
  }
}
