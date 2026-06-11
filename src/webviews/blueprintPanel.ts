import * as vscode from 'vscode';
import {
  BlueprintDocument,
  BlueprintEdgeType,
  BlueprintPanelState,
  BlueprintRefKind,
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
  | { command: 'preview-sync'; blueprintId: string }
  | { command: 'apply-sync'; blueprintId: string; decisions: BlueprintSyncDecision[] }
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
    .shell { display: grid; grid-template-columns: 270px 1fr 310px; grid-template-rows: auto 1fr; height: 100vh; }
    header { grid-column: 1 / 4; border-bottom: 1px solid var(--border); display: flex; align-items: center; flex-wrap: wrap; gap: 7px; padding: 8px 10px; background: var(--panel); }
    header h1 { font-size: 14px; margin: 0 8px 0 0; }
    button, select, input, textarea { font: inherit; border-radius: 4px; border: 1px solid var(--vscode-input-border, var(--border)); }
    button { cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 8px; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.danger { color: var(--vscode-errorForeground); background: var(--vscode-input-background); border-color: var(--vscode-errorForeground); }
    button.ghost { color: var(--vscode-foreground); background: transparent; }
    button.active { outline: 1px solid var(--vscode-focusBorder); }
    select, input, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 5px 7px; }
    .new-title { width: 128px; }
    .toolbar-sep { width: 1px; height: 22px; background: var(--border); margin: 0 2px; }
    aside { border-right: 1px solid var(--border); background: var(--panel); overflow: auto; padding: 10px; }
    aside.right { border-right: 0; border-left: 1px solid var(--border); }
    h2 { font-size: 12px; margin: 12px 0 7px; color: var(--vscode-descriptionForeground); font-weight: 650; }
    .resource-tools { display: grid; grid-template-columns: 1fr; gap: 7px; margin-bottom: 10px; }
    .resource { border: 1px solid var(--border); border-radius: 6px; padding: 7px; margin-bottom: 6px; background: var(--vscode-editor-background); cursor: grab; }
    .resource-title { font-weight: 650; font-size: 12px; }
    .resource-actions { display: flex; gap: 6px; margin-top: 7px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; }
    .canvas-wrap { position: relative; overflow: hidden; background-color: var(--vscode-editor-background); background-image: radial-gradient(var(--vscode-panel-border) 1px, transparent 1px); background-size: 22px 22px; }
    .stage { position: absolute; left: 0; top: 0; width: 4800px; height: 3600px; transform-origin: 0 0; }
    svg.edges { position: absolute; left: 0; top: 0; width: 4800px; height: 3600px; overflow: visible; pointer-events: none; }
    .edge { stroke-width: 2.4; fill: none; pointer-events: stroke; cursor: pointer; }
    .edge.selected { stroke: var(--vscode-testing-iconPassed); stroke-width: 3; }
    .edge-label-bg { fill: var(--vscode-editor-background); stroke: var(--border); stroke-width: 1; opacity: .95; pointer-events: none; }
    .edge-label { fill: var(--vscode-descriptionForeground); font-size: 11px; pointer-events: none; }
    .node { position: absolute; border: 1px solid var(--border); border-top: 4px solid var(--vscode-textLink-foreground); border-radius: 7px; background: var(--panel); box-shadow: 0 4px 16px rgba(0,0,0,.18); user-select: none; overflow: hidden; }
    .node.selected { outline: 2px solid var(--vscode-focusBorder); }
    .node.connecting { outline: 2px dashed var(--vscode-textLink-foreground); }
    .node.status-missing { border-color: var(--vscode-errorForeground); }
    .node.status-conflict { box-shadow: 0 0 0 1px var(--vscode-errorForeground), 0 4px 16px rgba(0,0,0,.18); }
    .node.status-stale { box-shadow: 0 0 0 1px var(--vscode-textLink-foreground), 0 4px 16px rgba(0,0,0,.18); }
    .selection-box { position: absolute; display: none; border: 1px solid var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent); pointer-events: none; }
    .node-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 8px 5px; font-weight: 650; font-size: 12px; }
    .badge { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 500; }
    .node-kind { color: var(--vscode-descriptionForeground); font-size: 10px; padding: 0 8px; }
    .node-note { padding: 2px 8px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.35; white-space: pre-wrap; }
    .semantic-lines { padding: 3px 8px 8px; display: grid; gap: 2px; }
    .semantic-line { color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pin { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--vscode-foreground); background: var(--vscode-editor-background); cursor: crosshair; flex: 0 0 auto; }
    .pin.active { background: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    .row { display: grid; gap: 5px; margin-bottom: 9px; }
    .row.two { grid-template-columns: 1fr 1fr; }
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
    .small { font-size: 11px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1>大纲蓝图</h1>
      <select id="blueprintSelect"></select>
      <input class="new-title" id="newBlueprintTitle" placeholder="新蓝图标题">
      <button class="secondary" id="newBlueprint">新建大纲蓝图</button>
      <button class="secondary" id="refresh">刷新</button>
      <span class="toolbar-sep"></span>
      <button class="secondary" id="undo">撤销</button>
      <button class="secondary" id="redo">重做</button>
      <button class="secondary" id="addNote">备注节点</button>
      <button class="secondary" id="duplicateNodes">复制</button>
      <button class="secondary" id="autoLayout">自动布局</button>
      <button class="secondary" id="fitView">适配</button>
      <span class="toolbar-sep"></span>
      <button class="secondary" id="zoomOut">-</button>
      <button class="secondary" id="zoomIn">+</button>
      <label>连线</label>
      <select id="edgeType">${edgeTypeOptions()}</select>
      <button class="secondary" id="previewSync">同步预览</button>
      <span class="small" id="outlineBinding"></span>
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
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    let state = ${serialized};
    let current = state.current;
    let selectedNodeId = '';
    let selectedEdgeId = '';
    const selectedNodeIds = new Set();
    let connectFrom = '';
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let canvasDrag = null;
    let resourceSearch = '';
    let resourceKindFilter = 'all';
    let activeTab = state.syncPreview ? 'sync' : 'inspector';
    const history = [];
    const future = [];
    const canvas = document.getElementById('canvas');
    const stage = document.getElementById('stage');
    const nodesEl = document.getElementById('nodes');
    const edgesEl = document.getElementById('edges');
    const selectionBox = document.getElementById('selectionBox');
    const rightPanel = document.getElementById('rightPanel');
    const contextMenu = document.getElementById('contextMenu');

    function post(action) { vscode.postMessage(action); }
    function save() { post({ command: 'save-blueprint', document: current }); }
    function snapshot() { return JSON.stringify(current); }
    function restore(raw) { current = JSON.parse(raw); selectedNodeId = ''; selectedEdgeId = ''; selectedNodeIds.clear(); render(); save(); }
    function pushHistory() { history.push(snapshot()); if (history.length > 60) history.shift(); future.length = 0; }
    function commit(mutator) { pushHistory(); mutator(); render(); save(); }
    function byId(id) { return current.nodes.find((node) => node.id === id); }
    function edgeById(id) { return current.edges.find((edge) => edge.id === id); }
    function selectedNodes() {
      const ids = selectedNodeIds.size ? selectedNodeIds : new Set(selectedNodeId ? [selectedNodeId] : []);
      return current.nodes.filter((node) => ids.has(node.id));
    }
    function selectedEdges() { return current.edges.filter((edge) => edge.id === selectedEdgeId); }
    function clientToWorld(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left - panX) / scale, y: (event.clientY - rect.top - panY) / scale };
    }
    function viewportCenter() {
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round((rect.width / 2 - panX) / scale), y: Math.round((rect.height / 2 - panY) / scale) };
    }
    function applyTransform() { stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')'; }

    function render() {
      document.getElementById('blueprintSelect').innerHTML = state.blueprints.map((item) => '<option value="' + item.id + '"' + (item.id === current.id ? ' selected' : '') + '>' + escapeHtml(item.title) + '</option>').join('');
      document.getElementById('outlineBinding').textContent = current.outlineId ? '绑定大纲：' + current.outlineId : '未绑定大纲';
      renderResourceTools();
      renderResources();
      renderEdges();
      renderNodes();
      renderRightPanel();
      applyTransform();
    }
    function renderResourceTools() {
      const kinds = ['all', ...new Set(state.resources.map((resource) => resource.kind))];
      document.getElementById('resourceKindFilter').innerHTML = kinds.map((kind) => '<option value="' + escapeAttr(kind) + '"' + (kind === resourceKindFilter ? ' selected' : '') + '>' + (kind === 'all' ? '全部类型' : escapeHtml(kindLabel(kind))) + '</option>').join('');
      document.getElementById('resourceSearch').value = resourceSearch;
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
      nodesEl.innerHTML = current.nodes.map((node) => {
        const semantic = semanticForNode(node);
        return '<div class="node status-' + escapeAttr(semantic.status) + (node.id === selectedNodeId || selectedNodeIds.has(node.id) ? ' selected' : '') + '" data-id="' + node.id + '" style="left:' + node.x + 'px;top:' + node.y + 'px;width:' + node.width + 'px;height:' + node.height + 'px;border-top-color:' + escapeHtml(node.color || '#4fc1ff') + '">' +
          '<div class="node-head"><span>' + escapeHtml(node.title) + '</span><span class="pin' + (connectFrom === node.id ? ' active' : '') + '" title="从此节点拉线"></span></div>' +
          '<div class="node-kind"><span class="badge">' + escapeHtml(semantic.badge) + '</span> ' + escapeHtml(sourceStatusLabel(semantic.status)) + '</div>' +
          '<div class="semantic-lines">' + semantic.lines.map((line) => '<div class="semantic-line">' + escapeHtml(line) + '</div>').join('') + '</div>' +
        '</div>';
      }).join('');
      document.querySelectorAll('.node').forEach((el) => wireNode(el));
    }
    function renderEdges() {
      edgesEl.innerHTML = edgeMarkerDefs() + current.edges.map((edge) => {
        const from = byId(edge.fromNodeId);
        const to = byId(edge.toNodeId);
        if (!from || !to) return '';
        const x1 = from.x + from.width;
        const y1 = from.y + from.height / 2;
        const x2 = to.x;
        const y2 = to.y + to.height / 2;
        const mid = Math.max(60, Math.abs(x2 - x1) / 2);
        const label = edge.label || edgeTypeLabel(edge.type);
        const style = edgeStyle(edge.type);
        const labelX = Math.round((x1 + x2) / 2);
        const labelY = Math.round(((y1 + y2) / 2) - 8);
        const labelWidth = Math.max(38, label.length * 12);
        const path = '<path class="edge' + (edge.id === selectedEdgeId ? ' selected' : '') + '" data-id="' + edge.id + '" style="stroke:' + style.color + ';stroke-dasharray:' + style.dash + '" marker-end="url(#arrow-' + edge.type + ')" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + mid) + ' ' + y1 + ', ' + (x2 - mid) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '"></path>';
        const text = '<rect class="edge-label-bg" x="' + (labelX - labelWidth / 2) + '" y="' + (labelY - 13) + '" width="' + labelWidth + '" height="17" rx="4"></rect><text class="edge-label" text-anchor="middle" x="' + labelX + '" y="' + labelY + '">' + escapeHtml(label) + '</text>';
        return path + text;
      }).join('');
      document.querySelectorAll('.edge').forEach((el) => el.addEventListener('click', () => {
        selectedEdgeId = el.dataset.id;
        selectedNodeId = '';
        selectedNodeIds.clear();
        render();
      }));
      document.querySelectorAll('.edge').forEach((el) => el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        selectedEdgeId = el.dataset.id;
        selectedNodeId = '';
        selectedNodeIds.clear();
        render();
        showContextMenu(event.clientX, event.clientY, [
          { label: '删除', run: () => deleteSelection() }
        ]);
      }));
    }
    function wireNode(el) {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let starts = [];
      el.addEventListener('pointerdown', (event) => {
        if (event.target.classList.contains('pin')) return;
        const node = byId(el.dataset.id);
        if (!node) return;
        if (connectFrom && connectFrom !== node.id && event.button === 0) {
          event.preventDefault();
          connectNodes(connectFrom, node.id);
          return;
        }
        selectedEdgeId = '';
        if (!event.shiftKey && !selectedNodeIds.has(node.id)) {
          selectedNodeIds.clear();
          selectedNodeId = node.id;
        } else {
          selectedNodeId = '';
          selectedNodeIds.add(node.id);
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
      el.addEventListener('pointerup', () => {
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
        selectedNodeIds.clear();
        selectedNodeId = el.dataset.id;
        selectedEdgeId = '';
        render();
        const actions = [{ label: '删除', run: () => deleteSelection() }];
        if (sourceDelete) {
          actions.push({ label: '完全删除', danger: true, run: () => post(sourceDelete) });
        }
        showContextMenu(event.clientX, event.clientY, actions);
      });
      el.querySelector('.pin').addEventListener('click', (event) => {
        event.stopPropagation();
        if (connectFrom && connectFrom !== el.dataset.id) {
          connectNodes(connectFrom, el.dataset.id);
        } else if (connectFrom === el.dataset.id) {
          connectFrom = '';
          renderNodes();
        } else {
          connectFrom = el.dataset.id;
          renderNodes();
        }
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
      if (nodes.length > 1) {
        rightPanel.innerHTML = '<div class="row"><label>已选择</label><div>' + nodes.length + ' 个节点</div></div>' +
          '<div class="row"><label>批量颜色</label><input id="multiColor" value="' + escapeAttr(nodes[0].color || '') + '"></div>' +
          '<button id="saveMulti">保存颜色</button>';
        document.getElementById('saveMulti').addEventListener('click', () => {
          const color = document.getElementById('multiColor').value;
          commit(() => nodes.forEach((node) => { node.color = color; }));
        });
      } else if (nodes.length === 1) {
        const node = nodes[0];
        const semantic = semanticForNode(node);
        rightPanel.innerHTML = '<div class="row"><label>标题</label><input id="nodeTitle" value="' + escapeAttr(node.title) + '"></div>' +
          '<div class="row"><label>备注</label><textarea id="nodeNote">' + escapeHtml(node.note || '') + '</textarea></div>' +
          '<div class="row"><label>颜色</label><input id="nodeColor" value="' + escapeAttr(node.color || '') + '"></div>' +
          '<div class="row"><label>来源</label><input readonly value="' + escapeAttr(node.refPath || '本地备注节点') + '"></div>' +
          '<div class="row"><label>语义摘要</label><div class="small"><strong>' + escapeHtml(semantic.label) + '</strong><br>' + semantic.lines.map(escapeHtml).join('<br>') + '</div></div>' +
          '<div class="small">' + (node.lastSynced ? '有同步快照：' + escapeHtml(node.lastSynced.syncedAt) : '没有同步快照，首次同步会要求确认。') + '</div>' +
          '<div class="sync-actions"><button id="saveNode">保存节点</button></div>';
        document.getElementById('saveNode').addEventListener('click', () => {
          commit(() => {
            node.title = document.getElementById('nodeTitle').value;
            node.note = document.getElementById('nodeNote').value;
            node.color = document.getElementById('nodeColor').value;
          });
        });
      } else if (edge) {
        const issues = edgeIssuesFor(edge.id);
        rightPanel.innerHTML = '<div class="row"><label>类型</label><select id="edgeEditType">${edgeTypeOptions()}</select></div>' +
          '<div class="row"><label>标签</label><input id="edgeLabel" value="' + escapeAttr(edge.label || '') + '"></div>' +
          '<div class="row"><label>建议用法</label><div class="small">' + escapeHtml(edgeTypeHelp(edge.type)) + '</div></div>' +
          issues.map((issue) => '<div class="issue ' + escapeAttr(issue.severity) + '"><strong>' + escapeHtml(issue.title) + '</strong><div class="small">' + escapeHtml(issue.detail) + '</div></div>').join('') +
          '<div class="sync-actions"><button id="saveEdge">保存连线</button></div>';
        document.getElementById('edgeEditType').value = edge.type;
        document.getElementById('saveEdge').addEventListener('click', () => {
          commit(() => {
            edge.type = document.getElementById('edgeEditType').value;
            edge.label = document.getElementById('edgeLabel').value;
          });
        });
      } else {
        rightPanel.innerHTML = '<div class="empty">选择节点或连线。</div>';
      }
    }
    function renderSyncPanel() {
      if (!state.syncPreview) {
        rightPanel.innerHTML = '<button id="loadSync">生成同步预览</button><div class="empty">同步不会自动写回源文件。</div>';
        document.getElementById('loadSync').addEventListener('click', () => post({ command: 'preview-sync', blueprintId: current.id }));
        return;
      }
      const summary = state.syncPreview.summary;
      const result = state.syncResult ? '<div class="small">上次同步：应用 ' + state.syncResult.applied + '，拉取 ' + state.syncResult.pulled + '，推送 ' + state.syncResult.pushed + '，删除来源 ' + (state.syncResult.deletedSources || 0) + '，跳过 ' + state.syncResult.skipped + '</div>' : '';
      rightPanel.innerHTML = result + '<div class="small">拉取 ' + summary.pull + ' · 推送 ' + summary.push + ' · 冲突 ' + summary.conflict + ' · 缺失 ' + summary.missing + ' · 一致 ' + summary.unchanged + '</div>' +
        '<div class="sync-actions"><button id="applySuggested">应用建议</button><button class="secondary" id="applyClean">只应用无冲突</button><button class="secondary" id="pullAll">全部拉取</button><button class="secondary" id="pushAll">全部推送</button><button class="secondary" id="reloadSync">重新预览</button></div>' +
        renderSyncGroups();
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
      });
    }
    function connectNodes(fromNodeId, toNodeId) {
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
      commit(() => {
        const type = document.getElementById('edgeType').value;
        const exists = current.edges.some((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId && edge.type === type);
        if (!exists) {
          current.edges.push({ id: 'bp-edge-' + Date.now(), fromNodeId, toNodeId, type });
        }
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
      if (current.nodes.length === 0) {
        scale = 1;
        panX = 0;
        panY = 0;
        applyTransform();
        return;
      }
      const minX = Math.min(...current.nodes.map((node) => node.x));
      const minY = Math.min(...current.nodes.map((node) => node.y));
      const maxX = Math.max(...current.nodes.map((node) => node.x + node.width));
      const maxY = Math.max(...current.nodes.map((node) => node.y + node.height));
      const rect = canvas.getBoundingClientRect();
      scale = Math.max(.35, Math.min(1.6, Math.min((rect.width - 80) / Math.max(1, maxX - minX), (rect.height - 80) / Math.max(1, maxY - minY))));
      panX = Math.round(40 - minX * scale);
      panY = Math.round(40 - minY * scale);
      applyTransform();
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
      if (event.target.closest('.node') || event.target.closest('.edge')) return;
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
      showSelectionBox(point.x, point.y, 0, 0);
      canvas.setPointerCapture(event.pointerId);
      updateNodeSelectionClasses();
      renderRightPanel();
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
        if (rectsIntersect(left, top, width, height, node.x, node.y, node.width, node.height)) {
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
    document.getElementById('refresh').addEventListener('click', () => post({ command: 'refresh', blueprintId: current.id }));
    document.getElementById('previewSync').addEventListener('click', () => post({ command: 'preview-sync', blueprintId: current.id }));
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
    function edgeIssuesFor(edgeId) {
      return (state.edgeSemanticIssues || []).filter((issue) => issue.edgeId === edgeId);
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
