import * as vscode from 'vscode';
import { LoreDockStorage } from '../core/storage';
import { CodexCard, CodexEntry } from '../types';

export type CodexNode = CodexCategoryNode | CodexEntryNode | EmptyCodexNode;

interface CodexCategoryNode {
  kind: 'category';
  id: 'characters' | 'locations' | 'worldRules' | 'foreshadowing' | 'scenes' | 'beats';
  label: string;
  cardKind: CodexCard['kind'];
  icon: string;
}

export interface CodexEntryNode {
  kind: 'entry';
  entry: CodexEntry;
}

interface EmptyCodexNode {
  kind: 'empty';
  label: string;
}

const CATEGORIES: CodexCategoryNode[] = [
  { kind: 'category', id: 'characters', label: '人物', cardKind: 'character', icon: 'account' },
  { kind: 'category', id: 'locations', label: '地点', cardKind: 'location', icon: 'location' },
  { kind: 'category', id: 'worldRules', label: '世界规则', cardKind: 'world-rule', icon: 'law' },
  { kind: 'category', id: 'foreshadowing', label: '伏笔', cardKind: 'foreshadowing', icon: 'symbol-key' },
  { kind: 'category', id: 'scenes', label: '场景', cardKind: 'scene', icon: 'layout' },
  { kind: 'category', id: 'beats', label: 'Beat', cardKind: 'beat', icon: 'list-ordered' }
];

export class CodexTreeProvider implements vscode.TreeDataProvider<CodexNode> {
  private readonly emitter = new vscode.EventEmitter<CodexNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getStorage: () => LoreDockStorage | undefined) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: CodexNode): vscode.TreeItem {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = `loredock.${element.id}`;
      return item;
    }

    if (element.kind === 'entry') {
      const item = new vscode.TreeItem(element.entry.card.name, vscode.TreeItemCollapsibleState.None);
      item.description = describeCard(element.entry.card);
      item.tooltip = element.entry.relativePath;
      item.iconPath = new vscode.ThemeIcon(iconForCard(element.entry.card));
      item.contextValue = 'loredock.codexEntry';
      item.command = {
        command: 'loredock.openCodexEntry',
        title: '打开资料卡',
        arguments: [element]
      };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  public async getChildren(element?: CodexNode): Promise<CodexNode[]> {
    const storage = this.getStorage();
    if (!storage) {
      return [{ kind: 'empty', label: '请先打开一个文件夹' }];
    }

    if (!(await storage.manifestExists())) {
      return [{ kind: 'empty', label: '初始化后可管理资料库' }];
    }

    if (!element) {
      return CATEGORIES;
    }

    if (element.kind === 'category') {
      const entries = await storage.listCodexEntries(element.cardKind);
      return entries.map((entry) => ({ kind: 'entry', entry }));
    }

    return [];
  }
}

export function isCodexEntryNode(value: unknown): value is CodexEntryNode {
  return Boolean(value && typeof value === 'object' && (value as CodexEntryNode).kind === 'entry');
}

function describeCard(card: CodexCard): string {
  if (card.kind === 'character') {
    return card.identity || card.currentState || undefinedText(card.allowInContext);
  }
  if (card.kind === 'location') {
    return card.type || card.region || undefinedText(card.allowInContext);
  }
  if (card.kind === 'world-rule') {
    return card.importance === 'absolute' ? '绝对禁止违反' : card.importance === 'important' ? '重要' : '普通';
  }
  if (card.kind === 'foreshadowing') {
    return `${card.status} · ${card.importance}`;
  }
  if (card.kind === 'scene') {
    return card.chapterId || card.location || `场景 ${card.order}`;
  }
  if (card.kind === 'beat') {
    const beat = card as unknown as { status?: string; order?: number };
    return beat.status || `Beat ${beat.order ?? ''}`;
  }
  return '';
}

function undefinedText(allowInContext: boolean): string {
  return allowInContext ? '' : '不进入上下文';
}

function iconForCard(card: CodexCard): string {
  if (card.kind === 'character') {
    return 'person';
  }
  if (card.kind === 'location') {
    return 'map';
  }
  if (card.kind === 'world-rule') {
    return 'symbol-boolean';
  }
  if (card.kind === 'foreshadowing') {
    return 'symbol-key';
  }
  if (card.kind === 'scene') {
    return 'layout';
  }
  return 'list-ordered';
}
