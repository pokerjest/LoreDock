import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { MANIFEST_RELATIVE_PATH } from "../../kernel/types";
import { readManuscriptManifest, readManuscriptManifestStructure } from "./manifest";
import {
  MANUSCRIPT_NOTES_PATH,
  type BookId,
  type ChapterId,
  type ManuscriptStatus,
  type ManuscriptTrashKind,
  type TrashItemId,
  type VolumeId
} from "./types";

export type ManuscriptTreeNode =
  | { kind: "workspace"; workspaceFolder: vscode.WorkspaceFolder; title: string; description?: string }
  | {
      kind: "bookProject";
      folderUri: vscode.Uri;
      workspaceFolder?: vscode.WorkspaceFolder;
      title: string;
      description?: string;
      active: boolean;
    }
  | { kind: "book"; workspaceFolder: vscode.WorkspaceFolder; id: BookId; title: string }
  | { kind: "volume"; workspaceFolder: vscode.WorkspaceFolder; id: VolumeId; title: string }
  | { kind: "chapter"; workspaceFolder: vscode.WorkspaceFolder; id: ChapterId; title: string; path: string; status: string }
  | { kind: "notes"; workspaceFolder: vscode.WorkspaceFolder; title: string; path: string }
  | { kind: "trashItem"; workspaceFolder: vscode.WorkspaceFolder; id: TrashItemId; title: string; description: string; trashKind: ManuscriptTrashKind }
  | { kind: "diagnostic"; workspaceFolder?: vscode.WorkspaceFolder; title: string; description?: string }
  | { kind: "action"; workspaceFolder: vscode.WorkspaceFolder; title: string; description?: string; command: string; icon: string }
  | { kind: "empty"; workspaceFolder?: vscode.WorkspaceFolder; title: string; description?: string };

export class BookSelectionState {
  private activeBookFolderPath: string | undefined;

  public setActiveBookFolder(folderPath: string): void {
    this.activeBookFolderPath = path.resolve(folderPath);
  }

  public clear(): void {
    this.activeBookFolderPath = undefined;
  }

