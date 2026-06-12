import * as vscode from 'vscode';
import {
  BlueprintDocument,
  BlueprintEdgeStrength,
  BlueprintEdgeStatus,
  BlueprintEdgeType,
  BlueprintPanelState,
  BlueprintRefKind,
  BlueprintMarkdownSyncAction,
  BlueprintSyncDecision
} from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export type BlueprintPanelAction =
  | { command: 'refresh'; blueprintId?: string }
  | { command: 'create-blueprint'; title: string }
  | { command: 'delete-blueprint'; blueprintId: string }
  | { command: 'select-blueprint'; blueprintId: string }
  | { command: 'save-blueprint'; document: BlueprintDocument }
  | { command: 'add-resource'; blueprintId: string; resourceId: string; resourceKind: BlueprintRefKind; x: number; y: number }
  | { command: 'delete-resource'; blueprintId: string; resourceId: string; resourceKind: BlueprintRefKind }
  | { command: 'create-from-outline'; outlineId: string }
  | { command: 'add-note'; blueprintId: string; x: number; y: number }
  | { command: 'auto-layout'; blueprintId: string }
  | { command: 'create-edges'; blueprintId: string; pairs: Array<{ fromNodeId: string; toNodeId: string }>; edgeType: BlueprintEdgeType; label?: string; note?: string; strength?: BlueprintEdgeStrength; status?: BlueprintEdgeStatus }
  | { command: 'reverse-edges'; blueprintId: string; edgeIds: string[] }
  | { command: 'update-edges'; blueprintId: string; edgeIds: string[]; patch: Partial<Pick<BlueprintDocument['edges'][number], 'type' | 'label' | 'note' | 'strength' | 'status'>> }
  | { command: 'preview-sync'; blueprintId: string }
  | { command: 'apply-sync'; blueprintId: string; decisions: BlueprintSyncDecision[] }
  | { command: 'export-markdown'; blueprintId: string }
  | { command: 'import-markdown'; blueprintId?: string }
  | { command: 'preview-markdown-sync'; blueprintId: string }
  | { command: 'apply-markdown-sync'; blueprintId: string; markdownPath: string; decisions: Array<{ itemId: string; action: BlueprintMarkdownSyncAction }> }
  | { command: 'open-source'; source: string };

export interface BlueprintPanelHandle {
  refresh(state: BlueprintPanelState): void;
  reveal(): void;
  dispose(): void;
}

