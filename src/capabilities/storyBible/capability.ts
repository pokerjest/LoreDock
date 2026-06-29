import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { validateProjectManifest } from "../../kernel/manifest";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import type { Capability, KernelContext, OperationPlan, ProjectManifest } from "../../kernel/types";
import { MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import { MANUSCRIPT_CAPABILITY_ID, type ManuscriptService } from "../manuscript/types";
import { StoryBibleController } from "./controller";
import {
  isStoryBibleCapabilityEnabled,
  readStoryBible,
  resolveExistingSafeStoryBiblePath
} from "./files";
import { openStoryBibleGallery } from "./galleryWebview";
import { StoryBibleTreeProvider, type StoryBibleTreeNode } from "./tree";
import {
  LORE_DIR,
  STORY_BIBLE_CAPABILITY_ID,
  STORY_BIBLE_CARD_SCHEMA_ID,
  STORY_BIBLE_CARD_TYPES,
  STORY_BIBLE_CHARACTER_DIR,
  STORY_BIBLE_LOCATION_DIR,
  STORY_BIBLE_RULE_DIR,
  STORY_BIBLE_SCHEMA_VERSION,
  STORY_BIBLE_TAG_DIR,
  STORY_BIBLE_TAG_SCHEMA_ID,
  STORY_BIBLE_STATUSES,
  STORY_BIBLE_VISIBILITIES,
  type StoryBibleCardId,
  type StoryBibleCardType,
  type StoryBibleStatus,
  type StoryBibleTrashItemId,
  type StoryBibleVisibility
} from "./types";

const VIEW_ID = "loredock.storyBible.tree";
const STORY_BIBLE_ACTIVE_CONTEXT = "loredock.storyBible.active";
const STORY_BIBLE_TRASH_MODE_CONTEXT = "loredock.storyBible.trashMode";

const sharedTreeWorkspaces = new Set<string>();
let sharedTreeProvider: StoryBibleTreeProvider | undefined;
let sharedTreeRegistration: vscode.Disposable | undefined;
let sharedRefreshCommandRegistration: vscode.Disposable | undefined;
let sharedToggleTrashCommandRegistration: vscode.Disposable | undefined;

export const storyBibleCapability: Capability = {
  id: STORY_BIBLE_CAPABILITY_ID,
  bootstrapCommands: ["loredock.enableStoryBible"],
  bootstrap(context) {
    const tree = getOrCreateTreeProvider();
    const projectWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, ".loredock/project.json")
    );
    const refresh = () => {
      void refreshStoryBibleTree(tree);
    };

    void refreshStoryBibleTree(tree);
    return [
      acquireSharedTreeRegistration(context, tree),
      context.registerCommand("loredock.enableStoryBible", () => enableStoryBible(context)),
      projectWatcher,
      projectWatcher.onDidCreate(refresh),
      projectWatcher.onDidChange(refresh),
      projectWatcher.onDidDelete(refresh)
    ];
  },
  activate(context) {
    const controller = new StoryBibleController({
      workspaceFolder: context.workspaceFolder,
      output: context.output,
      diagnostics: context.diagnostics,
      confirmOperationPlan: context.confirmOperationPlan,
      confirmDestructiveDelete,
      getManuscriptReader: () => context.getCapabilityService<ManuscriptService>(MANUSCRIPT_CAPABILITY_ID)?.reader,
      now: context.now
    });
    const tree = getOrCreateTreeProvider();
    const loreWatcher = context.registerFileWatcher(new vscode.RelativePattern(context.workspaceFolder, "lore/**"));
    const trashWatcher = context.registerFileWatcher(
      new vscode.RelativePattern(context.workspaceFolder, ".loredock/trash/resources/story-bible/**")
    );

    const disposables: vscode.Disposable[] = [
      controller,
      context.registerSchema({ id: STORY_BIBLE_CARD_SCHEMA_ID, version: STORY_BIBLE_SCHEMA_VERSION }),
      context.registerSchema({ id: STORY_BIBLE_TAG_SCHEMA_ID, version: STORY_BIBLE_SCHEMA_VERSION }),
      context.registerCapabilityService(STORY_BIBLE_CAPABILITY_ID, controller),
      controller.onDidChange(() => {
        void refreshStoryBibleTree(tree);
      }),
      loreWatcher,
      trashWatcher,
      loreWatcher.onDidCreate((uri) => handleWatchedFile(context, controller, tree, uri)),
      loreWatcher.onDidChange((uri) => handleWatchedFile(context, controller, tree, uri)),
      loreWatcher.onDidDelete((uri) => handleWatchedFile(context, controller, tree, uri)),
      trashWatcher.onDidCreate((uri) => handleWatchedFile(context, controller, tree, uri)),
      trashWatcher.onDidChange((uri) => handleWatchedFile(context, controller, tree, uri)),
      trashWatcher.onDidDelete((uri) => handleWatchedFile(context, controller, tree, uri)),
      context.registerCommand("loredock.storyBible.createCard", () => createCard(controller)),
      context.registerCommand("loredock.storyBible.createCharacter", () => createCard(controller, "character")),
      context.registerCommand("loredock.storyBible.createLocation", () => createCard(controller, "location")),
      context.registerCommand("loredock.storyBible.createRule", () => createCard(controller, "rule")),
      context.registerCommand("loredock.storyBible.openGallery", () => openStoryBibleGallery(context, controller)),
      context.registerCommand("loredock.storyBible.openCard", (node) => openCard(context, controller, node)),
      context.registerCommand("loredock.storyBible.renameCard", (node) => renameCard(controller, node)),
      context.registerCommand("loredock.storyBible.editCardMetadata", (node) => editCardMetadata(controller, node)),
      context.registerCommand("loredock.storyBible.deleteCard", (node) => deleteCard(controller, node)),
      context.registerCommand("loredock.storyBible.searchCards", () => searchCards(context, controller)),
      context.registerCommand("loredock.storyBible.createCardFromSelection", () => createCardFromSelection(controller)),
      context.registerCommand("loredock.storyBible.browseKeywords", () => browseKeywords(controller)),
      context.registerCommand("loredock.storyBible.defineKeyword", () => defineKeyword(controller)),
      context.registerCommand("loredock.storyBible.openKeywordDefinition", (node) =>
        openKeywordDefinition(context, controller, node)
      ),
      context.registerCommand("loredock.storyBible.editKeywordDefinition", (node) =>
        editKeywordDefinition(controller, node)
      ),
      context.registerCommand("loredock.storyBible.deleteKeywordDefinition", (node) =>
        deleteKeywordDefinition(controller, node)
      ),
      context.registerCommand("loredock.storyBible.restoreTrashItem", (node) => restoreTrashItem(controller, node)),
      context.registerCommand("loredock.storyBible.permanentlyDeleteTrashItem", (node) =>
        permanentlyDeleteTrashItem(controller, node)
      )
    ];

    void controller.refreshDiagnostics().then(() => refreshStoryBibleTree(tree));
    return disposables;
  }
};