  public activeWorkspaceFolder(workspaceFolders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | undefined {
    const activePath = this.activeBookFolderPath;
    if (!activePath) {
      return undefined;
    }
    return workspaceFolders.find((folder) => path.resolve(folder.uri.fsPath) === activePath);
  }

  public isActiveBookFolder(folderPath: string, workspaceFolders: readonly vscode.WorkspaceFolder[]): boolean {
    const activePath = this.activePath(workspaceFolders);
    return activePath ? path.resolve(folderPath) === path.resolve(activePath) : false;
  }

  private activePath(workspaceFolders: readonly vscode.WorkspaceFolder[]): string | undefined {
    if (
      this.activeBookFolderPath &&
      workspaceFolders.some((folder) => path.resolve(folder.uri.fsPath) === this.activeBookFolderPath)
    ) {
      return this.activeBookFolderPath;
    }
    return workspaceFolders[0]?.uri.fsPath;
  }
}

export class ManuscriptTreeProvider implements vscode.TreeDataProvider<ManuscriptTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ManuscriptTreeNode | undefined>();
  private readonly fixedWorkspaceFolders?: readonly vscode.WorkspaceFolder[];
  private mode: "active" | "trash" = "active";
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    fixedWorkspaceFolder?: vscode.WorkspaceFolder | readonly vscode.WorkspaceFolder[],
    protected readonly selection = new BookSelectionState()
  ) {
    this.fixedWorkspaceFolders = fixedWorkspaceFolder
      ? Array.isArray(fixedWorkspaceFolder)
        ? fixedWorkspaceFolder
        : [fixedWorkspaceFolder]
      : undefined;
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public setActiveBookFolder(folderPath: string): void {
    this.selection.setActiveBookFolder(folderPath);
    this.refresh();
  }

  public toggleTrashMode(): "active" | "trash" {
    this.mode = this.mode === "active" ? "trash" : "active";
    this.refresh();
    return this.mode;
  }

  public setTrashMode(mode: "active" | "trash"): void {
    this.mode = mode;
    this.refresh();
  }

  public get isTrashMode(): boolean {
    return this.mode === "trash";
  }

  public async getChildren(element?: ManuscriptTreeNode): Promise<ManuscriptTreeNode[]> {
    if (element?.kind === "workspace") {
      return this.getWorkspaceRootNodes(element.workspaceFolder);
    }

    if (element) {
      return this.getChildNodes(element);
    }

    const folders = this.workspaceFolders;
    if (folders.length === 0) {
      return [{ kind: "empty", title: "当前没有打开工作区" }];
    }

    const activeWorkspaceFolder = this.activeWorkspaceFolder ?? folders[0];
    return this.getWorkspaceRootNodes(activeWorkspaceFolder);
  }

  protected async getBookProjectNodes(): Promise<ManuscriptTreeNode[]> {
    const candidates = await this.discoverBookProjectCandidates();
    const nodes = await Promise.all(candidates.map((candidate) => this.createBookProjectNode(candidate)));
    return nodes
      .filter((node): node is Extract<ManuscriptTreeNode, { kind: "bookProject" }> => Boolean(node))
      .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  }

  protected async discoverBookProjectCandidates(): Promise<BookProjectCandidate[]> {
    const candidates = new Map<string, BookProjectCandidate>();
    const addCandidate = (folderUri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder): void => {
      candidates.set(path.resolve(folderUri.fsPath), { folderUri, workspaceFolder });
    };

    for (const workspaceFolder of this.workspaceFolders) {
      addCandidate(workspaceFolder.uri, workspaceFolder);
    }

    const parentPaths = new Set(this.workspaceFolders.map((folder) => path.dirname(folder.uri.fsPath)));
    for (const parentPath of parentPaths) {
      const entries = await readDirectoryEntries(parentPath);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const folderPath = path.join(parentPath, entry.name);
        if (await looksLikeLoreDockBookFolder(folderPath)) {
          addCandidate(vscode.Uri.file(folderPath));
        }
      }
    }

    return [...candidates.values()];
  }

  protected async createBookProjectNode(candidate: BookProjectCandidate): Promise<ManuscriptTreeNode | undefined> {
    const workspaceRoot = candidate.folderUri.fsPath;
    const projectManifest = await inspectExistingWorkspacePath(workspaceRoot, MANIFEST_RELATIVE_PATH);
    if (projectManifest.status === "missing") {
      if (!candidate.workspaceFolder) {
        return undefined;
      }
      return {
        kind: "bookProject",
        folderUri: candidate.folderUri,
        workspaceFolder: candidate.workspaceFolder,
        title: candidate.workspaceFolder.name,
        description: this.isActiveBookFolder(candidate.folderUri.fsPath) ? "当前书" : "未初始化",
        active: this.isActiveBookFolder(candidate.folderUri.fsPath)
      };
    }

    if (projectManifest.status === "unsafe") {
      if (!candidate.workspaceFolder) {
        return undefined;
      }
      return {
        kind: "bookProject",
        folderUri: candidate.folderUri,
        workspaceFolder: candidate.workspaceFolder,
        title: candidate.workspaceFolder.name,
        description: this.isActiveBookFolder(candidate.folderUri.fsPath) ? "当前书" : "项目清单不安全",
        active: this.isActiveBookFolder(candidate.folderUri.fsPath)
      };
    }

    const result = await readManuscriptManifestStructure(workspaceRoot);
    if (result.status === "valid") {
      const folderName = path.basename(workspaceRoot);
      return {
        kind: "bookProject",
        folderUri: candidate.folderUri,
        workspaceFolder: candidate.workspaceFolder,
        title: result.manifest.book.title,
        description: this.isActiveBookFolder(candidate.folderUri.fsPath)
          ? "当前书"
          : result.manifest.book.title === folderName
            ? "书籍文件夹"
            : folderName,
        active: this.isActiveBookFolder(candidate.folderUri.fsPath)
      };
    }

    if (!candidate.workspaceFolder) {
      return undefined;
    }
    return {
      kind: "bookProject",
      folderUri: candidate.folderUri,
      workspaceFolder: candidate.workspaceFolder,
      title: candidate.workspaceFolder.name,
      description: this.isActiveBookFolder(candidate.folderUri.fsPath)
        ? "当前书"
        : result.status === "missing"
          ? "未启用手稿"
          : "手稿需要修复",
      active: this.isActiveBookFolder(candidate.folderUri.fsPath)
    };
  }

  protected async getWorkspaceRootNodes(workspaceFolder: vscode.WorkspaceFolder): Promise<ManuscriptTreeNode[]> {
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

    const result = await readManuscriptManifest(workspaceFolder.uri.fsPath);

    if (result.status !== "valid") {
      if (result.status === "missing") {
        return [
          { kind: "empty", workspaceFolder, title: "尚未启用手稿" },
          {
            kind: "action",
            workspaceFolder,
            title: "启用手稿",
            description: "创建 manuscript/ 结构",
            command: "loredock.enableManuscript",
            icon: "add"
          }
        ];
      }

      return result.diagnostics.length === 0
        ? [{ kind: "empty", workspaceFolder, title: "手稿暂无可显示内容" }]
        : result.diagnostics.map((item) => ({
            kind: "diagnostic" as const,
            workspaceFolder,
            title: item.message,
            description: item.relativePath
          }));
    }

    const { manifest } = result;
    if (this.mode === "trash") {
      if (manifest.trash.itemIds.length === 0) {
        return [{ kind: "empty", workspaceFolder, title: "回收站为空" }];
      }

      return manifest.trash.itemIds
        .map((id) => manifest.trash.items[id])
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => ({
          kind: "trashItem" as const,
          workspaceFolder,
          id: item.id,
          title: item.title,
          description: `${formatTrashKind(item.kind)} · ${formatDeletedAt(item.deletedAt)}`,
          trashKind: item.kind
        }));
    }

    return [
      { kind: "book" as const, workspaceFolder, id: manifest.book.id, title: manifest.book.title },
      { kind: "notes", workspaceFolder, title: "笔记", path: MANUSCRIPT_NOTES_PATH }
    ];
  }

  private async getChildNodes(element: ManuscriptTreeNode): Promise<ManuscriptTreeNode[]> {
    if (element.kind === "book") {
      const result = await readManuscriptManifestStructure(element.workspaceFolder.uri.fsPath);
      if (result.status !== "valid") {
        return [];
      }
      const { manifest } = result;
      return manifest.volumeIds.map((id) => {
        const volume = manifest.volumes[id];
        return {
          kind: "volume" as const,
          workspaceFolder: element.workspaceFolder,
          id: volume.id,
          title: volume.title
        };
      });
    }

    if (element.kind === "volume") {
      const result = await readManuscriptManifestStructure(element.workspaceFolder.uri.fsPath);
      if (result.status !== "valid") {
        return [];
      }
      const { manifest } = result;
      const volume = manifest.volumes[element.id];
      return volume.chapterIds.map((id) => {
        const chapter = manifest.chapters[id];
        return {
          kind: "chapter" as const,
          workspaceFolder: element.workspaceFolder,
          id: chapter.id,
          title: chapter.title,
          path: chapter.path,
          status: chapter.status
        };
      });
    }

    return [];
  }

  public getTreeItem(element: ManuscriptTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "workspace":
        return treeItem(
          element.title,
          "loredock.manuscript.workspace",
          vscode.TreeItemCollapsibleState.Expanded,
          "root-folder"
        );
      case "bookProject": {
        const item = treeItem(
          element.title,
          "loredock.manuscript.bookProject",
          vscode.TreeItemCollapsibleState.None,
          element.active ? "check" : "book"
        );
        item.description = element.description;
        item.tooltip = `${element.title}\n${element.folderUri.fsPath}`;
        item.command = {
          command: "loredock.manuscript.openBookProject",
          title: "打开书籍项目",
          arguments: [element]
        };
        return item;
      }
      case "book":
        return treeItem(element.title, "loredock.manuscript.book", vscode.TreeItemCollapsibleState.Expanded, "book");
      case "volume":
        return treeItem(element.title, "loredock.manuscript.volume", vscode.TreeItemCollapsibleState.Expanded, "library");
      case "chapter": {
        const item = treeItem(element.title, "loredock.manuscript.chapter", vscode.TreeItemCollapsibleState.None, "file-text");
        item.description = formatStatus(element.status);
        item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolder.uri.fsPath, element.path));
        item.command = {
          command: "loredock.manuscript.openChapter",
          title: "打开章节",
          arguments: [element]
        };
        return item;
      }
      case "notes": {
        const item = treeItem(element.title, "loredock.manuscript.notes", vscode.TreeItemCollapsibleState.None, "notebook");
        item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolder.uri.fsPath, element.path));
        item.command = {
          command: "loredock.manuscript.openNotes",
          title: "打开笔记",
          arguments: [element]
        };
        return item;
      }
      case "trashItem": {
        const item = treeItem(element.title, "loredock.manuscript.trashItem", vscode.TreeItemCollapsibleState.None, "trash");
        item.description = element.description;
        item.tooltip = `${formatTrashKind(element.trashKind)} · ${element.title}`;
        return item;
      }
      case "diagnostic": {
        const item = treeItem(element.title, "loredock.manuscript.diagnostic", vscode.TreeItemCollapsibleState.None, "warning");
        item.description = element.description;
        return item;
      }
      case "action": {
        const item = treeItem(element.title, "loredock.manuscript.action", vscode.TreeItemCollapsibleState.None, element.icon);
        item.description = element.description;
        item.command = {
          command: element.command,
          title: element.title,
          arguments: [element.workspaceFolder]
        };
        return item;
      }
      case "empty":
        {
          const item = treeItem(element.title, "loredock.manuscript.empty", vscode.TreeItemCollapsibleState.None, "circle-slash");
          item.description = element.description;
          return item;
        }
    }
  }

  protected get workspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return this.fixedWorkspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
  }

  protected get activeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return this.selection.activeWorkspaceFolder(this.workspaceFolders);
  }

  protected isActiveBookFolder(folderPath: string): boolean {
    return this.selection.isActiveBookFolder(folderPath, this.workspaceFolders);
  }
}

