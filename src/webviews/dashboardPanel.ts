import * as vscode from 'vscode';
import { CHAPTER_STATUS_LABELS } from '../core/constants';
import { ProjectDashboard, ProjectHealthSeverity } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export type DashboardPanelAction =
  | { command: 'refresh' }
  | { command: 'show-health' }
  | { command: 'show-stats' }
  | { command: 'open-source'; source: string };

export function showDashboardPanel(
  context: vscode.ExtensionContext,
  dashboard: ProjectDashboard,
  onAction: (action: DashboardPanelAction) => Promise<ProjectDashboard | undefined>
): void {
  const panel = vscode.window.createWebviewPanel('loredock.dashboard', 'LoreDock 项目仪表盘', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = (nextDashboard: ProjectDashboard) => {
    dashboard = nextDashboard;
    panel.webview.html = renderDashboard(dashboard);
  };

  render(dashboard);
  panel.webview.onDidReceiveMessage(async (action: DashboardPanelAction) => {
    const nextDashboard = await onAction(action);
    if (nextDashboard) {
      render(nextDashboard);
    }
  }, undefined, context.subscriptions);
}

function renderDashboard(dashboard: ProjectDashboard): string {
  const scriptNonce = nonce();
  const statusRows = Object.entries(dashboard.stats.statusCounts)
    .map(([status, count]) => `<tr><td>${escapeHtml(CHAPTER_STATUS_LABELS[status] ?? status)}</td><td>${count}</td></tr>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 项目仪表盘</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    h1 { margin: 0 0 5px; font-size: 18px; }
    h2 { margin: 0 0 10px; font-size: 14px; color: var(--vscode-descriptionForeground); }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
    main { padding: 14px 18px 40px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 6px 9px; font: inherit; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .metric, section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); padding: 12px; }
    .metric span { display: block; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .metric strong { display: block; font-size: 24px; margin-top: 3px; }
    .columns { display: grid; grid-template-columns: minmax(260px, 1.25fr) minmax(240px, 1fr); gap: 10px; margin-top: 10px; }
    ul { margin: 0; padding-left: 18px; line-height: 1.55; }
    li { margin: 5px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); text-align: left; padding: 6px; }
    .error { color: var(--vscode-errorForeground); }
    .warning { color: var(--vscode-editorWarning-foreground); }
    .info { color: var(--vscode-textLink-foreground); }
    .link { color: var(--vscode-textLink-foreground); background: transparent; border: 0; padding: 0; text-align: left; }
    .empty { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(dashboard.projectTitle)} · 项目仪表盘</h1>
      <div class="meta">生成时间：${escapeHtml(dashboard.generatedAt)}</div>
    </div>
    <div class="actions">
      <button class="secondary" data-command="refresh">刷新</button>
      <button data-command="show-health">打开健康面板</button>
      <button class="secondary" data-command="show-stats">写作统计</button>
    </div>
  </header>
  <main>
    <section class="grid">
      <div class="metric"><span>总字数</span><strong>${dashboard.stats.totalWordCount}</strong></div>
      <div class="metric"><span>章节</span><strong>${dashboard.stats.chapterCount}</strong></div>
      <div class="metric"><span>未忽略错误</span><strong>${dashboard.health.summary.error}</strong></div>
      <div class="metric"><span>未忽略警告</span><strong>${dashboard.health.summary.warning}</strong></div>
      <div class="metric"><span>今日修改章节字数</span><strong>${dashboard.stats.modifiedTodayWordCount}</strong></div>
    </section>
    <div class="columns">
      <section>
        <h2>最需要处理的问题</h2>
        ${dashboard.topIssues.length ? `<ul>${dashboard.topIssues.map((issue) => `<li><span class="${issue.severity}">${severityLabel(issue.severity)}</span> · ${escapeHtml(issue.title)}${issue.source ? ` · <button class="link" data-source="${escapeHtml(firstSource(issue.source))}">${escapeHtml(firstSource(issue.source))}</button>` : ''}</li>`).join('')}</ul>` : '<div class="empty">暂无未忽略问题。</div>'}
      </section>
      <section>
        <h2>章节状态</h2>
        <table><tbody>${statusRows}</tbody></table>
      </section>
      <section>
        <h2>近期修改章节</h2>
        ${dashboard.recentChapters.length ? `<ul>${dashboard.recentChapters.map((ref) => `<li><button class="link" data-source="${escapeHtml(ref.chapter.filePath)}">${escapeHtml(ref.volume.title)} / ${escapeHtml(ref.chapter.title)}</button></li>`).join('')}</ul>` : '<div class="empty">暂无最近修改记录。</div>'}
      </section>
      <section>
        <h2>重要但未引用资料</h2>
        ${dashboard.unreferencedImportantCards.length ? `<ul>${dashboard.unreferencedImportantCards.map((entry) => `<li><button class="link" data-source="${escapeHtml(entry.relativePath)}">${escapeHtml(entry.card.name)}</button></li>`).join('')}</ul>` : '<div class="empty">暂无重要未引用资料。</div>'}
      </section>
      <section>
        <h2>需要留意的伏笔</h2>
        ${dashboard.overdueForeshadowing.length ? `<ul>${dashboard.overdueForeshadowing.map((card) => `<li>${escapeHtml(card.name)} · ${escapeHtml(card.status)}</li>`).join('')}</ul>` : '<div class="empty">暂无过期伏笔提醒。</div>'}
      </section>
    </div>
  </main>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
    document.querySelectorAll('[data-source]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'open-source', source: button.dataset.source }));
    });
  </script>
</body>
</html>`;
}

function firstSource(source: string): string {
  return source.split(',')[0]?.trim() || source;
}

function severityLabel(severity: ProjectHealthSeverity): string {
  return ({ error: '错误', warning: '警告', info: '提示' } satisfies Record<ProjectHealthSeverity, string>)[severity];
}
