import * as vscode from 'vscode';
import { AIJobRecord } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export type HistoryAction = 'clear' | 'close';

export function showHistoryPanel(records: AIJobRecord[]): Promise<HistoryAction> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('loredock.history', 'LoreDock AI 历史', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    let settled = false;
    const finish = (action: HistoryAction) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(action);
      panel.dispose();
    };
    panel.webview.html = renderHistory(records);
    panel.webview.onDidReceiveMessage(async (message: { command?: string; content?: string }) => {
      if (message.command === 'copy' && message.content !== undefined) {
        await vscode.env.clipboard.writeText(message.content);
      }
      if (message.command === 'clear') {
        finish('clear');
      }
    });
    panel.onDidDispose(() => finish('close'));
  });
}

function renderHistory(records: AIJobRecord[]): string {
  const scriptNonce = nonce();
  const items = records.length
    ? records.map((record, index) => renderRecord(record, index)).join('')
    : '<p class="empty">还没有 AI 操作历史。</p>';
  const outputsJson = JSON.stringify(records.map((record) => record.output)).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock AI 历史</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1 { font-size: 18px; margin: 0; }
    main { padding: 12px 20px 24px; }
    details { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 10px 0; background: var(--vscode-sideBar-background); }
    summary { padding: 10px 12px; cursor: pointer; font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-left: 8px; }
    pre { white-space: pre-wrap; margin: 0; padding: 0 12px 12px; line-height: 1.55; font-family: var(--vscode-editor-font-family); }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 7px 10px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .actions { padding: 0 12px 12px; }
    .empty { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <header>
    <h1>AI 历史</h1>
    <button class="secondary" id="clear">清空历史</button>
  </header>
  <main>${items}</main>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const outputs = ${outputsJson};
    document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ command: 'clear' }));
    document.querySelectorAll('button[data-copy]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'copy', content: outputs[Number(button.dataset.copy)] || '' }));
    });
  </script>
</body>
</html>`;
}

function renderRecord(record: AIJobRecord, index: number): string {
  const title = `${labelTask(record.taskType)}${record.chapterTitle ? ` · ${record.chapterTitle}` : ''}`;
  return `<details>
    <summary>${escapeHtml(title)}<span class="meta">${escapeHtml(record.createdAt)} · ${escapeHtml(record.model)} · ${escapeHtml(record.action)}</span></summary>
    <div class="actions"><button data-copy="${index}">复制输出</button></div>
    <pre>${escapeHtml(record.output)}</pre>
  </details>`;
}

function labelTask(taskType: string): string {
  if (taskType === 'continue') {
    return '续写';
  }
  if (taskType === 'polish') {
    return '润色';
  }
  if (taskType === 'summary') {
    return '摘要';
  }
  if (taskType === 'consistency') {
    return '一致性检查';
  }
  return taskType;
}
