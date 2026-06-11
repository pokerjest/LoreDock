import * as vscode from 'vscode';
import { LoreDockStorage } from '../core/storage';
import { TimelineDocument, TimelineEvent, TimelineEventType, TimelineResolvedView } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

interface TimelineWorkbenchState extends TimelineResolvedView {
  characters: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  chapters: Array<{ id: string; title: string }>;
  scenes: Array<{ id: string; name: string }>;
  beats: Array<{ id: string; name: string }>;
}

type TimelineMessage =
  | { command: 'refresh' | 'createEvent' }
  | { command: 'saveDocument'; document: TimelineDocument }
  | { command: 'deleteEvent'; eventId: string }
  | { command: 'duplicateEvent'; eventId: string }
  | { command: 'moveEvents'; updates: Array<{ id: string; startSortValue: number; endSortValue?: number }> };

export async function showTimelineWorkbench(context: vscode.ExtensionContext, storage: LoreDockStorage): Promise<void> {
  await storage.requireManifest();
  const panel = vscode.window.createWebviewPanel('loredock.timelineWorkbench', 'LoreDock 时间线', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = async () => {
    const state = await buildTimelineState(storage);
    panel.webview.html = renderTimelineHtml(state);
  };

  panel.webview.onDidReceiveMessage(async (message: TimelineMessage) => {
    if (message.command === 'refresh') {
      await render();
      return;
    }
    if (message.command === 'createEvent') {
      const document = await storage.readTimelineDocument();
      await storage.createTimelineEvent({ name: `未命名事件 ${document.events.length + 1}` });
      await render();
      return;
    }
    if (message.command === 'saveDocument') {
      await storage.writeTimelineDocument(message.document);
      await render();
      return;
    }
    if (message.command === 'moveEvents') {
      await storage.moveTimelineEvents(message.updates);
      await render();
      return;
    }
    if (message.command === 'duplicateEvent') {
      const document = await storage.readTimelineDocument();
      const source = document.events.find((event) => event.id === message.eventId);
      if (source) {
        await storage.updateTimelineEvents([{ ...source, id: `${source.id}-copy-${Date.now().toString(36)}`, title: `${source.title} 副本`, locked: false, status: 'planned' }]);
      }
      await render();
      return;
    }
    if (message.command === 'deleteEvent') {
      const choice = await vscode.window.showWarningMessage('确定删除这个时间线事件吗？', { modal: true }, '删除');
      if (choice === '删除') {
        await storage.deleteTimelineEvent(message.eventId);
        await render();
      }
    }
  }, undefined, context.subscriptions);

  await render();
}

async function buildTimelineState(storage: LoreDockStorage): Promise<TimelineWorkbenchState> {
  const [view, entries, chapters] = await Promise.all([
    storage.getTimelineResolvedView(),
    storage.listCodexEntries(),
    storage.getFlatChapterRefs()
  ]);
  return {
    ...view,
    characters: entries.filter((entry) => entry.card.kind === 'character').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    locations: entries.filter((entry) => entry.card.kind === 'location').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    chapters: chapters.map((ref) => ({ id: ref.chapter.id, title: `${ref.volume.title} / ${ref.chapter.title}` })),
    scenes: entries.filter((entry) => entry.card.kind === 'scene').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    beats: entries.filter((entry) => entry.card.kind === 'beat').map((entry) => ({ id: entry.card.id, name: entry.card.name }))
  };
}

function renderTimelineHtml(state: TimelineWorkbenchState): string {
  const nonceValue = nonce();
  const stateJson = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(nonceValue)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 时间线</title>
  <style>
    :root { color-scheme: dark; --bg:#101010; --panel:#171717; --panel2:#202020; --line:#343434; --text:#dedede; --muted:#8b8b8b; --accent:#39d3c6; --danger:#ff7b72; --warn:#dcdcaa; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 var(--vscode-font-family); overflow: hidden; }
    button, input, textarea, select { font: inherit; color: var(--text); background: #2a2a2a; border: 1px solid #474747; border-radius: 4px; }
    button { padding: 6px 9px; cursor: pointer; white-space: nowrap; }
    button:hover { border-color: var(--accent); }
    button.icon { width: 32px; padding: 6px 0; }
    button.danger { color: var(--danger); border-color: #7c3932; }
    input, textarea, select { width: 100%; padding: 7px 8px; }
    textarea { min-height: 70px; resize: vertical; }
    .shell { display: grid; grid-template-rows: 42px 1fr; height: 100vh; }
    .topbar { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-bottom: 1px solid var(--line); background: #151515; }
    .title { color: var(--accent); font-weight: 700; margin-right: 8px; }
    .spacer { flex: 1; }
    .main { display: grid; grid-template-columns: 292px minmax(520px, 1fr) 342px; min-height: 0; }
    .side, .inspector { background: var(--panel); padding: 12px; overflow: auto; }
    .side { border-right: 1px solid var(--line); }
    .inspector { border-left: 1px solid var(--line); }
    .canvasWrap { position: relative; overflow: auto; background-color: #101010; background-image: radial-gradient(#333 1px, transparent 1px); background-size: 24px 24px; }
    .section { margin-bottom: 14px; }
    .section h3 { margin: 0 0 8px; font-size: 12px; color: var(--accent); }
    .field { margin-bottom: 9px; }
    .field label { display: block; color: var(--muted); margin-bottom: 4px; font-size: 12px; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .resourceList, .eventList, .conflictList { display: grid; gap: 6px; }
    .resource, .eventItem, .conflict { padding: 8px; border: 1px solid #383838; background: #121212; border-radius: 5px; cursor: pointer; }
    .resource:hover, .eventItem:hover { border-color: var(--accent); }
    .resource small, .eventItem span, .conflict span { color: var(--muted); display: block; font-size: 12px; }
    .eventItem.active { border-color: var(--accent); }
    .conflict.warning { border-color: #7b6532; }
    .conflict.info { border-color: #3d6370; }
    svg { min-width: 1280px; min-height: 840px; display: block; }
    .laneLabel { fill: #9ff6ef; font-size: 12px; font-weight: 700; }
    .laneSub { fill: #777; font-size: 11px; }
    .laneLine { stroke: #303030; stroke-width: 1; }
    .tick { stroke: #3d3d3d; stroke-width: 1; }
    .eventBlock { cursor: grab; }
    .eventBlock.locked { cursor: not-allowed; opacity: .72; }
    .eventBlock rect { rx: 5; stroke-width: 2; }
    .eventBlock.selected rect { stroke: var(--accent); }
    .eventBlock.conflicted rect { stroke-dasharray: 5 3; }
    .eventBlock text { fill: #f0f0f0; pointer-events: none; }
    .resizeHandle { cursor: ew-resize; }
    .dropHint { outline: 1px dashed var(--accent); outline-offset: -6px; }
    .empty { color: var(--muted); border: 1px dashed #454545; border-radius: 5px; padding: 10px; }
    .pill { display:inline-block; border:1px solid #444; border-radius:999px; padding:1px 7px; color:#aaa; font-size:11px; margin-left:4px; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="title">时间线</div>
      <button id="newEvent">新建事件</button>
      <button id="save">保存</button>
      <button id="refresh">刷新</button>
      <button id="undo" class="icon" title="撤销">↶</button>
      <button id="redo" class="icon" title="重做">↷</button>
      <button id="duplicate">复制</button>
      <button id="fitView">适配视图</button>
      <button id="sortTime">按时间排序</button>
      <button id="autoLane">自动分泳道</button>
      <button id="conflictCheck">冲突检查</button>
      <div class="spacer"></div>
      <span id="summary"></span>
    </div>
    <div class="main">
      <aside class="side">
        <div class="section">
          <h3>资源</h3>
          <div class="field"><input id="resourceSearch" placeholder="搜索人物、地点、章节、场景、Beat"></div>
          <div class="field"><select id="resourceKind"><option value="all">全部资源</option><option value="character">人物</option><option value="location">地点</option><option value="chapter">章节</option><option value="scene">场景</option><option value="beat">Beat</option></select></div>
          <div id="resources" class="resourceList"></div>
        </div>
        <div class="section">
          <h3>过滤</h3>
          <div class="field"><input id="eventSearch" placeholder="搜索事件、人物、地点"></div>
          <div class="field"><select id="typeFilter">${eventTypeOptions('all')}</select></div>
          <div class="field"><select id="conflictFilter"><option value="all">全部事件</option><option value="conflict">只看冲突</option><option value="clean">只看无冲突</option></select></div>
        </div>
        <div class="section">
          <h3>事件</h3>
          <div id="events" class="eventList"></div>
        </div>
      </aside>
      <main id="canvasWrap" class="canvasWrap"><svg id="timelineSvg"></svg></main>
      <aside class="inspector">
        <div class="section">
          <h3>世界日历</h3>
          <div class="split">
            <div class="field"><label>日历</label><input id="calendarName"></div>
            <div class="field"><label>纪元</label><input id="eraLabel"></div>
          </div>
          <div class="field"><label>世界创建时间</label><input id="worldCreatedAt"></div>
          <div class="field"><label>说明</label><textarea id="calendarNote"></textarea></div>
        </div>
        <div id="emptyInspector" class="empty">选择事件，或从左侧资源拖入泳道创建事件。</div>
        <div id="eventInspector" hidden>
          <div class="section">
            <h3>事件属性</h3>
            ${inputField('title', '标题')}
            ${textareaField('summaryText', '说明')}
            <div class="split"><div class="field"><label>类型</label><select id="eventType">${eventTypeOptions()}</select></div><div class="field"><label>泳道</label><select id="laneType">${laneOptions()}</select></div></div>
            <div class="split"><div class="field"><label>重要性</label><select id="importance">${importanceOptions()}</select></div><div class="field"><label>状态</label><select id="status">${statusOptions()}</select></div></div>
            <div class="split"><div class="field"><label>开始时间</label><input id="startLabel"></div><div class="field"><label>排序值</label><input id="startSort" type="number"></div></div>
            <div class="split"><div class="field"><label>结束时间</label><input id="endLabel"></div><div class="field"><label>结束排序值</label><input id="endSort" type="number"></div></div>
            <div class="split"><div class="field"><label>颜色</label><input id="color" placeholder="#4fc1ff"></div><div class="field"><label>锁定</label><select id="locked"><option value="false">可拖动</option><option value="true">锁定</option></select></div></div>
          </div>
          <div class="section">
            <h3>强绑定</h3>
            ${multiSelectField('participantIds', '人物', state.characters)}
            ${selectField('locationId', '地点', state.locations)}
            ${selectField('chapterId', '章节', state.chapters)}
            ${selectField('sceneId', '场景', state.scenes)}
            ${selectField('beatId', 'Beat', state.beats)}
          </div>
          <div class="section">
            <h3>剧情结果</h3>
            ${textareaField('result', '结果')}
            ${textareaField('notes', '备注')}
            <div class="field"><label>可见性</label><select id="visibility"><option value="public">public</option><option value="reader-unknown">reader-unknown</option><option value="character-unknown">character-unknown</option></select></div>
          </div>
          <button id="deleteEvent" class="danger">删除事件</button>
        </div>
        <div class="section">
          <h3>冲突</h3>
          <div id="conflicts" class="conflictList"></div>
        </div>
      </aside>
    </div>
  </div>
  <script nonce="${nonceValue}">
    const vscode = acquireVsCodeApi();
    let state = ${stateJson};
    let selectedId = state.events[0]?.id || '';
    let history = [];
    let future = [];
    let dragging = null;
    let scaleContext = null;
    const $ = (id) => document.getElementById(id);
    const typeColors = { world:'#dcdcaa', plot:'#4fc1ff', character:'#c586c0', location:'#6a9955', relationship:'#ce9178', custom:'#9cdcfe' };

    function snapshot() { history.push(JSON.stringify(state.document)); if (history.length > 80) history.shift(); future = []; }
    function restore(raw) { if (!raw) return; future.push(JSON.stringify(state.document)); state.document = JSON.parse(raw); rebuildViewFromDocument(); render(); }
    function rebuildViewFromDocument() { state.events = state.document.events.map((event) => ({ ...event, resolvedParticipants: resolveParticipants(event), resolvedLocation: resolveLocation(event), conflictIds: conflictIdsFor(event.id) })); }
    function conflictIdsFor(id) { return state.conflicts.filter((conflict) => conflict.eventIds.includes(id)).map((conflict) => conflict.id); }
    function resolveParticipants(event) { return (event.participantIds || []).length ? event.participantIds.map((id) => state.characters.find((item) => item.id === id)?.name || id) : (event.participants || []); }
    function resolveLocation(event) { return event.locationId ? state.locations.find((item) => item.id === event.locationId)?.name || event.location || event.locationId : event.location; }
    function selectedEvent() { return state.document.events.find((event) => event.id === selectedId); }
    function filteredEvents() {
      const query = $('eventSearch').value.trim().toLowerCase();
      const type = $('typeFilter').value;
      const conflict = $('conflictFilter').value;
      return state.document.events
        .filter((event) => type === 'all' || event.type === type)
        .filter((event) => conflict === 'all' || (conflict === 'conflict' ? conflictIdsFor(event.id).length > 0 : conflictIdsFor(event.id).length === 0))
        .filter((event) => !query || [event.title, event.summary, event.location, ...(event.participants || []), ...resolveParticipants(event)].join('\\n').toLowerCase().includes(query))
        .sort((a, b) => a.start.sortValue - b.start.sortValue || a.title.localeCompare(b.title, 'zh-Hans-CN'));
    }
    function render() {
      $('summary').textContent = state.document.events.length + ' 个事件 · ' + state.conflicts.length + ' 个提示';
      $('calendarName').value = state.document.calendar.calendarName || '';
      $('eraLabel').value = state.document.calendar.eraLabel || '';
      $('worldCreatedAt').value = state.document.calendar.worldCreatedAt || '';
      $('calendarNote').value = state.document.calendar.note || '';
      renderResources(); renderEventList(); renderSvg(); renderInspector(); renderConflicts();
    }
    function renderResources() {
      const kind = $('resourceKind').value;
      const query = $('resourceSearch').value.trim().toLowerCase();
      const pools = [
        ['character', '人物', state.characters],
        ['location', '地点', state.locations],
        ['chapter', '章节', state.chapters],
        ['scene', '场景', state.scenes],
        ['beat', 'Beat', state.beats]
      ];
      const items = pools.flatMap(([type, label, rows]) => kind === 'all' || kind === type ? rows.map((row) => ({ ...row, type, label, title: row.name || row.title })) : []);
      const filtered = items.filter((item) => !query || item.title.toLowerCase().includes(query)).slice(0, 80);
      $('resources').innerHTML = filtered.length ? filtered.map((item) => '<div class="resource" draggable="true" data-type="' + item.type + '" data-id="' + escapeAttr(item.id) + '" data-title="' + escapeAttr(item.title) + '"><strong>' + escapeHtml(item.title) + '</strong><small>' + item.label + '</small></div>').join('') : '<div class="empty">没有资源</div>';
      $('resources').querySelectorAll('.resource').forEach((el) => el.addEventListener('dragstart', (event) => event.dataTransfer.setData('application/json', JSON.stringify(el.dataset))));
    }
    function renderEventList() {
      const events = filteredEvents();
      $('events').innerHTML = events.length ? events.map((event) => '<div class="eventItem ' + (event.id === selectedId ? 'active' : '') + '" data-id="' + escapeAttr(event.id) + '"><strong>' + escapeHtml(event.title) + conflictBadge(event) + '</strong><span>' + escapeHtml(event.start.label || String(event.start.sortValue)) + ' · ' + escapeHtml(resolveLocation(event) || '未绑定地点') + '</span></div>').join('') : '<div class="empty">暂无事件</div>';
      $('events').querySelectorAll('.eventItem').forEach((el) => el.addEventListener('click', () => { selectedId = el.dataset.id; render(); }));
    }
    function renderSvg() {
      const svg = $('timelineSvg');
      const events = filteredEvents();
      const lanes = visibleLanes(events);
      const min = Math.min(0, ...events.map((event) => event.start.sortValue));
      const max = Math.max(100, ...events.map((event) => event.end?.sortValue ?? event.start.sortValue + 8));
      const width = 1360, left = 172, top = 42, laneHeight = 96;
      const scale = (value) => left + ((value - min) / Math.max(1, max - min)) * (width - left - 90);
      const unscale = (x) => min + ((x - left) / Math.max(1, width - left - 90)) * Math.max(1, max - min);
      scaleContext = { min, max, width, left, top, laneHeight, scale, unscale };
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + Math.max(840, top + lanes.length * laneHeight + 90));
      const ticks = makeTicks(min, max);
      svg.innerHTML = ticks.map((tick) => '<line class="tick" x1="' + scale(tick) + '" y1="18" x2="' + scale(tick) + '" y2="' + (top + lanes.length * laneHeight) + '"></line><text x="' + scale(tick) + '" y="16" fill="#777" font-size="11">' + tick + '</text>').join('');
      lanes.forEach((lane, laneIndex) => {
        const y = top + laneIndex * laneHeight;
        svg.insertAdjacentHTML('beforeend', '<text class="laneLabel" x="16" y="' + (y + 28) + '">' + escapeHtml(lane.title) + '</text><text class="laneSub" x="16" y="' + (y + 46) + '">' + escapeHtml(lane.type) + '</text><line class="laneLine" x1="0" y1="' + (y + laneHeight - 12) + '" x2="' + width + '" y2="' + (y + laneHeight - 12) + '"></line>');
        events.filter((event) => eventInLane(event, lane)).forEach((event, index) => {
          const x1 = scale(event.start.sortValue);
          const x2 = scale(event.end?.sortValue ?? event.start.sortValue + 8);
          const w = Math.max(112, x2 - x1);
          const eventY = y + 18 + (index % 2) * 28;
          const color = event.color || typeColors[event.type] || typeColors.custom;
          const classes = ['eventBlock', event.id === selectedId ? 'selected' : '', conflictIdsFor(event.id).length ? 'conflicted' : '', event.locked || event.status === 'locked' ? 'locked' : ''].join(' ');
          svg.insertAdjacentHTML('beforeend', '<g class="' + classes + '" data-id="' + escapeAttr(event.id) + '"><rect x="' + x1 + '" y="' + eventY + '" width="' + w + '" height="40" fill="#171717" stroke="' + color + '"></rect><rect class="resizeHandle" data-id="' + escapeAttr(event.id) + '" data-edge="end" x="' + (x1 + w - 7) + '" y="' + eventY + '" width="7" height="40" fill="transparent"></rect><text x="' + (x1 + 8) + '" y="' + (eventY + 17) + '" font-size="12">' + escapeHtml(short(event.title, 18)) + '</text><text x="' + (x1 + 8) + '" y="' + (eventY + 33) + '" font-size="11" fill="#999">' + escapeHtml(short(resolveLocation(event) || event.start.label || '', 22)) + '</text></g>');
        });
      });
      svg.querySelectorAll('.eventBlock').forEach((el) => {
        el.addEventListener('mousedown', (event) => startDrag(event, el.dataset.id, 'move'));
        el.addEventListener('click', (event) => { selectedId = el.dataset.id; render(); event.stopPropagation(); });
      });
      svg.querySelectorAll('.resizeHandle').forEach((el) => el.addEventListener('mousedown', (event) => startDrag(event, el.dataset.id, 'resize')));
    }
    function visibleLanes(events) {
      const base = state.lanes.length ? state.lanes : [{ id:'world', type:'world', title:'世界线' }, { id:'plot', type:'plot', title:'剧情线' }];
      return base.filter((lane) => lane.type === 'world' || lane.type === 'plot' || events.some((event) => eventInLane(event, lane)));
    }
    function eventInLane(event, lane) {
      if (lane.id === 'world') return event.laneType === 'world' || event.type === 'world';
      if (lane.id === 'plot') return event.laneType === 'plot' || (!event.participantIds?.length && !event.locationId && event.type !== 'world');
      if (lane.type === 'character') return (event.participantIds || []).includes(lane.refId);
      if (lane.type === 'location') return event.locationId === lane.refId;
      if (lane.type === 'chapter') return event.chapterId === lane.refId;
      return false;
    }
    function renderInspector() {
      const event = selectedEvent();
      $('emptyInspector').hidden = !!event;
      $('eventInspector').hidden = !event;
      if (!event) return;
      $('title').value = event.title || '';
      $('summaryText').value = event.summary || '';
      $('eventType').value = event.type || 'plot';
      $('laneType').value = event.laneType || 'plot';
      $('importance').value = event.importance || 'normal';
      $('status').value = event.status || 'planned';
      $('startLabel').value = event.start.label || '';
      $('startSort').value = event.start.sortValue ?? 0;
      $('endLabel').value = event.end?.label || '';
      $('endSort').value = event.end?.sortValue ?? '';
      $('color').value = event.color || '';
      $('locked').value = String(Boolean(event.locked || event.status === 'locked'));
      setMulti('participantIds', event.participantIds || []);
      $('locationId').value = event.locationId || '';
      $('chapterId').value = event.chapterId || '';
      $('sceneId').value = event.sceneId || '';
      $('beatId').value = event.beatId || '';
      $('result').value = event.result || '';
      $('notes').value = event.notes || '';
      $('visibility').value = event.visibility || 'public';
    }
    function renderConflicts() {
      $('conflicts').innerHTML = state.conflicts.length ? state.conflicts.map((conflict) => '<div class="conflict ' + conflict.severity + '" data-id="' + escapeAttr(conflict.eventIds[0] || '') + '"><strong>' + escapeHtml(conflict.title) + '</strong><span>' + escapeHtml(conflict.detail) + '</span></div>').join('') : '<div class="empty">暂无冲突</div>';
      $('conflicts').querySelectorAll('.conflict').forEach((el) => el.addEventListener('click', () => { if (el.dataset.id) selectedId = el.dataset.id; render(); }));
    }
    function syncFromForm() {
      state.document.calendar = { worldCreatedAt: $('worldCreatedAt').value, calendarName: $('calendarName').value || '自由日历', eraLabel: $('eraLabel').value, note: $('calendarNote').value };
      const event = selectedEvent();
      if (!event) return;
      event.title = $('title').value || '未命名事件';
      event.summary = $('summaryText').value;
      event.type = $('eventType').value;
      event.laneType = $('laneType').value;
      event.importance = $('importance').value;
      event.status = $('status').value;
      event.start = { ...event.start, label: $('startLabel').value, sortValue: Number($('startSort').value || 0) };
      event.end = $('endLabel').value || $('endSort').value ? { ...(event.end || event.start), label: $('endLabel').value, sortValue: Number($('endSort').value || $('startSort').value || 0) } : undefined;
      event.color = $('color').value;
      event.locked = $('locked').value === 'true' || event.status === 'locked';
      event.participantIds = getMulti('participantIds');
      event.participants = event.participantIds.map((id) => state.characters.find((item) => item.id === id)?.name || id);
      event.locationId = $('locationId').value || undefined;
      event.location = event.locationId ? state.locations.find((item) => item.id === event.locationId)?.name || event.locationId : '';
      event.chapterId = $('chapterId').value || undefined;
      event.sceneId = $('sceneId').value || undefined;
      event.beatId = $('beatId').value || undefined;
      event.result = $('result').value;
      event.notes = $('notes').value;
      event.visibility = $('visibility').value;
      event.updatedAt = new Date().toISOString();
      rebuildViewFromDocument();
    }
    function startDrag(mouseEvent, id, mode) {
      const event = state.document.events.find((item) => item.id === id);
      if (!event || event.locked || event.status === 'locked') return;
      selectedId = id; snapshot();
      dragging = { id, mode, startX: mouseEvent.clientX, originalStart: event.start.sortValue, originalEnd: event.end?.sortValue };
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', endDrag);
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
    }
    function onDrag(mouseEvent) {
      if (!dragging || !scaleContext) return;
      const event = selectedEvent();
      if (!event) return;
      const delta = scaleContext.unscale(scaleContext.left + mouseEvent.clientX - dragging.startX) - scaleContext.unscale(scaleContext.left);
      if (dragging.mode === 'resize') {
        event.end = { ...(event.end || event.start), sortValue: Math.max(event.start.sortValue, Math.round((dragging.originalEnd ?? event.start.sortValue + 8) + delta)) };
      } else {
        event.start.sortValue = Math.round(dragging.originalStart + delta);
        if (event.end && dragging.originalEnd !== undefined) event.end.sortValue = Math.round(dragging.originalEnd + delta);
      }
      renderSvg(); renderInspector();
    }
    function endDrag() {
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', endDrag);
      dragging = null;
    }
    function createFromResource(resource, sortValue) {
      snapshot();
      const id = 'timeline-' + Date.now().toString(36);
      const base = { schemaVersion:1, id, kind:'timeline-event', title: resource.title || '未命名事件', summary:'', type: resource.type === 'character' ? 'character' : resource.type === 'location' ? 'location' : 'plot', laneType: resource.type === 'character' ? 'character' : resource.type === 'location' ? 'location' : resource.type === 'chapter' ? 'chapter' : 'plot', importance:'normal', status:'planned', start:{ label:'', sortValue }, location:'', participants:[], participantIds:[], result:'', visibility:'public', tags:[], notes:'', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
      if (resource.type === 'character') { base.participantIds = [resource.id]; base.participants = [resource.title]; }
      if (resource.type === 'location') { base.locationId = resource.id; base.location = resource.title; }
      if (resource.type === 'chapter') base.chapterId = resource.id;
      if (resource.type === 'scene') base.sceneId = resource.id;
      if (resource.type === 'beat') base.beatId = resource.id;
      state.document.events.push(base);
      selectedId = id; rebuildViewFromDocument(); render();
    }
    function applyAutoLanes() {
      snapshot();
      for (const event of state.document.events) {
        event.laneType = event.type === 'world' ? 'world' : event.participantIds?.length ? 'character' : event.locationId ? 'location' : event.chapterId ? 'chapter' : 'plot';
      }
      render();
    }
    function sortByTime() { snapshot(); state.document.events.sort((a,b) => a.start.sortValue - b.start.sortValue || a.title.localeCompare(b.title, 'zh-Hans-CN')); render(); }
    function conflictBadge(event) { return conflictIdsFor(event.id).length ? '<span class="pill">冲突</span>' : ''; }
    function setMulti(id, values) { [...$(id).options].forEach((option) => option.selected = values.includes(option.value)); }
    function getMulti(id) { return [...$(id).selectedOptions].map((option) => option.value).filter(Boolean); }
    function splitDrop(event) { try { return JSON.parse(event.dataTransfer.getData('application/json')); } catch { return undefined; } }
    ['calendarName','eraLabel','worldCreatedAt','calendarNote'].forEach((id) => $(id).addEventListener('input', () => { syncFromForm(); }));
    ['eventSearch','typeFilter','conflictFilter','resourceSearch','resourceKind'].forEach((id) => $(id).addEventListener('input', render));
    ['title','summaryText','eventType','laneType','importance','status','startLabel','startSort','endLabel','endSort','color','locked','participantIds','locationId','chapterId','sceneId','beatId','result','notes','visibility'].forEach((id) => $(id).addEventListener('input', () => { snapshot(); syncFromForm(); renderEventList(); renderSvg(); }));
    $('newEvent').addEventListener('click', () => vscode.postMessage({ command:'createEvent' }));
    $('save').addEventListener('click', () => { syncFromForm(); vscode.postMessage({ command:'saveDocument', document: state.document }); });
    $('refresh').addEventListener('click', () => vscode.postMessage({ command:'refresh' }));
    $('duplicate').addEventListener('click', () => { if (selectedId) vscode.postMessage({ command:'duplicateEvent', eventId:selectedId }); });
    $('deleteEvent').addEventListener('click', () => { if (selectedId) vscode.postMessage({ command:'deleteEvent', eventId:selectedId }); });
    $('undo').addEventListener('click', () => restore(history.pop()));
    $('redo').addEventListener('click', () => { const raw = future.pop(); if (raw) { history.push(JSON.stringify(state.document)); state.document = JSON.parse(raw); rebuildViewFromDocument(); render(); } });
    $('fitView').addEventListener('click', () => { $('canvasWrap').scrollLeft = 0; $('canvasWrap').scrollTop = 0; });
    $('sortTime').addEventListener('click', sortByTime);
    $('autoLane').addEventListener('click', applyAutoLanes);
    $('conflictCheck').addEventListener('click', () => { $('conflictFilter').value = 'conflict'; render(); });
    $('canvasWrap').addEventListener('dragover', (event) => { event.preventDefault(); $('canvasWrap').classList.add('dropHint'); });
    $('canvasWrap').addEventListener('dragleave', () => $('canvasWrap').classList.remove('dropHint'));
    $('canvasWrap').addEventListener('drop', (event) => { event.preventDefault(); $('canvasWrap').classList.remove('dropHint'); const resource = splitDrop(event); if (resource && scaleContext) createFromResource(resource, Math.round(scaleContext.unscale(event.offsetX))); });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.shiftKey ? $('redo').click() : $('undo').click(); event.preventDefault(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { $('duplicate').click(); event.preventDefault(); }
      if (event.key === 'Delete' && selectedId) { $('deleteEvent').click(); event.preventDefault(); }
    });
    function makeTicks(min, max) { const step = Math.max(10, Math.ceil((max - min) / 9 / 10) * 10); const ticks = []; for (let value = Math.floor(min / step) * step; value <= max + step; value += step) ticks.push(value); return ticks; }
    function short(value, length) { return Array.from(value || '').slice(0, length).join(''); }
    function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char])); }
    function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }
    render();
  </script>
</body>
</html>`;
}

function inputField(id: string, label: string, type = 'text'): string {
  return `<div class="field"><label>${escapeHtml(label)}</label><input id="${id}" type="${type}"></div>`;
}

function textareaField(id: string, label: string): string {
  return `<div class="field"><label>${escapeHtml(label)}</label><textarea id="${id}"></textarea></div>`;
}

function selectField(id: string, label: string, options: Array<{ id: string; name?: string; title?: string }>): string {
  return `<div class="field"><label>${escapeHtml(label)}</label><select id="${id}"><option value="">未绑定</option>${options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name || option.title || option.id)}</option>`).join('')}</select></div>`;
}

function multiSelectField(id: string, label: string, options: Array<{ id: string; name?: string; title?: string }>): string {
  return `<div class="field"><label>${escapeHtml(label)}</label><select id="${id}" multiple size="5">${options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name || option.title || option.id)}</option>`).join('')}</select></div>`;
}

function eventTypeOptions(selected = 'plot'): string {
  const labels: Record<TimelineEventType | 'all', string> = { all: '全部类型', world: '世界事件', plot: '剧情事件', character: '人物事件', location: '地点事件', relationship: '关系事件', custom: '自定义' };
  return (Object.keys(labels) as Array<TimelineEventType | 'all'>).map((type) => `<option value="${type}"${type === selected ? ' selected' : ''}>${escapeHtml(labels[type])}</option>`).join('');
}

function laneOptions(): string {
  return [
    ['world', '世界线'],
    ['plot', '剧情线'],
    ['character', '人物线'],
    ['location', '地点线'],
    ['chapter', '章节线']
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
}

function importanceOptions(): string {
  return [
    ['minor', '轻微'],
    ['normal', '普通'],
    ['major', '重要'],
    ['turning-point', '转折点']
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
}

function statusOptions(): string {
  return [
    ['planned', '计划中'],
    ['drafted', '已写入'],
    ['locked', '锁定']
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
}