function getOrCreateTreeProvider(): StoryBibleTreeProvider {
  if (!sharedTreeProvider) {
    sharedTreeProvider = new StoryBibleTreeProvider();
  }
  return sharedTreeProvider;
}

function acquireSharedTreeRegistration(context: KernelContext, tree: StoryBibleTreeProvider): vscode.Disposable {
  const key = context.workspaceFolder.uri.fsPath;
  sharedTreeWorkspaces.add(key);

  if (!sharedTreeRegistration) {
    sharedTreeRegistration = vscode.window.registerTreeDataProvider(VIEW_ID, tree);
  }
  if (!sharedRefreshCommandRegistration) {
    sharedRefreshCommandRegistration = vscode.commands.registerCommand("loredock.storyBible.refreshTree", () =>
      refreshStoryBibleTree(tree)
    );
  }
  if (!sharedToggleTrashCommandRegistration) {
    sharedToggleTrashCommandRegistration = vscode.commands.registerCommand("loredock.storyBible.toggleTrash", async () => {
      tree.toggleTrashMode();
      await refreshStoryBibleTree(tree);
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

async function refreshStoryBibleTree(tree: StoryBibleTreeProvider): Promise<void> {
  await updateStoryBibleContext();
  await vscode.commands.executeCommand("setContext", STORY_BIBLE_TRASH_MODE_CONTEXT, tree.isTrashMode);
  tree.refresh();
}

async function updateStoryBibleContext(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeStates = await Promise.all(
    folders.map((folder) =>
      isStoryBibleCapabilityEnabled(folder.uri.fsPath)
        .catch(() => false)
    )
  );
  await vscode.commands.executeCommand("setContext", STORY_BIBLE_ACTIVE_CONTEXT, activeStates.some(Boolean));
}

async function enableStoryBible(context: KernelContext): Promise<void> {
  const workspaceRoot = context.workspaceFolder.uri.fsPath;
  const projectManifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
  const readProject = await readJsonFile(projectManifestPath);

  if (readProject.status === "missing") {
    context.output.appendLine("尚未运行 loredock.initProject，无法启用 Story Bible。");
    void vscode.window.showWarningMessage("请先运行 LoreDock：初始化项目，再启用 Story Bible。");
    return;
  }
  if (readProject.status === "unsafe") {
    context.output.appendLine("项目清单路径不安全，无法启用 Story Bible。");
    void vscode.window.showWarningMessage("项目清单路径不安全，请先修复工作区文件结构。");
    return;
  }
  if (readProject.status === "invalidJson") {
    context.output.appendLine("项目清单不是有效 JSON，无法启用 Story Bible。");
    void vscode.window.showWarningMessage("项目清单不是有效 JSON，请先修复 LoreDock 项目清单。");
    return;
  }

  const validation = validateProjectManifest(
    readProject.value,
    workspaceRoot,
    new Set([STORY_BIBLE_CAPABILITY_ID, MANUSCRIPT_CAPABILITY_ID])
  );
  for (const item of validation.diagnostics) {
    context.diagnostics.add(item);
  }
  if (!validation.isValid || !validation.manifest) {
    context.output.appendLine("项目清单处于异常状态，无法启用 Story Bible。");
    void vscode.window.showWarningMessage("项目清单处于异常状态，请先修复后再启用 Story Bible。");
    return;
  }

  if (validation.manifest.capabilities.includes(STORY_BIBLE_CAPABILITY_ID)) {
    context.output.appendLine("Story Bible 已经启用。");
    await context.refreshWorkspaceFolder();
    await refreshStoryBibleTree(getOrCreateTreeProvider());
    return;
  }

  const existing = await readStoryBible(workspaceRoot);
  const blockingErrors = existing.diagnostics.filter(
    (item) => item.severity === "error" && item.code !== "storyBible.directory.missing"
  );
  if (existing.status !== "missing" && blockingErrors.length > 0) {
    for (const item of existing.diagnostics) {
      context.diagnostics.add(item);
    }
    context.output.appendLine("现有 Story Bible 文件处于异常状态，无法启用 Story Bible。");
    void vscode.window.showWarningMessage("现有 Story Bible 文件需要修复后才能启用。");
    return;
  }

  const nextProjectManifest: ProjectManifest = {
    ...validation.manifest,
    updatedAt: context.now().toISOString(),
    capabilities: [...validation.manifest.capabilities, STORY_BIBLE_CAPABILITY_ID]
  };
  const directories = [
    LORE_DIR,
    STORY_BIBLE_CHARACTER_DIR,
    STORY_BIBLE_LOCATION_DIR,
    STORY_BIBLE_RULE_DIR,
    STORY_BIBLE_TAG_DIR
  ];
  const plan: OperationPlan = {
    summary: existing.status === "missing" ? "启用 Story Bible 并创建 lore/ 结构。" : "启用现有 Story Bible。",
    directoriesToCreate: directories,
    filesToCreate: [],
    filesToModify: [MANIFEST_RELATIVE_PATH]
  };

  const confirmed = await context.confirmOperationPlan(plan);
  if (!confirmed) {
    context.output.appendLine("已取消启用 Story Bible，未写入文件。");
    await refreshStoryBibleTree(getOrCreateTreeProvider());
    return;
  }

  const writer = new SafeFileWriter(workspaceRoot, plan);
  for (const directory of directories) {
    await writer.ensureDirectory(directory);
  }

  try {
    await writer.writeFile(MANIFEST_RELATIVE_PATH, `${JSON.stringify(nextProjectManifest, null, 2)}\n`);
  } catch (error) {
    context.diagnostics.add({
      severity: "error",
      code: "storyBible.enable.partial",
      message: "Story Bible 目录结构已创建，但项目清单未能更新。请再次运行启用 Story Bible 以恢复。",
      workspaceFolder: workspaceRoot,
      relativePath: LORE_DIR
    });
    throw error;
  }

  await context.refreshWorkspaceFolder();
  await refreshStoryBibleTree(getOrCreateTreeProvider());
  void vscode.window.showInformationMessage("Story Bible 已启用。");
}

async function createCard(controller: StoryBibleController, type?: StoryBibleCardType): Promise<void> {
  const pickedType = type ?? (await pickCardType());
  if (!pickedType) {
    return;
  }
  const name = await vscode.window.showInputBox({ title: `新建${formatCardType(pickedType)}`, value: `新${formatCardType(pickedType)}` });
  if (name === undefined) {
    return;
  }
  await controller.createCard(pickedType, name);
}

async function createCardFromSelection(controller: StoryBibleController): Promise<void> {
  const pickedType = await pickCardType();
  if (!pickedType) {
    return;
  }
  const selectedText = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection).trim() ?? "";
  const name = await vscode.window.showInputBox({
    title: `从选中文本创建${formatCardType(pickedType)}`,
    value: selectedText
  });
  if (name === undefined) {
    return;
  }
  await controller.createCard(pickedType, name);
}

async function openCard(context: KernelContext, controller: StoryBibleController, node: unknown): Promise<void> {
  const cardId = isCardNode(node) ? node.id : await pickCard(controller);
  if (!cardId) {
    return;
  }
  openStoryBibleGallery(context, controller, cardId);
}

async function renameCard(controller: StoryBibleController, node: unknown): Promise<void> {
  const cardId = isCardNode(node) ? node.id : await pickCard(controller);
  if (!cardId) {
    return;
  }
  const current = await controller.getCard(cardId);
  const name = await vscode.window.showInputBox({ title: "重命名 Card", value: current?.name });
  if (name !== undefined) {
    await controller.renameCard(cardId, name);
  }
}

async function editCardMetadata(controller: StoryBibleController, node: unknown): Promise<void> {
  const cardId = isCardNode(node) ? node.id : await pickCard(controller);
  if (!cardId) {
    return;
  }
  const card = await controller.getCard(cardId);
  if (!card) {
    return;
  }
  const field = await vscode.window.showQuickPick(
    [
      { label: "摘要", field: "summary" as const },
      { label: "可见性", field: "visibility" as const },
      { label: "状态", field: "status" as const },
      { label: "别名", field: "aliases" as const },
      { label: "关键词", field: "tags" as const },
      { label: "章节引用", field: "chapterRefs" as const }
    ],
    { title: "编辑 Card 元数据" }
  );
  if (!field) {
    return;
  }

  if (field.field === "visibility") {
    const picked = await vscode.window.showQuickPick(
      STORY_BIBLE_VISIBILITIES.map((visibility) => ({ label: formatVisibility(visibility), description: visibility, visibility })),
      { title: "Card 可见性" }
    );
    if (picked) {
      await controller.updateCardMetadata(cardId, { visibility: picked.visibility });
    }
    return;
  }

  if (field.field === "status") {
    const picked = await vscode.window.showQuickPick(
      STORY_BIBLE_STATUSES.map((status) => ({ label: formatStatus(status), description: status, status })),
      { title: "Card 状态" }
    );
    if (picked) {
      await controller.updateCardMetadata(cardId, { status: picked.status });
    }
    return;
  }

  const value = await vscode.window.showInputBox({
    title: field.label,
    value: field.field === "summary"
      ? card.summary
      : field.field === "aliases"
        ? card.aliases.join(", ")
        : field.field === "tags"
          ? card.tags.join(", ")
          : (card.chapterRefs ?? []).join(", ")
  });
  if (value === undefined) {
    return;
  }

  if (field.field === "summary") {
    await controller.updateCardMetadata(cardId, { summary: value });
  } else if (field.field === "aliases") {
    await controller.updateCardMetadata(cardId, { aliases: splitCommaList(value) });
  } else if (field.field === "tags") {
    await controller.updateCardMetadata(cardId, { tags: splitCommaList(value) });
  } else {
    await controller.updateCardMetadata(cardId, { chapterRefs: splitCommaList(value) });
  }
}

async function deleteCard(controller: StoryBibleController, node: unknown): Promise<void> {
  const cardId = isCardNode(node) ? node.id : await pickCard(controller);
  if (cardId) {
    await controller.deleteCard(cardId);
  }
}

async function searchCards(context: KernelContext, controller: StoryBibleController): Promise<void> {
  const text = await vscode.window.showInputBox({ title: "搜索 Story Bible Card" });
  if (text === undefined) {
    return;
  }
  const cards = await controller.searchCards({ text });
  const picked = await vscode.window.showQuickPick(
    cards.map((card) => ({
      label: card.name,
      description: `${formatCardType(card.type)} · ${card.status}`,
      detail: card.summary,
      id: card.id
    })),
    { title: "Story Bible 搜索结果" }
  );
  if (picked) {
    openStoryBibleGallery(context, controller, picked.id);
  }
}

async function browseKeywords(controller: StoryBibleController): Promise<void> {
  const keywords = await controller.listKeywords();
  await vscode.window.showQuickPick(
    keywords.map((keyword) => ({
      label: keyword.label,
      description: `${keyword.slug} · ${keyword.category} · ${keyword.usageCount}`,
      detail: keyword.description
    })),
    { title: "Story Bible 关键词" }
  );
}

async function defineKeyword(controller: StoryBibleController): Promise<void> {
  const slug = await vscode.window.showInputBox({ title: "关键词 slug", placeHolder: "theme/revenge" });
  if (slug === undefined) {
    return;
  }
  const label = await vscode.window.showInputBox({ title: "关键词显示名" });
  if (label === undefined) {
    return;
  }
  const description = await vscode.window.showInputBox({ title: "关键词说明", value: "" });
  if (description === undefined) {
    return;
  }
  const category = await vscode.window.showInputBox({ title: "关键词分类", value: "custom" });
  if (category === undefined) {
    return;
  }
  const appliesTo = await vscode.window.showInputBox({ title: "适用 CardType", value: "any" });
  if (appliesTo === undefined) {
    return;
  }

  await controller.defineKeyword({ slug, label, description, category, appliesTo: splitCommaList(appliesTo) });
}

async function openKeywordDefinition(
  context: KernelContext,
  controller: StoryBibleController,
  node: unknown
): Promise<void> {
  const keyword = isKeywordNode(node) ? node : await pickUserDefinedKeyword(controller);
  if (!keyword?.definitionPath) {
    void vscode.window.showWarningMessage("该关键词没有定义文件。");
    return;
  }
  await openRelativeFile(context.workspaceFolder, keyword.definitionPath);
}

async function editKeywordDefinition(controller: StoryBibleController, node: unknown): Promise<void> {
  const keyword = isKeywordNode(node) ? node : await pickUserDefinedKeyword(controller);
  if (!keyword) {
    return;
  }
  const field = await vscode.window.showQuickPick(
    [
      { label: "显示名", field: "label" as const },
      { label: "说明", field: "description" as const },
      { label: "分类", field: "category" as const },
      { label: "适用类型", field: "appliesTo" as const }
    ],
    { title: "编辑关键词定义" }
  );
  if (!field) {
    return;
  }
  const value = await vscode.window.showInputBox({ title: field.label });
  if (value === undefined) {
    return;
  }
  if (field.field === "appliesTo") {
    await controller.updateKeywordDefinition(keyword.slug, { appliesTo: splitCommaList(value) });
  } else {
    await controller.updateKeywordDefinition(keyword.slug, { [field.field]: value });
  }
}

async function deleteKeywordDefinition(controller: StoryBibleController, node: unknown): Promise<void> {
  const keyword = isKeywordNode(node) ? node : await pickUserDefinedKeyword(controller);
  if (keyword) {
    await controller.deleteKeywordDefinition(keyword.slug);
  }
}

async function restoreTrashItem(controller: StoryBibleController, node: unknown): Promise<void> {
  const trashItemId = isTrashItemNode(node) ? node.id : await pickTrashItem(controller);
  if (trashItemId) {
    await controller.restoreTrashItem(trashItemId);
  }
}

async function permanentlyDeleteTrashItem(controller: StoryBibleController, node: unknown): Promise<void> {
  const trashItemId = isTrashItemNode(node) ? node.id : await pickTrashItem(controller);
  if (trashItemId) {
    await controller.permanentlyDeleteTrashItem(trashItemId);
  }
}

async function pickCardType(): Promise<StoryBibleCardType | undefined> {
  const picked = await vscode.window.showQuickPick(
    STORY_BIBLE_CARD_TYPES.map((type) => ({ label: formatCardType(type), description: type, type })),
    { title: "选择 Card 类型" }
  );
  return picked?.type;
}

async function pickCard(controller: StoryBibleController): Promise<StoryBibleCardId | undefined> {
  const cards = await controller.listCards();
  const picked = await vscode.window.showQuickPick(
    cards.map((card) => ({
      label: card.name,
      description: formatCardType(card.type),
      detail: card.path,
      id: card.id
    })),
    { title: "选择 Story Bible Card" }
  );
  return picked?.id;
}

async function pickUserDefinedKeyword(controller: StoryBibleController) {
  const keywords = (await controller.listKeywords()).filter((keyword) => Boolean(keyword.definitionPath));
  const picked = await vscode.window.showQuickPick(
    keywords.map((keyword) => ({
      label: keyword.label,
      description: keyword.slug,
      detail: keyword.description,
      slug: keyword.slug,
      definitionPath: keyword.definitionPath
    })),
    { title: "选择关键词定义" }
  );
  return picked;
}

async function pickTrashItem(controller: StoryBibleController): Promise<StoryBibleTrashItemId | undefined> {
  const items = await controller.listTrashItems();
  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: item.title,
      description: item.resourceType,
      detail: item.originalPath,
      id: item.id
    })),
    { title: "选择 Story Bible 资源垃圾桶项目" }
  );
  return picked?.id;
}