export function showBlueprintPanel(
  context: vscode.ExtensionContext,
  state: BlueprintPanelState,
  onAction: (action: BlueprintPanelAction) => Promise<BlueprintPanelState | undefined>,
  onDispose?: () => void
): BlueprintPanelHandle {
  const panel = vscode.window.createWebviewPanel('loredock.blueprint', 'LoreDock 大纲蓝图', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = (nextState: BlueprintPanelState) => {
    state = nextState;
    panel.webview.html = renderBlueprintPanel(state);
  };

  render(state);
  panel.webview.onDidReceiveMessage(async (action: BlueprintPanelAction) => {
    const nextState = await onAction(action);
    if (nextState) {
      render(nextState);
    }
  }, undefined, context.subscriptions);
  panel.onDidDispose(() => onDispose?.(), undefined, context.subscriptions);

  return {
    refresh: render,
    reveal: () => panel.reveal(vscode.ViewColumn.One),
    dispose: () => panel.dispose()
  };
}

function renderBlueprintPanel(state: BlueprintPanelState): string {
  const scriptNonce = nonce();
  const serialized = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 大纲蓝图</title>
  <style>
    :root { --panel: var(--vscode-sideBar-background); --border: var(--vscode-panel-border); }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); overflow: hidden; }
    .shell { display: grid; grid-template-columns: 260px 1fr 320px; grid-template-rows: auto 1fr; height: 100vh; }
    header { grid-column: 1 / 4; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: minmax(520px, 1fr) auto; gap: 8px 12px; padding: 8px 10px; background: var(--panel); align-items: start; }
    header h1 { font-size: 13px; margin: 0; white-space: nowrap; }
    .topbar-main { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .topbar-main select { max-width: 180px; }
    .topbar-tools { display: flex; align-items: flex-start; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
    .tool-group { position: relative; }
    .tool-group > summary { list-style: none; cursor: pointer; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; padding: 5px 8px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-size: 12px; user-select: none; }
    .tool-group > summary::-webkit-details-marker { display: none; }
    .tool-group[open] > summary { outline: 1px solid var(--vscode-focusBorder); }
    .tool-panel { position: absolute; top: 31px; right: 0; z-index: 18; display: grid; gap: 7px; min-width: 245px; max-width: 360px; padding: 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-menu-background, var(--panel)); box-shadow: 0 10px 28px rgba(0,0,0,.35); }
    .tool-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .tool-row label { margin-right: 2px; }
    button, select, input, textarea { font: inherit; border-radius: 4px; border: 1px solid var(--vscode-input-border, var(--border)); }
    button { cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 8px; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.danger { color: var(--vscode-errorForeground); background: var(--vscode-input-background); border-color: var(--vscode-errorForeground); }
    button.ghost { color: var(--vscode-foreground); background: transparent; }
    button.active { outline: 1px solid var(--vscode-focusBorder); }
    select, input, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 5px 7px; }
    .new-title { width: 132px; }
    .toolbar-sep { width: 1px; height: 22px; background: var(--border); margin: 0 2px; }
    .edge-layers { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; max-width: 320px; }
    .edge-layers button { padding: 3px 6px; font-size: 11px; }
    .edge-layers button.off { opacity: .42; text-decoration: line-through; }
    aside { border-right: 1px solid var(--border); background: var(--panel); overflow: auto; padding: 10px; }
    aside.right { border-right: 0; border-left: 1px solid var(--border); }
    h2 { font-size: 12px; margin: 12px 0 7px; color: var(--vscode-descriptionForeground); font-weight: 650; }
    .resource-tools { display: grid; grid-template-columns: 1fr; gap: 7px; margin-bottom: 10px; }
    .resource { border: 1px solid var(--border); border-radius: 5px; padding: 7px; margin-bottom: 6px; background: var(--vscode-editor-background); cursor: grab; }
    .resource-title { font-weight: 650; font-size: 12px; }
    .resource-actions { display: flex; gap: 6px; margin-top: 7px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; }
    .canvas-wrap { position: relative; overflow: hidden; background-color: var(--vscode-editor-background); background-image: radial-gradient(var(--vscode-panel-border) 1px, transparent 1px); background-size: 22px 22px; }
    .stage { position: absolute; left: 0; top: 0; width: 4800px; height: 3600px; transform-origin: 0 0; }
    svg.edges { position: absolute; left: 0; top: 0; width: 4800px; height: 3600px; overflow: visible; pointer-events: none; }
    .edge { stroke-width: 2.4; fill: none; pointer-events: stroke; cursor: pointer; }
    .edge-hit { stroke: transparent; stroke-width: 26; fill: none; pointer-events: stroke; cursor: pointer; }
    .edge.selected { stroke: var(--vscode-testing-iconPassed); stroke-width: 3; }
    .edge.deprecated { opacity: .35; }
    .edge.weak { stroke-width: 1.5; }
    .edge.strong { stroke-width: 4; }
    .edge.dimmed, .node.dimmed { opacity: .25; }
    .edge-preview { stroke: var(--vscode-textLink-foreground); stroke-width: 2; stroke-dasharray: 6 5; fill: none; opacity: .82; pointer-events: none; }
    .edge-label-bg { fill: var(--vscode-editor-background); stroke: var(--border); stroke-width: 1; opacity: .95; pointer-events: all; cursor: pointer; }
    .edge-label { fill: var(--vscode-descriptionForeground); font-size: 11px; pointer-events: all; cursor: pointer; }
    .node { position: absolute; border: 1px solid var(--border); border-top: 3px solid var(--vscode-textLink-foreground); border-radius: 6px; background: var(--panel); box-shadow: 0 4px 14px rgba(0,0,0,.16); user-select: none; overflow: hidden; cursor: crosshair; }
    .node.selected { outline: 2px solid var(--vscode-focusBorder); }
    .node.connecting { outline: 2px dashed var(--vscode-textLink-foreground); }
    .node.locked { border-style: dashed; }
    .node.collapsed .semantic-lines, .node.collapsed .node-note, .node.collapsed .node-tags { display: none; }
    .node:not(.selected):not(:hover) .semantic-lines { display: none; }
    .node:not(.selected):not(:hover) .node-tags { display: none; }
    .node.status-missing { border-color: var(--vscode-errorForeground); }
    .node.status-conflict { box-shadow: 0 0 0 1px var(--vscode-errorForeground), 0 4px 16px rgba(0,0,0,.18); }
    .node.status-stale { box-shadow: 0 0 0 1px var(--vscode-textLink-foreground), 0 4px 16px rgba(0,0,0,.18); }
    .selection-box { position: absolute; display: none; border: 1px solid var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent); pointer-events: none; }
    .node-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 8px 4px; font-weight: 650; font-size: 12px; cursor: move; }
    .node-tools { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .node-tool { color: var(--vscode-descriptionForeground); cursor: pointer; font-weight: 700; line-height: 1; }
    .node-tool:hover { color: var(--vscode-foreground); }
    .badge { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 500; }
    .node-kind { color: var(--vscode-descriptionForeground); font-size: 10px; padding: 0 8px; }
    .node-note { padding: 2px 8px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.35; white-space: pre-wrap; }
    .node-tags { display: flex; gap: 4px; flex-wrap: wrap; padding: 4px 8px 0; }
    .node-tag { border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .semantic-lines { padding: 3px 8px 8px; display: grid; gap: 2px; }
    .semantic-line { color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .resizeHandle { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; border-left: 1px solid var(--border); border-top: 1px solid var(--border); background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
    .node.locked .resizeHandle { cursor: not-allowed; opacity: .35; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    .row { display: grid; gap: 5px; margin-bottom: 9px; }
    .row.two { grid-template-columns: 1fr 1fr; }
    .inspector-section { border: 1px solid var(--border); border-radius: 6px; padding: 0; margin: 9px 0; background: color-mix(in srgb, var(--vscode-editor-background) 58%, transparent); }
    .inspector-section > summary { cursor: pointer; padding: 7px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 650; user-select: none; }
    .inspector-section-body { padding: 0 8px 8px; }
    label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    textarea { min-height: 80px; resize: vertical; }
    .empty { color: var(--vscode-descriptionForeground); padding: 12px 0; }
    .sync-item { border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 7px; background: var(--vscode-editor-background); }
    .sync-item.conflict { border-color: var(--vscode-errorForeground); }
    .sync-item.push, .sync-item.pull { border-color: var(--vscode-textLink-foreground); }
    .sync-group { margin-top: 12px; }
    .sync-group h2 { display: flex; justify-content: space-between; }
    .sync-head { display: flex; justify-content: space-between; gap: 8px; font-weight: 650; font-size: 12px; }
    .sync-actions { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
    .diff { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 5px; }
    .diff.changed { color: var(--vscode-textLink-foreground); }
    .issue { border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 7px; margin: 7px 0; }
    .issue.warning { border-left-color: var(--vscode-errorForeground); }
    .context-menu { position: fixed; display: none; z-index: 20; min-width: 132px; padding: 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 8px 24px rgba(0,0,0,.35); }
    .context-menu button { display: block; width: 100%; text-align: left; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; border: 0; padding: 6px 8px; }
    .context-menu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
    .context-menu button.danger { color: var(--vscode-errorForeground); border: 0; }
    .edge-tip { position: fixed; display: none; z-index: 12; max-width: 260px; border: 1px solid var(--border); border-radius: 6px; padding: 7px; background: var(--vscode-editor-background); box-shadow: 0 8px 24px rgba(0,0,0,.3); font-size: 11px; pointer-events: none; }
    .nav-search { width: 160px; }
    .search-hit { box-shadow: 0 0 0 2px var(--vscode-textLink-foreground), 0 4px 16px rgba(0,0,0,.18); }
    .edge.search-hit { stroke: var(--vscode-textLink-foreground); stroke-width: 4; }
    .minimap { position: absolute; right: 12px; bottom: 12px; z-index: 8; width: 190px; height: 132px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent); box-shadow: 0 8px 24px rgba(0,0,0,.28); overflow: hidden; }
    .minimap svg { width: 100%; height: 100%; display: block; cursor: pointer; }
    .minimap-node { fill: var(--vscode-textLink-foreground); opacity: .78; }
    .minimap-node.selected { fill: var(--vscode-testing-iconPassed); opacity: 1; }
    .minimap-viewport { fill: transparent; stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
    .small { font-size: 11px; color: var(--vscode-descriptionForeground); }
    @media (max-width: 1080px) {
      .shell { grid-template-columns: 230px 1fr 300px; }
      header { grid-template-columns: 1fr; }
      .topbar-tools { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="topbar-main">
        <h1>大纲蓝图</h1>
        <select id="blueprintSelect"></select>
        <input class="new-title" id="newBlueprintTitle" placeholder="新蓝图标题">
        <button class="secondary" id="newBlueprint">新建</button>
        <button class="secondary" id="refresh">刷新</button>
        <button class="secondary" id="fitView">适配</button>
        <input class="nav-search" id="blueprintSearch" placeholder="搜索节点/关系">
        <button class="secondary" id="searchPrev">上一个</button>
        <button class="secondary" id="searchNext">下一个</button>
        <span class="small" id="searchCount"></span>
        <span class="small" id="outlineBinding"></span>
      </div>
      <div class="topbar-tools">
        <details class="tool-group">
          <summary>编辑</summary>
          <div class="tool-panel">
            <div class="tool-row">
              <button class="secondary" id="undo">撤销</button>
              <button class="secondary" id="redo">重做</button>
              <button class="secondary" id="addNote">备注节点</button>
              <button class="secondary" id="duplicateNodes">复制</button>
              <button class="secondary" id="autoLayout">自动布局</button>
            </div>
          </div>
        </details>
        <details class="tool-group">
          <summary>导航</summary>
          <div class="tool-panel">
            <div class="tool-row">
              <button class="secondary" id="zoomOut">-</button>
              <button class="secondary" id="zoomIn">+</button>
              <button class="secondary" id="saveViewport">保存视角</button>
              <select id="viewportBookmarkSelect"></select>
              <button class="secondary" id="deleteViewport">删除视角</button>
            </div>
            <div class="tool-row">
              <select id="focusMode"><option value="all">显示全部</option><option value="one">一阶关系</option><option value="two">二阶关系</option><option value="path">路径高亮</option></select>
            </div>
          </div>
        </details>
        <details class="tool-group">
          <summary>关系</summary>
          <div class="tool-panel">
            <div class="tool-row">
              <label>连线</label>
              <select id="edgeType">${edgeTypeOptions()}</select>
              <button class="secondary" id="relationBrush">关系刷</button>
            </div>
          </div>
        </details>
        <details class="tool-group">
          <summary>同步</summary>
          <div class="tool-panel">
            <div class="tool-row">
              <button class="secondary" id="previewSync">资料同步</button>
              <button class="secondary" id="exportMarkdown">导出 Markdown</button>
              <button class="secondary" id="importMarkdown">导入 Markdown</button>
              <button class="secondary" id="previewMarkdownSync">Markdown 同步</button>
            </div>
          </div>
        </details>
        <details class="tool-group">
          <summary>图层</summary>
          <div class="tool-panel">
            <div class="edge-layers" id="edgeLayers"></div>
          </div>
        </details>
      </div>
    </header>
    <aside>
      <h2>资源库</h2>
      <div class="resource-tools">
        <input id="resourceSearch" placeholder="搜索资源">
        <select id="resourceKindFilter"></select>
      </div>
      <div id="resources"></div>
    </aside>
    <main class="canvas-wrap" id="canvas">
      <div class="stage" id="stage">
        <svg class="edges" id="edges"></svg>
        <div id="nodes"></div>
        <div class="selection-box" id="selectionBox"></div>
      </div>
      <div class="minimap" id="minimap"></div>
    </main>
    <aside class="right">
      <div class="tabs">
        <button class="ghost active" id="tabInspector">属性</button>
        <button class="ghost" id="tabSync">同步</button>
      </div>
      <div id="rightPanel" class="empty">选择节点或连线。</div>
    </aside>
  </div>
  <div class="context-menu" id="contextMenu"></div>
  <div class="edge-tip" id="edgeTip"></div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    let state = ${serialized};
    let current = state.current;
    let selectedNodeId = '';
    let selectedEdgeId = '';
    const selectedNodeIds = new Set();
    const selectedEdgeIds = new Set();
    let connectFrom = '';
    let relationBrush = false;
    let focusMode = 'all';
    let pathStartId = '';
    let pathEndId = '';
    let pathMessage = '';
    const visibleEdgeLayers = new Set(['flow', 'reference', 'foreshadowing', 'conflict', 'support', 'custom']);
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let canvasDrag = null;
    let resourceSearch = '';
    let resourceKindFilter = 'all';
    let blueprintSearch = '';
    let searchResults = [];
    let searchIndex = -1;
    let connectionPreview = null;
    let activeTab = state.syncPreview || state.markdownSyncPreview ? 'sync' : 'inspector';
    const history = [];
    const future = [];
    const canvas = document.getElementById('canvas');
    const stage = document.getElementById('stage');
    const nodesEl = document.getElementById('nodes');
    const edgesEl = document.getElementById('edges');
    const selectionBox = document.getElementById('selectionBox');
    const rightPanel = document.getElementById('rightPanel');
    const contextMenu = document.getElementById('contextMenu');
    const edgeTip = document.getElementById('edgeTip');
    const minimap = document.getElementById('minimap');

    function post(action) { vscode.postMessage(action); }
    function save() { post({ command: 'save-blueprint', document: current }); }
    function snapshot() { return JSON.stringify(current); }
    function restore(raw) { current = JSON.parse(raw); selectedNodeId = ''; selectedEdgeId = ''; selectedNodeIds.clear(); selectedEdgeIds.clear(); render(); save(); }
    function pushHistory() { history.push(snapshot()); if (history.length > 60) history.shift(); future.length = 0; }
    function commit(mutator) { pushHistory(); mutator(); render(); save(); }
    function byId(id) { return current.nodes.find((node) => node.id === id); }
    function edgeById(id) { return current.edges.find((edge) => edge.id === id); }
    function defaultOutputPortForEdge(type) {
      return ({ flow: 'out', uses: 'uses', foreshadows: 'foreshadows', resolves: 'resolves', conflicts: 'conflicts', supports: 'causes', blocks: 'conflicts', custom: 'out' })[type] || 'out';
    }
    function defaultInputPortForEdge(type) {
      return ({ flow: 'in', uses: 'usedBy', foreshadows: 'foreshadowIn', resolves: 'resolveIn', conflicts: 'conflictIn', supports: 'affectedBy', blocks: 'conflictIn', custom: 'in' })[type] || 'in';
    }
    function edgeEndpoints(edge) {
      const from = byId(edge.fromNodeId);
      const to = byId(edge.toNodeId);
      if (!from || !to) return undefined;
      const fromTarget = { x: to.x + to.width / 2, y: to.y + nodeVisualHeight(to) / 2 };
      const toTarget = { x: from.x + from.width / 2, y: from.y + nodeVisualHeight(from) / 2 };
      const fromAnchor = nodeAnchorForPoint(from, fromTarget);
      const toAnchor = nodeAnchorForPoint(to, toTarget);
      return {
        from,
        to,
        x1: fromAnchor.x,
        y1: fromAnchor.y,
        x2: toAnchor.x,
        y2: toAnchor.y
      };
    }
    function nodeAnchorForPoint(node, point) {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + nodeVisualHeight(node) / 2;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: dx >= 0 ? node.x + node.width : node.x, y: centerY };
      }
      return { x: centerX, y: dy >= 0 ? node.y + nodeVisualHeight(node) : node.y };
    }
    function selectedNodes() {
      const ids = selectedNodeIds.size ? selectedNodeIds : new Set(selectedNodeId ? [selectedNodeId] : []);
      return current.nodes.filter((node) => ids.has(node.id));
    }
    function selectedEdges() {
      const ids = selectedEdgeIds.size ? selectedEdgeIds : new Set(selectedEdgeId ? [selectedEdgeId] : []);
      return current.edges.filter((edge) => ids.has(edge.id));
    }
    function clientToWorld(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left - panX) / scale, y: (event.clientY - rect.top - panY) / scale };
    }
    function viewportCenter() {
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round((rect.width / 2 - panX) / scale), y: Math.round((rect.height / 2 - panY) / scale) };
    }
    function applyTransform() { stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')'; renderMinimap(); }

    function render() {
      document.getElementById('blueprintSelect').innerHTML = state.blueprints.map((item) => '<option value="' + item.id + '"' + (item.id === current.id ? ' selected' : '') + '>' + escapeHtml(item.title) + '</option>').join('');
      document.getElementById('outlineBinding').textContent = current.outlineId ? '绑定大纲：' + current.outlineId : '未绑定大纲';
      renderNavigationControls();
      renderResourceTools();
      renderEdgeLayers();
      renderResources();
      refreshSearchResults(false);
      renderEdges();
      renderNodes();
      renderRightPanel();
      applyTransform();
    }
    function renderNavigationControls() {
      document.getElementById('blueprintSearch').value = blueprintSearch;
      document.getElementById('searchCount').textContent = searchResults.length ? (searchIndex + 1) + '/' + searchResults.length : '';
      document.getElementById('viewportBookmarkSelect').innerHTML = '<option value="">视角</option>' + (current.viewportBookmarks || []).map((bookmark) => '<option value="' + escapeAttr(bookmark.id) + '">' + escapeHtml(bookmark.title) + '</option>').join('');
    }
    function renderResourceTools() {
      const kinds = ['all', ...new Set(state.resources.map((resource) => resource.kind))];
      document.getElementById('resourceKindFilter').innerHTML = kinds.map((kind) => '<option value="' + escapeAttr(kind) + '"' + (kind === resourceKindFilter ? ' selected' : '') + '>' + (kind === 'all' ? '全部类型' : escapeHtml(kindLabel(kind))) + '</option>').join('');
      document.getElementById('resourceSearch').value = resourceSearch;
    }
    function renderEdgeLayers() {
      const layers = [
        ['flow', '剧情流'],
        ['reference', '引用'],
        ['foreshadowing', '伏笔'],
        ['conflict', '冲突'],
        ['support', '支撑'],
        ['custom', '自定义']
      ];
      document.getElementById('edgeLayers').innerHTML = layers.map(([layer, label]) => '<button class="secondary ' + (visibleEdgeLayers.has(layer) ? '' : 'off') + '" data-edge-layer="' + layer + '">' + escapeHtml(label) + '</button>').join('');
      document.querySelectorAll('[data-edge-layer]').forEach((button) => button.addEventListener('click', () => {
        const layer = button.dataset.edgeLayer;
        if (visibleEdgeLayers.has(layer)) visibleEdgeLayers.delete(layer); else visibleEdgeLayers.add(layer);
        render();
      }));
    }
    function renderResources() {
      const query = resourceSearch.trim().toLowerCase();
      const filtered = state.resources.filter((resource) => {
        const matchesKind = resourceKindFilter === 'all' || resource.kind === resourceKindFilter;
        const haystack = (resource.title + ' ' + resource.kind + ' ' + (resource.detail || '')).toLowerCase();
        return matchesKind && (!query || haystack.includes(query));
      });
      const groups = {};
      for (const resource of filtered) {
        (groups[resource.kind] ||= []).push(resource);
      }
      document.getElementById('resources').innerHTML = Object.entries(groups).map(([kind, resources]) => '<h2>' + escapeHtml(kindLabel(kind)) + '</h2>' + resources.map(renderResource).join('')).join('') || '<div class="empty">暂无资源。</div>';
      document.querySelectorAll('.resource').forEach((el) => {
        el.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('application/json', JSON.stringify({ id: el.dataset.id, kind: el.dataset.kind }));
        });
        el.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          showContextMenu(event.clientX, event.clientY, [
            { label: '删除', danger: true, run: () => post({ command: 'delete-resource', blueprintId: current.id, resourceId: el.dataset.id, resourceKind: el.dataset.kind }) }
          ]);
        });
      });
    }
    function renderResource(resource) {
      return '<div class="resource" draggable="true" data-id="' + escapeHtml(resource.id) + '" data-kind="' + escapeHtml(resource.kind) + '">' +
        '<div class="resource-title">' + escapeHtml(resource.title) + '</div>' +
        '<div class="meta">' + escapeHtml(resource.detail || resource.relativePath) + '</div>' +
      '</div>';
    }
    function renderNodes() {
      const focus = focusedNodeIds();
      nodesEl.innerHTML = current.nodes.map((node) => {
        const semantic = semanticForNode(node);
        const selected = node.id === selectedNodeId || selectedNodeIds.has(node.id);
        const dimmed = focus && !focus.has(node.id);
        const hit = isSearchHit('node', node.id);
        const tags = Array.isArray(node.tags) ? node.tags : [];
        return '<div class="node status-' + escapeAttr(semantic.status) + (selected ? ' selected' : '') + (hit ? ' search-hit' : '') + (dimmed ? ' dimmed' : '') + (node.locked ? ' locked' : '') + (node.collapsed ? ' collapsed' : '') + '" data-id="' + node.id + '" style="left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.width + 'px;height:' + nodeVisualHeight(node) + 'px;border-top-color:' + escapeHtml(node.color || '#4fc1ff') + '">' +
          '<div class="node-head"><span>' + escapeHtml(node.title) + '</span><span class="node-tools"><span class="node-tool collapseToggle" title="' + (node.collapsed ? '展开节点' : '折叠节点') + '">' + (node.collapsed ? '▸' : '▾') + '</span><span class="node-tool lockToggle" title="' + (node.locked ? '解锁节点' : '锁定节点') + '">' + (node.locked ? '🔒' : '◇') + '</span></span></div>' +
          '<div class="node-kind"><span class="badge">' + escapeHtml(semantic.badge) + '</span> ' + escapeHtml(sourceStatusLabel(semantic.status)) + '</div>' +
          (tags.length ? '<div class="node-tags">' + tags.map((tag) => '<span class="node-tag">' + escapeHtml(tag) + '</span>').join('') + '</div>' : '') +
          '<div class="semantic-lines">' + semantic.lines.map((line) => '<div class="semantic-line">' + escapeHtml(line) + '</div>').join('') + '</div>' +
          '<div class="resizeHandle" title="调整节点大小"></div>' +
        '</div>';
      }).join('');
      document.querySelectorAll('.node').forEach((el) => wireNode(el));
    }
    function renderEdges() {
      const focus = focusedNodeIds();
      const focusEdges = focusedEdgeIds(focus);
      const previewPath = renderConnectionPreview();
      edgesEl.innerHTML = edgeMarkerDefs() + current.edges.map((edge) => {
        if (!visibleEdgeLayers.has(edgeLayer(edge.type))) return '';
        const endpoints = edgeEndpoints(edge);
        if (!endpoints) return '';
        const x1 = endpoints.x1;
        const y1 = endpoints.y1;
        const x2 = endpoints.x2;
        const y2 = endpoints.y2;
        const mid = Math.max(60, Math.abs(x2 - x1) / 2);
        const label = edge.label || edgeTypeLabel(edge.type);
        const style = edgeStyle(edge.type);
        const labelX = Math.round((x1 + x2) / 2);
        const labelY = Math.round(((y1 + y2) / 2) - 8);
        const labelWidth = Math.max(38, label.length * 12);
        const selected = edge.id === selectedEdgeId || selectedEdgeIds.has(edge.id);
        const dimmed = focus && (focusEdges ? !focusEdges.has(edge.id) : (!focus.has(edge.fromNodeId) || !focus.has(edge.toNodeId)));
        const hit = isSearchHit('edge', edge.id);
        const stroke = hit ? 'var(--vscode-textLink-foreground)' : style.color;
        const d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + mid) + ' ' + y1 + ', ' + (x2 - mid) + ' ' + y2 + ', ' + x2 + ' ' + y2;
        const hitPath = '<path class="edge-hit" data-id="' + edge.id + '" d="' + d + '"></path>';
        const path = '<path class="edge' + (selected ? ' selected' : '') + (hit ? ' search-hit' : '') + (edge.status === 'deprecated' ? ' deprecated' : '') + ' ' + escapeAttr(edge.strength || 'normal') + (dimmed ? ' dimmed' : '') + '" data-id="' + edge.id + '" style="stroke:' + stroke + ';stroke-dasharray:' + edgeDash(edge, style) + '" marker-end="url(#arrow-' + edge.type + ')" d="' + d + '"></path>';
        const text = '<rect class="edge-label-bg" data-id="' + edge.id + '" x="' + (labelX - labelWidth / 2) + '" y="' + (labelY - 13) + '" width="' + labelWidth + '" height="17" rx="4"></rect><text class="edge-label" data-id="' + edge.id + '" text-anchor="middle" x="' + labelX + '" y="' + labelY + '">' + escapeHtml(label) + '</text>';
        return hitPath + path + text;
      }).join('') + previewPath;
      document.querySelectorAll('.edge, .edge-hit, .edge-label, .edge-label-bg').forEach((el) => el.addEventListener('click', (event) => selectEdgeFromElement(el, event)));
      document.querySelectorAll('.edge, .edge-hit, .edge-label, .edge-label-bg').forEach((el) => {
        el.addEventListener('mouseenter', (event) => showEdgeTip(event, el.dataset.id));
        el.addEventListener('mousemove', (event) => positionEdgeTip(event.clientX, event.clientY));
        el.addEventListener('mouseleave', hideEdgeTip);
      });
      document.querySelectorAll('.edge, .edge-hit, .edge-label, .edge-label-bg').forEach((el) => el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openEdgeContextMenu(el.dataset.id, event.clientX, event.clientY);
      }));
    }
    function renderConnectionPreview() {
      if (!connectionPreview) return '';
      const from = byId(connectionPreview.fromNodeId);
      if (!from) return '';
      const start = nodeAnchorForPoint(from, connectionPreview);
      const x1 = start.x;
      const y1 = start.y;
      const x2 = connectionPreview.x;
      const y2 = connectionPreview.y;
      const mid = Math.max(60, Math.abs(x2 - x1) / 2);
      const d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + mid) + ' ' + y1 + ', ' + (x2 - mid) + ' ' + y2 + ', ' + x2 + ' ' + y2;
      return '<path class="edge-preview" d="' + d + '"></path>';
    }
    function selectEdgeFromElement(el, event) {
      if (event.shiftKey) {
        selectedEdgeId = '';
        if (selectedEdgeIds.has(el.dataset.id)) selectedEdgeIds.delete(el.dataset.id); else selectedEdgeIds.add(el.dataset.id);
      } else {
        selectedEdgeIds.clear();
        selectedEdgeId = el.dataset.id;
      }
      selectedNodeId = '';
      selectedNodeIds.clear();
      render();
    }
    function openEdgeContextMenu(edgeId, clientX, clientY) {
      if (!edgeId) return;
      if (!selectedEdgeIds.has(edgeId) && selectedEdgeId !== edgeId) {
        selectedEdgeIds.clear();
        selectedEdgeId = edgeId;
      }
      selectedNodeId = '';
      selectedNodeIds.clear();
      render();
      showContextMenu(clientX, clientY, [
        { label: '改为剧情流', run: () => setEdgeType(edgeId, 'flow') },
        { label: '改为引用', run: () => setEdgeType(edgeId, 'uses') },
        { label: '改为冲突', run: () => setEdgeType(edgeId, 'conflicts') },
        { label: '改为伏笔', run: () => setEdgeType(edgeId, 'foreshadows') },
        { label: '改为回收', run: () => setEdgeType(edgeId, 'resolves') },
        { label: '删除关系', danger: true, run: () => deleteEdgeById(edgeId) },
        { label: '反转方向', run: () => reverseSelectedEdges() },
        { label: '复制关系类型', run: () => copySelectedEdgeType() }
      ]);
    }
    function wireNode(el) {
      let dragging = false;
      let resizing = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let starts = [];
      let resizeStart = null;
      let relationDragFrom = '';
      let relationDragActive = false;
      el.addEventListener('pointerdown', (event) => {
        if (event.target.classList.contains('collapseToggle') || event.target.classList.contains('lockToggle')) return;
        const node = byId(el.dataset.id);
        if (!node) return;
        if (event.target.classList.contains('resizeHandle')) {
          event.preventDefault();
          selectedEdgeId = '';
          selectedEdgeIds.clear();
          selectedNodeIds.clear();
          selectedNodeId = node.id;
          updateNodeSelectionClasses();
          renderRightPanel();
          if (node.locked) return;
          resizing = true;
          moved = false;
          startX = event.clientX;
          startY = event.clientY;
          resizeStart = { width: node.width, height: node.height };
          pushHistory();
          el.setPointerCapture(event.pointerId);
          return;
        }
        if (event.button === 0 && !event.shiftKey && !event.target.closest('.node-head')) {
          event.preventDefault();
          selectedEdgeId = '';
          selectedEdgeIds.clear();
          selectedNodeIds.clear();
          selectedNodeId = node.id;
          relationDragFrom = node.id;
          relationDragActive = false;
          startX = event.clientX;
          startY = event.clientY;
          connectFrom = node.id;
          updateNodeSelectionClasses();
          renderRightPanel();
          el.setPointerCapture(event.pointerId);
          return;
        }
        if (connectFrom && connectFrom !== node.id && event.button === 0) {
          event.preventDefault();
          connectNodes(connectFrom, node.id);
          if (relationBrush) {
            connectFrom = node.id;
            renderNodes();
          }
          return;
        }
        if (focusMode === 'path' && event.button === 0 && !event.shiftKey && !relationBrush) {
          event.preventDefault();
          selectPathEndpoint(node.id);
          return;
        }
        if (relationBrush && event.button === 0) {
          event.preventDefault();
          relationDragFrom = node.id;
          relationDragActive = false;
          startX = event.clientX;
          startY = event.clientY;
          if (!connectFrom) {
            connectFrom = node.id;
            renderNodes();
          }
          el.setPointerCapture(event.pointerId);
          return;
        }
        selectedEdgeId = '';
        selectedEdgeIds.clear();
        if (!event.shiftKey && !selectedNodeIds.has(node.id)) {
          selectedNodeIds.clear();
          selectedNodeId = node.id;
        } else {
          selectedNodeId = '';
          selectedNodeIds.add(node.id);
        }
        if (node.locked) {
          updateNodeSelectionClasses();
          renderRightPanel();
          return;
        }
        dragging = true;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        starts = selectedNodes().map((item) => ({ id: item.id, x: item.x, y: item.y }));
        pushHistory();
        el.setPointerCapture(event.pointerId);
        updateNodeSelectionClasses();
        renderRightPanel();
      });
      el.addEventListener('pointermove', (event) => {
        if (relationDragFrom) {
          const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
          if (distance > 4) relationDragActive = true;
          if (relationDragActive) {
            const point = clientToWorld(event);
            connectionPreview = { fromNodeId: relationDragFrom, x: point.x, y: point.y };
            renderEdges();
          }
          return;
        }
        if (resizing) {
          const node = byId(el.dataset.id);
          if (!node || !resizeStart) return;
          moved = true;
          node.width = Math.max(140, Math.round(resizeStart.width + (event.clientX - startX) / scale));
          node.height = Math.max(70, Math.round(resizeStart.height + (event.clientY - startY) / scale));
          el.style.width = node.width + 'px';
          el.style.height = nodeVisualHeight(node) + 'px';
          renderEdges();
          return;
        }
        if (!dragging) return;
        moved = true;
        for (const start of starts) {
          const node = byId(start.id);
          if (!node) continue;
          node.x = Math.round(start.x + (event.clientX - startX) / scale);
          node.y = Math.round(start.y + (event.clientY - startY) / scale);
          const nodeEl = document.querySelector('.node[data-id="' + cssEscape(node.id) + '"]');
          if (nodeEl) {
            nodeEl.style.left = node.x + 'px';
            nodeEl.style.top = node.y + 'px';
          }
        }
        renderEdges();
      });
      el.addEventListener('pointerup', (event) => {
        if (relationDragFrom) {
          const targetEl = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node');
          const targetId = targetEl?.dataset.id || '';
          if (relationDragActive && targetId && targetId !== relationDragFrom) {
            connectNodes(relationDragFrom, targetId);
          }
          relationDragFrom = '';
          relationDragActive = false;
          connectionPreview = null;
          connectFrom = '';
          renderEdges();
          renderNodes();
        }
        if (resizing && moved) {
          save();
        } else if (resizing) {
          history.pop();
        }
        resizing = false;
        resizeStart = null;
        if (dragging && moved) {
          save();
        } else if (dragging) {
          history.pop();
        }
        dragging = false;
      });
      el.addEventListener('dblclick', () => {
        const node = byId(el.dataset.id);
        if (node && node.refPath) post({ command: 'open-source', source: node.refPath });
      });
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const node = byId(el.dataset.id);
        const sourceDelete = node ? nodeSourceDeleteAction(node) : undefined;
        const previousSelected = selectedNodes();
        const rightClickedSelected = selectedNodeIds.has(el.dataset.id) || selectedNodeId === el.dataset.id;
        if (!rightClickedSelected) {
          selectedNodeIds.clear();
          selectedNodeId = el.dataset.id;
        } else if (selectedNodeIds.size > 1) {
          selectedNodeId = '';
        }
        selectedEdgeId = '';
        render();
        const actions = [{ label: '删除', run: () => deleteSelection() }];
        const connectTargets = rightClickedSelected ? selectedNodes().filter((candidate) => candidate.id !== el.dataset.id) : previousSelected;
        if (node) {
          actions.unshift({ label: node.locked ? '解锁节点' : '锁定节点', run: () => toggleNodeLock(node.id) });
          actions.unshift({ label: node.collapsed ? '展开节点' : '折叠节点', run: () => toggleNodeCollapse(node.id) });
          actions.unshift({ label: '定位到节点', run: () => centerOnNode(node.id) });
        }
        if (connectTargets.length > 0) {
          actions.unshift({ label: '连接选中到此节点', run: () => connectSelectedToNode(el.dataset.id, connectTargets.map((candidate) => candidate.id)) });
          actions.unshift({ label: '从此节点连接到选中', run: () => connectNodeToSelected(el.dataset.id, connectTargets.map((candidate) => candidate.id)) });
        }
        actions.unshift({ label: '恢复显示全部', run: () => { focusMode = 'all'; pathStartId = ''; pathEndId = ''; pathMessage = ''; document.getElementById('focusMode').value = focusMode; render(); } });
        actions.unshift({ label: '只看此节点关系', run: () => { selectedNodeId = el.dataset.id; selectedNodeIds.clear(); focusMode = 'one'; document.getElementById('focusMode').value = focusMode; render(); } });
        actions.unshift({ label: '显示一阶关系', run: () => { selectedNodeId = el.dataset.id; selectedNodeIds.clear(); focusMode = 'one'; document.getElementById('focusMode').value = focusMode; render(); } });
        actions.unshift({ label: '显示二阶关系', run: () => { selectedNodeId = el.dataset.id; selectedNodeIds.clear(); focusMode = 'two'; document.getElementById('focusMode').value = focusMode; render(); } });
        if (sourceDelete) {
          actions.push({ label: '完全删除', danger: true, run: () => post(sourceDelete) });
        }
        showContextMenu(event.clientX, event.clientY, actions);
      });
      el.querySelector('.collapseToggle').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleNodeCollapse(el.dataset.id);
      });
      el.querySelector('.lockToggle').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleNodeLock(el.dataset.id);
      });
    }
    function renderRightPanel() {
      document.getElementById('tabInspector').classList.toggle('active', activeTab === 'inspector');
      document.getElementById('tabSync').classList.toggle('active', activeTab === 'sync');
      if (activeTab === 'sync') {
        renderSyncPanel();
      } else {
        renderInspector();
      }
    }
    function renderInspector() {
      const nodes = selectedNodes();
      const edge = selectedEdgeId ? edgeById(selectedEdgeId) : undefined;
      const relationIssues = renderRelationIssuesPanel();
      const pathHint = renderPathHint();
      if (nodes.length > 1) {
        rightPanel.innerHTML = '<div class="row"><label>已选择</label><div>' + nodes.length + ' 个节点</div></div>' +
          '<div class="row"><label>批量颜色</label><input id="multiColor" value="' + escapeAttr(nodes[0].color || '') + '"></div>' +
          '<div class="row"><label>节点操作</label><div class="sync-actions">' +
            '<button class="secondary" id="collapseNodes">折叠</button>' +
            '<button class="secondary" id="expandNodes">展开</button>' +
            '<button class="secondary" id="lockNodes">锁定</button>' +
            '<button class="secondary" id="unlockNodes">解锁</button>' +
            '<button class="secondary" id="alignLeftNodes">左对齐</button>' +
            '<button class="secondary" id="alignTopNodes">上对齐</button>' +
            '<button class="secondary" id="sameSizeNodes">统一尺寸</button>' +
          '</div></div>' +
          '<div class="row"><label>关系操作</label><div class="sync-actions">' +
            '<button class="secondary" id="chainEdges">按顺序串联</button>' +
            '<button class="secondary" id="toFirstEdges">全部连到第一个</button>' +
            '<button class="secondary" id="toLastEdges">全部连到最后一个</button>' +
            '<button class="secondary" id="meshEdges">两两连接</button>' +
          '</div></div>' +
          '<button id="saveMulti">保存颜色</button>' +
          pathHint +
          relationIssues;
        document.getElementById('saveMulti').addEventListener('click', () => {
          const color = document.getElementById('multiColor').value;
          commit(() => nodes.forEach((node) => { node.color = color; }));
        });
        document.getElementById('collapseNodes').addEventListener('click', () => commit(() => nodes.forEach((node) => { node.collapsed = true; })));
        document.getElementById('expandNodes').addEventListener('click', () => commit(() => nodes.forEach((node) => { node.collapsed = false; })));
        document.getElementById('lockNodes').addEventListener('click', () => commit(() => nodes.forEach((node) => { node.locked = true; })));
        document.getElementById('unlockNodes').addEventListener('click', () => commit(() => nodes.forEach((node) => { node.locked = false; })));
        document.getElementById('alignLeftNodes').addEventListener('click', () => {
          const x = Math.min(...nodes.map((node) => node.x));
          commit(() => nodes.filter((node) => !node.locked).forEach((node) => { node.x = x; }));
        });
        document.getElementById('alignTopNodes').addEventListener('click', () => {
          const y = Math.min(...nodes.map((node) => node.y));
          commit(() => nodes.filter((node) => !node.locked).forEach((node) => { node.y = y; }));
        });
        document.getElementById('sameSizeNodes').addEventListener('click', () => {
          const width = nodes[0].width;
          const height = nodes[0].height;
          commit(() => nodes.filter((node) => !node.locked).forEach((node) => { node.width = width; node.height = height; }));
        });
        document.getElementById('chainEdges').addEventListener('click', () => createBatchEdges('chain'));
        document.getElementById('toFirstEdges').addEventListener('click', () => createBatchEdges('to-first'));
        document.getElementById('toLastEdges').addEventListener('click', () => createBatchEdges('to-last'));
        document.getElementById('meshEdges').addEventListener('click', () => createBatchEdges('mesh'));
      } else if (nodes.length === 1) {
        const node = nodes[0];
        const semantic = semanticForNode(node);
        rightPanel.innerHTML = '<div class="row"><label>标题</label><input id="nodeTitle" value="' + escapeAttr(node.title) + '"></div>' +
          '<div class="row"><label>备注</label><textarea id="nodeNote">' + escapeHtml(node.note || '') + '</textarea></div>' +
          '<div class="row"><label>颜色</label><input id="nodeColor" value="' + escapeAttr(node.color || '') + '"></div>' +
          '<div class="row"><label>标签</label><input id="nodeTags" value="' + escapeAttr((node.tags || []).join(', ')) + '"></div>' +
          '<div class="row two"><label><input id="nodeLocked" type="checkbox"' + (node.locked ? ' checked' : '') + '> 锁定</label><label><input id="nodeCollapsed" type="checkbox"' + (node.collapsed ? ' checked' : '') + '> 折叠</label></div>' +
          '<details class="inspector-section"><summary>布局与来源</summary><div class="inspector-section-body">' +
            '<div class="row two"><div><label>宽度</label><input id="nodeWidth" type="number" min="140" value="' + escapeAttr(node.width) + '"></div><div><label>高度</label><input id="nodeHeight" type="number" min="70" value="' + escapeAttr(node.height) + '"></div></div>' +
            '<div class="row"><label>来源</label><input readonly value="' + escapeAttr(node.refPath || '本地备注节点') + '"></div>' +
            '<div class="row"><label>语义摘要</label><div class="small"><strong>' + escapeHtml(semantic.label) + '</strong><br>' + semantic.lines.map(escapeHtml).join('<br>') + '</div></div>' +
          '</div></details>' +
          '<div class="small">' + (node.lastSynced ? '有同步快照：' + escapeHtml(node.lastSynced.syncedAt) : '没有同步快照，首次同步会要求确认。') + '</div>' +
          '<div class="sync-actions"><button id="saveNode">保存节点</button><button class="secondary" id="focusNode">定位</button></div>' +
          pathHint +
          relationIssues;
        document.getElementById('saveNode').addEventListener('click', () => {
          commit(() => {
            node.title = document.getElementById('nodeTitle').value;
            node.note = document.getElementById('nodeNote').value;
            node.color = document.getElementById('nodeColor').value;
            node.tags = parseTags(document.getElementById('nodeTags').value);
            node.width = Math.max(140, Number(document.getElementById('nodeWidth').value) || node.width);
            node.height = Math.max(70, Number(document.getElementById('nodeHeight').value) || node.height);
            node.locked = document.getElementById('nodeLocked').checked;
            node.collapsed = document.getElementById('nodeCollapsed').checked;
          });
        });
        document.getElementById('focusNode').addEventListener('click', () => centerOnNode(node.id));
      } else if (edge) {
        const issues = edgeIssuesFor(edge.id);
        rightPanel.innerHTML = '<div class="row"><label>类型</label><select id="edgeEditType">' + edgeTypeOptions() + '</select></div>' +
          '<div class="small">关系从节点连到节点；选中关系线后在这里或右键菜单切换线型。</div>' +
          '<div class="row"><label>标签</label><input id="edgeLabel" value="' + escapeAttr(edge.label || '') + '"></div>' +
          '<div class="row"><label>说明</label><textarea id="edgeNote">' + escapeHtml(edge.note || '') + '</textarea></div>' +
          '<div class="row two"><div><label>强度</label><select id="edgeStrength">' + edgeStrengthOptions() + '</select></div><div><label>状态</label><select id="edgeStatus">' + edgeStatusOptions() + '</select></div></div>' +
          '<div class="row"><label>建议用法</label><div class="small">' + escapeHtml(edgeTypeHelp(edge.type)) + '</div></div>' +
          issues.map((issue) => '<div class="issue ' + escapeAttr(issue.severity) + '"><strong>' + escapeHtml(issue.title) + '</strong><div class="small">' + escapeHtml(issue.detail) + '</div></div>').join('') +
          '<div class="sync-actions"><button id="saveEdge">保存连线</button><button class="secondary" id="reverseEdge">反转方向</button><button class="danger" id="deleteEdge">删除</button></div>' +
          pathHint +
          relationIssues;
        document.getElementById('edgeEditType').value = edge.type;
        document.getElementById('edgeStrength').value = edge.strength || 'normal';
        document.getElementById('edgeStatus').value = edge.status || 'draft';
        document.getElementById('saveEdge').addEventListener('click', () => {
          commit(() => {
            edge.type = document.getElementById('edgeEditType').value;
            edge.fromPortId = defaultOutputPortForEdge(edge.type);
            edge.toPortId = defaultInputPortForEdge(edge.type);
            edge.label = document.getElementById('edgeLabel').value;
            edge.note = document.getElementById('edgeNote').value;
            edge.strength = document.getElementById('edgeStrength').value;
            edge.status = document.getElementById('edgeStatus').value;
            edge.updatedAt = new Date().toISOString();
          });
        });
        document.getElementById('reverseEdge').addEventListener('click', reverseSelectedEdges);
        document.getElementById('deleteEdge').addEventListener('click', deleteSelection);
      } else {
        rightPanel.innerHTML = '<div class="empty">选择节点或连线。</div>' + pathHint + relationIssues;
      }
      wireRelationIssueNavigation();
    }
    function renderSyncPanel() {
      if (!state.syncPreview) {
        rightPanel.innerHTML = '<button id="loadSync">生成同步预览</button><div class="empty">同步不会自动写回源文件。</div>' + renderMarkdownSyncPanel();
        document.getElementById('loadSync').addEventListener('click', () => post({ command: 'preview-sync', blueprintId: current.id }));
        wireMarkdownSyncPanel();
        return;
      }
      const summary = state.syncPreview.summary;
      const result = state.syncResult ? '<div class="small">上次同步：应用 ' + state.syncResult.applied + '，拉取 ' + state.syncResult.pulled + '，推送 ' + state.syncResult.pushed + '，删除来源 ' + (state.syncResult.deletedSources || 0) + '，跳过 ' + state.syncResult.skipped + '</div>' : '';
      rightPanel.innerHTML = result + '<div class="small">拉取 ' + summary.pull + ' · 推送 ' + summary.push + ' · 冲突 ' + summary.conflict + ' · 缺失 ' + summary.missing + ' · 一致 ' + summary.unchanged + '</div>' +
        '<div class="sync-actions"><button id="applySuggested">应用建议</button><button class="secondary" id="applyClean">只应用无冲突</button><button class="secondary" id="pullAll">全部拉取</button><button class="secondary" id="pushAll">全部推送</button><button class="secondary" id="reloadSync">重新预览</button></div>' +
        renderSyncGroups() +
        renderMarkdownSyncPanel();
      document.getElementById('reloadSync').addEventListener('click', () => post({ command: 'preview-sync', blueprintId: current.id }));
      document.getElementById('applySuggested').addEventListener('click', () => {
        const decisions = state.syncPreview.items
          .filter((item) => item.defaultAction !== 'skip')
          .map((item) => ({ itemId: item.id, action: item.defaultAction }));
        post({ command: 'apply-sync', blueprintId: current.id, decisions });
      });
      document.getElementById('applyClean').addEventListener('click', () => {
        const decisions = state.syncPreview.items
          .filter((item) => item.status === 'pull' || item.status === 'push')
          .map((item) => ({ itemId: item.id, action: item.defaultAction }));
        post({ command: 'apply-sync', blueprintId: current.id, decisions });
      });
      document.getElementById('pullAll').addEventListener('click', () => {
        const decisions = state.syncPreview.items
          .filter((item) => item.status !== 'missing' && item.status !== 'unchanged')
          .map((item) => ({ itemId: item.id, action: 'pull' }));
        post({ command: 'apply-sync', blueprintId: current.id, decisions });
      });
      document.getElementById('pushAll').addEventListener('click', () => {
        const decisions = state.syncPreview.items
          .filter((item) => item.status !== 'missing' && item.status !== 'unchanged')
          .map((item) => ({ itemId: item.id, action: 'push' }));
        post({ command: 'apply-sync', blueprintId: current.id, decisions });
      });
      document.querySelectorAll('[data-sync-action]').forEach((button) => {
        button.addEventListener('click', () => {
          post({ command: 'apply-sync', blueprintId: current.id, decisions: [{ itemId: button.dataset.itemId, action: button.dataset.syncAction }] });
        });
      });
      document.querySelectorAll('[data-sync-item]').forEach((el) => {
        el.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          const item = state.syncPreview.items.find((candidate) => candidate.id === el.dataset.syncItem);
          if (item && isDeletableSourceKind(item.refKind) && item.status !== 'missing') {
            post({ command: 'apply-sync', blueprintId: current.id, decisions: [{ itemId: item.id, action: 'delete-source' }] });
          }
        });
      });
      wireMarkdownSyncPanel();
    }
    function renderSyncGroups() {
      return ['conflict', 'push', 'pull', 'missing', 'unchanged'].map((status) => {
        const items = state.syncPreview.items.filter((item) => item.status === status);
        if (items.length === 0) return '';
        return '<div class="sync-group"><h2><span>' + escapeHtml(syncStatusLabel(status)) + '</span><span>' + items.length + '</span></h2>' + items.map(renderSyncItem).join('') + '</div>';
      }).join('');
    }
    function renderSyncItem(item) {
      const diffs = (item.fieldDiffs || []).map((diff) => '<div class="diff' + (diff.changed ? ' changed' : '') + '"><strong>' + escapeHtml(diff.label) + '</strong><div class="small">蓝图：' + escapeHtml(diff.nodeValue || '') + '</div><div class="small">来源：' + escapeHtml(diff.sourceValue || '') + '</div></div>').join('');
      return '<div class="sync-item ' + escapeAttr(item.status) + '" data-sync-item="' + escapeAttr(item.id) + '">' +
        '<div class="sync-head"><span>' + escapeHtml(item.nodeTitle) + '</span><span>' + escapeHtml(syncStatusLabel(item.status)) + '</span></div>' +
        '<div class="small">' + escapeHtml(item.detail) + '</div>' +
        diffs +
        '<div class="sync-actions">' +
          '<button class="secondary" data-item-id="' + escapeAttr(item.id) + '" data-sync-action="pull">拉取</button>' +
          '<button class="secondary" data-item-id="' + escapeAttr(item.id) + '" data-sync-action="push">推送</button>' +
          '<button class="secondary" data-item-id="' + escapeAttr(item.id) + '" data-sync-action="skip">跳过</button>' +
        '</div></div>';
    }
    function renderMarkdownSyncPanel() {
      const preview = state.markdownSyncPreview;
      if (!preview) {
        return '<div class="sync-group" id="markdownSync"><h2>Markdown 互转</h2><div class="small">Markdown 使用可读大纲 + @node/@port/@wire 明文蓝图代码。</div><div class="sync-actions"><button class="secondary" id="loadMarkdownSync">Markdown 同步预览</button><button class="secondary" id="exportMarkdownFromSync">导出 Markdown</button><button class="secondary" id="importMarkdownFromSync">导入 Markdown</button></div></div>';
      }
      const summary = preview.summary;
      return '<div class="sync-group" id="markdownSync"><h2>Markdown 同步</h2>' +
        '<div class="small">路径：' + escapeHtml(preview.markdownPath) + '</div>' +
        '<div class="small">拉取 ' + summary.pull + ' · 推送 ' + summary.push + ' · 冲突 ' + summary.conflict + ' · 缺失 ' + summary.missing + ' · 一致 ' + summary.unchanged + '</div>' +
        '<div class="sync-actions"><button class="secondary" id="reloadMarkdownSync">重新预览</button><button class="secondary" id="pushMarkdown">推送到 Markdown</button><button class="secondary" id="pullMarkdown">从 Markdown 拉取</button><button class="secondary" id="skipMarkdown">跳过</button></div>' +
        preview.items.map((item) => '<div class="sync-item ' + escapeAttr(item.status) + '"><div class="sync-head"><span>' + escapeHtml(item.label) + '</span><span>' + escapeHtml(item.status) + '</span></div><div class="small">' + escapeHtml(item.detail) + '</div></div>').join('') +
        '</div>';
    }
    function wireMarkdownSyncPanel() {
      const load = document.getElementById('loadMarkdownSync');
      if (load) load.addEventListener('click', () => post({ command: 'preview-markdown-sync', blueprintId: current.id }));
      const reload = document.getElementById('reloadMarkdownSync');
      if (reload) reload.addEventListener('click', () => post({ command: 'preview-markdown-sync', blueprintId: current.id }));
      const exportButton = document.getElementById('exportMarkdownFromSync');
      if (exportButton) exportButton.addEventListener('click', () => post({ command: 'export-markdown', blueprintId: current.id }));
      const importButton = document.getElementById('importMarkdownFromSync');
      if (importButton) importButton.addEventListener('click', () => post({ command: 'import-markdown', blueprintId: current.id }));
      const push = document.getElementById('pushMarkdown');
      if (push && state.markdownSyncPreview) push.addEventListener('click', () => post({ command: 'apply-markdown-sync', blueprintId: current.id, markdownPath: state.markdownSyncPreview.markdownPath, decisions: state.markdownSyncPreview.items.map((item) => ({ itemId: item.id, action: 'push' })) }));
      const pull = document.getElementById('pullMarkdown');
      if (pull && state.markdownSyncPreview) pull.addEventListener('click', () => post({ command: 'apply-markdown-sync', blueprintId: current.id, markdownPath: state.markdownSyncPreview.markdownPath, decisions: state.markdownSyncPreview.items.map((item) => ({ itemId: item.id, action: 'pull' })) }));
      const skip = document.getElementById('skipMarkdown');
      if (skip && state.markdownSyncPreview) skip.addEventListener('click', () => post({ command: 'apply-markdown-sync', blueprintId: current.id, markdownPath: state.markdownSyncPreview.markdownPath, decisions: state.markdownSyncPreview.items.map((item) => ({ itemId: item.id, action: 'skip' })) }));
    }
    function refreshSearchResults(keepIndex) {
      const query = blueprintSearch.trim().toLowerCase();
      if (!query) {
        searchResults = [];
        searchIndex = -1;
        updateSearchCount();
        return;
      }
      const results = [];
      for (const node of current.nodes) {
        const semantic = semanticForNode(node);
        const haystack = [
          node.title,
          node.note || '',
          ...(node.tags || []),
          node.refPath || '',
          semantic.label,
          semantic.badge,
          ...(semantic.lines || [])
        ].join(' ').toLowerCase();
        if (haystack.includes(query)) results.push({ kind: 'node', id: node.id });
      }
      for (const edge of current.edges) {
        const from = byId(edge.fromNodeId);
        const to = byId(edge.toNodeId);
        const haystack = [
          edge.label || '',
          edge.note || '',
          edgeTypeLabel(edge.type),
          from?.title || '',
          to?.title || ''
        ].join(' ').toLowerCase();
        if (haystack.includes(query)) results.push({ kind: 'edge', id: edge.id });
      }
      const previous = searchResults[searchIndex];
      searchResults = results;
      if (!searchResults.length) {
        searchIndex = -1;
      } else if (keepIndex && previous) {
        const nextIndex = searchResults.findIndex((item) => item.kind === previous.kind && item.id === previous.id);
        searchIndex = nextIndex >= 0 ? nextIndex : Math.min(searchIndex, searchResults.length - 1);
      } else {
        searchIndex = 0;
      }
      updateSearchCount();
    }
    function updateSearchCount() {
      const el = document.getElementById('searchCount');
      if (el) el.textContent = searchResults.length ? (searchIndex + 1) + '/' + searchResults.length : (blueprintSearch.trim() ? '0/0' : '');
    }
    function isSearchHit(kind, id) {
      return searchResults.some((item) => item.kind === kind && item.id === id);
    }
    function jumpSearchResult(delta) {
      refreshSearchResults(true);
      if (!searchResults.length) {
        render();
        return;
      }
      searchIndex = (searchIndex + delta + searchResults.length) % searchResults.length;
      const target = searchResults[searchIndex];
      selectedNodeId = '';
      selectedEdgeId = '';
      selectedNodeIds.clear();
      selectedEdgeIds.clear();
      if (target.kind === 'node') {
        selectedNodeId = target.id;
        render();
        centerOnNode(target.id);
      } else {
        const edge = edgeById(target.id);
        selectedEdgeId = target.id;
        render();
        if (edge) centerOnEdge(edge);
      }
      updateSearchCount();
    }
    function saveViewportBookmark() {
      const bookmarks = current.viewportBookmarks || [];
      const now = new Date().toISOString();
      commit(() => {
        current.viewportBookmarks = [
          ...bookmarks,
          { id: 'bp-view-' + Date.now(), title: '视角 ' + (bookmarks.length + 1), x: panX, y: panY, scale, createdAt: now }
        ];
      });
    }
    function deleteSelectedViewportBookmark() {
      const id = document.getElementById('viewportBookmarkSelect').value;
      if (!id) return;
      commit(() => {
        current.viewportBookmarks = (current.viewportBookmarks || []).filter((bookmark) => bookmark.id !== id);
      });
    }
    function renderMinimap() {
      if (!minimap) return;
      const bounds = blueprintBounds();
      if (!bounds) {
        minimap.innerHTML = '<div class="empty" style="padding:8px">暂无节点</div>';
        return;
      }
      const width = 190;
      const height = 132;
      const pad = 10;
      const factor = Math.min((width - pad * 2) / Math.max(1, bounds.width), (height - pad * 2) / Math.max(1, bounds.height));
      const mapX = (x) => pad + (x - bounds.minX) * factor;
      const mapY = (y) => pad + (y - bounds.minY) * factor;
      const rect = canvas.getBoundingClientRect();
      const viewLeft = (-panX) / scale;
      const viewTop = (-panY) / scale;
      const viewWidth = rect.width / scale;
      const viewHeight = rect.height / scale;
      const nodes = current.nodes.map((node) => {
        const selected = selectedNodeId === node.id || selectedNodeIds.has(node.id);
        return '<rect class="minimap-node' + (selected ? ' selected' : '') + '" x="' + mapX(node.x) + '" y="' + mapY(node.y) + '" width="' + Math.max(3, node.width * factor) + '" height="' + Math.max(3, nodeVisualHeight(node) * factor) + '" rx="1"></rect>';
      }).join('');
      const viewport = '<rect class="minimap-viewport" x="' + mapX(viewLeft) + '" y="' + mapY(viewTop) + '" width="' + Math.max(8, viewWidth * factor) + '" height="' + Math.max(8, viewHeight * factor) + '" rx="2"></rect>';
      minimap.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" data-minimap="true">' + nodes + viewport + '</svg>';
    }
    function panFromMinimapEvent(event) {
      const bounds = blueprintBounds();
      if (!bounds) return;
      const rect = minimap.getBoundingClientRect();
      const width = 190;
      const height = 132;
      const pad = 10;
      const factor = Math.min((width - pad * 2) / Math.max(1, bounds.width), (height - pad * 2) / Math.max(1, bounds.height));
      const mapX = event.clientX - rect.left;
      const mapY = event.clientY - rect.top;
      const worldX = bounds.minX + (mapX - pad) / factor;
      const worldY = bounds.minY + (mapY - pad) / factor;
      focusViewportOnPoint(worldX, worldY, false);
    }
    function deleteSelection() {
      hideContextMenu();
      const nodeIds = new Set(selectedNodes().map((node) => node.id));
      const edgeIds = new Set(selectedEdges().map((edge) => edge.id));
      if (nodeIds.size === 0 && edgeIds.size === 0) return;
      commit(() => {
        current.nodes = current.nodes.filter((node) => !nodeIds.has(node.id));
        current.edges = current.edges.filter((edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.fromNodeId) && !nodeIds.has(edge.toNodeId));
        selectedNodeId = '';
        selectedEdgeId = '';
        selectedNodeIds.clear();
        selectedEdgeIds.clear();
      });
    }
    function deleteEdgeById(edgeId) {
      if (!edgeId) return;
      hideContextMenu();
      const ids = selectedEdgeIds.has(edgeId) ? new Set(selectedEdges().map((edge) => edge.id)) : new Set([edgeId]);
      commit(() => {
        current.edges = current.edges.filter((edge) => !ids.has(edge.id));
        selectedEdgeId = '';
        selectedEdgeIds.clear();
      });
    }
    function selectedNodeOrder() {
      return selectedNodes().sort((left, right) => left.x - right.x || left.y - right.y || left.title.localeCompare(right.title, 'zh-Hans-CN'));
    }
    function createBatchEdges(mode) {
      const nodes = selectedNodeOrder();
      const type = document.getElementById('edgeType').value;
      const pairs = [];
      if (mode === 'chain') {
        for (let index = 0; index < nodes.length - 1; index += 1) pairs.push([nodes[index].id, nodes[index + 1].id]);
      } else if (mode === 'to-first') {
        const first = nodes[0];
        for (const node of nodes.slice(1)) pairs.push([node.id, first.id]);
      } else if (mode === 'to-last') {
        const last = nodes[nodes.length - 1];
        for (const node of nodes.slice(0, -1)) pairs.push([node.id, last.id]);
      } else if (mode === 'mesh') {
        for (let left = 0; left < nodes.length; left += 1) {
          for (let right = left + 1; right < nodes.length; right += 1) pairs.push([nodes[left].id, nodes[right].id]);
        }
      }
      if (pairs.length === 0) return;
      commit(() => pairs.forEach(([from, to]) => addEdgeIfMissing(from, to, type)));
    }
    function addEdgeIfMissing(fromNodeId, toNodeId, type, label, fromPortId, toPortId) {
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return false;
      const normalizedFromPort = fromPortId || defaultOutputPortForEdge(type);
      const normalizedToPort = toPortId || defaultInputPortForEdge(type);
      const exists = current.edges.some((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId && (edge.fromPortId || defaultOutputPortForEdge(edge.type)) === normalizedFromPort && (edge.toPortId || defaultInputPortForEdge(edge.type)) === normalizedToPort && edge.type === type);
      if (exists) return false;
      const now = new Date().toISOString();
      current.edges.push({ id: 'bp-edge-' + Date.now() + '-' + Math.floor(Math.random() * 1000), fromNodeId, toNodeId, fromPortId: normalizedFromPort, toPortId: normalizedToPort, type, label: label || '', note: '', strength: 'normal', status: 'draft', createdAt: now, updatedAt: now });
      return true;
    }
    function reverseSelectedEdges() {
      const edges = selectedEdges();
      if (edges.length === 0) return;
      commit(() => edges.forEach((edge) => {
        const from = edge.fromNodeId;
        const fromPort = edge.fromPortId;
        edge.fromNodeId = edge.toNodeId;
        edge.toNodeId = from;
        edge.fromPortId = edge.toPortId || defaultOutputPortForEdge(edge.type);
        edge.toPortId = fromPort || defaultInputPortForEdge(edge.type);
        edge.updatedAt = new Date().toISOString();
      }));
    }
    function copySelectedEdgeType() {
      const edge = selectedEdges()[0];
      if (!edge) return;
      document.getElementById('edgeType').value = edge.type;
    }
    function setEdgeType(edgeId, type) {
      const edge = edgeById(edgeId);
      if (!edge) return;
      commit(() => {
        edge.type = type;
        edge.fromPortId = defaultOutputPortForEdge(type);
        edge.toPortId = defaultInputPortForEdge(type);
        edge.updatedAt = new Date().toISOString();
      });
    }
    function connectSelectedToNode(targetNodeId, sourceNodeIds) {
      const type = document.getElementById('edgeType').value;
      commit(() => sourceNodeIds.filter((id) => id !== targetNodeId).forEach((id) => addEdgeIfMissing(id, targetNodeId, type)));
    }
    function connectNodeToSelected(sourceNodeId, targetNodeIds) {
      const type = document.getElementById('edgeType').value;
      commit(() => targetNodeIds.filter((id) => id !== sourceNodeId).forEach((id) => addEdgeIfMissing(sourceNodeId, id, type)));
    }
    function connectNodes(fromNodeId, toNodeId) {
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
      commit(() => {
        const type = document.getElementById('edgeType').value;
        addEdgeIfMissing(fromNodeId, toNodeId, type);
        connectFrom = '';
      });
    }
    function duplicateSelection() {
      const nodes = selectedNodes();
      if (nodes.length === 0) return;
      commit(() => {
        selectedNodeId = '';
        selectedNodeIds.clear();
        for (const node of nodes) {
          const copy = { ...node, id: 'bp-node-' + Date.now() + '-' + Math.floor(Math.random() * 1000), x: node.x + 36, y: node.y + 36 };
          current.nodes.push(copy);
          selectedNodeIds.add(copy.id);
        }
      });
    }
    function addNoteAtCenter() {
      const point = viewportCenter();
      post({ command: 'add-note', blueprintId: current.id, x: point.x, y: point.y });
    }
    function fitView() {
      const bounds = blueprintBounds();
      if (!bounds) {
        scale = 1;
        panX = 0;
        panY = 0;
        applyTransform();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      scale = Math.max(.35, Math.min(1.6, Math.min((rect.width - 80) / Math.max(1, bounds.width), (rect.height - 80) / Math.max(1, bounds.height))));
      panX = Math.round(40 - bounds.minX * scale);
      panY = Math.round(40 - bounds.minY * scale);
      applyTransform();
    }
    function blueprintBounds() {
      if (current.nodes.length === 0) return undefined;
      const minX = Math.min(...current.nodes.map((node) => node.x));
      const minY = Math.min(...current.nodes.map((node) => node.y));
      const maxX = Math.max(...current.nodes.map((node) => node.x + node.width));
      const maxY = Math.max(...current.nodes.map((node) => node.y + nodeVisualHeight(node)));
      return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    }
    function focusViewportOnPoint(x, y, readable = true) {
      if (readable && scale < .75) scale = .75;
      const rect = canvas.getBoundingClientRect();
      panX = Math.round(rect.width / 2 - x * scale);
      panY = Math.round(rect.height / 2 - y * scale);
      applyTransform();
    }
    function restoreViewport(bookmark) {
      if (!bookmark) return;
      panX = Math.round(bookmark.x);
      panY = Math.round(bookmark.y);
      scale = Math.max(.35, Math.min(2.2, bookmark.scale || 1));
      applyTransform();
    }
    function edgeLayer(type) {
      if (type === 'flow') return 'flow';
      if (type === 'uses') return 'reference';
      if (type === 'foreshadows' || type === 'resolves') return 'foreshadowing';
      if (type === 'conflicts' || type === 'blocks') return 'conflict';
      if (type === 'supports') return 'support';
      return 'custom';
    }
    function edgeDash(edge, style) {
      if (edge.status === 'deprecated') return '2 6';
      return style.dash;
    }
    function focusedNodeIds() {
      if (focusMode === 'all') return undefined;
      const start = focusMode === 'path' ? (pathStartId || selectedNodeId || [...selectedNodeIds][0] || '') : (selectedNodeId || [...selectedNodeIds][0] || '');
      if (!start) return undefined;
      if (focusMode === 'path') {
        const end = pathEndId || '';
        return end ? pathNodeIds(start, end).nodes : new Set([start]);
      }
      const depth = focusMode === 'two' ? 2 : 1;
      const ids = new Set([start]);
      let frontier = new Set([start]);
      for (let step = 0; step < depth; step += 1) {
        const next = new Set();
        for (const edge of current.edges) {
          if (!isEdgeVisibleForReading(edge)) continue;
          if (frontier.has(edge.fromNodeId) && !ids.has(edge.toNodeId)) next.add(edge.toNodeId);
          if (frontier.has(edge.toNodeId) && !ids.has(edge.fromNodeId)) next.add(edge.fromNodeId);
        }
        for (const id of next) ids.add(id);
        frontier = next;
      }
      return ids;
    }
    function focusedEdgeIds(focus) {
      if (!focus) return undefined;
      if (focusMode === 'path' && pathStartId && pathEndId) return pathNodeIds(pathStartId, pathEndId).edges;
      return undefined;
    }
    function pathNodeIds(start, end) {
      const queue = [start];
      const previous = new Map([[start, '']]);
      const previousEdge = new Map();
      while (queue.length) {
        const id = queue.shift();
        if (id === end) break;
        for (const edge of current.edges) {
          if (!isEdgeVisibleForReading(edge)) continue;
          if (edge.fromNodeId !== id || previous.has(edge.toNodeId)) continue;
          previous.set(edge.toNodeId, id);
          previousEdge.set(edge.toNodeId, edge.id);
          queue.push(edge.toNodeId);
        }
      }
      if (!previous.has(end)) return { nodes: new Set([start, end]), edges: new Set(), found: false };
      const ids = new Set();
      const edgeIds = new Set();
      let cursor = end;
      while (cursor) {
        ids.add(cursor);
        const edgeId = previousEdge.get(cursor);
        if (edgeId) edgeIds.add(edgeId);
        cursor = previous.get(cursor);
      }
      return { nodes: ids, edges: edgeIds, found: true };
    }
    function selectPathEndpoint(nodeId) {
      selectedNodeId = nodeId;
      selectedNodeIds.clear();
      selectedEdgeId = '';
      selectedEdgeIds.clear();
      if (!pathStartId || (pathStartId && pathEndId)) {
        pathStartId = nodeId;
        pathEndId = '';
        pathMessage = '已选择路径起点：' + (byId(nodeId)?.title || nodeId) + '。请再选择终点。';
      } else if (pathStartId === nodeId) {
        pathEndId = '';
        pathMessage = '已重新选择起点：' + (byId(nodeId)?.title || nodeId) + '。请再选择终点。';
      } else {
        pathEndId = nodeId;
        const result = pathNodeIds(pathStartId, pathEndId);
        pathMessage = result.found
          ? '已高亮路径：' + (byId(pathStartId)?.title || pathStartId) + ' → ' + (byId(pathEndId)?.title || pathEndId) + '。'
          : '当前可见关系图层里没有找到路径：' + (byId(pathStartId)?.title || pathStartId) + ' → ' + (byId(pathEndId)?.title || pathEndId) + '。';
      }
      render();
      centerOnNode(nodeId);
    }
    function isEdgeVisibleForReading(edge) {
      return visibleEdgeLayers.has(edgeLayer(edge.type));
    }
    function showEdgeTip(event, edgeId) {
      const edge = edgeById(edgeId);
      if (!edge) return;
      const from = byId(edge.fromNodeId);
      const to = byId(edge.toNodeId);
      const missingConflictNote = (edge.type === 'conflicts' || edge.type === 'blocks') && !String(edge.note || '').trim() && !String(edge.label || '').trim();
      edgeTip.innerHTML = '<strong>' + escapeHtml(edge.label || edgeTypeLabel(edge.type)) + '</strong>' +
        '<div class="small">起点：' + escapeHtml(from?.title || edge.fromNodeId) + '</div>' +
        '<div class="small">终点：' + escapeHtml(to?.title || edge.toNodeId) + '</div>' +
        '<div>' + escapeHtml(edgeTypeLabel(edge.type)) + ' · ' + escapeHtml(edge.strength || 'normal') + ' · ' + escapeHtml(edge.status || 'draft') + '</div>' +
        (edge.note ? '<div class="small">说明：' + escapeHtml(edge.note) + '</div>' : '') +
        (missingConflictNote ? '<div class="small">缺少说明：建议补充冲突或阻碍原因。</div>' : '') +
        (edge.status === 'deprecated' ? '<div class="small">废弃关系：不建议参与当前结构判断。</div>' : '');
      edgeTip.style.display = 'block';
      positionEdgeTip(event.clientX, event.clientY);
    }
    function positionEdgeTip(x, y) {
      edgeTip.style.left = Math.min(x + 12, window.innerWidth - 280) + 'px';
      edgeTip.style.top = Math.min(y + 12, window.innerHeight - 90) + 'px';
    }
    function hideEdgeTip() {
      edgeTip.style.display = 'none';
      edgeTip.innerHTML = '';
    }
    canvas.addEventListener('dragover', (event) => event.preventDefault());
    canvas.addEventListener('drop', (event) => {
      event.preventDefault();
      const payload = JSON.parse(event.dataTransfer.getData('application/json') || '{}');
      const point = clientToWorld(event);
      post({ command: 'add-resource', blueprintId: current.id, resourceId: payload.id, resourceKind: payload.kind, x: Math.round(point.x), y: Math.round(point.y) });
    });
    canvas.addEventListener('wheel', (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      scale = Math.max(.35, Math.min(2.2, scale + (event.deltaY > 0 ? -.08 : .08)));
      applyTransform();
    });
    canvas.addEventListener('pointerdown', (event) => {
      hideContextMenu();
      if (event.target.closest('.node') || event.target.closest('.edge') || event.target.closest('.edge-hit') || event.target.closest('.edge-label') || event.target.closest('.edge-label-bg')) return;
      if (event.button === 1 || event.altKey) {
        canvasDrag = { mode: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX, panY };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button !== 0) return;
      const point = clientToWorld(event);
      canvasDrag = { mode: 'select', pointerId: event.pointerId, startX: point.x, startY: point.y };
      selectedNodeId = '';
      selectedEdgeId = '';
      selectedNodeIds.clear();
      selectedEdgeIds.clear();
      showSelectionBox(point.x, point.y, 0, 0);
      canvas.setPointerCapture(event.pointerId);
      updateNodeSelectionClasses();
      renderRightPanel();
    });
    canvas.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.node') || event.target.closest('.resource')) return;
      const point = clientToWorld(event);
      const nearby = nearestEdgeAt(point, 28 / scale);
      if (!nearby) return;
      event.preventDefault();
      openEdgeContextMenu(nearby.id, event.clientX, event.clientY);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!canvasDrag || event.pointerId !== canvasDrag.pointerId) return;
      if (canvasDrag.mode === 'pan') {
        panX = canvasDrag.panX + event.clientX - canvasDrag.startX;
        panY = canvasDrag.panY + event.clientY - canvasDrag.startY;
        applyTransform();
        return;
      }
      const point = clientToWorld(event);
      const left = Math.min(canvasDrag.startX, point.x);
      const top = Math.min(canvasDrag.startY, point.y);
      const width = Math.abs(point.x - canvasDrag.startX);
      const height = Math.abs(point.y - canvasDrag.startY);
      showSelectionBox(left, top, width, height);
      selectedNodeIds.clear();
      for (const node of current.nodes) {
        if (rectsIntersect(left, top, width, height, node.x, node.y, node.width, nodeVisualHeight(node))) {
          selectedNodeIds.add(node.id);
        }
      }
      updateNodeSelectionClasses();
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!canvasDrag || event.pointerId !== canvasDrag.pointerId) return;
      if (canvasDrag.mode === 'select' && selectedNodeIds.size === 1) {
        selectedNodeId = [...selectedNodeIds][0];
      }
      canvasDrag = null;
      selectionBox.style.display = 'none';
      renderRightPanel();
    });
    document.addEventListener('keydown', (event) => {
      hideContextMenu();
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); }
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); }
      if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (history.length) { future.push(snapshot()); restore(history.pop()); }
      }
      if (mod && event.key.toLowerCase() === 'z' && event.shiftKey) {
        event.preventDefault();
        if (future.length) { history.push(snapshot()); restore(future.pop()); }
      }
    });
    document.getElementById('resourceSearch').addEventListener('input', (event) => { resourceSearch = event.target.value; renderResources(); });
    document.getElementById('resourceKindFilter').addEventListener('change', (event) => { resourceKindFilter = event.target.value; renderResources(); });
    document.getElementById('tabInspector').addEventListener('click', () => { activeTab = 'inspector'; renderRightPanel(); });
    document.getElementById('tabSync').addEventListener('click', () => { activeTab = 'sync'; renderRightPanel(); });
    document.getElementById('undo').addEventListener('click', () => { if (history.length) { future.push(snapshot()); restore(history.pop()); } });
    document.getElementById('redo').addEventListener('click', () => { if (future.length) { history.push(snapshot()); restore(future.pop()); } });
    document.getElementById('addNote').addEventListener('click', addNoteAtCenter);
    document.getElementById('duplicateNodes').addEventListener('click', duplicateSelection);
    document.getElementById('autoLayout').addEventListener('click', () => post({ command: 'auto-layout', blueprintId: current.id }));
    document.getElementById('fitView').addEventListener('click', fitView);
    document.getElementById('zoomIn').addEventListener('click', () => { scale = Math.min(2.2, scale + .1); applyTransform(); });
    document.getElementById('zoomOut').addEventListener('click', () => { scale = Math.max(.35, scale - .1); applyTransform(); });
    document.getElementById('blueprintSearch').addEventListener('input', (event) => {
      blueprintSearch = event.target.value;
      refreshSearchResults(false);
      renderEdges();
      renderNodes();
      updateSearchCount();
    });
    document.getElementById('blueprintSearch').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        jumpSearchResult(event.shiftKey ? -1 : 1);
      }
    });
    document.getElementById('searchPrev').addEventListener('click', () => jumpSearchResult(-1));
    document.getElementById('searchNext').addEventListener('click', () => jumpSearchResult(1));
    document.getElementById('saveViewport').addEventListener('click', saveViewportBookmark);
    document.getElementById('deleteViewport').addEventListener('click', deleteSelectedViewportBookmark);
    document.getElementById('viewportBookmarkSelect').addEventListener('change', (event) => {
      const bookmark = (current.viewportBookmarks || []).find((item) => item.id === event.target.value);
      restoreViewport(bookmark);
    });
    document.getElementById('viewportBookmarkSelect').addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        { label: '删除视角', danger: true, run: deleteSelectedViewportBookmark }
      ]);
    });
    minimap.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      panFromMinimapEvent(event);
      minimap.setPointerCapture(event.pointerId);
      canvasDrag = { mode: 'minimap', pointerId: event.pointerId };
    });
    minimap.addEventListener('pointermove', (event) => {
      event.stopPropagation();
      if (!canvasDrag || canvasDrag.mode !== 'minimap' || event.pointerId !== canvasDrag.pointerId) return;
      panFromMinimapEvent(event);
    });
    minimap.addEventListener('pointerup', (event) => {
      event.stopPropagation();
      if (canvasDrag && canvasDrag.mode === 'minimap' && event.pointerId === canvasDrag.pointerId) {
        canvasDrag = null;
      }
    });
    document.getElementById('refresh').addEventListener('click', () => post({ command: 'refresh', blueprintId: current.id }));
    document.getElementById('previewSync').addEventListener('click', () => post({ command: 'preview-sync', blueprintId: current.id }));
    document.getElementById('exportMarkdown').addEventListener('click', () => post({ command: 'export-markdown', blueprintId: current.id }));
    document.getElementById('importMarkdown').addEventListener('click', () => post({ command: 'import-markdown', blueprintId: current.id }));
    document.getElementById('previewMarkdownSync').addEventListener('click', () => { activeTab = 'sync'; post({ command: 'preview-markdown-sync', blueprintId: current.id }); });
    document.getElementById('relationBrush').addEventListener('click', () => {
      relationBrush = !relationBrush;
      connectFrom = '';
      document.getElementById('relationBrush').classList.toggle('active', relationBrush);
      renderNodes();
    });
    document.getElementById('focusMode').addEventListener('change', (event) => {
      focusMode = event.target.value;
      pathMessage = focusMode === 'path' ? '路径高亮：请选择起点。' : '';
      if (focusMode !== 'path') {
        pathStartId = '';
        pathEndId = '';
      }
      render();
    });
    document.getElementById('newBlueprint').addEventListener('click', () => {
      const input = document.getElementById('newBlueprintTitle');
      const title = input.value.trim() || ('大纲蓝图 ' + (state.blueprints.length + 1));
      input.value = '';
      post({ command: 'create-blueprint', title });
    });
    document.getElementById('blueprintSelect').addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        { label: '删除蓝图', danger: true, run: () => post({ command: 'delete-blueprint', blueprintId: current.id }) }
      ]);
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#contextMenu')) hideContextMenu();
    });
    document.getElementById('blueprintSelect').addEventListener('change', (event) => post({ command: 'select-blueprint', blueprintId: event.target.value }));
    function showSelectionBox(left, top, width, height) {
      selectionBox.style.display = 'block';
      selectionBox.style.left = left + 'px';
      selectionBox.style.top = top + 'px';
      selectionBox.style.width = width + 'px';
      selectionBox.style.height = height + 'px';
    }
    function rectsIntersect(left, top, width, height, nodeLeft, nodeTop, nodeWidth, nodeHeight) {
      return left <= nodeLeft + nodeWidth && left + width >= nodeLeft && top <= nodeTop + nodeHeight && top + height >= nodeTop;
    }
    function semanticForNode(node) {
      return (state.nodeSemantics && state.nodeSemantics[node.id]) || {
        nodeId: node.id,
        label: kindLabel(node.refKind || node.kind),
        badge: kindLabel(node.refKind || node.kind),
        status: node.refKind ? 'linked' : 'local',
        lines: node.note ? [node.note] : []
      };
    }
    function nodeVisualHeight(node) {
      return node.collapsed ? 68 : node.height;
    }
    function parseTags(value) {
      return String(value || '')
        .split(/[,，#\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12);
    }
    function toggleNodeCollapse(nodeId) {
      const node = byId(nodeId);
      if (!node) return;
      commit(() => { node.collapsed = !node.collapsed; });
    }
    function toggleNodeLock(nodeId) {
      const node = byId(nodeId);
      if (!node) return;
      commit(() => { node.locked = !node.locked; });
    }
    function edgeIssuesFor(edgeId) {
      return (state.edgeSemanticIssues || []).filter((issue) => issue.edgeId === edgeId);
    }
    function renderPathHint() {
      if (focusMode !== 'path') return '';
      const start = pathStartId ? (byId(pathStartId)?.title || pathStartId) : '未选择';
      const end = pathEndId ? (byId(pathEndId)?.title || pathEndId) : '未选择';
      return '<div class="sync-group" id="pathStatus"><h2>路径高亮</h2><div class="small">起点：' + escapeHtml(start) + ' · 终点：' + escapeHtml(end) + '</div><div class="small">' + escapeHtml(pathMessage || '请选择起点和终点。') + '</div></div>';
    }
    function renderRelationIssuesPanel() {
      const issues = state.edgeSemanticIssues || [];
      if (issues.length === 0) return '<div class="sync-group" id="relationIssues"><h2>关系问题</h2><div class="small">当前蓝图没有关系问题。</div></div>';
      return '<div class="sync-group" id="relationIssues"><h2>关系问题</h2>' + issues.map((issue) => {
        const target = issue.edgeId.startsWith('node:') ? issue.edgeId.slice(5) : issue.edgeId;
        return '<button class="ghost issue ' + escapeAttr(issue.severity) + '" data-relation-issue="' + escapeAttr(issue.edgeId) + '" title="' + escapeAttr(issue.suggestion) + '"><strong>' + escapeHtml(issue.title) + '</strong><div class="small">' + escapeHtml(issue.detail) + '</div><div class="small">定位：' + escapeHtml(target) + '</div></button>';
      }).join('') + '</div>';
    }
    function wireRelationIssueNavigation() {
      document.querySelectorAll('[data-relation-issue]').forEach((button) => {
        button.addEventListener('click', () => focusRelationIssue(button.dataset.relationIssue));
      });
    }
    function focusRelationIssue(issueId) {
      if (!issueId) return;
      selectedNodeIds.clear();
      selectedEdgeIds.clear();
      selectedNodeId = '';
      selectedEdgeId = '';
      if (issueId.startsWith('node:')) {
        const nodeId = issueId.slice(5);
        selectedNodeId = nodeId;
        focusMode = 'one';
        pathStartId = '';
        pathEndId = '';
        pathMessage = '';
        document.getElementById('focusMode').value = focusMode;
        render();
        centerOnNode(nodeId);
        return;
      }
      const edge = edgeById(issueId);
      if (!edge) return;
      selectedEdgeId = edge.id;
      focusMode = 'one';
      selectedNodeId = edge.fromNodeId;
      pathStartId = '';
      pathEndId = '';
      pathMessage = '';
      document.getElementById('focusMode').value = focusMode;
      render();
      centerOnEdge(edge);
    }
    function centerOnNode(nodeId) {
      const node = byId(nodeId);
      if (!node) return;
      focusViewportOnPoint(node.x + node.width / 2, node.y + nodeVisualHeight(node) / 2);
    }
    function centerOnEdge(edge) {
      const endpoints = edgeEndpoints(edge);
      if (!endpoints) return;
      const x = (endpoints.x1 + endpoints.x2) / 2;
      const y = (endpoints.y1 + endpoints.y2) / 2;
      focusViewportOnPoint(x, y);
    }
    function nearestEdgeAt(point, threshold) {
      let best = null;
      for (const edge of current.edges) {
        if (!visibleEdgeLayers.has(edgeLayer(edge.type))) continue;
        const endpoints = edgeEndpoints(edge);
        if (!endpoints) continue;
        const distance = distanceToCubic(point, { x: endpoints.x1, y: endpoints.y1 }, { x: endpoints.x2, y: endpoints.y2 });
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { id: edge.id, distance };
        }
      }
      return best;
    }
    function distanceToCubic(point, from, to) {
      const mid = Math.max(60, Math.abs(to.x - from.x) / 2);
      const c1 = { x: from.x + mid, y: from.y };
      const c2 = { x: to.x - mid, y: to.y };
      let best = Number.POSITIVE_INFINITY;
      let previous = from;
      for (let i = 1; i <= 24; i += 1) {
        const t = i / 24;
        const currentPoint = cubicPoint(from, c1, c2, to, t);
        best = Math.min(best, distanceToSegment(point, previous, currentPoint));
        previous = currentPoint;
      }
      return best;
    }
    function cubicPoint(p0, p1, p2, p3, t) {
      const mt = 1 - t;
      return {
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
      };
    }
    function distanceToSegment(point, a, b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy;
      if (!lengthSq) return Math.hypot(point.x - a.x, point.y - a.y);
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
      return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
    }
    function nodeSourceDeleteAction(node) {
      if (!node.refKind || !node.refId) return undefined;
      if (node.refKind === 'outline-node') {
        const outlineId = String(node.refId).split(':')[0];
        return outlineId ? { command: 'delete-resource', blueprintId: current.id, resourceId: outlineId, resourceKind: 'outline-node' } : undefined;
      }
      if (isDeletableSourceKind(node.refKind)) {
        return { command: 'delete-resource', blueprintId: current.id, resourceId: node.refId, resourceKind: node.refKind };
      }
      return undefined;
    }
    function showContextMenu(x, y, actions) {
      contextMenu.innerHTML = actions.map((action, index) => '<button data-context-action="' + index + '"' + (action.danger ? ' class="danger"' : '') + '>' + escapeHtml(action.label) + '</button>').join('');
      contextMenu.style.display = 'block';
      const width = contextMenu.offsetWidth || 132;
      const height = contextMenu.offsetHeight || 32;
      contextMenu.style.left = Math.min(x, window.innerWidth - width - 8) + 'px';
      contextMenu.style.top = Math.min(y, window.innerHeight - height - 8) + 'px';
      contextMenu.querySelectorAll('[data-context-action]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const action = actions[Number(button.dataset.contextAction)];
          hideContextMenu();
          action?.run();
        });
      });
    }
    function hideContextMenu() {
      contextMenu.style.display = 'none';
      contextMenu.innerHTML = '';
    }
    function edgeMarkerDefs() {
      return '<defs>' + ['flow', 'uses', 'foreshadows', 'resolves', 'conflicts', 'supports', 'blocks', 'custom'].map((type) => {
        const style = edgeStyle(type);
        return '<marker id="arrow-' + type + '" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M 0 0 L 10 4 L 0 8 z" fill="' + style.color + '"></path></marker>';
      }).join('') + '</defs>';
    }
    function edgeStyle(type) {
      return ({
        flow: { color: '#d4d4d4', dash: '0' },
        uses: { color: '#4fc1ff', dash: '0' },
        foreshadows: { color: '#c586c0', dash: '7 5' },
        resolves: { color: '#6a9955', dash: '0' },
        conflicts: { color: '#f14c4c', dash: '0' },
        supports: { color: '#4ec9b0', dash: '0' },
        blocks: { color: '#ce9178', dash: '5 4' },
        custom: { color: '#808080', dash: '3 4' }
      })[type] || { color: '#808080', dash: '3 4' };
    }
    function updateNodeSelectionClasses() {
      document.querySelectorAll('.node').forEach((el) => {
        el.classList.toggle('selected', selectedNodeIds.has(el.dataset.id) || selectedNodeId === el.dataset.id);
        el.classList.toggle('connecting', connectFrom === el.dataset.id);
      });
    }
    function cssEscape(value) { return String(value).replace(/"/g, '\\"'); }
    function kindLabel(kind) {
      return ({ outline: '大纲', 'outline-node': '大纲节点', character: '人物', location: '地点', 'world-rule': '世界规则', foreshadowing: '伏笔', 'timeline-event': '时间线', scene: '场景', beat: 'Beat' })[kind] || kind;
    }
    function edgeTypeLabel(type) {
      return ({ flow: '剧情流', uses: '使用', foreshadows: '埋伏笔', resolves: '回收', conflicts: '冲突', supports: '支撑', blocks: '阻碍', custom: '自定义' })[type] || type;
    }
    function edgeTypeHelp(type) {
      return ({
        flow: '表示剧情、场景、Beat 或时间线的推进顺序。',
        uses: '表示节点使用某个资料、地点、规则或设定。',
        foreshadows: '表示某个节点埋下伏笔，建议连接到伏笔节点。',
        resolves: '表示某个节点回收伏笔，建议连接到伏笔节点。',
        conflicts: '表示两个节点存在矛盾、冲突或对抗。',
        supports: '表示一个节点支撑另一个节点成立。',
        blocks: '表示一个节点阻碍另一个节点推进。',
        custom: '自定义关系，适合临时或项目专属含义。'
      })[type] || type;
    }
    function sourceStatusLabel(status) {
      return ({ local: '本地', linked: '已连接', missing: '来源缺失', stale: '待同步', conflict: '同步冲突' })[status] || status;
    }
    function syncStatusLabel(status) {
      return ({ pull: '可拉取', push: '可推送', conflict: '冲突', missing: '缺失', unchanged: '一致' })[status] || status;
    }
    function isCodexKind(kind) {
      return ['character', 'location', 'world-rule', 'foreshadowing', 'scene', 'beat'].includes(kind);
    }
    function isDeletableSourceKind(kind) {
      return isCodexKind(kind) || kind === 'outline' || kind === 'outline-node';
    }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[ch]); }
    function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }
    render();
  </script>
