import * as vscode from 'vscode';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

interface DiffBlock {
  index: number;
  original: string;
  revised: string;
  changed: boolean;
}

export function showDiffApplyPanel(original: string, revised: string, title: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('loredock.diffApply', `LoreDock 分段应用：${title}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    let settled = false;
    const finish = (content: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(content);
      panel.dispose();
    };

    panel.webview.html = renderDiffApplyPanel(original, revised, title);
    panel.webview.onDidReceiveMessage((message: { command?: string; content?: string }) => {
      if (message.command === 'cancel') {
        finish(undefined);
      }
      if (message.command === 'apply') {
        finish(message.content ?? revised);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}

function renderDiffApplyPanel(original: string, revised: string, title: string): string {
  const scriptNonce = nonce();
  const blocks = buildBlocks(original, revised);
  const rows = blocks.map(renderBlock).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 分段应用</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { font-size: 17px; margin: 0; }
    main { padding: 14px 20px 96px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .block { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
    .block header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
    .block h2 { font-size: 13px; margin: 0; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .cell { padding: 10px 12px; min-height: 56px; white-space: pre-wrap; line-height: 1.55; font-family: var(--vscode-editor-font-family); border-right: 1px solid var(--vscode-panel-border); }
    .cell:last-child { border-right: 0; }
    .label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; font-family: var(--vscode-font-family); }
    .unchanged { opacity: 0.78; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); display: flex; justify-content: flex-end; gap: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 8px 12px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .cell { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); } .cell:last-child { border-bottom: 0; } }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(title)}</h1></header>
  <main>
    <div class="toolbar">
      <button class="secondary" id="all-revised">全部使用 AI 改稿</button>
      <button class="secondary" id="all-original">全部保留原文</button>
    </div>
    ${rows}
  </main>
  <div class="bar"><button class="secondary" id="cancel">取消</button><button id="apply">应用勾选段落</button></div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const blocks = ${scriptJson(blocks)};
    function setAll(value) {
      document.querySelectorAll('input[data-index]').forEach((input) => {
        input.checked = value;
      });
    }
    document.getElementById('all-revised').addEventListener('click', () => setAll(true));
    document.getElementById('all-original').addEventListener('click', () => setAll(false));
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
    document.getElementById('apply').addEventListener('click', () => {
      const content = blocks.map((block) => {
        const input = document.querySelector('input[data-index="' + block.index + '"]');
        return input && input.checked ? block.revised : block.original;
      }).join('\\n\\n');
      vscode.postMessage({ command: 'apply', content });
    });
  </script>
</body>
</html>`;
}

function buildBlocks(original: string, revised: string): DiffBlock[] {
  const originalBlocks = splitBlocks(original);
  const revisedBlocks = splitBlocks(revised);
  const count = Math.max(originalBlocks.length, revisedBlocks.length);
  const blocks: DiffBlock[] = [];
  for (let index = 0; index < count; index += 1) {
    const originalBlock = originalBlocks[index] ?? '';
    const revisedBlock = revisedBlocks[index] ?? '';
    blocks.push({
      index,
      original: originalBlock,
      revised: revisedBlock,
      changed: originalBlock.trim() !== revisedBlock.trim()
    });
  }
  return blocks;
}

function splitBlocks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [''];
  }
  return trimmed.split(/\n{2,}/).map((block) => block.trim());
}

function renderBlock(block: DiffBlock): string {
  const checked = block.changed ? 'checked' : '';
  const className = block.changed ? '' : ' unchanged';
  return `<section class="block${className}">
    <header>
      <input type="checkbox" data-index="${block.index}" ${checked}>
      <h2>第 ${block.index + 1} 段${block.changed ? '' : '（无明显变化）'}</h2>
    </header>
    <div class="grid">
      <div class="cell"><span class="label">原文</span>${escapeHtml(block.original || ' ')}</div>
      <div class="cell"><span class="label">AI 改稿</span>${escapeHtml(block.revised || ' ')}</div>
    </div>
  </section>`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
