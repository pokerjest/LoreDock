import * as vscode from 'vscode';
import { ProjectHealthCategory, ProjectHealthIssue, ProjectHealthReport, ProjectHealthSeverity } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export type HealthPanelAction =
  | { command: 'refresh' }
  | { command: 'preview-fix' }
  | { command: 'fix' }
  | { command: 'save-baseline' }
  | { command: 'clear-baseline' }
  | { command: 'open-source'; source: string };

export function showHealthPanel(
  context: vscode.ExtensionContext,
  report: ProjectHealthReport,
  onAction: (action: HealthPanelAction) => Promise<ProjectHealthReport | undefined>
): void {
  const panel = vscode.window.createWebviewPanel('loredock.health', 'LoreDock 项目健康检查', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = (nextReport: ProjectHealthReport) => {
    report = nextReport;
    panel.webview.html = renderHealthPanel(report);
  };

  render(report);
  panel.webview.onDidReceiveMessage(async (action: HealthPanelAction) => {
    const nextReport = await onAction(action);
    if (nextReport) {
      render(nextReport);
    }
  }, undefined, context.subscriptions);
}

function renderHealthPanel(report: ProjectHealthReport): string {
  const scriptNonce = nonce();
  const activeIssues = report.issues.filter((issue) => !issue.ignored);
  const fixableCount = activeIssues.filter((issue) => issue.fixable).length;
  const issuesHtml = report.issues
    .map((issue) => renderIssue(issue))
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 项目健康检查</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    h1 { margin: 0 0 6px; font-size: 18px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
    .actions, .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button, select { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 6px 9px; font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border); }
    main { padding: 14px 18px 40px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .metric { border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); padding: 10px; }
    .metric strong { display: block; font-size: 22px; margin-top: 2px; }
    .issue { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; margin: 8px 0; background: var(--vscode-sideBar-background); }
    .issue.ignored { opacity: 0.58; }
    .line { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .title { font-weight: 650; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .badge { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .warning { color: var(--vscode-editorWarning-foreground); }
    .info { color: var(--vscode-textLink-foreground); }
    .detail { margin-top: 7px; line-height: 1.55; }
    .source { margin-top: 6px; }
    .link { color: var(--vscode-textLink-foreground); background: transparent; border: 0; padding: 0; text-align: left; }
    .empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(report.projectTitle)} · 项目健康检查</h1>
      <div class="meta">生成时间：${escapeHtml(report.generatedAt)} · 新增/未忽略：${report.newCount} · 已忽略：${report.ignoredCount} · 可安全修复：${fixableCount}</div>
    </div>
    <div class="actions">
      <button class="secondary" data-command="refresh">刷新</button>
      <button class="secondary" data-command="preview-fix">预览修复</button>
      <button data-command="fix">执行安全修复</button>
      <button class="secondary" data-command="save-baseline">设为基线</button>
      <button class="secondary" data-command="clear-baseline">清空基线</button>
    </div>
  </header>
  <main>
    <section class="summary">
      <div class="metric">错误<strong>${report.summary.error}</strong></div>
      <div class="metric">警告<strong>${report.summary.warning}</strong></div>
      <div class="metric">提示<strong>${report.summary.info}</strong></div>
      <div class="metric">总问题<strong>${report.issues.length}</strong></div>
    </section>
    <section class="filters">
      <select id="severity"><option value="all">全部严重程度</option>${severityOptions()}</select>
      <select id="category"><option value="all">全部类别</option>${categoryOptions()}</select>
      <select id="ignored"><option value="active">只看新增/未忽略</option><option value="all">包含已忽略</option><option value="ignored">只看已忽略</option></select>
    </section>
    <section id="issues">${issuesHtml || '<div class="empty">未发现结构问题。</div>'}</section>
  </main>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
    document.querySelectorAll('[data-source]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'open-source', source: button.dataset.source }));
    });
    const filters = ['severity', 'category', 'ignored'].map((id) => document.getElementById(id));
    filters.forEach((filter) => filter.addEventListener('change', applyFilters));
    function applyFilters() {
      const severity = document.getElementById('severity').value;
      const category = document.getElementById('category').value;
      const ignored = document.getElementById('ignored').value;
      document.querySelectorAll('.issue').forEach((item) => {
        const okSeverity = severity === 'all' || item.dataset.severity === severity;
        const okCategory = category === 'all' || item.dataset.category === category;
        const okIgnored = ignored === 'all' || (ignored === 'ignored' ? item.dataset.ignored === 'true' : item.dataset.ignored !== 'true');
        item.style.display = okSeverity && okCategory && okIgnored ? '' : 'none';
      });
    }
    applyFilters();
  </script>
</body>
</html>`;
}

function renderIssue(issue: ProjectHealthIssue): string {
  const sources = splitSources(issue.source);
  return `<article class="issue ${issue.ignored ? 'ignored' : ''}" data-severity="${issue.severity}" data-category="${issue.category}" data-ignored="${issue.ignored ? 'true' : 'false'}">
    <div class="line">
      <div class="title ${issue.severity}">${escapeHtml(issue.title)}</div>
      <div class="badges">
        <span class="badge">${severityLabel(issue.severity)}</span>
        <span class="badge">${categoryLabel(issue.category)}</span>
        ${issue.fixable ? '<span class="badge">可安全修复</span>' : ''}
        ${issue.ignored ? '<span class="badge">基线忽略</span>' : ''}
      </div>
    </div>
    <div class="detail">${escapeHtml(issue.detail)}</div>
    <div class="detail">建议：${escapeHtml(issue.suggestion)}</div>
    <div class="source">来源：${sources.length ? sources.map((source) => `<button class="link" data-source="${escapeHtml(source)}">${escapeHtml(source)}</button>`).join('、') : '未指定'}</div>
  </article>`;
}

function splitSources(source: string | undefined): string[] {
  return (source || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function severityOptions(): string {
  return (['error', 'warning', 'info'] as ProjectHealthSeverity[])
    .map((severity) => `<option value="${severity}">${severityLabel(severity)}</option>`)
    .join('');
}

function categoryOptions(): string {
  return (['manuscript', 'codex', 'plan', 'timeline', 'foreshadowing', 'references'] as ProjectHealthCategory[])
    .map((category) => `<option value="${category}">${categoryLabel(category)}</option>`)
    .join('');
}

function severityLabel(severity: ProjectHealthSeverity): string {
  return ({ error: '错误', warning: '警告', info: '提示' } satisfies Record<ProjectHealthSeverity, string>)[severity];
}

function categoryLabel(category: ProjectHealthCategory): string {
  return ({
    manuscript: '手稿',
    codex: '资料库',
    plan: '规划',
    timeline: '时间线',
    foreshadowing: '伏笔',
    references: '引用'
  } satisfies Record<ProjectHealthCategory, string>)[category];
}
