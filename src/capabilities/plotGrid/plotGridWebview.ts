import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import type { KernelContext } from "../../kernel/types";
import type { SceneCardMetadataPatch, SceneId } from "../outlineScenes/types";
import { PlotGridController } from "./controller";
import type { PlotGridFilters, PlotGridTrackInput, PlotGridViewPreferencesPatch } from "./types";

export interface PlotGridOpenTarget {
  workspaceFolder?: vscode.WorkspaceFolder;
  sceneId?: SceneId;
}

type PlotGridMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "setFilter"; filters: PlotGridFilters }
  | { type: "openSource"; rowId?: string; ref?: string }
  | { type: "updateTrack"; payload: PlotGridTrackInput }
  | { type: "deleteTrack"; trackId: string }
  | { type: "updateSceneMetadata"; sceneId: SceneId; patch: SceneCardMetadataPatch }
  | { type: "assignSceneTrack"; sceneId: SceneId; trackId: string; assigned: boolean }
  | { type: "reorderScenes"; chapterId: string; sceneIds: SceneId[] }
  | { type: "persistViewState"; patch: PlotGridViewPreferencesPatch };

interface PlotGridPanelState {
  panel: vscode.WebviewPanel;
  refresh(filters?: PlotGridFilters, target?: PlotGridOpenTarget): Promise<void>;
  changeDisposable: vscode.Disposable;
}

const plotGridPanels = new Map<string, PlotGridPanelState>();

export function openPlotGridWebview(context: KernelContext, controller: PlotGridController, target?: PlotGridOpenTarget): void {
  const panelKey = context.workspaceFolder.uri.fsPath;
  const existing = plotGridPanels.get(panelKey);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.One);
    void existing.refresh(target?.sceneId ? {} : undefined, target);
    return;
  }

  let currentFilters: PlotGridFilters = {};
  let pendingTarget = target;
  const panel = vscode.window.createWebviewPanel(
    "loredock.plotGrid",
    "剧情矩阵",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  const nonce = createNonce();
  panel.webview.html = buildPlotGridHtml(panel.webview, nonce);

  const refresh = async (filters: PlotGridFilters = currentFilters, target?: PlotGridOpenTarget): Promise<void> => {
    currentFilters = filters;
    await panel.webview.postMessage({
      type: "state",
      projection: await controller.getProjection(currentFilters),
      filters: currentFilters,
      focusSceneId: target?.sceneId
    });
  };

  const changeDisposable = controller.onDidChange(() => {
    void refresh();
  });
  plotGridPanels.set(panelKey, { panel, refresh, changeDisposable });
  panel.onDidDispose(() => {
    changeDisposable.dispose();
    plotGridPanels.delete(panelKey);
  });

  panel.webview.onDidReceiveMessage(async (message: PlotGridMessage) => {
    if (message.type === "ready") {
      const focusTarget = pendingTarget;
      pendingTarget = undefined;
      await refresh(focusTarget?.sceneId ? {} : undefined, focusTarget);
      return;
    }
    if (message.type === "refresh") {
      await refresh();
      return;
    }
    if (message.type === "setFilter") {
      await refresh(message.filters);
      return;
    }
    if (message.type === "openSource") {
      await openSource(context, controller, message.rowId, message.ref);
      return;
    }
    if (message.type === "updateTrack") {
      await controller.upsertTrack(message.payload);
      await refresh();
      return;
    }
    if (message.type === "deleteTrack") {
      await controller.deleteTrack(message.trackId);
      await refresh();
      return;
    }
    if (message.type === "updateSceneMetadata") {
      await controller.updateSceneMetadata(message.sceneId, message.patch);
      await refresh();
      return;
    }
    if (message.type === "assignSceneTrack") {
      await controller.assignSceneTrack(message.sceneId, message.trackId, message.assigned);
      await refresh();
      return;
    }
    if (message.type === "reorderScenes") {
      await controller.reorderChapterScenes(message.chapterId, message.sceneIds);
      await refresh();
      return;
    }
    if (message.type === "persistViewState") {
      await controller.updateViewPreferences(message.patch);
      await refresh();
    }
  });

}

