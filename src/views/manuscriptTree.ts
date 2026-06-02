import * as vscode from 'vscode';
import { CHAPTER_STATUS_LABELS } from '../core/constants';
import { LoreDockStorage } from '../core/storage';
import { ChapterMeta, ProjectManifest, VolumeMeta } from '../types';

export type ManuscriptNode = ProjectNode | VolumeNode | ChapterNode | EmptyNode;

export interface ProjectNode {
  kind: 'project';
  manifest: ProjectManifest;
}

export interface VolumeNode {
  kind: 'volume';
  volume: VolumeMeta;
}

export interface ChapterNode {
  kind: 'chapter';
  volume: VolumeMeta;
  chapter: ChapterMeta;
}

interface EmptyNode {
  kind: 'empty';
  label: string;
}

export class ManuscriptTreeProvider implements vscode.TreeDataProvider<ManuscriptNode> {
  private readonly emitter = new vscode.EventEmitter<ManuscriptNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getStorage: () => LoreDockStorage | undefined) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: ManuscriptNode): vscode.TreeItem {
    if (element.kind === 'project') {
      const item = new vscode.TreeItem(element.manifest.title, vscode.TreeItemCollapsibleState.Expanded);
      item.description = element.manifest.author || undefined;
      item.contextValue = 'loredock.project';
      item.iconPath = new vscode.ThemeIcon('book');
      return item;
    }

    if (element.kind === 'volume') {
      const item = new vscode.TreeItem(element.volume.title, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.volume.chapters.length} 章`;
      item.contextValue = 'loredock.volume';
      item.iconPath = new vscode.ThemeIcon('library');
      return item;
    }

    if (element.kind === 'chapter') {
      const label = element.chapter.title;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = `${CHAPTER_STATUS_LABELS[element.chapter.status] ?? element.chapter.status} · ${element.chapter.wordCount} 字`;
      item.tooltip = `${element.volume.title} / ${element.chapter.title}\n${element.chapter.filePath}`;
      item.contextValue = 'loredock.chapter';
      item.iconPath = new vscode.ThemeIcon('file-text');
      item.command = {
        command: 'loredock.openChapter',
        title: '打开章节',
        arguments: [element]
      };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'loredock.empty';
    item.iconPath = new vscode.ThemeIcon('info');
    item.command = {
      command: 'loredock.initProject',
      title: '初始化小说项目'
    };
    return item;
  }

  public async getChildren(element?: ManuscriptNode): Promise<ManuscriptNode[]> {
    const storage = this.getStorage();
    if (!storage) {
      return [{ kind: 'empty', label: '请先打开一个文件夹' }];
    }

    const manifest = await storage.refreshChapterStats();
    if (!manifest) {
      return [{ kind: 'empty', label: '初始化 LoreDock 小说项目' }];
    }

    if (!element) {
      return [{ kind: 'project', manifest }];
    }

    if (element.kind === 'project') {
      return [...manifest.volumes]
        .sort((a, b) => a.order - b.order)
        .map((volume) => ({ kind: 'volume', volume }));
    }

    if (element.kind === 'volume') {
      const freshVolume = manifest.volumes.find((volume) => volume.id === element.volume.id) ?? element.volume;
      return [...freshVolume.chapters]
        .sort((a, b) => a.order - b.order)
        .map((chapter) => ({ kind: 'chapter', volume: freshVolume, chapter }));
    }

    return [];
  }
}

export function isChapterNode(value: unknown): value is ChapterNode {
  return Boolean(value && typeof value === 'object' && (value as ChapterNode).kind === 'chapter');
}

export function isProjectNode(value: unknown): value is ProjectNode {
  return Boolean(value && typeof value === 'object' && (value as ProjectNode).kind === 'project');
}

export function isVolumeNode(value: unknown): value is VolumeNode {
  return Boolean(value && typeof value === 'object' && (value as VolumeNode).kind === 'volume');
}
