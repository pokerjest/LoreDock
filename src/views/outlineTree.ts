import * as vscode from 'vscode';
import { LoreDockStorage } from '../core/storage';
import { OutlineDocument } from '../types';

export type OutlineTreeNode = OutlineDocumentNode | EmptyOutlineNode;

export interface OutlineDocumentNode {
  kind: 'outline';
  outline: OutlineDocument;
}

interface EmptyOutlineNode {
  kind: 'empty';
  label: string;
}

export class OutlineTreeProvider implements vscode.TreeDataProvider<OutlineTreeNode> {
  private readonly emitter = new vscode.EventEmitter<OutlineTreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getStorage: () => LoreDockStorage | undefined) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: OutlineTreeNode): vscode.TreeItem {
    if (element.kind === 'outline') {
      const item = new vscode.TreeItem(element.outline.title, vscode.TreeItemCollapsibleState.None);
      item.description = `${element.outline.nodes.length} 个节点`;
      item.tooltip = `.loredock/outlines / ${element.outline.title}`;
      item.contextValue = 'loredock.outline';
      item.iconPath = new vscode.ThemeIcon('type-hierarchy');
      item.command = {
        command: 'loredock.openBlueprintForOutline',
        title: '打开大纲蓝图',
        arguments: [element]
      };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'loredock.empty';
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  public async getChildren(element?: OutlineTreeNode): Promise<OutlineTreeNode[]> {
    const storage = this.getStorage();
    if (!storage) {
      return [{ kind: 'empty', label: '请先打开一个文件夹' }];
    }
    if (!(await storage.manifestExists())) {
      return [{ kind: 'empty', label: '初始化后可管理大纲' }];
    }
    if (!element) {
      await storage.ensureBlueprintOutlineBindings();
      const outlines = await storage.listOutlines();
      return outlines.length
        ? outlines.map((outline) => ({ kind: 'outline', outline }))
        : [{ kind: 'empty', label: '暂无大纲' }];
    }
    return [];
  }
}

export function isOutlineDocumentNode(value: unknown): value is OutlineDocumentNode {
  return Boolean(value && typeof value === 'object' && (value as OutlineDocumentNode).kind === 'outline');
}