export function buildPlotGridHtml(webview: vscode.Webview, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>剧情矩阵</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, var(--bg)));
      --line: var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      --line-soft: color-mix(in srgb, var(--line) 62%, transparent);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      --input-bg: var(--vscode-input-background, var(--bg));
      --control-bg: color-mix(in srgb, var(--input-bg) 72%, transparent);
      --control-border: color-mix(in srgb, var(--line) 78%, transparent);
      --button-bg: var(--vscode-button-secondaryBackground, var(--vscode-input-background, var(--panel)));
      --button-fg: var(--vscode-button-secondaryForeground, var(--text));
      --button-hover: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, var(--button-bg)));
      --row-hover: color-mix(in srgb, var(--accent) 14%, var(--bg));
      --row-focus-bg: rgba(0, 122, 204, 0.14);
      --chapter-bg: color-mix(in srgb, var(--panel) 80%, var(--bg));
      --scene-bg: color-mix(in srgb, var(--bg) 96%, var(--panel));
      --sticky-bg: color-mix(in srgb, var(--bg) 92%, var(--panel));
      --tree-line: color-mix(in srgb, var(--accent) 52%, var(--line));
      --chip-bg: color-mix(in srgb, var(--accent) 16%, transparent);
      --preview-overlay: rgba(0, 0, 0, 0.18);
    }
    * { box-sizing: border-box; }
    [hidden] {
      display: none !important;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      user-select: none;
    }
    button, input, select, textarea {
      font: inherit;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: grid;
      grid-template-columns: minmax(240px, 1fr) repeat(4, minmax(132px, auto));
      gap: 10px;
      align-items: end;
      padding: 12px 18px 10px;
      border-bottom: 1px solid var(--line-soft);
      background: var(--panel);
    }
    .field {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0;
    }
    input, select, textarea {
      min-width: 0;
      height: 28px;
      border: 1px solid var(--control-border);
      background: var(--control-bg);
      color: var(--text);
      padding: 3px 7px;
      border-radius: 4px;
      user-select: text;
    }
    input:hover, select:hover, textarea:hover {
      border-color: var(--line);
    }
    input:focus, select:focus, textarea:focus {
      outline: 1px solid var(--accent);
      outline-offset: -1px;
      border-color: var(--accent);
    }
    textarea {
      height: 46px;
      resize: vertical;
    }
    button {
      border: 1px solid var(--control-border);
      background: var(--button-bg);
      color: var(--button-fg);
      border-radius: 3px;
      padding: 4px 8px;
      min-height: 26px;
      cursor: pointer;
    }
    button:hover {
      background: var(--button-hover);
    }
    button[data-open-row] {
      min-height: 22px;
      padding: 1px 6px;
      border-color: transparent;
      background: transparent;
      color: var(--accent);
      font-weight: 600;
    }
    button[data-open-row]:hover {
      background: var(--row-hover);
    }
    .grid-wrap {
      overflow: auto;
      min-width: 0;
      min-height: 0;
    }
    table {
      width: max-content;
      min-width: 100%;
      border-collapse: separate;
      border-spacing: 0;
    }
    th, td {
      border-right: 1px solid var(--line-soft);
      border-bottom: 1px solid var(--line-soft);
      padding: 8px;
      vertical-align: top;
      max-width: 240px;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--chapter-bg);
      text-align: left;
      color: var(--accent);
      font-weight: 700;
      white-space: nowrap;
      padding-top: 7px;
      padding-bottom: 7px;
    }
    .sticky {
      position: sticky;
      left: 0;
      z-index: 4;
      background: var(--sticky-bg);
      min-width: 300px;
      max-width: 360px;
    }
    th.sticky {
      z-index: 6;
      background: var(--chapter-bg);
    }
    .structure-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .structure-header-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .collapse-all {
      flex: 0 0 auto;
      min-height: 22px;
      padding: 1px 7px;
      border-color: color-mix(in srgb, var(--accent) 28%, transparent);
      background: transparent;
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
    }
    .collapse-all:hover {
      background: var(--row-hover);
    }
    .scene-row td {
      background: var(--scene-bg);
    }
    .scene-row:nth-child(even) td {
      background: color-mix(in srgb, var(--scene-bg) 92%, var(--panel));
    }
    .title {
      display: grid;
      gap: 4px;
    }
    .structure-cell {
      min-width: 320px;
    }
    .chapter-row td {
      background: var(--chapter-bg);
      padding-top: 9px;
      padding-bottom: 9px;
    }
    .chapter-row .sticky {
      font-weight: 700;
      background: var(--chapter-bg);
    }
    .chapter-structure .title-main span {
      font-weight: 700;
      color: var(--text);
    }
    .chapter-title {
      gap: 8px;
    }
    .tree-toggle {
      width: 20px;
      min-height: 20px;
      padding: 0;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: var(--accent);
      line-height: 1;
    }
    .tree-toggle:hover {
      background: var(--row-hover);
    }
    .tree-spacer {
      display: inline-block;
      width: 20px;
      height: 20px;
    }
    .structure-line {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .structure-actions {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
    }
    .scene-structure {
      position: relative;
      padding-left: 34px;
    }
    .scene-structure::before {
      content: "";
      position: absolute;
      left: 16px;
      top: -9px;
      bottom: -9px;
      border-left: 1px solid var(--tree-line);
    }
    .scene-structure::after {
      content: "";
      position: absolute;
      left: 16px;
      top: 18px;
      width: 14px;
      border-top: 1px solid var(--tree-line);
    }
    .scene-structure .structure-line::before {
      content: "";
      position: absolute;
      left: 28px;
      top: 15px;
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--tree-line);
    }
    .title-main {
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .title-main span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      color: var(--muted);
      font-size: 11px;
    }
    .scene-title-input {
      width: 100%;
      min-width: 150px;
      font-weight: 600;
    }
    .structure-line .scene-title-input {
      min-width: 0;
    }
    .scene-field {
      width: 100%;
      min-width: 120px;
    }
    .scene-notes {
      min-width: 180px;
    }
    .tag-editor {
      display: grid;
      gap: 5px;
      min-width: 190px;
    }
    .tag-entry {
      display: grid;
      grid-template-columns: minmax(110px, 1fr) auto;
      gap: 4px;
      align-items: start;
    }
    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      min-height: 22px;
    }
    .tag-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      max-width: 190px;
      border: 0;
      background: transparent;
      color: var(--text);
      padding: 0;
    }
    .tag-remove {
      display: grid;
      place-items: center;
      flex: 0 0 18px;
      min-height: 18px;
      width: 18px;
      padding: 0;
      border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      color: var(--muted);
      line-height: 1;
      border-radius: 999px;
    }
    .tag-remove:hover {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--text);
    }
    .tag-chip .chip {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 20px;
      max-width: 160px;
      border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
      border-radius: 999px;
      background: var(--chip-bg);
      color: inherit;
      padding: 1px 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
    .tag-chip .chip:hover {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      text-decoration: underline;
    }
    .suggest-wrap {
      position: relative;
      min-width: 0;
    }
    .suggestions {
      position: absolute;
      z-index: 20;
      top: calc(100% + 3px);
      left: 0;
      right: 0;
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--control-border);
      border-radius: 5px;
      background: var(--vscode-quickInput-background, var(--panel));
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
    }
    .suggestion {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 1px;
      border: 0;
      border-radius: 0;
      padding: 5px 7px;
      text-align: left;
      background: transparent;
    }
    .suggestion:hover,
    .suggestion.active {
      background: var(--vscode-quickInputList-focusBackground, var(--row-hover));
    }
    .suggestion-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .suggestion-detail {
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .save-scene[disabled] {
      opacity: 0;
      cursor: default;
      pointer-events: none;
    }
    tbody tr:hover > td,
    tbody tr:hover > td.sticky {
      background: var(--row-hover) !important;
    }
    tr.dirty td {
      box-shadow: inset 2px 0 0 var(--accent);
    }
    tr.focus-row td,
    tr.focus-row .sticky {
      background: var(--row-focus-bg) !important;
      box-shadow: inset 0 1px 0 var(--accent), inset 0 -1px 0 var(--accent);
    }
    tr.focus-row .sticky {
      box-shadow: inset 3px 0 0 var(--accent), inset 0 1px 0 var(--accent), inset 0 -1px 0 var(--accent);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .chip {
      border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
      border-radius: 999px;
      padding: 1px 7px;
      color: var(--text);
      background: var(--chip-bg);
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .preview-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--preview-overlay);
      backdrop-filter: blur(1px);
      pointer-events: auto;
    }
    .preview-backdrop[hidden] {
      display: none !important;
      pointer-events: none;
    }
    .preview-card {
      width: min(420px, 100%);
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--panel));
      box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--accent);
    }
    .preview-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    .preview-title {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .preview-title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .preview-body {
      display: grid;
      gap: 8px;
      padding: 12px;
    }
    .preview-row {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 8px;
    }
    .preview-row span:first-child {
      color: var(--muted);
    }
    .preview-row span:last-child {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .preview-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--line);
    }
    .track-cell {
      min-width: 160px;
    }
    .track-hit {
      display: grid;
      gap: 3px;
    }
    .empty {
      padding: 28px;
      color: var(--muted);
    }
    .diagnostics {
      color: var(--vscode-errorForeground, var(--muted));
      font-size: 12px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    @media (max-width: 900px) {
      .toolbar {
        grid-template-columns: 1fr 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div id="diagnostics" class="diagnostics" hidden></div>
    <div class="toolbar">
      <div class="field">
        <label for="search">搜索</label>
        <input id="search" type="search">
      </div>
      <div class="field">
        <label for="statusFilter">状态</label>
        <select id="statusFilter"></select>
      </div>
      <div class="field">
        <label for="characterFilter">人物</label>
        <select id="characterFilter"></select>
      </div>
      <div class="field">
        <label for="locationFilter">地点</label>
        <select id="locationFilter"></select>
      </div>
      <div class="field">
        <label for="plotlineFilter">剧情线</label>
        <select id="plotlineFilter"></select>
      </div>
    </div>
    <div id="grid" class="grid-wrap"></div>
  </div>
  <div id="preview" class="preview-backdrop" hidden></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { projection: null, filters: {}, collapsedChapters: new Set(), collapseSnapshot: null, chapterSceneCounts: {} };
    const els = {
      diagnostics: document.getElementById('diagnostics'),
      grid: document.getElementById('grid'),
      search: document.getElementById('search'),
      statusFilter: document.getElementById('statusFilter'),
      characterFilter: document.getElementById('characterFilter'),
      locationFilter: document.getElementById('locationFilter'),
      plotlineFilter: document.getElementById('plotlineFilter'),
      preview: document.getElementById('preview')
    };
    document.addEventListener('click', event => {
      if (!event.target.closest('.suggest-wrap')) hideAllSuggestions();
    });
    els.preview.addEventListener('click', event => {
      if (event.target === els.preview || event.target.closest('[data-close-preview]')) hidePreview();
      const open = event.target.closest('[data-open-preview-source]');
      if (open) {
        vscode.postMessage({ type: 'openSource', ref: open.dataset.openPreviewSource });
        hidePreview();
      }
    });
    window.addEventListener('message', event => {
      if (event.data.type !== 'state') return;
      state.projection = event.data.projection;
      state.filters = event.data.filters || {};
      state.focusSceneId = event.data.focusSceneId || null;
      render();
    });
    vscode.postMessage({ type: 'ready' });

    for (const [key, el] of Object.entries({
      text: els.search,
      status: els.statusFilter,
      characterRef: els.characterFilter,
      locationRef: els.locationFilter,
      plotlineRef: els.plotlineFilter
    })) {
      el.addEventListener('change', () => updateFilter(key, el.value));
      el.addEventListener('input', () => {
        if (key === 'text') updateFilter(key, el.value);
      });
    }
    function updateFilter(key, value) {
      const filters = { ...state.filters };
      if (value) filters[key] = value; else delete filters[key];
      vscode.postMessage({ type: 'setFilter', filters });
    }

    function render() {
      const projection = state.projection;
      if (!projection) return;
      renderDiagnostics(projection);
      renderFilters(projection);
      if (projection.rows.length === 0) {
        els.grid.innerHTML = '<div class="empty">暂无可显示行</div>';
        return;
      }
      const fixedColumns = projection.visibleColumns || [];
      const sceneColumns = projection.rowMode === 'chapter' ? [] : ['conflict', 'turn', 'outcome'];
      const headers = ['结构', ...fixedColumns.map(columnLabel), ...sceneColumns.map(columnLabel), ...projection.tracks.map(track => track.label)];
      state.suggestions = suggestionCatalog(projection);
      state.chapterSceneCounts = chapterSceneCounts(projection.rows);
      const rows = visibleRows(projection.rows).map(row => rowHtml(row, fixedColumns, sceneColumns, projection.tracks, projection.entities, projection.filters.statuses)).join('');
      const headerCells = headers.map((header, index) => index === 0 ? structureHeaderHtml() : '<th>' + escapeHtml(header) + '</th>').join('');
      els.grid.innerHTML = '<table><thead><tr>' + headerCells + '</tr></thead><tbody>' + rows + '</tbody></table>';
      bindTableActions();
      focusSceneRow(state.focusSceneId);
      state.focusSceneId = null;
    }

    function renderDiagnostics(projection) {
      if (!projection.diagnostics || projection.diagnostics.length === 0) {
        els.diagnostics.hidden = true;
        els.diagnostics.textContent = '';
        return;
      }
      els.diagnostics.hidden = false;
      els.diagnostics.textContent = projection.diagnostics.slice(0, 3).join(' / ');
    }

    function renderFilters(projection) {
      setOptions(els.statusFilter, projection.filters.statuses.map(value => ({ value, label: sceneStatusLabel(value) })), state.filters.status);
      setOptions(els.characterFilter, projection.filters.characters.map(entity => ({ value: entity.ref, label: entity.label })), state.filters.characterRef);
      setOptions(els.locationFilter, projection.filters.locations.map(entity => ({ value: entity.ref, label: entity.label })), state.filters.locationRef);
      setOptions(els.plotlineFilter, projection.filters.plotlines.map(track => ({ value: track.id, label: track.label })), state.filters.plotlineRef);
      if (els.search.value !== (state.filters.text || '')) els.search.value = state.filters.text || '';
    }

    function setOptions(select, options, selected) {
      select.innerHTML = '<option value="">全部</option>' + options.map(option => '<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + '</option>').join('');
      select.value = selected || '';
    }

    function structureHeaderHtml() {
      const restoring = Boolean(state.collapseSnapshot);
      const label = restoring ? '复原' : '收起';
      const title = restoring ? '复原到上次展开状态' : '全部收起章节';
      return '<th class="sticky"><div class="structure-header"><span class="structure-header-title">结构</span><button class="collapse-all" type="button" data-toggle-all-chapters title="' + title + '" aria-label="' + title + '">' + label + '</button></div></th>';
    }

    function chapterSceneCounts(rows) {
      const counts = {};
      let chapterId = '';
      for (const row of rows || []) {
        if (row.type === 'chapter') {
          chapterId = row.id;
          counts[chapterId] = counts[chapterId] || 0;
        } else if (row.type === 'scene' && chapterId) {
          counts[chapterId] = (counts[chapterId] || 0) + 1;
        }
      }
      return counts;
    }

    function visibleRows(rows) {
      const result = [];
      let chapterId = '';
      let collapsed = false;
      for (const row of rows || []) {
        if (row.type === 'chapter') {
          chapterId = row.id;
          collapsed = state.collapsedChapters.has(chapterId);
          result.push(row);
          continue;
        }
        if (!collapsed) {
          result.push(row);
        }
      }
      return result;
    }

    function rowHtml(row, fixedColumns, sceneColumns, tracks, entities, statuses) {
      const cells = [
        structureCell(row),
        ...fixedColumns.map(column => fixedCell(row, column, entities, statuses)),
        ...sceneColumns.map(column => fixedCell(row, column, entities, statuses)),
        ...tracks.map(track => trackCell(row, track))
      ];
      return '<tr class="' + (row.type === 'chapter' ? 'chapter-row' : 'scene-row') + '"' + (row.sceneId ? ' data-scene-row="' + escapeHtml(row.sceneId) + '"' : '') + '>' + cells.join('') + '</tr>';
    }

    function structureCell(row) {
      if (row.type !== 'scene') {
        const count = state.chapterSceneCounts?.[row.id] || 0;
        const collapsed = state.collapsedChapters?.has(row.id);
        const toggle = count > 0
          ? '<button class="tree-toggle" type="button" data-toggle-chapter="' + escapeHtml(row.id) + '" aria-label="' + (collapsed ? '展开章节' : '收起章节') + '">' + (collapsed ? '▸' : '▾') + '</button>'
          : '<span class="tree-spacer"></span>';
        return '<td class="sticky structure-cell"><div class="title chapter-structure"><div class="structure-line"><div class="title-main chapter-title">' + toggle + '<span>' + escapeHtml(row.title) + '</span></div><div class="structure-actions"><button type="button" data-open-row="' + escapeHtml(row.id) + '">打开</button></div></div><div class="meta">章节' + (count ? ' · ' + count + ' 场' : '') + '</div></div></td>';
      }
      return '<td class="sticky structure-cell"><div class="title scene-structure"><div class="structure-line">' + sceneInput('title', row.title, '场景标题') + '<div class="structure-actions"><button type="button" data-open-row="' + escapeHtml(row.id) + '">打开</button><button class="save-scene" type="button" data-save-scene="' + escapeHtml(row.sceneId || '') + '" disabled>保存</button></div></div><div class="meta">场景</div></div></td>';
    }

    function fixedCell(row, column, entities, statuses) {
      if (row.type !== 'scene') {
        if (column === 'status') return '<td>' + escapeHtml(sceneStatusLabel(row.status || '')) + '</td>';
        if (column === 'pov') return '<td>' + escapeHtml(row.pov || '') + '</td>';
        if (column === 'characters') return '<td>' + chips(row.characterRefs || [], entities) + '</td>';
        if (column === 'locations') return '<td>' + chips(row.locationRefs || [], entities) + '</td>';
        if (column === 'rules') return '<td>' + chips(row.ruleRefs || [], entities) + '</td>';
        if (column === 'wordCount') return '<td>' + (row.wordCount === undefined ? '' : String(row.wordCount)) + '</td>';
        if (column === 'targetWordCount') return '<td>' + (row.targetWordCount === undefined ? '' : String(row.targetWordCount)) + '</td>';
        return '<td></td>';
      }
      if (column === 'status') return '<td>' + statusSelect(row.status || '', statuses) + '</td>';
      if (column === 'pov') return '<td>' + sceneInput('pov', row.pov || '', '视角人物', 'pov') + '</td>';
      if (column === 'characters') return '<td>' + tagEditor('characterRefs', row.characterRefs || [], '输入人物名称或引用', 'characters', entities) + '</td>';
      if (column === 'locations') return '<td>' + tagEditor('locationRefs', row.locationRefs || [], '输入地点名称或引用', 'locations', entities) + '</td>';
      if (column === 'rules') return '<td>' + chips(row.ruleRefs || [], entities) + '</td>';
      if (column === 'wordCount') return '<td>' + (row.wordCount === undefined ? '' : String(row.wordCount)) + '</td>';
      if (column === 'targetWordCount') return '<td>' + (row.targetWordCount === undefined ? '' : String(row.targetWordCount)) + '</td>';
      if (column === 'conflict') return '<td>' + sceneInput('conflict', row.conflict || '', '冲突') + '</td>';
      if (column === 'turn') return '<td>' + sceneInput('turn', row.turn || '', '转折') + '</td>';
      if (column === 'outcome') return '<td>' + sceneInput('outcome', row.outcome || '', '结果') + '</td>';
      return '<td></td>';
    }

    function statusSelect(value, statuses) {
      const allowed = ['idea', 'outline', 'draft', 'revise', 'done', 'archived'];
      const values = Array.from(new Set([...allowed, ...(statuses || [])]));
      return '<select class="scene-field" data-scene-field="status">' + values.map(status => '<option value="' + escapeHtml(status) + '"' + (status === value ? ' selected' : '') + '>' + escapeHtml(sceneStatusLabel(status)) + '</option>').join('') + '</select>';
    }

    function sceneInput(field, value, placeholder, suggestKey) {
      const inputClass = field === 'title' ? 'scene-title-input' : 'scene-field scene-notes';
      const suggestAttr = suggestKey ? ' data-suggest-key="' + escapeHtml(suggestKey) + '"' : '';
      return '<div class="suggest-wrap"><input class="' + inputClass + '" data-scene-field="' + escapeHtml(field) + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(placeholder) + '"' + suggestAttr + '><div class="suggestions" hidden></div></div>';
    }

    function tagEditor(field, refs, placeholder, suggestKey, entities) {
      const value = uniqueValues(refs || []).join(', ');
      return '<div class="tag-editor" data-tag-editor="' + escapeHtml(field) + '">' +
        '<div class="tag-entry"><div class="suggest-wrap"><input class="scene-field" data-tag-input="' + escapeHtml(field) + '" data-suggest-key="' + escapeHtml(suggestKey) + '" placeholder="' + escapeHtml(placeholder) + '"><div class="suggestions" hidden></div></div><button type="button" data-add-tag="' + escapeHtml(field) + '">添加</button></div>' +
        '<input type="hidden" data-scene-field="' + escapeHtml(field) + '" value="' + escapeHtml(value) + '">' +
        '<div class="tag-list">' + uniqueValues(refs || []).map(ref => tagChip(field, ref, entities)).join('') + '</div>' +
      '</div>';
    }

    function tagChip(field, ref, entities) {
      const entity = entities[ref] || { label: ref };
      return '<span class="tag-chip" data-tag-value="' + escapeHtml(ref) + '" title="' + escapeHtml(ref) + '"><button class="chip" type="button" data-preview-ref="' + escapeHtml(ref) + '">' + escapeHtml(entity.label || ref) + '</button><button class="tag-remove" type="button" data-remove-tag="' + escapeHtml(field) + '" data-tag-value="' + escapeHtml(ref) + '" aria-label="删除">×</button></span>';
    }

    function suggestionCatalog(projection) {
      const entities = Object.values(projection.entities || {});
      const characterOptions = uniqueOptions([
        ...(projection.filters.characters || []),
        ...entities.filter(entity => entity.type === 'character')
      ].map(entity => ({ value: entity.ref, label: entity.label })));
      const locationOptions = uniqueOptions([
        ...(projection.filters.locations || []),
        ...entities.filter(entity => entity.type === 'location')
      ].map(entity => ({ value: entity.ref, label: entity.label })));
      const povOptions = uniqueValues([
        ...(projection.rows || []).map(row => row.pov).filter(value => value && !isObjectKeywordRef(value)),
        ...characterOptions.map(entity => entity.label).filter(Boolean)
      ]).map(value => {
        const matchedCharacter = characterOptions.find(entity => entity.label === value);
        return matchedCharacter
          ? { value: matchedCharacter.value, label: value, insertValue: value }
          : { value, label: value, insertValue: value };
      });
      return {
        pov: uniqueOptions(povOptions),
        characters: characterOptions,
        locations: locationOptions
      };
    }

    function uniqueOptions(options) {
      const seen = new Set();
      const result = [];
      for (const option of options) {
        if (!option.value || seen.has(option.value)) continue;
        seen.add(option.value);
        result.push(option);
      }
      return result;
    }

    function isObjectKeywordRef(value) {
      return /^(character|location|rule)\\//.test(String(value || ''));
    }

    function uniqueValues(values) {
      return Array.from(new Set(values.filter(Boolean)));
    }

    function trackCell(row, track) {
      const checked = (row.plotlineRefs || []).includes(track.id);
      const body = checked
        ? '<div class="track-hit"><strong>' + escapeHtml(row.conflict || row.turn || row.outcome || row.title) + '</strong><span class="meta">' + escapeHtml(row.turn || row.outcome || '') + '</span></div>'
        : '';
      const control = row.type === 'scene'
        ? '<label class="meta"><input type="checkbox" data-scene="' + escapeHtml(row.sceneId || '') + '" data-track="' + escapeHtml(track.id) + '" ' + (checked ? 'checked' : '') + '> 命中</label>'
        : '';
      return '<td class="track-cell">' + control + body + '</td>';
    }

    function chips(refs, entities) {
      if (!refs || refs.length === 0) return '';
      return '<div class="chips">' + refs.map(ref => {
        const entity = entities[ref] || { label: ref };
        return '<button class="chip" type="button" data-preview-ref="' + escapeHtml(ref) + '">' + escapeHtml(entity.label || ref) + '</button>';
      }).join('') + '</div>';
    }

    function bindTableActions() {
      for (const button of els.grid.querySelectorAll('[data-toggle-all-chapters]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          toggleAllChapters();
        });
      }
      for (const button of els.grid.querySelectorAll('[data-toggle-chapter]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          toggleChapter(button.dataset.toggleChapter || '');
        });
      }
      for (const button of els.grid.querySelectorAll('[data-open-row]')) {
        button.addEventListener('click', () => vscode.postMessage({ type: 'openSource', rowId: button.dataset.openRow }));
      }
      for (const button of els.grid.querySelectorAll('[data-preview-ref]')) {
        button.addEventListener('click', () => showPreview(button.dataset.previewRef || ''));
      }
      for (const control of els.grid.querySelectorAll('[data-scene-field]')) {
        control.dataset.original = control.value;
        control.addEventListener('input', () => markSceneDirty(control));
        control.addEventListener('change', () => markSceneDirty(control));
        if (control.dataset.suggestKey) {
          control.addEventListener('focus', () => showSuggestions(control));
          control.addEventListener('input', () => showSuggestions(control));
          control.addEventListener('keydown', event => handleSuggestionKeydown(event, control));
        }
        control.addEventListener('keydown', event => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            saveSceneRow(control.closest('[data-scene-row]'));
          }
        });
      }
      for (const input of els.grid.querySelectorAll('[data-tag-input]')) {
        input.addEventListener('focus', () => showSuggestions(input));
        input.addEventListener('input', () => showSuggestions(input));
        input.addEventListener('keydown', event => {
          handleSuggestionKeydown(event, input);
          if (!event.defaultPrevented && event.key === 'Enter') {
            event.preventDefault();
            addTagFromInput(input);
          }
        });
      }
      for (const button of els.grid.querySelectorAll('[data-add-tag]')) {
        button.addEventListener('click', () => addTagFromInput(button.closest('.tag-editor')?.querySelector('[data-tag-input]')));
      }
      for (const button of els.grid.querySelectorAll('[data-remove-tag]')) {
        button.addEventListener('click', () => removeTag(button.closest('.tag-editor'), button.dataset.tagValue || ''));
      }
      for (const button of els.grid.querySelectorAll('[data-save-scene]')) {
        button.addEventListener('click', () => saveSceneRow(button.closest('[data-scene-row]')));
      }
      for (const checkbox of els.grid.querySelectorAll('[data-scene][data-track]')) {
        checkbox.addEventListener('change', () => vscode.postMessage({
          type: 'assignSceneTrack',
          sceneId: checkbox.dataset.scene,
          trackId: checkbox.dataset.track,
          assigned: checkbox.checked
        }));
      }
    }

    function toggleAllChapters() {
      const chapterIds = (state.projection?.rows || [])
        .filter(row => row.type === 'chapter')
        .map(row => row.id);
      if (chapterIds.length === 0) return;

      if (state.collapseSnapshot) {
        state.collapsedChapters = new Set(state.collapseSnapshot);
        state.collapseSnapshot = null;
      } else {
        state.collapseSnapshot = new Set(state.collapsedChapters);
        state.collapsedChapters = new Set(chapterIds);
      }
      render();
    }

    function toggleChapter(chapterRowId) {
      if (!chapterRowId) return;
      if (state.collapsedChapters.has(chapterRowId)) {
        state.collapsedChapters.delete(chapterRowId);
      } else {
        state.collapsedChapters.add(chapterRowId);
      }
      render();
    }

    function markSceneDirty(control) {
      const row = control.closest('[data-scene-row]');
      if (!row) return;
      const dirty = Array.from(row.querySelectorAll('[data-scene-field]')).some(field => field.value !== field.dataset.original);
      row.classList.toggle('dirty', dirty);
      const save = row.querySelector('[data-save-scene]');
      if (save) save.disabled = !dirty;
    }

    function addTagFromInput(input) {
      if (!input) return;
      const value = input.value.trim();
      if (!value) return;
      const editor = input.closest('.tag-editor');
      const hidden = editor?.querySelector('[data-scene-field]');
      if (!editor || !hidden) return;
      const previous = hidden.value;
      const refs = uniqueValues([...splitList(previous), value]);
      hidden.value = refs.join(', ');
      input.value = '';
      hideAllSuggestions();
      refreshTagList(editor);
      if (hidden.value !== previous) {
        saveSceneField(hidden);
      }
      input.focus();
    }

    function removeTag(editor, value) {
      if (!editor || !value) return;
      const hidden = editor.querySelector('[data-scene-field]');
      if (!hidden) return;
      const previous = hidden.value;
      hidden.value = splitList(previous).filter(ref => ref !== value).join(', ');
      refreshTagList(editor);
      if (hidden.value !== previous) {
        saveSceneField(hidden);
      }
    }

    function refreshTagList(editor) {
      const field = editor.dataset.tagEditor;
      const hidden = editor.querySelector('[data-scene-field]');
      const list = editor.querySelector('.tag-list');
      if (!field || !hidden || !list) return;
      list.innerHTML = splitList(hidden.value).map(ref => tagChip(field, ref, state.projection?.entities || {})).join('');
      for (const button of list.querySelectorAll('[data-remove-tag]')) {
        button.addEventListener('click', () => removeTag(editor, button.dataset.tagValue || ''));
      }
      for (const button of list.querySelectorAll('[data-preview-ref]')) {
        button.addEventListener('click', () => showPreview(button.dataset.previewRef || ''));
      }
    }

    function showPreview(ref) {
      if (!ref) return;
      const entity = state.projection?.entities?.[ref] || { ref, label: ref, type: 'unknown' };
      const rows = [
        previewRow('引用', entity.ref || ref),
        previewRow('类型', entityTypeLabel(entity.type)),
        previewRow('别名', (entity.aliases || []).join(', ')),
        previewRow('状态', [entity.status, entity.visibility].filter(Boolean).join(' / ')),
        previewRow('分类', entity.category || ''),
        previewRow('简介', entity.intro || entity.summary || entity.description || ''),
        previewRow('路径', entity.path || '')
      ].filter(Boolean).join('');
      els.preview.innerHTML =
        '<section class="preview-card" role="dialog" aria-modal="true">' +
          '<div class="preview-head"><div class="preview-title"><strong>' + escapeHtml(entity.label || ref) + '</strong><span class="meta">' + escapeHtml(entity.ref || ref) + '</span></div><button type="button" data-close-preview>关闭</button></div>' +
          '<div class="preview-body">' + rows + '</div>' +
          '<div class="preview-actions">' + (entity.path ? '<button type="button" data-open-preview-source="' + escapeHtml(entity.ref || ref) + '">打开源文件</button>' : '') + '<button type="button" data-close-preview>完成</button></div>' +
        '</section>';
      els.preview.hidden = false;
    }

    function hidePreview() {
      els.preview.hidden = true;
      els.preview.innerHTML = '';
    }

    function previewRow(label, value) {
      if (!value) return '';
      return '<div class="preview-row"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value) + '</span></div>';
    }

    function entityTypeLabel(type) {
      return ({ character: '人物', location: '地点', rule: '规则', keyword: '关键词', unknown: '未解析' })[type] || type;
    }

    function showSuggestions(control) {
      const wrap = control.closest('.suggest-wrap');
      const box = wrap?.querySelector('.suggestions');
      const key = control.dataset.suggestKey;
      const options = state.suggestions?.[key] || [];
      if (!box || options.length === 0) return;

      const token = currentToken(control).toLowerCase();
      const matches = options.filter(option => {
        const haystack = [option.value, option.label || ''].join(' ').toLowerCase();
        return !token || haystack.includes(token);
      }).slice(0, 10);
      if (matches.length === 0) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }

      box.hidden = false;
      box.dataset.activeIndex = '0';
      box.innerHTML = matches.map((option, index) =>
        '<button class="suggestion' + (index === 0 ? ' active' : '') + '" type="button" data-suggestion-value="' + escapeHtml(option.value) + '" data-suggestion-insert="' + escapeHtml(option.insertValue || option.value) + '"><span class="suggestion-label">' + escapeHtml(option.label || option.value) + '</span>' + suggestionDetail(option) + '</button>'
      ).join('');
      for (const button of box.querySelectorAll('[data-suggestion-value]')) {
        button.addEventListener('mousedown', event => {
          event.preventDefault();
          applySuggestion(control, button.dataset.suggestionInsert || button.dataset.suggestionValue || '');
        });
      }
    }

    function handleSuggestionKeydown(event, control) {
      const box = control.closest('.suggest-wrap')?.querySelector('.suggestions');
      if (!box || box.hidden) return;
      const items = Array.from(box.querySelectorAll('[data-suggestion-value]'));
      if (items.length === 0) return;
      let index = Number(box.dataset.activeIndex || '0');
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        index = event.key === 'ArrowDown'
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
        setActiveSuggestion(box, items, index);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applySuggestion(control, items[index]?.dataset.suggestionInsert || items[index]?.dataset.suggestionValue || '');
        return;
      }
      if (event.key === 'Escape') {
        box.hidden = true;
      }
    }

    function setActiveSuggestion(box, items, index) {
      box.dataset.activeIndex = String(index);
      items.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === index));
      items[index]?.scrollIntoView({ block: 'nearest' });
    }

    function applySuggestion(control, value) {
      if (!value) return;
      const field = control.dataset.sceneField;
      if (field === 'characterRefs' || field === 'locationRefs') {
        control.value = replaceCurrentToken(control, value);
      } else {
        control.value = value;
      }
      hideAllSuggestions();
      markSceneDirty(control);
      control.focus();
    }

    function currentToken(control) {
      const value = control.value || '';
      if (control.dataset.tagInput) {
        return value.trim();
      }
      if (control.dataset.sceneField !== 'characterRefs' && control.dataset.sceneField !== 'locationRefs') {
        return value.trim();
      }
      const cursor = control.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const start = before.lastIndexOf(',') + 1;
      const endOffset = after.indexOf(',');
      const end = endOffset < 0 ? value.length : cursor + endOffset;
      return value.slice(start, end).trim();
    }

    function replaceCurrentToken(control, suggestion) {
      const value = control.value || '';
      const cursor = control.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const start = before.lastIndexOf(',') + 1;
      const endOffset = after.indexOf(',');
      const end = endOffset < 0 ? value.length : cursor + endOffset;
      const prefix = value.slice(0, start).replace(/\\s*$/, '');
      const suffix = value.slice(end).replace(/^\\s*/, '');
      const needsPrefixComma = prefix && !prefix.endsWith(',');
      const nextPrefix = prefix ? prefix + (needsPrefixComma ? ', ' : ' ') : '';
      const nextSuffix = suffix ? ', ' + suffix.replace(/^,\\s*/, '') : '';
      return nextPrefix + suggestion + nextSuffix;
    }

    function hideAllSuggestions() {
      for (const box of els.grid.querySelectorAll('.suggestions')) {
        box.hidden = true;
      }
    }

    function focusSceneRow(sceneId) {
      if (!sceneId) return;
      const row = Array.from(els.grid.querySelectorAll('[data-scene-row]')).find(candidate => candidate.dataset.sceneRow === sceneId);
      if (!row) return;
      row.classList.add('focus-row');
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
    }

    function saveSceneRow(row) {
      if (!row) return;
      const sceneId = row.dataset.sceneRow;
      const patch = {};
      for (const field of row.querySelectorAll('[data-scene-field]')) {
        if (field.value === field.dataset.original) continue;
        const key = field.dataset.sceneField;
        if (key === 'characterRefs' || key === 'locationRefs') {
          patch[key] = splitList(field.value);
        } else {
          patch[key] = field.value.trim();
        }
      }
      if (Object.keys(patch).length === 0 || !sceneId) return;
      const save = row.querySelector('[data-save-scene]');
      if (save) {
        save.disabled = true;
        save.textContent = '保存中';
      }
      vscode.postMessage({ type: 'updateSceneMetadata', sceneId, patch });
    }

    function saveSceneField(field) {
      const row = field.closest('[data-scene-row]');
      const sceneId = row?.dataset.sceneRow;
      const key = field.dataset.sceneField;
      if (!row || !sceneId || !key) return;
      const patch = {};
      patch[key] = key === 'characterRefs' || key === 'locationRefs'
        ? splitList(field.value)
        : field.value.trim();
      field.dataset.original = field.value;
      markSceneDirty(field);
      vscode.postMessage({ type: 'updateSceneMetadata', sceneId, patch });
    }

    function splitList(value) {
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }

    function columnLabel(column) {
      return ({ status: '状态', pov: '视角', characters: '人物', locations: '地点', rules: '规则', wordCount: '字数', targetWordCount: '目标', conflict: '冲突', turn: '转折', outcome: '结果' })[column] || column;
    }

    function sceneStatusLabel(status) {
      return ({ idea: '想法', outline: '大纲', draft: '草稿', revise: '修订', done: '完成', archived: '归档' })[status] || status;
    }

    function suggestionDetail(option) {
      const label = option.label || option.value;
      if (!option.value || option.value === label) return '';
      return '<span class="suggestion-detail">' + escapeHtml(option.value) + '</span>';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
  </script>
</body>
</html>`;
}

async function openSource(
  context: KernelContext,
  controller: PlotGridController,
  rowId?: string,
  ref?: string
): Promise<void> {
  const projection = await controller.getProjection();
  const row = rowId ? projection.rows.find((item) => item.id === rowId) : undefined;
  const entity = ref ? projection.entities[ref] : undefined;
  const relativePath = row?.path ?? entity?.path;
  if (!relativePath) {
    void vscode.window.showWarningMessage("没有可打开的源文件。");
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(context.workspaceFolder.uri.fsPath, relativePath)));
  await vscode.window.showTextDocument(document, { preview: false });
}

function createNonce(): string {
  return randomBytes(16).toString("base64");
}
