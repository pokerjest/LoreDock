import * as vscode from 'vscode';
import { BeatPlan, ChapterRef, CodexCard, OutlineDocument, ScenePlan } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export interface PlanPanelChapter {
  ref: ChapterRef;
  scenes: ScenePlan[];
  beats: BeatPlan[];
}

export interface PlanPanelState {
  title: string;
  chapters: PlanPanelChapter[];
  outlines: OutlineDocument[];
  outlineScenes: ScenePlan[];
  outlineBeats: BeatPlan[];
  codexCards: CodexCard[];
  references: Map<string, Set<string>>;
}

export type PlanPanelAction =
  | { command: 'import-outline' }
  | { command: 'open-blueprint' }
  | { command: 'refresh' };

export function showPlanPanel(
  context: vscode.ExtensionContext,
  state: PlanPanelState,
  onAction: (action: PlanPanelAction) => Promise<PlanPanelState>
): void {
  const panel = vscode.window.createWebviewPanel('loredock.plan', 'LoreDock Plan / Matrix', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = (nextState: PlanPanelState) => {
    state = nextState;
    panel.webview.html = renderPlanPanel(state);
  };

  render(state);
  panel.webview.onDidReceiveMessage(async (action: PlanPanelAction) => {
    render(await onAction(action));
  }, undefined, context.subscriptions);
}

function renderPlanPanel(state: PlanPanelState): string {
  const scriptNonce = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock Plan</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    h1 { font-size: 17px; margin: 0; }
    .tabs, .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 7px 10px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary, .tab { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .tab.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    main { padding: 14px 18px 40px; }
    section { display: none; }
    section.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); padding: 10px; min-width: 0; }
    .card h2, .card h3 { font-size: 13px; margin: 0 0 8px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .scene { border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 8px; margin: 8px 0; }
    .beat { border-left: 3px solid var(--vscode-testing-iconPassed); padding-left: 8px; margin: 6px 0; color: var(--vscode-descriptionForeground); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-sideBar-background); }
    .hit { color: var(--vscode-testing-iconPassed); font-weight: 700; }
    .outline { line-height: 1.65; white-space: pre-wrap; }
    .empty { color: var(--vscode-descriptionForeground); padding: 18px 0; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(state.title)} · Plan / Matrix</h1>
      <div class="meta">手稿 ${state.chapters.length} 章 · 独立大纲 ${state.outlines.length} 份 · 规划场景 ${state.chapters.reduce((sum, item) => sum + item.scenes.length, 0) + state.outlineScenes.length} · Beat ${state.chapters.reduce((sum, item) => sum + item.beats.length, 0) + state.outlineBeats.length}</div>
    </div>
    <div class="actions">
      <button class="secondary" data-command="import-outline">导入独立大纲</button>
      <button class="secondary" data-command="open-blueprint">打开大纲蓝图</button>
      <button class="secondary" data-command="refresh">刷新</button>
    </div>
  </header>
  <main>
    <div class="tabs">
      <button class="tab active" data-tab="grid">Grid</button>
      <button class="tab" data-tab="matrix">Matrix</button>
      <button class="tab" data-tab="outline">Outline</button>
    </div>
    <section id="grid" class="active">${renderGrid(state)}</section>
    <section id="matrix">${renderMatrix(state)}</section>
    <section id="outline">${renderOutline(state)}</section>
  </main>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
        document.querySelectorAll('section').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        document.getElementById(button.dataset.tab).classList.add('active');
      });
    });
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`;
}

function renderGrid(state: PlanPanelState): string {
  const manuscript = state.chapters.length
    ? `<h2>手稿结构</h2><div class="grid">${state.chapters.map((item) => `
    <article class="card">
      <h2>${escapeHtml(item.ref.volume.title)} / ${escapeHtml(item.ref.chapter.title)}</h2>
      <div class="meta">${escapeHtml(item.ref.chapter.status)} · ${item.ref.chapter.wordCount} 字</div>
      ${item.scenes.length ? item.scenes.map((scene) => renderScene(scene, item.beats.filter((beat) => beat.sceneId === scene.id || beat.chapterId === item.ref.chapter.id))).join('') : '<div class="empty">无场景计划</div>'}
    </article>
  `).join('')}</div>`
    : '<h2>手稿结构</h2><div class="empty">还没有手稿章节。</div>';
  const outlines = state.outlines.length
    ? `<h2>独立大纲</h2><div class="grid">${state.outlines.map((outline) => renderOutlineCard(outline, state)).join('')}</div>`
    : '<h2>独立大纲</h2><div class="empty">还没有独立大纲。</div>';
  return `${manuscript}${outlines}`;
}

function renderScene(scene: ScenePlan, beats: BeatPlan[]): string {
  return `<div class="scene">
    <h3>${escapeHtml(scene.name)}</h3>
    <div class="meta">POV：${escapeHtml(scene.viewpointCharacter || '未填')} · 地点：${escapeHtml(scene.location || '未填')} · 顺序：${scene.order}</div>
    <div>${escapeHtml(scene.conflict || scene.summary || '')}</div>
    ${beats.map((beat) => `<div class="beat">${beat.order}. ${escapeHtml(beat.content || beat.name)}</div>`).join('')}
  </div>`;
}

function renderMatrix(state: PlanPanelState): string {
  const tracked = state.codexCards.filter((card) => ['character', 'location', 'world-rule', 'foreshadowing'].includes(card.kind)).slice(0, 40);
  if (tracked.length === 0) {
    return '<div class="empty">资料库还没有可追踪条目。</div>';
  }
  return `<table>
    <thead><tr><th>资料卡</th>${state.chapters.map((item) => `<th>${escapeHtml(item.ref.chapter.title)}</th>`).join('')}</tr></thead>
    <tbody>${tracked.map((card) => `<tr><th>${escapeHtml(card.name)}<div class="meta">${escapeHtml(card.kind)}</div></th>${state.chapters.map((item) => {
      const refs = state.references.get(`${card.id}|${item.ref.chapter.id}`);
      return `<td>${refs?.size ? `<span class="hit">${refs.size}</span><div class="meta">${escapeHtml([...refs].slice(0, 3).join(' / '))}</div>` : ''}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

function renderOutline(state: PlanPanelState): string {
  const manuscriptOutline = state.chapters.map((item) => [
    `# 手稿：${item.ref.volume.title} / ${item.ref.chapter.title}`,
    ...item.scenes.map((scene) => [
      `## ${scene.name}`,
      scene.summary || scene.conflict || '',
      scene.viewpointCharacter ? `POV：${scene.viewpointCharacter}` : '',
      scene.location ? `地点：${scene.location}` : '',
      ...item.beats.filter((beat) => beat.sceneId === scene.id || beat.chapterId === item.ref.chapter.id).map((beat) => `- ${beat.content || beat.name}`)
    ].filter(Boolean).join('\n'))
  ].join('\n')).join('\n\n');
  const importedOutlines = state.outlines.map((outline) => `# 独立大纲：${outline.title}\n\n${outline.rawText}`).join('\n\n');
  return `<div class="outline">${escapeHtml([manuscriptOutline, importedOutlines].filter(Boolean).join('\n\n')) || '<span class="empty">还没有手稿规划或独立大纲。</span>'}</div>`;
}

function renderOutlineCard(outline: OutlineDocument, state: PlanPanelState): string {
  const scenes = state.outlineScenes.filter((scene) => scene.outlineId === outline.id);
  const beats = state.outlineBeats.filter((beat) => beat.outlineId === outline.id);
  const volumes = outline.nodes.filter((node) => node.type === 'volume').length;
  const chapters = outline.nodes.filter((node) => node.type === 'chapter').length;
  return `<article class="card">
    <h2>${escapeHtml(outline.title)}</h2>
    <div class="meta">${volumes} 卷 · ${chapters} 大纲章节 · ${scenes.length} 场景 · ${beats.length} Beat</div>
    ${scenes.length ? scenes.map((scene) => renderScene(scene, beats.filter((beat) => beat.sceneId === scene.id || beat.outlineChapterTitle === scene.outlineChapterTitle))).join('') : `<div class="outline">${escapeHtml(outline.rawText.slice(0, 1000))}</div>`}
  </article>`;
}
