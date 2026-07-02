import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { registerExclusiveCommand } from "../../kernel/commandRegistry";
import { createDefaultManifest, validateProjectManifest } from "../../kernel/manifest";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import type { Capability, KernelContext, OperationPlan, ProjectManifest } from "../../kernel/types";
import { LOREDOCK_DIR, MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import {
  createInitialManuscriptManifest,
  readManuscriptManifest,
  readManuscriptManifestStructure,
  resolveExistingSafeManuscriptPath,
  stringifyManuscriptManifest
} from "./manifest";
import { bookAgentPath, bookSystemAgentPath, createBookAgentText, createBookSystemAgentText } from "./bookAgent";
import { ManuscriptController } from "./controller";
import { ManuscriptTreeProvider, type ManuscriptTreeNode } from "./tree";
import {
  LORE_DIR,
  STORY_BIBLE_CAPABILITY_ID,
  STORY_BIBLE_CHARACTER_DIR,
  STORY_BIBLE_LOCATION_DIR,
  STORY_BIBLE_RULE_DIR,
  STORY_BIBLE_TAG_DIR
} from "../storyBible/types";
import {
  MANUSCRIPT_CAPABILITY_ID,
  MANUSCRIPT_DIR,
  MANUSCRIPT_MANIFEST_PATH,
  MANUSCRIPT_NOTES_PATH,
  MANUSCRIPT_SCHEMA_ID,
  MANUSCRIPT_SCHEMA_VERSION,
  MANUSCRIPT_STATUSES,
  type ChapterId,
  type ManuscriptStatus,
  type VolumeId
} from "./types";

const VIEW_ID = "loredock.manuscript.tree";
const MANUSCRIPT_ACTIVE_CONTEXT = "loredock.manuscript.active";
const MANUSCRIPT_TRASH_MODE_CONTEXT = "loredock.manuscript.trashMode";
const sharedTreeWorkspaces = new Set<string>();
let sharedTreeProvider: ManuscriptTreeProvider | undefined;
let sharedTreeRegistration: vscode.Disposable | undefined;
let sharedRefreshCommandRegistration: vscode.Disposable | undefined;
let sharedToggleTrashCommandRegistration: vscode.Disposable | undefined;

export const manuscriptCapability: Capability = {
  id: MANUSCRIPT_CAPABILITY_ID,
  bootstrapCommands: ["loredock.enableManuscript", "loredock.manuscript.createBook", "loredock.manuscript.switchBook"],
  bootstrap(context) {
    const tree = getOrCreateTreeProvider();
    const projectWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, ".loredock/project.json")
    );
    const refresh = () => {
      void refreshManuscriptTree(tree);
    };

    void refreshManuscriptTree(tree);
    return [
      acquireSharedTreeRegistration(context, tree),
      context.registerCommand("loredock.enableManuscript", () => enableManuscript(context)),
      context.registerCommand("loredock.manuscript.createBook", () => createBookProject(context)),
      context.registerCommand("loredock.manuscript.switchBook", () => switchBookProject()),
      projectWatcher,
      projectWatcher.onDidCreate(refresh),
      projectWatcher.onDidChange(refresh),
      projectWatcher.onDidDelete(refresh)
    ];
  },
  activate(context) {
    const controller = new ManuscriptController({
      workspaceFolder: context.workspaceFolder,
      output: context.output,
      diagnostics: context.diagnostics,
      confirmOperationPlan: context.confirmOperationPlan,
      confirmDestructiveDelete,
      now: context.now
    });
    const tree = getOrCreateTreeProvider();
    const watcher = context.registerFileWatcher(new vscode.RelativePattern(context.workspaceFolder, "manuscript/**"));

    const disposables: vscode.Disposable[] = [
      controller,
      context.registerSchema({ id: MANUSCRIPT_SCHEMA_ID, version: MANUSCRIPT_SCHEMA_VERSION }),
      context.registerCapabilityService(MANUSCRIPT_CAPABILITY_ID, controller),
      controller.onDidChange(() => {
        void refreshManuscriptTree(tree);
      }),
      watcher,
      watcher.onDidCreate((uri) => handleWatchedFile(context, controller, tree, uri)),
      watcher.onDidChange((uri) => handleWatchedFile(context, controller, tree, uri)),
      watcher.onDidDelete((uri) => handleWatchedFile(context, controller, tree, uri)),
      context.registerCommand("loredock.manuscript.createBook", () => createBookProject(context)),
      context.registerCommand("loredock.manuscript.switchBook", () => switchBookProject()),
      context.registerCommand("loredock.manuscript.createVolume", () => createVolume(controller)),
      context.registerCommand("loredock.manuscript.createChapter", (node) => createChapter(controller, node)),
      context.registerCommand("loredock.manuscript.openChapter", (node) => openChapter(context, controller, node)),
      context.registerCommand("loredock.manuscript.renameBook", () => renameBook(context, controller)),
      context.registerCommand("loredock.manuscript.refreshBookAgentGuide", () => refreshBookAgentGuide(controller)),
      context.registerCommand("loredock.manuscript.renameVolume", (node) => renameVolume(controller, node)),
      context.registerCommand("loredock.manuscript.renameChapter", (node) => renameChapter(controller, node)),
      context.registerCommand("loredock.manuscript.moveChapter", (node) => moveChapter(controller, node)),
      context.registerCommand("loredock.manuscript.moveChapterUp", (node) => moveChapterRelative(controller, node, -1)),
      context.registerCommand("loredock.manuscript.moveChapterDown", (node) => moveChapterRelative(controller, node, 1)),
      context.registerCommand("loredock.manuscript.deleteVolume", (node) => deleteVolume(controller, node)),
      context.registerCommand("loredock.manuscript.deleteChapter", (node) => deleteChapter(controller, node)),
      context.registerCommand("loredock.manuscript.restoreTrashItem", (node) => restoreTrashItem(controller, node)),
      context.registerCommand("loredock.manuscript.permanentlyDeleteTrashItem", (node) =>
        permanentlyDeleteTrashItem(controller, node)
      ),
      context.registerCommand("loredock.manuscript.setChapterStatus", (node) => setChapterStatus(controller, node)),
      context.registerCommand("loredock.manuscript.setChapterTargetWordCount", (node) =>
        setChapterTargetWordCount(controller, node)
      ),
      context.registerCommand("loredock.manuscript.openNotes", () => openNotes(context)),
      context.registerCommand("loredock.manuscript.showStats", () => showStats(controller))
    ];

    void syncBookAgentGuidesOnStartup(context, controller, tree);
    return disposables;
  }
};

