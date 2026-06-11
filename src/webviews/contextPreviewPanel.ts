import * as vscode from 'vscode';
import { ContextPackage } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export function showContextPreview(context: vscode.ExtensionContext, contextPackage: ContextPackage): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'loredock.contextPreview',
      `LoreDock 上下文预览：${contextPackage.title}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    let settled = false;
    const finish = (value: string[] | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      panel.dispose();
    };

    panel.webview.html = renderContextPreview(panel.webview, context, contextPackage);
    panel.webview.onDidReceiveMessage((message: { command?: string; selectedIds?: string[] }) => {
      if (message.command === 'send') {
        finish(message.selectedIds ?? []);
      }
      if (message.command === 'cancel') {
        finish(undefined);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}

function renderContextPreview(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  contextPackage: ContextPackage
): string {
  const scriptNonce = nonce();
  const sections = contextPackage.sections
    .map(
      (section) => `
        <details open data-section="${escapeHtml(section.id)}">
          <summary>
            <label>
              <input type="checkbox" data-section-check="${escapeHtml(section.id)}" ${section.alwaysInclude ? 'checked disabled' : 'checked'}>
              ${escapeHtml(section.title)}${section.alwaysInclude ? '（必需）' : ''}
            </label>
          </summary>
          ${section.reason ? `<div class="reason">为什么发送：${escapeHtml(section.reason)}</div>` : ''}
          <pre>${escapeHtml(section.body)}</pre>
        </details>`
    )
    .join('\n');
  const omitted = contextPackage.omitted.length
    ? `<p class="warn">因长度限制省略：${escapeHtml(contextPackage.omitted.join('、'))}</p>`
    : '<p class="ok">未省略上下文。</p>';
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'loredock.svg'));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 上下文预览</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    img { width: 22px; height: 22px; }
    h1 { font-size: 17px; margin: 0; font-weight: 600; }
    main { padding: 14px 20px 90px; max-width: 980px; }
    details { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 10px 0; background: var(--vscode-sideBar-background); }
    summary { cursor: pointer; padding: 10px 12px; font-weight: 600; }
    .reason { color: var(--vscode-descriptionForeground); border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border), transparent 45%); padding: 8px 12px 0; line-height: 1.5; }
    label { cursor: pointer; }
    input { vertical-align: middle; margin-right: 8px; }
    pre { white-space: pre-wrap; margin: 0; padding: 0 12px 12px; line-height: 1.55; font-family: var(--vscode-editor-font-family); }
    .warn { color: var(--vscode-editorWarning-foreground); }
    .ok { color: var(--vscode-testing-iconPassed); }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); display: flex; justify-content: flex-end; gap: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 8px 12px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  </style>
</head>
<body>
  <header>
    <img src="${codicons}" alt="">
    <h1>${escapeHtml(contextPackage.title)} · 上下文预览</h1>
  </header>
  <main>
    ${omitted}
    ${sections}
  </main>
  <div class="bar">
    <button class="secondary" id="cancel">取消</button>
    <button id="send">发送给 AI</button>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('send').addEventListener('click', () => {
      const selectedIds = Array.from(document.querySelectorAll('input[data-section-check]'))
        .filter((input) => input.checked)
        .map((input) => input.dataset.sectionCheck);
      vscode.postMessage({ command: 'send', selectedIds });
    });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  </script>
</body>
</html>`;
}