export class BookLibraryTreeProvider extends ManuscriptTreeProvider {
  public override async getChildren(element?: ManuscriptTreeNode): Promise<ManuscriptTreeNode[]> {
    if (element) {
      return [];
    }

    if (this.workspaceFolders.length === 0) {
      return [{ kind: "empty", title: "当前没有打开工作区" }];
    }

    const bookProjects = await this.getBookProjectNodes();
    return bookProjects.length > 0
      ? bookProjects
      : [{ kind: "empty", title: "未发现书籍项目" }];
  }
}

interface BookProjectCandidate {
  folderUri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
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

function formatStatus(status: string): string {
  switch (status as ManuscriptStatus) {
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
    default:
      return status;
  }
}

function formatTrashKind(kind: ManuscriptTrashKind): string {
  switch (kind) {
    case "volume":
      return "卷";
    case "chapter":
      return "章节";
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

async function looksLikeLoreDockBookFolder(folderPath: string): Promise<boolean> {
  return (
    (await pathExists(path.join(folderPath, MANIFEST_RELATIVE_PATH))) &&
    (await pathExists(path.join(folderPath, "manuscript/manifest.json")))
  );
}

async function readDirectoryEntries(parentPath: string): Promise<import("fs").Dirent[]> {
  try {
    return await fs.readdir(parentPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