function handleWatchedFile(
  context: KernelContext,
  controller: StoryBibleController,
  tree: StoryBibleTreeProvider,
  uri: vscode.Uri
): void {
  const relativePath = path.relative(context.workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  controller.notifyFileChanged(relativePath);
  void controller.refreshDiagnostics().then(() => refreshStoryBibleTree(tree));
  context.output.appendLine(`Story Bible 文件已变化：${relativePath}`);
}

async function openRelativeFile(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): Promise<void> {
  const absolutePath = await resolveExistingSafeStoryBiblePath(workspaceFolder.uri.fsPath, relativePath);
  if (!absolutePath) {
    void vscode.window.showWarningMessage("Story Bible 文件缺失或路径不安全。");
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showTextDocument(document);
}

async function confirmDestructiveDelete(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, "确认删除");
  return choice === "确认删除";
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

function isCardNode(node: unknown): node is Extract<StoryBibleTreeNode, { kind: "card" }> {
  return isTreeNode(node, "card");
}

function isKeywordNode(node: unknown): node is Extract<StoryBibleTreeNode, { kind: "keyword" }> {
  return isTreeNode(node, "keyword");
}

function isTrashItemNode(node: unknown): node is Extract<StoryBibleTreeNode, { kind: "trashItem" }> {
  return isTreeNode(node, "trashItem");
}

function isTreeNode<T extends StoryBibleTreeNode["kind"]>(
  node: unknown,
  kind: T
): node is Extract<StoryBibleTreeNode, { kind: T }> {
  return typeof node === "object" && node !== null && "kind" in node && node.kind === kind;
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function formatCardType(type: StoryBibleCardType): string {
  switch (type) {
    case "character":
      return "人物";
    case "location":
      return "地点";
    case "rule":
      return "规则";
  }
}

function formatVisibility(visibility: StoryBibleVisibility): string {
  switch (visibility) {
    case "public":
      return "公开";
    case "spoiler":
      return "剧透";
    case "private":
      return "私有";
  }
}

function formatStatus(status: StoryBibleStatus): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "canon":
      return "正典";
    case "archived":
      return "归档";
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
