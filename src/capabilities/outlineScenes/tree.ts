import * as path from "path";
import * as vscode from "vscode";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import { isPlotGridCapabilityEnabled } from "../plotGrid/files";
import { isOutlineScenesCapabilityEnabled, readOutlineScenes, type OutlineScenesReadResult } from "./files";
import type {
  OutlineDocumentDto,
  OutlineSceneReader,
  OutlineScenesTrashItemId,
  SceneCardDto,
  SceneId,
  StructureChapterDto,
  StructureVolumeDto
} from "./types";

export type OutlineScenesTreeNode =
  | { kind: "workspace"; workspaceFolder: vscode.WorkspaceFolder; title: string; description?: string }
  | { kind: "group"; workspaceFolder: vscode.WorkspaceFolder; group: "skeleton" | "scenes" | "outlines" | "drafts"; title: string; description?: string }
  | { kind: "outline"; workspaceFolder: vscode.WorkspaceFolder; title: string; path: string; outline: OutlineDocumentDto }
  | { kind: "volume"; workspaceFolder: vscode.WorkspaceFolder; id: string; title: string; volume: StructureVolumeDto }
  | { kind: "chapter"; workspaceFolder: vscode.WorkspaceFolder; id: string; title: string; chapterId: string; scenes: SceneCardDto[]; description?: string }
  | { kind: "scene"; workspaceFolder: vscode.WorkspaceFolder; id: SceneId; title: string; path: string; status: string; order: number; chapterTitle?: string }
  | { kind: "trashItem"; workspaceFolder: vscode.WorkspaceFolder; id: OutlineScenesTrashItemId; title: string; description: string }
  | { kind: "diagnostic"; workspaceFolder?: vscode.WorkspaceFolder; title: string; description?: string }
  | { kind: "action"; workspaceFolder: vscode.WorkspaceFolder; title: string; description?: string; command: string; icon: string; commandArgs?: unknown[] }
  | { kind: "empty"; workspaceFolder?: vscode.WorkspaceFolder; title: string; description?: string };