</body>
</html>`;
}

function edgeTypeOptions(): string {
  return (['flow', 'uses', 'foreshadows', 'resolves', 'conflicts', 'supports', 'blocks', 'custom'] as BlueprintEdgeType[])
    .map((type) => `<option value="${type}">${edgeTypeLabel(type)}</option>`)
    .join('');
}

function edgeStrengthOptions(): string {
  return (['weak', 'normal', 'strong'] as BlueprintEdgeStrength[])
    .map((value) => `<option value="${value}">${({ weak: '弱', normal: '普通', strong: '强' } as Record<BlueprintEdgeStrength, string>)[value]}</option>`)
    .join('');
}

function edgeStatusOptions(): string {
  return (['draft', 'confirmed', 'deprecated'] as BlueprintEdgeStatus[])
    .map((value) => `<option value="${value}">${({ draft: '草稿', confirmed: '确认', deprecated: '废弃' } as Record<BlueprintEdgeStatus, string>)[value]}</option>`)
    .join('');
}

function edgeTypeLabel(type: BlueprintEdgeType): string {
  const labels: Record<BlueprintEdgeType, string> = {
    flow: '剧情流',
    uses: '使用',
    foreshadows: '埋伏笔',
    resolves: '回收',
    conflicts: '冲突',
    supports: '支撑',
    blocks: '阻碍',
    custom: '自定义'
  };
  return labels[type];
}
