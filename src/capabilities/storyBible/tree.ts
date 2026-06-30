import * as path from "path";
import * as vscode from "vscode";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import { isStoryBibleCapabilityEnabled, readStoryBible, type StoryBibleReadResult as StoryBibleCatalog } from "./files";
import type {
  KeywordCatalogEntryDto,
  KeywordSlug,
  StoryBibleCardId,
  StoryBibleCardType,
  StoryBibleTrashItemId,
  StoryBibleTrashResourceType
} from "./types";

export type StoryBibleTreeNode =
  | { kind: "workspace"; workspaceFolder: vscode.WorkspaceFolder; title: string; description?: string }
  | { kind: "group"; workspaceFolder: vscode.WorkspaceFolder; group: "character" | "location" | "rule" | "keyword"; title: string }
  | {
      kind: "card";
      workspaceFolder: vscode.WorkspaceFolder;
      id: StoryBibleCardId;
      type: StoryBibleCardType;
      title: string;
      path: string;
      primaryKeyword: KeywordSlug;
      primaryKeywordLabel: string;
      status: string;
    }
  | {
      kind: "keyword";
      workspaceFolder: vscode.WorkspaceFolder;
      slug: KeywordSlug;
      title: string;
      description: string;
      definitionPath?: string;
      source: string;
    }
  | {
      kind: "trashItem";
      workspaceFolder: vscode.WorkspaceFolder;
      id: StoryBibleTrashItemId;
      title: string;
      description: string;
      resourceType: StoryBibleTrashResourceType;
    }
  | { kind: "diagnostic"; workspaceFolder?: vscode.WorkspaceFolder; title: string; description?: string }
  | { kind: "action"; workspaceFolder: vscode.WorkspaceFolder; title: string; description?: string; command: string; icon: string }
  | { kind: "empty"; workspaceFolder?: vscode.WorkspaceFolder; title: string; description?: string };