export class OutlineScenesTreeProvider implements vscode.TreeDataProvider<OutlineScenesTreeNode> {
  private readonly emitter = new vscode.EventEmitter<OutlineScenesTreeNode | undefined>();
  private mode: "active" | "trash" = "active";
  private readonly renderCache = new Map<string, Promise<OutlineScenesReadResult>>();
  private readonly readerProviders = new Map<string, () => OutlineSceneReader | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly fixedWorkspaceFolder?: vscode.WorkspaceFolder) {}

  public registerReaderProvider(
    workspaceFolder: vscode.WorkspaceFolder,
    provider: () => OutlineSceneReader | undefined
  ): vscode.Disposable {
    const key = workspaceFolder.uri.fsPath;
    this.readerProviders.set(key, provider);
    this.refresh();
    return {
      dispose: () => {
        if (this.readerProviders.get(key) === provider) {
          this.readerProviders.delete(key);
          this.refresh();
        }
      }
    };
  }

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

  public async getChildren(element?: OutlineScenesTreeNode): Promise<OutlineScenesTreeNode[]> {
    if (!element) {
      this.renderCache.clear();
    }
    if (element?.kind === "workspace") {
      return this.getWorkspaceRootNodes(element.workspaceFolder);
    }
    if (element?.kind === "group") {
      return this.getGroupChildren(element);
    }
    if (element?.kind === "volume") {
      const chapters = [...element.volume.chapters].sort(compareStructureChapters);
      return chapters.length === 0
        ? [{ kind: "empty", workspaceFolder: element.workspaceFolder, title: "暂无章节" }]
        : chapters.map((chapter) => chapterNode(element.workspaceFolder, chapter));
    }
    if (element?.kind === "chapter") {
      return element.scenes.length === 0
        ? []
        : [...element.scenes].sort(compareScenes).map((scene) => sceneNode(element.workspaceFolder, scene, element.title));
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

  public getTreeItem(element: OutlineScenesTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "workspace":
        return treeItem(element.title, "loredock.outlineScenes.workspace", vscode.TreeItemCollapsibleState.Expanded, "root-folder");
      case "group": {
        const item = treeItem(element.title, `loredock.outlineScenes.group.${element.group}`, groupCollapsibleState(element.group), groupIcon(element.group));
        item.description = element.description;
        return item;
      }
      case "outline": {
        const item = treeItem(element.title, "loredock.outlineScenes.outline", vscode.TreeItemCollapsibleState.None, "edit");
        item.description = outlineSummary(element.outline);
        item.tooltip = element.path;
        item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolder.uri.fsPath, element.path));
        item.command = {
          command: "vscode.open",
          title: "打开规划草稿",
          arguments: [item.resourceUri]
        };
        return item;
      }
      case "volume": {
        const item = treeItem(element.title, "loredock.outlineScenes.volume", vscode.TreeItemCollapsibleState.Expanded, "library");
        item.description = `${element.volume.chapters.length} 章`;
        item.tooltip = element.id;
        return item;
      }
      case "chapter": {
        const collapsibleState = element.scenes.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None;
        const item = treeItem(element.title, "loredock.outlineScenes.chapter", collapsibleState, "file-text");
        item.description = element.description;
        item.tooltip = element.chapterId;
        return item;
      }
      case "scene": {
        const item = treeItem(element.title, "loredock.outlineScenes.scene", vscode.TreeItemCollapsibleState.None, "symbol-event");
        item.description = element.chapterTitle
          ? `${element.chapterTitle} · ${element.order} · ${element.status}`
          : `${element.order} · ${element.status}`;
        item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolder.uri.fsPath, element.path));
        item.command = {
          command: "loredock.plotGrid.open",
          title: "打开剧情矩阵",
          arguments: [{ workspaceFolder: element.workspaceFolder, sceneId: element.id }]
        };
        return item;
      }
      case "trashItem": {
        const item = treeItem(element.title, "loredock.outlineScenes.trashItem", vscode.TreeItemCollapsibleState.None, "trash");
        item.description = element.description;
        return item;
      }
      case "diagnostic": {
        const item = treeItem(element.title, "loredock.outlineScenes.diagnostic", vscode.TreeItemCollapsibleState.None, "warning");
        item.description = element.description;
        return item;
      }
      case "action": {
        const item = treeItem(element.title, "loredock.outlineScenes.action", vscode.TreeItemCollapsibleState.None, element.icon);
        item.description = element.description;
        item.command = { command: element.command, title: element.title, arguments: element.commandArgs ?? [element.workspaceFolder] };
        return item;
      }
      case "empty": {
        const item = treeItem(element.title, "loredock.outlineScenes.empty", vscode.TreeItemCollapsibleState.None, "circle-slash");
        item.description = element.description;
        return item;
      }
    }
  }

  private async getWorkspaceRootNodes(workspaceFolder: vscode.WorkspaceFolder): Promise<OutlineScenesTreeNode[]> {
    const projectManifest = await inspectExistingWorkspacePath(workspaceFolder.uri.fsPath, MANIFEST_RELATIVE_PATH);
    if (projectManifest.status === "missing") {
      return [
        { kind: "empty", workspaceFolder, title: "尚未初始化 LoreDock 项目", description: ".loredock/project.json" },
        { kind: "action", workspaceFolder, title: "初始化项目", description: "创建 LoreDock 项目清单", command: "loredock.initProject", icon: "rocket" }
      ];
    }
    if (projectManifest.status === "unsafe") {
      return [{ kind: "diagnostic", workspaceFolder, title: "LoreDock 项目清单路径不安全", description: ".loredock/project.json" }];
    }

    const enabled = await isOutlineScenesCapabilityEnabled(workspaceFolder.uri.fsPath);
    if (!enabled) {
      return [
        { kind: "empty", workspaceFolder, title: "尚未启用结构规划" },
        { kind: "action", workspaceFolder, title: "启用结构规划", description: "创建 outlines/ 与 scenes/", command: "loredock.enableOutlineScenes", icon: "add" }
      ];
    }

    const result = await this.readCatalog(workspaceFolder.uri.fsPath);
    if (this.mode === "trash") {
      if (result.trashItems.length === 0) {
        return [{ kind: "empty", workspaceFolder, title: "结构规划资源垃圾桶为空" }];
      }
      return result.trashItems.map((item) => ({
        kind: "trashItem" as const,
        workspaceFolder,
        id: item.id,
        title: item.title,
        description: formatDeletedAt(item.deletedAt)
      }));
    }

    const diagnostics = result.diagnostics.map((item) => ({
      kind: "diagnostic" as const,
      workspaceFolder,
      title: item.message,
      description: item.relativePath
    }));
    const plotGridEnabled = await isPlotGridCapabilityEnabled(workspaceFolder.uri.fsPath);
    return [
      ...diagnostics,
      plotGridEnabled
        ? {
            kind: "action",
            workspaceFolder,
            title: "打开剧情矩阵",
            description: "章节、场景和剧情线总览",
            command: "loredock.plotGrid.open",
            icon: "table"
          }
        : {
            kind: "action",
            workspaceFolder,
            title: "启用剧情矩阵",
            description: "创建 boards/plot-grid.json",
            command: "loredock.enablePlotGrid",
            icon: "add"
          },
      { kind: "group", workspaceFolder, group: "skeleton", title: "结构骨架", description: "已落地" },
      { kind: "group", workspaceFolder, group: "scenes", title: "未绑定场景卡", description: "待安排" },
      { kind: "group", workspaceFolder, group: "outlines", title: "规划草稿", description: "导入源" }
    ];
  }

  private async getGroupChildren(group: Extract<OutlineScenesTreeNode, { kind: "group" }>): Promise<OutlineScenesTreeNode[]> {
    const result = await this.readCatalog(group.workspaceFolder.uri.fsPath);
    if (group.group === "scenes") {
      return this.getSceneChildren(group.workspaceFolder);
    }
    if (group.group === "outlines" || group.group === "drafts") {
      if (result.outlines.length === 0) {
        return [
          { kind: "empty", workspaceFolder: group.workspaceFolder, title: "暂无规划草稿" },
          { kind: "action", workspaceFolder: group.workspaceFolder, title: "新建规划草稿", description: "选择书/卷/章/场景粒度", command: "loredock.outlineScenes.createOutline", icon: "new-file" }
        ];
      }
      return result.outlines.map((outline) => ({
        kind: "outline" as const,
        workspaceFolder: group.workspaceFolder,
        title: outline.title,
        path: outline.path,
        outline
      }));
    }

    return this.getSkeletonChildren(group.workspaceFolder);
  }

  private async getSkeletonChildren(workspaceFolder: vscode.WorkspaceFolder): Promise<OutlineScenesTreeNode[]> {
    const reader = this.readerProviders.get(workspaceFolder.uri.fsPath)?.();
    if (!reader) {
      return [{ kind: "empty", workspaceFolder, title: "正在加载手稿结构" }];
    }

    try {
      const skeleton = await reader.getStructureSkeleton();
      const volumes = [...skeleton.volumes].sort(compareStructureVolumes).map((volume) => ({
        kind: "volume" as const,
        workspaceFolder,
        id: volume.id,
        title: volume.title,
        volume
      }));
      if (volumes.length === 0) {
        return [
          { kind: "empty", workspaceFolder, title: "暂无卷章结构" },
          { kind: "action", workspaceFolder, title: "新建规划草稿", description: "选择粒度后预览导入", command: "loredock.outlineScenes.createOutline", icon: "new-file" }
        ];
      }
      return volumes;
    } catch (error) {
      return [
        {
          kind: "diagnostic",
          workspaceFolder,
          title: "结构骨架加载失败",
          description: error instanceof Error ? error.message : String(error)
        }
      ];
    }
  }

  private async getSceneChildren(workspaceFolder: vscode.WorkspaceFolder): Promise<OutlineScenesTreeNode[]> {
    const reader = this.readerProviders.get(workspaceFolder.uri.fsPath)?.();
    if (!reader) {
      const result = await this.readCatalog(workspaceFolder.uri.fsPath);
      const scenes = result.scenes.map((scene) => scene.dto).filter((scene) => scene.chapterRefs.length === 0).sort(compareScenes);
      return scenes.length === 0
        ? [{ kind: "empty", workspaceFolder, title: "暂无未绑定场景卡" }]
        : scenes.map((scene) => sceneNode(workspaceFolder, scene));
    }

    try {
      const skeleton = await reader.getStructureSkeleton();
      const chapterTitles = new Map<string, string>();
      for (const volume of skeleton.volumes) {
        for (const chapter of volume.chapters) {
          chapterTitles.set(chapter.id, chapter.title);
        }
      }
      const sortedScenes = [...skeleton.orphanScenes].sort(compareScenes);
      return sortedScenes.length === 0
        ? [{ kind: "empty", workspaceFolder, title: "暂无未绑定场景卡" }]
        : sortedScenes.map((scene) => sceneNode(workspaceFolder, scene, chapterTitleDescription(scene, chapterTitles)));
    } catch (error) {
      return [
        {
          kind: "diagnostic",
          workspaceFolder,
          title: "场景卡加载失败",
          description: error instanceof Error ? error.message : String(error)
        }
      ];
    }
  }

  private readCatalog(workspaceRoot: string): Promise<OutlineScenesReadResult> {
    let cached = this.renderCache.get(workspaceRoot);
    if (!cached) {
      cached = readOutlineScenes(workspaceRoot).catch((error: unknown) => {
        this.renderCache.delete(workspaceRoot);
        throw error;
      });
      this.renderCache.set(workspaceRoot, cached);
    }
    return cached;
  }

  private get workspaceFolders(): vscode.WorkspaceFolder[] {
    return this.fixedWorkspaceFolder ? [this.fixedWorkspaceFolder] : [...(vscode.workspace.workspaceFolders ?? [])];
  }
}

