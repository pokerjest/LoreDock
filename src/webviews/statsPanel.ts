import * as vscode from 'vscode';
import { CHAPTER_STATUS_LABELS } from '../core/constants';
import { WritingStats } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export function showStatsPanel(stats: WritingStats): void {
  const panel = vscode.window.createWebviewPanel('loredock.stats', `LoreDock 写作统计：${stats.projectTitle}`, vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  const scriptNonce = nonce();
  const statusRows = Object.entries(stats.statusCounts)
    .map(([status, count]) => `<tr><td>${escapeHtml(CHAPTER_STATUS_LABELS[status] ?? status)}</td><td>${count}</td></tr>`)
    .join('');
  const volumeRows = stats.volumes
    .map((volume) => `<tr><td>${escapeHtml(volume.title)}</td><td>${volume.chapterCount}</td><td>${volume.wordCount}</td></tr>`)
    .join('');
  const dailyGoal = stats.goals?.dailyWordTarget ?? 0;
  const totalGoal = stats.goals?.totalWordTarget ?? 0;
  const dailyProgress = dailyGoal > 0 ? `${Math.round((stats.dailyGoalProgress ?? 0) * 100)}%` : '未设置';
  const totalProgress = totalGoal > 0 ? `${Math.round((stats.totalGoalProgress ?? 0) * 100)}%` : '未设置';
  panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 写作统计</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; padding: 20px; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    h2 { font-size: 14px; margin: 22px 0 8px; color: var(--vscode-descriptionForeground); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; background: var(--vscode-sideBar-background); }
    .value { display: block; font-size: 24px; font-weight: 650; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); text-align: left; padding: 8px; }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  </style>
</head>
<body>
  <h1>${escapeHtml(stats.projectTitle)} · 写作统计</h1>
  <section class="grid">
    <div class="metric">卷数<span class="value">${stats.volumeCount}</span></div>
    <div class="metric">章节<span class="value">${stats.chapterCount}</span></div>
    <div class="metric">总字数<span class="value">${stats.totalWordCount}</span></div>
    <div class="metric">今日修改章节字数<span class="value">${stats.modifiedTodayWordCount}</span></div>
  </section>
  <h2>写作目标</h2>
  <section class="grid">
    <div class="metric">每日目标<span class="value">${dailyGoal || '未设置'}</span></div>
    <div class="metric">今日进度<span class="value">${dailyProgress}</span></div>
    <div class="metric">总目标<span class="value">${totalGoal || '未设置'}</span></div>
    <div class="metric">总进度<span class="value">${totalProgress}</span></div>
  </section>
  <h2>各卷字数</h2>
  <table><thead><tr><th>卷</th><th>章节</th><th>字数</th></tr></thead><tbody>${volumeRows}</tbody></table>
  <h2>章节状态</h2>
  <table><thead><tr><th>状态</th><th>数量</th></tr></thead><tbody>${statusRows}</tbody></table>
</body>
</html>`;
}
