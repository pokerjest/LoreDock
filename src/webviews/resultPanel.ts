import * as vscode from 'vscode';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export type ResultMode = 'continue' | 'polish' | 'summary' | 'consistency';

export interface ResultPanelOptions {
  title: string;
  mode: ResultMode;
  output: string;
  original?: string;
}

export interface AIResultAction {
  kind: 'append' | 'insert' | 'replace' | 'copy' | 'save-summary' | 'regenerate' | 'discard' | 'diff' | 'apply-blocks';
  content: string;
}

export function showResultPanel(options: ResultPanelOptions): Promise<AIResultAction> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('loredock.aiResult', `LoreDock AI 结果：${options.title}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true
    });

    let settled = false;
    const finish = (action: AIResultAction) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(action);
      panel.dispose();
    };

    panel.webview.html = renderResultPanel(options);
    panel.webview.onDidReceiveMessage((message: { command?: AIResultAction['kind']; content?: string }) => {
      if (!message.command) {
        return;
      }
      finish({
        kind: message.command,
        content: message.content ?? options.output
      });
    });
    panel.onDidDispose(() => finish({ kind: 'discard', content: options.output }));
  });
}

function renderResultPanel(options: ResultPanelOptions): string {
  const scriptNonce = nonce();
  const buttons = renderButtons(options.mode);
  const comparison =
    options.mode === 'polish' && options.original
      ? `<section class="compare">
          <div>
            <h2>原文</h2>
            <pre>${escapeHtml(options.original)}</pre>
          </div>
          <div>
            <h2>AI 改稿</h2>
            <pre id="preview">${escapeHtml(options.output)}</pre>
          </div>
        </section>`
      : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock AI 结果</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { font-size: 17px; margin: 0; font-weight: 600; }
    h2 { font-size: 13px; margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
    main { padding: 14px 20px 96px; }
    textarea { width: 100%; min-height: 360px; box-sizing: border-box; resize: vertical; color: var(--vscode-editor-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 12px; line-height: 1.55; font-family: var(--vscode-editor-font-family); }
    .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    pre { white-space: pre-wrap; margin: 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); line-height: 1.55; font-family: var(--vscode-editor-font-family); max-height: 360px; overflow: auto; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 8px 12px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    @media (max-width: 760px) { .compare { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(options.title)}</h1></header>
  <main>
    ${comparison}
    <h2>可编辑结果</h2>
    <textarea id="content">${escapeHtml(options.output)}</textarea>
  </main>
  <div class="bar">${buttons}</div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ command: button.dataset.action, content: content.value });
      });
    });
  </script>
</body>
</html>`;
}

function renderButtons(mode: ResultMode): string {
  const shared = [
    `<button class="secondary" data-action="copy">复制</button>`,
    `<button class="secondary" data-action="regenerate">重新生成</button>`,
    `<button class="secondary" data-action="discard">丢弃</button>`
  ];
  if (mode === 'continue') {
    return [
      `<button data-action="append">追加到章节末尾</button>`,
      `<button data-action="insert">插入到光标处</button>`,
      ...shared
    ].join('');
  }
  if (mode === 'polish') {
    return [
      `<button class="secondary" data-action="diff">打开 Diff</button>`,
      `<button data-action="apply-blocks">分段应用</button>`,
      `<button data-action="replace">替换选区</button>`,
      `<button data-action="insert">插入到选区后</button>`,
      ...shared
    ].join('');
  }
  if (mode === 'consistency') {
    return shared.join('');
  }
  return [`<button data-action="save-summary">保存摘要</button>`, ...shared].join('');
}