function chapterNode(workspaceFolder: vscode.WorkspaceFolder, chapter: StructureChapterDto): OutlineScenesTreeNode {
  return {
    kind: "chapter",
    workspaceFolder,
    id: chapter.id,
    title: chapter.title,
    chapterId: chapter.id,
    scenes: chapter.scenes,
    description: `${chapter.scenes.length} 个场景`
  };
}

function sceneNode(workspaceFolder: vscode.WorkspaceFolder, scene: SceneCardDto, chapterTitle?: string): OutlineScenesTreeNode {
  return {
    kind: "scene",
    workspaceFolder,
    id: scene.id,
    title: scene.title,
    path: scene.path,
    status: scene.status,
    order: scene.order,
    chapterTitle
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

function outlineSummary(outline: OutlineDocumentDto): string {
  const volumeCount = outline.volumes.length;
  const chapterCount = outline.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0);
  const sceneCount = outline.volumes.reduce(
    (sum, volume) => sum + volume.chapters.reduce((chapterSum, chapter) => chapterSum + chapter.scenes.length, 0),
    0
  );
  if (outline.scope === "book") {
    return `${outlineScopeLabel(outline.scope)} · ${volumeCount} 卷 ${chapterCount} 章 ${sceneCount} 场`;
  }
  if (outline.scope === "volume") {
    return `${outlineScopeLabel(outline.scope)} · ${chapterCount} 章 ${sceneCount} 场`;
  }
  if (outline.scope === "chapter") {
    return `${outlineScopeLabel(outline.scope)} · ${chapterCount} 章 ${sceneCount} 场`;
  }
  return `${outlineScopeLabel(outline.scope)} · ${sceneCount} 场`;
}

function outlineScopeLabel(scope: OutlineDocumentDto["scope"]): string {
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

function groupIcon(group: "skeleton" | "scenes" | "outlines" | "drafts"): string {
  switch (group) {
    case "skeleton":
      return "symbol-structure";
    case "scenes":
      return "symbol-event";
    case "outlines":
      return "edit";
    case "drafts":
      return "edit";
  }
}

function groupCollapsibleState(group: "skeleton" | "scenes" | "outlines" | "drafts"): vscode.TreeItemCollapsibleState {
  return group === "skeleton" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
}

function compareScenes(left: SceneCardDto, right: SceneCardDto): number {
  return primaryChapterRef(left) === primaryChapterRef(right)
    ? left.order - right.order || left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
    : primaryChapterRef(left).localeCompare(primaryChapterRef(right));
}

function compareStructureVolumes(left: StructureVolumeDto, right: StructureVolumeDto): number {
  return left.index - right.index || left.title.localeCompare(right.title, "zh-CN") || left.id.localeCompare(right.id);
}

function compareStructureChapters(left: StructureChapterDto, right: StructureChapterDto): number {
  return left.index - right.index || left.title.localeCompare(right.title, "zh-CN") || left.id.localeCompare(right.id);
}

function formatDeletedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function primaryChapterRef(scene: SceneCardDto): string {
  return scene.chapterRefs[0] ?? "";
}

function chapterTitleDescription(scene: SceneCardDto, chapterTitles: Map<string, string>): string {
  const titles = scene.chapterRefs.map((chapterRef) => chapterTitles.get(chapterRef) ?? "未匹配章节");
  return titles.length === 0 ? "未绑定章节" : titles.join(", ");
}
