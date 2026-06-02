import * as vscode from 'vscode';
import { LoreDockStorage } from '../core/storage';

type AIStatusNode = ModelNode | EmptyNode;

interface ModelNode {
  kind: 'model';
  provider: string;
  model: string;
  baseUrl: string;
}

interface EmptyNode {
  kind: 'empty';
  label: string;
}

export class AIStatusTreeProvider implements vscode.TreeDataProvider<AIStatusNode> {
  private readonly emitter = new vscode.EventEmitter<AIStatusNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getStorage: () => LoreDockStorage | undefined) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: AIStatusNode): vscode.TreeItem {
    if (element.kind === 'model') {
      const item = new vscode.TreeItem(element.model || '未选择模型', vscode.TreeItemCollapsibleState.None);
      item.description = element.provider;
      item.tooltip = `${element.provider}\n${element.model || '未选择模型'}\n${element.baseUrl || '未配置 baseUrl'}\n\n点击切换模型`;
      item.iconPath = new vscode.ThemeIcon('sparkle');
      item.contextValue = 'loredock.aiModel';
      item.command = {
        command: 'loredock.selectAIModel',
        title: '选择 AI 模型'
      };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    item.contextValue = 'loredock.aiEmpty';
    item.command = {
      command: 'loredock.openSettings',
      title: '打开 LoreDock 设置'
    };
    return item;
  }

  public async getChildren(): Promise<AIStatusNode[]> {
    const storage = this.getStorage();
    if (!storage) {
      return [{ kind: 'empty', label: '请先打开文件夹' }];
    }
    if (!(await storage.manifestExists())) {
      return [{ kind: 'empty', label: '初始化后配置 AI' }];
    }
    const config = await storage.readAIConfig();
    const provider = config.activeProvider;
    const providerConfig = config.providers[provider] ?? (provider === 'anthropic' ? config.providers.claude : undefined);
    return [
      {
        kind: 'model',
        provider,
        model: providerConfig?.model || '未选择模型',
        baseUrl: providerConfig?.baseUrl || ''
      }
    ];
  }
}