export class StoryBibleTreeProvider implements vscode.TreeDataProvider<StoryBibleTreeNode> {
  private readonly emitter = new vscode.EventEmitter<StoryBibleTreeNode | undefined>();
  private mode: "active" | "trash" = "active";
  // Per-render cache: one Story Bible scan is shared by the root node and all of
  // its expanded children, then dropped at the start of the next top-level query.
  private readonly renderCache = new Map<string, Promise<StoryBibleCatalog>>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly fixedWorkspaceFolder?: vscode.WorkspaceFolder) {}

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public toggleTrashMode(): "active" | "trash" {
    this.mode = this.mode === "active" ? "trash" : "active";
    this.refresh();
    return this.mode;
  }

  public get isTrashMode(): boolean {
    return this.mode === "trash";
  }

  public async getChildren(element?: StoryBibleTreeNode): Promise<StoryBibleTreeNode[]> {
    if (!element) {
      this.renderCache.clear();
    }
    if (element?.kind === "workspace") {
      return this.getWorkspaceRootNodes(element.workspaceFolder);
    }
    if (element?.kind === "group") {
      return this.getGroupChildren(element);
    }
    if (element) {
      return [];
    }

    const folders = this.workspaceFolders;
    if (folders.length === 0) {
      return [{ kind: "empty", title: "当前没有打开工作区" }];
    }
    if (folders.length === 1) {
      return this.getWorkspaceRootNodes(folders[0]);
    }

    return folders.map((workspaceFolder) => ({
      kind: "workspace",
      workspaceFolder,
      title: workspaceFolder.name,
      description: workspaceFolder.uri.fsPath
    }));
  }

  private readCatalog(workspaceRoot: string): Promise<StoryBibleCatalog> {
    let cached = this.renderCache.get(workspaceRoot);
    if (!cached) {
      cached = readStoryBible(workspaceRoot).catch((error: unknown) => {
        this.renderCache.delete(workspaceRoot);
        throw error;
      });
      this.renderCache.set(workspaceRoot, cached);
    }
    return cached;
  }

  private async getWorkspaceRootNodes(workspaceFolder: vscode.WorkspaceFolder): Promise<StoryBibleTreeNode[]> {
    const projectManifest = await inspectExistingWorkspacePath(workspaceFolder.uri.fsPath, MANIFEST_RELATIVE_PATH);
    if (projectManifest.status === "missing") {
      return [
        { kind: "empty", workspaceFolder, title: "尚未初始化 LoreDock 项目", description: ".loredock/project.json" },
        {
          kind: "action",
          workspaceFolder,
          title: "初始化项目",
          description: "创建 LoreDock 项目清单",
          command: "loredock.initProject",
          icon: "rocket"
        }
      ];
    }
    if (projectManifest.status === "unsafe") {
      return [
        {
          kind: "diagnostic",
          workspaceFolder,
          title: "LoreDock 项目清单路径不安全",
          description: ".loredock/project.json"
        }
      ];
    }

    const enabled = await isStoryBibleCapabilityEnabled(workspaceFolder.uri.fsPath);
    if (!enabled) {
      return [
        { kind: "empty", workspaceFolder, title: "尚未启用故事圣经" },
        {
          kind: "action",
          workspaceFolder,
          title: "启用故事圣经",
          description: "创建 lore/ 结构",
          command: "loredock.enableStoryBible",
          icon: "add"
        }
      ];
    }

    const result = await this.readCatalog(workspaceFolder.uri.fsPath);

    if (this.mode === "trash") {
      if (result.trashItems.length === 0) {
        return [{ kind: "empty", workspaceFolder, title: "故事圣经资源垃圾桶为空" }];
      }

      return result.trashItems.map((item) => ({
        kind: "trashItem" as const,
        workspaceFolder,
        id: item.id,
        title: item.title,
        description: `${formatResourceType(item.resourceType)} · ${formatDeletedAt(item.deletedAt)}`,
        resourceType: item.resourceType
      }));
    }

    const diagnostics = result.diagnostics.map((item) => ({
      kind: "diagnostic" as const,
      workspaceFolder,
      title: item.message,
      description: item.relativePath
    }));

    return [
      ...diagnostics,
      { kind: "group", workspaceFolder, group: "character", title: "人物" },
      { kind: "group", workspaceFolder, group: "location", title: "地点" },
      { kind: "group", workspaceFolder, group: "rule", title: "规则" },
      { kind: "group", workspaceFolder, group: "keyword", title: "关键词" }
    ];
  }

  private async getGroupChildren(group: Extract<StoryBibleTreeNode, { kind: "group" }>): Promise<StoryBibleTreeNode[]> {
    const result = await this.readCatalog(group.workspaceFolder.uri.fsPath);
    if (group.group === "keyword") {
      return result.keywords.map((keyword) => keywordNode(group.workspaceFolder, keyword));
    }

    const cards = result.cards
      .map((card) => card.dto)
      .filter((card) => card.type === group.group)
      .sort((left, right) => left.name.localeCompare(right.name));

    if (cards.length === 0) {
      return [{ kind: "empty", workspaceFolder: group.workspaceFolder, title: `暂无${group.title}` }];
    }

    return cards.map((card) => ({
      kind: "card" as const,
      workspaceFolder: group.workspaceFolder,
      id: card.id,
      type: card.type,
      title: card.name,
      path: card.path,
      primaryKeyword: card.primaryKeyword,
      primaryKeywordLabel: card.keywordLabels[card.primaryKeyword] ?? card.name,
      status: card.status
    }));
  }

  public getTreeItem(element: StoryBibleTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "workspace":
        return treeItem(element.title, "loredock.storyBible.workspace", vscode.TreeItemCollapsibleState.Expanded, "root-folder");
      case "group":
        return treeItem(element.title, `loredock.storyBible.group.${element.group}`, vscode.TreeItemCollapsibleState.Expanded, groupIcon(element.group));
      case "card": {
        const item = treeItem(element.title, "loredock.storyBible.card", vscode.TreeItemCollapsibleState.None, cardIcon(element.type));
        item.description = `${element.primaryKeywordLabel} · ${formatStatus(element.status)}`;
        item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolder.uri.fsPath, element.path));
        item.command = {
          command: "loredock.storyBible.openCard",
          title: "打开条目",
          arguments: [element]
        };
        return item;
      }
      case "keyword": {
        const item = treeItem(
          element.title,
          element.definitionPath ? "loredock.storyBible.keywordDefinition" : "loredock.storyBible.keyword",
          vscode.TreeItemCollapsibleState.None,
          "symbol-keyword"
        );
        item.description = element.description;
        item.tooltip = `${element.slug} · ${element.source}`;
        if (element.definitionPath) {
          item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolder.uri.fsPath, element.definitionPath));
          item.command = {
            command: "loredock.storyBible.openKeywordDefinition",
            title: "打开关键词定义",
            arguments: [element]
          };
        }
        return item;
      }
      case "trashItem": {
        const item = treeItem(element.title, "loredock.storyBible.trashItem", vscode.TreeItemCollapsibleState.None, "trash");
        item.description = element.description;
        return item;
      }
      case "diagnostic": {
        const item = treeItem(element.title, "loredock.storyBible.diagnostic", vscode.TreeItemCollapsibleState.None, "warning");
        item.description = element.description;
        return item;
      }
      case "action": {
        const item = treeItem(element.title, "loredock.storyBible.action", vscode.TreeItemCollapsibleState.None, element.icon);
        item.description = element.description;
        item.command = {
          command: element.command,
          title: element.title,
          arguments: [element.workspaceFolder]
        };
        return item;
      }
      case "empty": {
        const item = treeItem(element.title, "loredock.storyBible.empty", vscode.TreeItemCollapsibleState.None, "circle-slash");
        item.description = element.description;
        return item;
      }
    }
  }

  private get workspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return this.fixedWorkspaceFolder ? [this.fixedWorkspaceFolder] : vscode.workspace.workspaceFolders ?? [];
  }
}

function keywordNode(workspaceFolder: vscode.WorkspaceFolder, keyword: KeywordCatalogEntryDto): StoryBibleTreeNode {
  return {
    kind: "keyword",
    workspaceFolder,
    slug: keyword.slug,
    title: keyword.label,
    description: `${keyword.category} · ${keyword.usageCount}`,
    ...(keyword.definitionPath ? { definitionPath: keyword.definitionPath } : {}),
    source: keyword.source
  };
}

function treeItem(
  label: string,
  contextValue: string,
  collapsibleState: vscode.TreeItemCollapsibleState,
  icon: string
): vscode.TreeItem {
  const item = new vscode.TreeItem(label, collapsibleState);
  item.contextValue = contextValue;
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function groupIcon(group: "character" | "location" | "rule" | "keyword"): string {
  switch (group) {
    case "character":
      return "person";
    case "location":
      return "location";
    case "rule":
      return "law";
    case "keyword":
      return "symbol-keyword";
  }
}

function cardIcon(type: StoryBibleCardType): string {
  switch (type) {
    case "character":
      return "person";
    case "location":
      return "location";
    case "rule":
      return "law";
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "canon":
      return "正典";
    case "archived":
      return "归档";
    default:
      return status;
  }
}

function formatResourceType(type: StoryBibleTrashResourceType): string {
  switch (type) {
    case "card":
      return "条目";
    case "keyword-definition":
      return "关键词定义";
  }
}

function formatDeletedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