function getOrCreateTreeProvider(): ManuscriptTreeProvider {
  if (!sharedTreeProvider) {
    sharedTreeProvider = new ManuscriptTreeProvider();
  }

  return sharedTreeProvider;
}

function acquireSharedTreeRegistration(context: KernelContext, tree: ManuscriptTreeProvider): vscode.Disposable {
  const key = context.workspaceFolder.uri.fsPath;
  sharedTreeWorkspaces.add(key);

  if (!sharedTreeRegistration) {
    sharedTreeRegistration = vscode.window.registerTreeDataProvider(VIEW_ID, tree);
  }

  if (!sharedRefreshCommandRegistration) {
    sharedRefreshCommandRegistration = registerExclusiveCommand("loredock.manuscript.refreshTree", () =>
      refreshManuscriptTree(tree)
    );
  }

  if (!sharedToggleTrashCommandRegistration) {
    sharedToggleTrashCommandRegistration = registerExclusiveCommand("loredock.manuscript.toggleTrash", async () => {
      tree.toggleTrashMode();
      await refreshManuscriptTree(tree);
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

async function refreshManuscriptTree(tree: ManuscriptTreeProvider): Promise<void> {
  await updateManuscriptContext();
  await vscode.commands.executeCommand("setContext", MANUSCRIPT_TRASH_MODE_CONTEXT, tree.isTrashMode);
  tree.refresh();
}

async function syncBookAgentGuidesOnStartup(
  context: KernelContext,
  controller: ManuscriptController,
  tree: ManuscriptTreeProvider
): Promise<void> {
  try {
    const titleSynced = await controller.syncBookTitleWithWorkspaceFolder();
    if (titleSynced) {
      context.output.appendLine("已同步书名为当前文件夹名。");
    }
    const result = await controller.syncBookAgentGuides();
    const changedCount = result.filesCreated.length + result.filesModified.length;
    if (changedCount > 0) {
      context.output.appendLine(
        `已同步 ${changedCount} 个书籍 AI 指南系统规则，用户自定义规则已保留。`
      );
    }
    if (result.filesSkipped.length > 0) {
      context.output.appendLine(
        `跳过 ${result.filesSkipped.length} 个无法安全同步的书籍 AI 指南：${result.filesSkipped.join(", ")}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.output.appendLine(`同步书籍 AI 指南失败：${message}`);
  }

  await controller.refreshDiagnostics();
  await refreshManuscriptTree(tree);
}

async function updateManuscriptContext(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeStates = await Promise.all(
    folders.map((folder) =>
      readManuscriptManifestStructure(folder.uri.fsPath)
        .then((result) => result.status === "valid")
        .catch(() => false)
    )
  );
  await vscode.commands.executeCommand("setContext", MANUSCRIPT_ACTIVE_CONTEXT, activeStates.some(Boolean));
}

async function enableManuscript(context: KernelContext): Promise<void> {
  const workspaceRoot = context.workspaceFolder.uri.fsPath;
  const projectManifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
  const readProject = await readJsonFile(projectManifestPath);

  if (readProject.status === "missing") {
    context.output.appendLine("尚未运行 loredock.initProject，无法启用手稿。");
    void vscode.window.showWarningMessage("请先运行 LoreDock：初始化项目，再启用手稿。");
    return;
  }

  if (readProject.status === "unsafe") {
    context.output.appendLine("项目清单路径不安全，无法启用手稿。");
    void vscode.window.showWarningMessage("项目清单路径不安全，请先修复工作区文件结构。");
    return;
  }

  if (readProject.status === "invalidJson") {
    context.output.appendLine("项目清单不是有效 JSON，无法启用手稿。");
    void vscode.window.showWarningMessage("项目清单不是有效 JSON，请先修复 LoreDock 项目清单。");
    return;
  }

  const validation = validateProjectManifest(readProject.value, workspaceRoot, new Set([MANUSCRIPT_CAPABILITY_ID]));
  for (const diagnostic of validation.diagnostics) {
    context.diagnostics.add(diagnostic);
  }

  if (!validation.isValid || !validation.manifest) {
    context.output.appendLine("项目清单处于异常状态，无法启用手稿。");
    void vscode.window.showWarningMessage("项目清单处于异常状态，请先修复后再启用手稿。");
    return;
  }

  if (validation.manifest.capabilities.includes(MANUSCRIPT_CAPABILITY_ID)) {
    context.output.appendLine("手稿已经启用。");
    await context.refreshWorkspaceFolder();
    return;
  }

  const manuscriptResult = await readManuscriptManifest(workspaceRoot);
  if (manuscriptResult.status !== "missing" && manuscriptResult.status !== "valid") {
    for (const diagnostic of manuscriptResult.diagnostics) {
      context.diagnostics.add(diagnostic);
    }
    context.output.appendLine("现有手稿清单处于异常状态，无法启用手稿。");
    void vscode.window.showWarningMessage("现有手稿文件需要修复后才能启用。");
    return;
  }

  const nextProjectManifest: ProjectManifest = {
    ...validation.manifest,
    updatedAt: context.now().toISOString(),
    capabilities: [...validation.manifest.capabilities, MANUSCRIPT_CAPABILITY_ID]
  };

  const firstEnable = manuscriptResult.status === "missing";
  const initialManifest = createInitialManuscriptManifest(context.now(), path.basename(workspaceRoot));
  const firstBook = initialManifest.book;
  const firstVolume = initialManifest.volumes[initialManifest.volumeIds[0]];
  const firstChapter = initialManifest.chapters[firstVolume.chapterIds[0]];
  const firstBookAgentPath = bookAgentPath();
  const firstBookSystemAgentPath = bookSystemAgentPath();
  const plan: OperationPlan = {
    summary: firstEnable ? "启用手稿并创建初始手稿结构。" : "启用现有手稿。",
    directoriesToCreate: firstEnable ? [MANUSCRIPT_DIR, firstVolume.path] : [],
    filesToCreate: firstEnable
      ? [MANUSCRIPT_MANIFEST_PATH, MANUSCRIPT_NOTES_PATH, firstBookSystemAgentPath, firstBookAgentPath, firstChapter.path]
      : [],
    filesToModify: [MANIFEST_RELATIVE_PATH]
  };

  if (firstEnable) {
    const existingPaths = await findExistingRelativePaths(workspaceRoot, plan.filesToCreate);
    if (existingPaths.length > 0) {
      context.output.appendLine(`手稿初始文件已存在，无法启用：${existingPaths.join(", ")}`);
      void vscode.window.showWarningMessage("手稿初始文件已存在，请先移动或修复后再启用。");
      return;
    }
  }

  const confirmed = await context.confirmOperationPlan(plan);
  if (!confirmed) {
    context.output.appendLine("已取消启用手稿，未写入文件。");
    await refreshManuscriptTree(getOrCreateTreeProvider());
    return;
  }

  const writer = new SafeFileWriter(workspaceRoot, plan);
  if (firstEnable) {
    await writer.ensureDirectory(MANUSCRIPT_DIR);
    await writer.ensureDirectory(firstVolume.path);
    await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(initialManifest));
    await writer.writeFile(MANUSCRIPT_NOTES_PATH, "# 笔记\n\n");
    await writer.writeFile(firstBookSystemAgentPath, createBookSystemAgentText(firstBook.title));
    await writer.writeFile(firstBookAgentPath, createBookAgentText(firstBook.title));
    await writer.writeFile(firstChapter.path, "# 第一章\n\n");
  }

  try {
    await writer.writeFile(MANIFEST_RELATIVE_PATH, `${JSON.stringify(nextProjectManifest, null, 2)}\n`);
  } catch (error) {
    context.diagnostics.add({
      severity: "error",
      code: "manuscript.enable.partial",
      message: "手稿文件已创建，但项目清单未能更新。请再次运行启用手稿以恢复。",
      workspaceFolder: workspaceRoot,
      relativePath: MANUSCRIPT_MANIFEST_PATH
    });
    throw error;
  }

  await context.refreshWorkspaceFolder();
  await refreshManuscriptTree(getOrCreateTreeProvider());
  void vscode.window.showInformationMessage("手稿已启用。");
}

async function createBookProject(context: KernelContext): Promise<void> {
  const folderUris = await vscode.window.showOpenDialog({
    title: "选择或创建书籍文件夹",
    openLabel: "作为新书打开",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  const folderUri = folderUris?.[0];
  if (!folderUri) {
    return;
  }

  if (await initializeBookProject(context, folderUri, path.basename(folderUri.fsPath))) {
    await vscode.commands.executeCommand("vscode.openFolder", folderUri, false);
  }
}

async function switchBookProject(): Promise<void> {
  const folderUris = await vscode.window.showOpenDialog({
    title: "选择书籍文件夹",
    openLabel: "打开书籍",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  const folderUri = folderUris?.[0];
  if (!folderUri) {
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", folderUri, false);
}

async function initializeBookProject(context: KernelContext, folderUri: vscode.Uri, title: string): Promise<boolean> {
  const workspaceRoot = folderUri.fsPath;
  const cleanTitle = title.trim() || "新书";
  const initialManifest = createInitialManuscriptManifest(context.now(), cleanTitle);
  const firstVolume = initialManifest.volumes[initialManifest.volumeIds[0]];
  const firstChapter = initialManifest.chapters[firstVolume.chapterIds[0]];
  const projectManifest: ProjectManifest = {
    ...createDefaultManifest(workspaceRoot, context.now()),
    title: cleanTitle,
    capabilities: [MANUSCRIPT_CAPABILITY_ID, STORY_BIBLE_CAPABILITY_ID]
  };
  const systemAgentPath = bookSystemAgentPath();
  const userAgentPath = bookAgentPath();
  const plan: OperationPlan = {
    summary: `新建书籍项目“${cleanTitle}”。`,
    directoriesToCreate: [
      LOREDOCK_DIR,
      MANUSCRIPT_DIR,
      firstVolume.path,
      LORE_DIR,
      STORY_BIBLE_CHARACTER_DIR,
      STORY_BIBLE_LOCATION_DIR,
      STORY_BIBLE_RULE_DIR,
      STORY_BIBLE_TAG_DIR
    ],
    filesToCreate: [
      MANIFEST_RELATIVE_PATH,
      MANUSCRIPT_MANIFEST_PATH,
      MANUSCRIPT_NOTES_PATH,
      systemAgentPath,
      userAgentPath,
      firstChapter.path
    ],
    filesToModify: []
  };
  const existingPaths = await findExistingRelativePaths(workspaceRoot, [
    ...plan.filesToCreate,
    MANUSCRIPT_DIR,
    LORE_DIR
  ]);

  if (existingPaths.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `目标文件夹已包含 LoreDock 或书籍文件：${existingPaths.join(", ")}`,
      { modal: true },
      "打开该文件夹"
    );
    if (choice === "打开该文件夹") {
      await vscode.commands.executeCommand("vscode.openFolder", folderUri, false);
    }
    return false;
  }

  const confirmed = await context.confirmOperationPlan(plan);
  if (!confirmed) {
    context.output.appendLine("已取消新建书籍项目，未写入文件。");
    return false;
  }

  const writer = new SafeFileWriter(workspaceRoot, plan);
  for (const directory of plan.directoriesToCreate) {
    await writer.ensureDirectory(directory);
  }
  await writer.writeFile(MANIFEST_RELATIVE_PATH, `${JSON.stringify(projectManifest, null, 2)}\n`);
  await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(initialManifest));
  await writer.writeFile(MANUSCRIPT_NOTES_PATH, "# 笔记\n\n");
  await writer.writeFile(systemAgentPath, createBookSystemAgentText(cleanTitle));
  await writer.writeFile(userAgentPath, createBookAgentText(cleanTitle));
  await writer.writeFile(firstChapter.path, "# 第一章\n\n");
  return true;
}

async function createVolume(controller: ManuscriptController): Promise<void> {
  const title = await vscode.window.showInputBox({ title: "新建卷", value: "新卷" });
  if (title === undefined) {
    return;
  }
  await controller.createVolume(title);
}

async function createChapter(controller: ManuscriptController, node: unknown): Promise<void> {
  const volumeId = isVolumeNode(node) ? node.id : await pickVolume(controller);
  if (!volumeId) {
    return;
  }
  const title = await vscode.window.showInputBox({ title: "新建章节", value: "新章节" });
  if (title === undefined) {
    return;
  }
  await controller.createChapter(volumeId, title);
}

async function openChapter(
  context: KernelContext,
  controller: ManuscriptController,
  node: unknown
): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  if (!chapterId) {
    return;
  }

  const relativePath = await controller.resolveChapterPath(chapterId);
  if (!relativePath) {
    void vscode.window.showWarningMessage("章节文件缺失或路径不安全。");
    return;
  }

  await openRelativeFile(context.workspaceFolder, relativePath);
}

async function renameBook(context: KernelContext, controller: ManuscriptController): Promise<void> {
  const workspaceRoot = context.workspaceFolder.uri.fsPath;
  const currentFolderName = path.basename(workspaceRoot);
  const title = await vscode.window.showInputBox({
    title: "重命名书籍",
    value: currentFolderName,
    prompt: "书名会与外层文件夹名保持一致。"
  });
  if (title === undefined) {
    return;
  }

  let folderName: string;
  try {
    folderName = normalizeBookFolderName(title);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(message);
    return;
  }
  const targetRoot = path.join(path.dirname(workspaceRoot), folderName);
  if (path.resolve(targetRoot) === path.resolve(workspaceRoot)) {
    await controller.renameBook(folderName);
    return;
  }

  if (await pathExists(targetRoot)) {
    void vscode.window.showWarningMessage(`目标文件夹已存在：${targetRoot}`);
    return;
  }

  const oldBook = await controller.getBook();
  await controller.renameBook(folderName);
  try {
    await fs.rename(workspaceRoot, targetRoot);
  } catch (error) {
    await controller.renameBook(oldBook.title).catch(() => undefined);
    throw error;
  }

  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetRoot), false);
}

async function refreshBookAgentGuide(controller: ManuscriptController): Promise<void> {
  await controller.refreshBookAgentGuide();
}

async function renameVolume(controller: ManuscriptController, node: unknown): Promise<void> {
  const volumeId = isVolumeNode(node) ? node.id : await pickVolume(controller);
  if (!volumeId) {
    return;
  }
  const title = await vscode.window.showInputBox({ title: "重命名卷" });
  if (title !== undefined) {
    await controller.renameVolume(volumeId, title);
  }
}

async function renameChapter(controller: ManuscriptController, node: unknown): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  if (!chapterId) {
    return;
  }
  const title = await vscode.window.showInputBox({ title: "重命名章节" });
  if (title !== undefined) {
    await controller.renameChapter(chapterId, title);
  }
}

async function deleteVolume(controller: ManuscriptController, node: unknown): Promise<void> {
  const volumeId = isVolumeNode(node) ? node.id : await pickVolume(controller);
  if (!volumeId) {
    return;
  }
  await controller.deleteVolume(volumeId);
}

async function moveChapter(controller: ManuscriptController, node: unknown): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  const targetVolumeId = await pickVolume(controller);
  if (!chapterId || !targetVolumeId) {
    return;
  }
  await controller.moveChapter(chapterId, targetVolumeId);
}

async function deleteChapter(controller: ManuscriptController, node: unknown): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  if (!chapterId) {
    return;
  }
  await controller.deleteChapter(chapterId);
}

async function permanentlyDeleteTrashItem(controller: ManuscriptController, node: unknown): Promise<void> {
  const trashItemId = isTrashItemNode(node) ? node.id : await pickTrashItem(controller);
  if (!trashItemId) {
    return;
  }
  await controller.permanentlyDeleteTrashItem(trashItemId);
}

async function restoreTrashItem(controller: ManuscriptController, node: unknown): Promise<void> {
  const trashItemId = isTrashItemNode(node) ? node.id : await pickTrashItem(controller);
  if (!trashItemId) {
    return;
  }
  await controller.restoreTrashItem(trashItemId);
}

async function moveChapterRelative(controller: ManuscriptController, node: unknown, delta: number): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  if (!chapterId) {
    return;
  }

  const chapter = await controller.getChapter(chapterId);
  if (!chapter) {
    return;
  }

  const siblings = await controller.listChapters(chapter.volumeId);
  const currentIndex = siblings.findIndex((item) => item.id === chapterId);
  const targetIndex = currentIndex + delta;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= siblings.length) {
    return;
  }

  await controller.moveChapter(chapterId, chapter.volumeId, targetIndex);
}

async function setChapterStatus(controller: ManuscriptController, node: unknown): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  if (!chapterId) {
    return;
  }

  const picked = await vscode.window.showQuickPick(
    MANUSCRIPT_STATUSES.map((status) => ({ label: formatStatus(status), description: status, status })),
    { title: "章节状态" }
  );
  if (picked) {
    await controller.setChapterStatus(chapterId, picked.status);
  }
}

async function setChapterTargetWordCount(controller: ManuscriptController, node: unknown): Promise<void> {
  const chapterId = isChapterNode(node) ? node.id : await pickChapter(controller);
  if (!chapterId) {
    return;
  }

  const value = await vscode.window.showInputBox({
    title: "章节目标字数",
    placeHolder: "输入正整数；留空则清除"
  });
  if (value === undefined) {
    return;
  }

  await controller.setChapterTargetWordCount(chapterId, value.trim() === "" ? undefined : Number(value));
}

async function openNotes(context: KernelContext): Promise<void> {
  await openRelativeFile(context.workspaceFolder, MANUSCRIPT_NOTES_PATH);
}

async function showStats(controller: ManuscriptController): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content: await controller.buildStatisticsReport(),
    language: "markdown"
  });
  await vscode.window.showTextDocument(document);
}

async function confirmDestructiveDelete(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, "确认删除");
  return choice === "确认删除";
}

async function pickVolume(controller: ManuscriptController): Promise<VolumeId | undefined> {
  const volumes = await controller.listVolumes();
  const picked = await vscode.window.showQuickPick(
    volumes.map((volume) => ({ label: volume.title, description: volume.path, id: volume.id })),
    { title: "选择卷" }
  );
  return picked?.id;
}

async function pickChapter(controller: ManuscriptController): Promise<ChapterId | undefined> {
  const chapters = await controller.listChapters();
  const picked = await vscode.window.showQuickPick(
    chapters.map((chapter) => ({ label: chapter.title, description: chapter.path, id: chapter.id })),
    { title: "选择章节" }
  );
  return picked?.id;
}

async function pickTrashItem(controller: ManuscriptController) {
  const items = await controller.listTrashItems();
  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: item.title,
      description: formatTrashKind(item.kind),
      detail: item.originalPath,
      id: item.id
    })),
    { title: "选择回收站项目" }
  );
  return picked?.id;
}

function handleWatchedFile(
  context: KernelContext,
  controller: ManuscriptController,
  tree: ManuscriptTreeProvider,
  uri: vscode.Uri
): void {
  const relativePath = path.relative(context.workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  controller.notifyFileChanged(relativePath);
  void controller.refreshDiagnostics().then(() => refreshManuscriptTree(tree));
  context.output.appendLine(`手稿文件已变化：${relativePath}`);
}

async function openRelativeFile(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): Promise<void> {
  const absolutePath = await resolveExistingSafeManuscriptPath(workspaceFolder.uri.fsPath, relativePath);
  if (!absolutePath) {
    void vscode.window.showWarningMessage("手稿文件缺失或路径不安全。");
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showTextDocument(document);
}

async function readJsonFile(filePath: string): Promise<
  | { status: "missing" }
  | { status: "unsafe" }
  | { status: "invalidJson"; text: string }
  | { status: "parsed"; text: string; value: unknown }
> {
  const workspaceRoot = path.dirname(path.dirname(filePath));
  const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, relativePath);
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
    } catch {
      return { status: "invalidJson", text };
    }
  } catch (error) {
    if (isNotFound(error)) {
      return { status: "missing" };
    }
    throw error;
  }
}

async function findExistingRelativePaths(workspaceRoot: string, relativePaths: string[]): Promise<string[]> {
  const existing: string[] = [];

  for (const relativePath of relativePaths) {
    try {
      await fs.lstat(path.join(workspaceRoot, relativePath));
      existing.push(relativePath);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  return existing;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function normalizeBookFolderName(value: string): string {
  const clean = value.trim();
  if (
    clean === "" ||
    clean === "." ||
    clean === ".." ||
    clean.includes("/") ||
    clean.includes("\\") ||
    clean.includes("\0")
  ) {
    throw new Error("书名必须是可用的文件夹名，不能包含路径分隔符。");
  }
  return clean;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isVolumeNode(node: unknown): node is Extract<ManuscriptTreeNode, { kind: "volume" }> {
  return isTreeNode(node, "volume");
}

function isChapterNode(node: unknown): node is Extract<ManuscriptTreeNode, { kind: "chapter" }> {
  return isTreeNode(node, "chapter");
}

function isTrashItemNode(node: unknown): node is Extract<ManuscriptTreeNode, { kind: "trashItem" }> {
  return isTreeNode(node, "trashItem");
}

function isTreeNode<T extends ManuscriptTreeNode["kind"]>(
  node: unknown,
  kind: T
): node is Extract<ManuscriptTreeNode, { kind: T }> {
  return typeof node === "object" && node !== null && "kind" in node && node.kind === kind;
}

function formatStatus(status: ManuscriptStatus): string {
  switch (status) {
    case "idea":
      return "构思";
    case "outline":
      return "大纲";
    case "draft":
      return "草稿";
    case "revise":
      return "修订";
    case "done":
      return "完成";
    case "archived":
      return "归档";
  }
}

function formatTrashKind(kind: "volume" | "chapter"): string {
  switch (kind) {
    case "volume":
      return "卷";
    case "chapter":
      return "章节";
  }
}
