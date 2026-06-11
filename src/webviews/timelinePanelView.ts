import { TimelineDocument, TimelineEventType, TimelineResolvedView } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export interface TimelineWorkbenchState extends TimelineResolvedView {
  characters: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  chapters: Array<{ id: string; title: string }>;
  scenes: Array<{ id: string; name: string }>;
  beats: Array<{ id: string; name: string }>;
  timelineEventOptions: Array<{ timelineId: string; timelineTitle: string; eventId: string; title: string; sortValue: number }>;
  selectedEventId?: string;
  hiddenEventIds: string[];
}

export function renderTimelineHtml(state: TimelineWorkbenchState): string {
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
    :root {
      color-scheme: dark;
      --bg: #101010;
      --panel: #171717;
      --panel-soft: #1f1f1f;
      --line: #343434;
      --text: #e5e5e5;
      --muted: #9a9a9a;
      --accent: #3dd6c6;
      --accent-soft: rgba(61, 214, 198, .13);
      --danger: #ff897d;
      --warn: #e6c76e;
    }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--text); font: 13px/1.45 var(--vscode-font-family); }
    button, input, textarea, select { font: inherit; color: var(--text); background: #252525; border: 1px solid #484848; border-radius: 4px; }
    button { min-height: 32px; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    button.iconButton { width: 34px; min-width: 34px; padding: 6px 0; font-size: 16px; line-height: 1; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button.primary { background: #17433f; border-color: #2a8b82; }
    button.danger { color: var(--danger); border-color: #7f3934; }
    input, textarea, select { width: 100%; min-width: 0; padding: 7px 8px; }
    textarea { min-height: 76px; resize: vertical; }
    label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
    .shell { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100vh; min-width: 0; }
    .topbar { display: grid; grid-template-columns: auto minmax(180px, 260px) auto auto auto auto 1fr; gap: 8px; align-items: center; min-width: 0; padding: 8px 10px; border-bottom: 1px solid var(--line); background: #151515; }
    .brand { color: var(--accent); font-weight: 700; white-space: nowrap; }
    .currentName { min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; justify-self: end; }
    .main { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr) minmax(280px, 340px); min-height: 0; min-width: 0; overflow: hidden; }
    .eventsPane, .inspector { min-width: 0; overflow: auto; padding: 12px; background: var(--panel); }
    .eventsPane { border-right: 1px solid var(--line); }
    .inspector { border-left: 1px solid var(--line); }
    .canvasWrap { position: relative; min-width: 0; overflow: auto; background-color: #101010; background-image: radial-gradient(#303030 1px, transparent 1px); background-size: 24px 24px; }
    .paneTitle { margin: 0 0 10px; font-size: 12px; color: var(--accent); }
    .eventList, .timelineTree, .referenceList, .conflictList, .categoryList { display: grid; gap: 6px; }
    .categoryList { margin-bottom: 10px; }
    .categoryButton { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 6px; width: 100%; min-height: 30px; padding: 5px 8px; text-align: left; }
    .categoryButton[aria-pressed="false"] { opacity: .55; }
    .categoryIcon { color: var(--accent); text-align: center; }
    .categoryCount { color: var(--muted); font-size: 12px; }
    .eventGroup { display: grid; gap: 6px; margin-bottom: 10px; }
    .eventGroupTitle { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0; }
    .eventItem, .timelineNode, .referenceItem, .conflictItem { min-width: 0; padding: 8px; border: 1px solid #383838; background: #121212; border-radius: 5px; cursor: pointer; }
    .eventItem { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: start; gap: 6px; }
    .eventItem.hiddenEvent { opacity: .56; }
    .eventEye { width: 26px; min-width: 26px; min-height: 26px; padding: 0; color: var(--accent); background: transparent; border-color: #3a3a3a; }
    .eventText { min-width: 0; }
    .eventItem:hover, .timelineNode:hover, .referenceItem:hover { border-color: var(--accent); }
    .eventItem.active, .timelineNode.active { border-color: var(--accent); background: var(--accent-soft); }
    .eventItem strong, .timelineNode strong, .referenceItem strong, .conflictItem strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .eventItem span, .timelineNode span, .referenceItem span, .conflictItem span { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .timelineNode { padding-left: calc(8px + var(--depth, 0) * 16px); }
    .field { margin-bottom: 10px; min-width: 0; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
    .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .row > * { min-width: 0; }
    .empty { color: var(--muted); border: 1px dashed #484848; border-radius: 5px; padding: 12px; overflow-wrap: anywhere; }
    .emptyHero { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; background: rgba(16, 16, 16, .94); }
    .emptyHero[hidden] { display: none; }
    .emptyHeroInner { max-width: 360px; }
    .emptyHeroInner h2 { margin: 0 0 8px; color: var(--text); font-size: 20px; }
    .emptyHeroInner p { margin: 0 0 16px; color: var(--muted); }
    .hint { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
    .details { margin-top: 14px; border-top: 1px solid #292929; padding-top: 12px; }
    details summary { color: var(--accent); cursor: pointer; margin-bottom: 10px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill { display: inline-block; border: 1px solid #444; border-radius: 999px; padding: 1px 7px; color: #aaa; font-size: 11px; margin-left: 4px; }
    svg { min-width: 980px; min-height: 720px; display: block; }
    .laneLabel { fill: #9ff6ef; font-size: 12px; font-weight: 700; }
    .laneSub { fill: #777; font-size: 11px; }
    .laneLine { stroke: #303030; stroke-width: 1; }
    .tick { stroke: #3d3d3d; stroke-width: 1; }
    .eventBlock { cursor: grab; }
    .eventBlock.locked { cursor: not-allowed; opacity: .72; }
    .eventBlock.reference { opacity: .34; cursor: pointer; }
    .eventBlock rect { rx: 5; stroke-width: 2; }
    .eventBlock.selected rect { stroke: var(--accent); }
    .eventBlock.conflicted rect { stroke-dasharray: 5 3; }
    .eventBlock text { fill: #f0f0f0; pointer-events: none; }
    .resizeHandle { cursor: ew-resize; pointer-events: all; }
    .modalBackdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 18px; background: rgba(0, 0, 0, .58); }
    .modalBackdrop[hidden] { display: none; }
    .modal { width: min(860px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow: auto; background: #171717; border: 1px solid #3d3d3d; border-radius: 6px; box-shadow: 0 18px 48px rgba(0,0,0,.45); }
    .modalHeader { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #2c2c2c; }
    .modalHeader h2 { margin: 0; font-size: 14px; color: var(--accent); }
    .modalHeader .spacer { flex: 1; }
    .modalBody { display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 1fr); gap: 14px; padding: 14px; }
    .modalSection { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid #292929; }
    .modalSection:last-child { border-bottom: 0; }
    .modalSection h3 { margin: 0 0 8px; color: var(--accent); font-size: 12px; }
    .checkRow { display: flex; align-items: center; gap: 8px; color: var(--muted); }
    .checkRow input { width: auto; }
    .checkboxGroup { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; max-height: 156px; overflow: auto; padding: 6px; border: 1px solid #3a3a3a; border-radius: 4px; background: #141414; }
    .checkboxItem { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 5px 6px; border: 1px solid transparent; border-radius: 4px; color: var(--text); cursor: pointer; }
    .checkboxItem:hover { border-color: #4f4f4f; background: #1d1d1d; }
    .checkboxItem input { width: auto; flex: 0 0 auto; margin: 0; }
    .checkboxItem span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 1080px) {
      .topbar { grid-template-columns: auto minmax(160px, 1fr) auto auto auto; }
      .currentName { display: none; }
      .main { grid-template-columns: minmax(230px, 280px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(260px, 40vh); }
      .inspector { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); }
    }
    @media (max-width: 720px) {
      body { overflow: auto; }
      .shell { height: auto; min-height: 100vh; }
      .topbar { grid-template-columns: 1fr 1fr; }
      .brand, #timelineSelect { grid-column: 1 / -1; }
      .main { display: block; }
      .eventsPane, .inspector { border: 0; border-top: 1px solid var(--line); max-height: none; }
      .canvasWrap { min-height: 440px; }
      .modalBody { grid-template-columns: minmax(0, 1fr); }
      .split { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">时间线</div>
      <select id="timelineSelect"></select>
      <button id="openCreateTimeline" class="primary">新建时间线</button>
      <button id="openTimelineManager">管理时间线</button>
      <button id="newEvent">新建事件</button>
      <button id="save">保存</button>
      <button id="refresh" class="iconButton" title="刷新" aria-label="刷新">↻</button>
      <div id="currentName" class="currentName"></div>
    </header>
    <section class="main">
      <aside class="eventsPane">
        <h2 class="paneTitle">事件</h2>
        <div id="eventCategories" class="categoryList"></div>
        <div id="events" class="eventList"></div>
      </aside>
      <main id="canvasWrap" class="canvasWrap">
        <svg id="timelineSvg"></svg>
        <div id="emptyTimeline" class="emptyHero" hidden>
          <div class="emptyHeroInner">
            <h2>还没有时间线</h2>
            <p>先建一条时间线，然后添加第一个事件。</p>
            <button id="emptyCreateTimeline" class="primary">新建时间线</button>
          </div>
        </div>
      </main>
      <aside class="inspector">
        <div id="emptyInspector" class="empty">选择事件，或点击“新建事件”。</div>
        <div id="eventInspector" hidden>
          <h2 class="paneTitle">编辑事件</h2>
          <div class="field"><label>标题</label><input id="title"></div>
          <div class="split">
            <div class="field"><label>日期标签</label><input id="startLabel" placeholder="例如：建国第 3 年"></div>
            <div class="field"><label>排序值</label><input id="startSort" type="number"></div>
          </div>
          <div class="actions">
            <button id="duplicate">复制</button>
            <button id="deleteEvent" class="danger">删除</button>
          </div>
          <details class="details">
            <summary>更多信息</summary>
            <div class="field"><label>摘要</label><textarea id="summaryText"></textarea></div>
            <div class="split">
              <div class="field"><label>类型</label><select id="eventType">${eventTypeOptions('plot')}</select></div>
              <div class="field"><label>轨道</label><select id="laneType">${laneOptions()}</select></div>
            </div>
            <div class="split">
              <div class="field"><label>重要性</label><select id="importance">${importanceOptions()}</select></div>
              <div class="field"><label>状态</label><select id="status">${statusOptions()}</select></div>
            </div>
            <div class="split">
              <div class="field"><label>结束标签</label><input id="endLabel"></div>
              <div class="field"><label>结束排序值</label><input id="endSort" type="number"></div>
            </div>
            <div class="split">
              <div class="field"><label>颜色</label><input id="color" placeholder="#3dd6c6"></div>
              <div class="field"><label>锁定</label><select id="locked"><option value="false">否</option><option value="true">是</option></select></div>
            </div>
            ${checkboxGroupField('participantIds', '人物', state.characters)}
            ${selectField('locationId', '地点', state.locations)}
            ${selectField('chapterId', '章节', state.chapters)}
            ${selectField('sceneId', '场景', state.scenes)}
            ${selectField('beatId', 'Beat', state.beats)}
            <div class="field"><label>结果</label><textarea id="result"></textarea></div>
            <div class="field"><label>备注</label><textarea id="notes"></textarea></div>
            <div class="field"><label>可见性</label><select id="visibility"><option value="public">公开事实</option><option value="reader-unknown">读者未知</option><option value="character-unknown">角色未知</option></select></div>
          </details>
        </div>
      </aside>
    </section>
  </div>

  <div id="createTimelineDialog" class="modalBackdrop" hidden>
    <div class="modal">
      <div class="modalHeader">
        <h2>新建时间线</h2>
        <div class="spacer"></div>
        <button id="closeCreateTimeline">关闭</button>
      </div>
      <div class="modalBody">
        <div>
          <div class="field"><label>标题</label><input id="newTimelineTitle" placeholder="例如：王国纪年"></div>
          <div class="field"><label>日历名</label><input id="newTimelineCalendar" placeholder="可留空"></div>
          <button id="newRootTimeline" class="primary">创建</button>
          <p class="hint">创建后会进入一条空时间线，你可以马上添加事件。</p>
        </div>
      </div>
    </div>
  </div>

  <div id="managerModal" class="modalBackdrop" hidden>
    <div class="modal">
      <div class="modalHeader">
        <h2>时间线管理</h2>
        <div class="spacer"></div>
        <button id="closeTimelineManager">关闭</button>
      </div>
      <div class="modalBody">
        <div>
          <div class="modalSection">
            <h3>时间线树</h3>
            <div id="timelineTree" class="timelineTree"></div>
          </div>
          <div class="modalSection">
            <h3>显示</h3>
            <label class="checkRow"><input id="showReferenceEvents" type="checkbox"> 显示祖先参考事件</label>
            <p class="hint">参考事件只读，点击会切换到来源时间线。</p>
          </div>
          <div class="modalSection">
            <h3>删除</h3>
            <button id="deleteTimeline" class="danger">删除当前时间线</button>
            <p class="hint">删除前会二次确认；子时间线会提升为普通根线。</p>
          </div>
        </div>
        <div>
          <div class="modalSection">
            <h3>当前时间线</h3>
            <div class="field"><label>标题</label><input id="timelineTitle"></div>
            <div class="field"><label>日历名</label><input id="calendarName"></div>
            <button id="saveTimelineMeta">保存元数据</button>
          </div>
          <div class="modalSection">
            <h3>创建子时间线</h3>
            <div class="field"><label>子线标题</label><input id="newChildTimelineTitle" placeholder="例如：王国纪年"></div>
            <div class="field"><label>子线日历名</label><input id="newChildTimelineCalendar" placeholder="可留空"></div>
            <div class="field"><label>父时间线</label><select id="parentTimelineId"></select></div>
            <div class="field"><label>起点事件</label><select id="originEventId"></select></div>
            <button id="newChildTimeline">创建子时间线</button>
            <p id="childTimelineHint" class="hint"></p>
          </div>
          <div class="modalSection">
            <h3>锚点</h3>
            <div id="originSummary" class="empty"></div>
            <div class="actions" style="margin-top:8px">
              <button id="reanchorTimeline">重选起点</button>
              <button id="syncOrigin">同步锚点排序值</button>
            </div>
          </div>
          <div class="modalSection">
            <h3>祖先参考</h3>
            <div id="referenceEvents" class="referenceList"></div>
          </div>
          <div class="modalSection">
            <h3>健康提示</h3>
            <div id="conflicts" class="conflictList"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonceValue}">
    const vscode = acquireVsCodeApi();
    const initialState = ${stateJson};
    let state = initialState;
    let draft = state.document ? JSON.parse(JSON.stringify(state.document)) : undefined;
    let selectedId = state.selectedEventId && draft?.events?.some((event) => event.id === state.selectedEventId) ? state.selectedEventId : draft?.events?.[0]?.id || '';
    let hiddenEventIds = new Set(state.hiddenEventIds || []);
    let showReferences = false;
    let dragging = null;
    let scaleContext = null;
    const typeColors = { world:'#8ec07c', plot:'#83a598', character:'#fabd2f', location:'#d3869b', relationship:'#fe8019', custom:'#b8bb26' };
    const eventTypeLabels = { world:'世界', plot:'剧情', character:'人物', location:'地点', relationship:'关系', custom:'自定义' };
    let visibleTypes = new Set(Object.keys(eventTypeLabels));
    const $ = (id) => document.getElementById(id);

    function hasTimeline() { return Boolean(draft && draft.id); }
    function timelineMetas() { return state.index?.timelines || []; }
    function currentEvents() { return state.events.filter((event) => !event.isReference && (!draft || event.timelineId === draft.id) && !hiddenEventIds.has(event.id)); }
    function referenceEvents() { return state.events.filter((event) => event.isReference); }
    function selectedEvent() { return draft?.events.find((event) => event.id === selectedId); }
    function conflictIdsFor(id) { const event = state.events.find((item) => item.id === id); return event?.conflictIds || []; }

    function render() {
      renderTopbar();
      renderEventCategories();
      renderEventList();
      renderSvg();
      renderInspector();
      renderManager();
    }

    function renderTopbar() {
      const metas = timelineMetas();
      $('timelineSelect').disabled = metas.length === 0;
      $('timelineSelect').innerHTML = metas.length
        ? metas.map((timeline) => '<option value="' + escapeAttr(timeline.id) + '"' + (timeline.id === draft?.id ? ' selected' : '') + '>' + escapeHtml(timeline.title) + '</option>').join('')
        : '<option value="">暂无时间线</option>';
      $('currentName').textContent = hasTimeline() ? (draft.title + ' · ' + draft.events.length + ' 个事件') : '暂无时间线';
      $('newEvent').disabled = !hasTimeline();
      $('save').disabled = !hasTimeline();
      $('openTimelineManager').disabled = metas.length === 0;
      $('emptyTimeline').hidden = hasTimeline();
    }

    function renderEventCategories() {
      if (!hasTimeline()) {
        $('eventCategories').innerHTML = '';
        return;
      }
      const counts = {};
      for (const event of draft.events) {
        const type = event.type || 'plot';
        counts[type] = (counts[type] || 0) + 1;
      }
      const types = Object.keys(eventTypeLabels).filter((type) => counts[type]);
      $('eventCategories').innerHTML = types.length
        ? types.map((type) => '<button class="categoryButton" data-type="' + escapeAttr(type) + '" aria-pressed="' + String(visibleTypes.has(type)) + '" title="' + (visibleTypes.has(type) ? '隐藏' : '显示') + eventTypeLabels[type] + '事件"><span class="categoryIcon">' + (visibleTypes.has(type) ? '◉' : '○') + '</span><span>' + escapeHtml(eventTypeLabels[type]) + '</span><span class="categoryCount">' + counts[type] + '</span></button>').join('')
        : '';
      $('eventCategories').querySelectorAll('.categoryButton').forEach((button) => button.addEventListener('click', () => {
        const type = button.dataset.type;
        if (!type) return;
        if (visibleTypes.has(type)) {
          visibleTypes.delete(type);
        } else {
          visibleTypes.add(type);
        }
        renderEventCategories();
        renderEventList();
        renderSvg();
      }));
    }

    function renderEventList() {
      if (!hasTimeline()) {
        $('events').innerHTML = '<div class="empty">还没有时间线。先点击“新建时间线”。</div>';
        return;
      }
      const events = [...draft.events]
        .filter((event) => visibleTypes.has(event.type || 'plot'))
        .sort((a, b) => a.start.sortValue - b.start.sortValue || a.title.localeCompare(b.title, 'zh-Hans-CN'));
      const groups = Object.keys(eventTypeLabels)
        .map((type) => ({ type, events: events.filter((event) => (event.type || 'plot') === type) }))
        .filter((group) => group.events.length > 0);
      $('events').innerHTML = groups.length
        ? groups.map((group) => '<div class="eventGroup"><div class="eventGroupTitle">' + escapeHtml(eventTypeLabels[group.type]) + '</div>' + group.events.map((event) => {
          const hidden = hiddenEventIds.has(event.id);
          return '<div class="eventItem ' + (event.id === selectedId ? 'active ' : '') + (hidden ? 'hiddenEvent' : '') + '" data-id="' + escapeAttr(event.id) + '"><button class="eventEye" data-id="' + escapeAttr(event.id) + '" title="' + (hidden ? '显示事件' : '隐藏事件') + '" aria-label="' + (hidden ? '显示事件' : '隐藏事件') + '">' + (hidden ? '○' : '◉') + '</button><div class="eventText"><strong>' + escapeHtml(event.title || '未命名事件') + conflictBadge(event) + '</strong><span>' + escapeHtml(event.start.label || '未填写日期') + ' · 排序 ' + escapeHtml(String(event.start.sortValue ?? 0)) + participantsSummary(event) + '</span></div></div>';
        }).join('') + '</div>').join('')
        : '<div class="empty">这条时间线还没有事件。</div>';
      $('events').querySelectorAll('.eventEye').forEach((button) => button.addEventListener('click', (event) => {
        toggleEventVisibility(button.dataset.id || '');
        event.preventDefault();
        event.stopPropagation();
      }));
      $('events').querySelectorAll('.eventItem').forEach((el) => el.addEventListener('click', () => {
        syncFromForm();
        selectedId = el.dataset.id || '';
        render();
      }));
    }

    function renderSvg() {
      const svg = $('timelineSvg');
      const events = svgEvents();
      if (!hasTimeline() || events.length === 0) {
        scaleContext = null;
        svg.setAttribute('viewBox', '0 0 980 720');
        svg.innerHTML = hasTimeline()
          ? '<text x="40" y="58" fill="#999" font-size="14">点击“新建事件”添加第一个事件。</text>'
          : '';
        return;
      }
      const lanes = visibleLanes(events);
      const values = events.flatMap((event) => [event.absoluteStartSortValue ?? event.start.sortValue, event.absoluteEndSortValue ?? event.end?.sortValue ?? event.absoluteStartSortValue ?? event.start.sortValue]);
      const min = Math.min(...values) - 10;
      const max = Math.max(...values) + 20;
      const left = 120;
      const top = 56;
      const laneHeight = 96;
      const width = Math.max(980, left + Math.max(1, max - min) * 16 + 120);
      const height = Math.max(720, top + lanes.length * laneHeight + 70);
      const scale = (value) => left + ((value - min) / Math.max(1, max - min)) * (width - left - 90);
      const unscale = (x) => min + ((x - left) / Math.max(1, width - left - 90)) * Math.max(1, max - min);
      scaleContext = { min, max, width, left, top, laneHeight, scale, unscale };
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      const ticks = makeTicks(min, max);
      svg.innerHTML = ticks.map((tick) => '<line class="tick" x1="' + scale(tick) + '" y1="24" x2="' + scale(tick) + '" y2="' + (top + lanes.length * laneHeight) + '"></line><text x="' + scale(tick) + '" y="18" fill="#777" font-size="11">' + tick + '</text>').join('');
      lanes.forEach((lane, laneIndex) => {
        const y = top + laneIndex * laneHeight;
        svg.insertAdjacentHTML('beforeend', '<text class="laneLabel" x="16" y="' + (y + 28) + '">' + escapeHtml(lane.title) + '</text><text class="laneSub" x="16" y="' + (y + 46) + '">' + escapeHtml(lane.type) + '</text><line class="laneLine" x1="0" y1="' + (y + laneHeight - 12) + '" x2="' + width + '" y2="' + (y + laneHeight - 12) + '"></line>');
        events.filter((event) => eventInLane(event, lane)).forEach((event, index) => {
          const x1 = scale(event.absoluteStartSortValue ?? event.start.sortValue);
          const x2 = scale(event.absoluteEndSortValue ?? event.end?.sortValue ?? (event.absoluteStartSortValue ?? event.start.sortValue) + 8);
          const w = Math.max(116, x2 - x1);
          const eventY = y + 18 + (index % 2) * 28;
          const color = event.color || typeColors[event.type] || typeColors.custom;
          const classes = ['eventBlock', event.id === selectedId ? 'selected' : '', conflictIdsFor(event.id).length ? 'conflicted' : '', event.locked || event.status === 'locked' ? 'locked' : '', event.isReference ? 'reference' : ''].join(' ');
          svg.insertAdjacentHTML('beforeend', '<g class="' + classes + '" data-id="' + escapeAttr(event.id) + '" data-timeline-id="' + escapeAttr(event.timelineId || '') + '" data-reference="' + String(Boolean(event.isReference)) + '"><rect x="' + x1 + '" y="' + eventY + '" width="' + w + '" height="40" fill="#171717" stroke="' + color + '"></rect><rect class="resizeHandle" data-id="' + escapeAttr(event.id) + '" data-edge="end" x="' + (x1 + w - 16) + '" y="' + eventY + '" width="16" height="40" fill="rgba(61,214,198,.16)"></rect><line x1="' + (x1 + w - 6) + '" y1="' + (eventY + 8) + '" x2="' + (x1 + w - 6) + '" y2="' + (eventY + 32) + '" stroke="' + color + '" stroke-width="2"></line><text x="' + (x1 + 8) + '" y="' + (eventY + 17) + '" font-size="12">' + escapeHtml(short(event.title || '未命名事件', 18)) + '</text><text x="' + (x1 + 8) + '" y="' + (eventY + 33) + '" font-size="11" fill="#999">' + escapeHtml(short((event.isReference ? event.timelineTitle + ' / ' : '') + (event.start.label || '排序 ' + event.start.sortValue), 26)) + '</text></g>');
        });
      });
      svg.querySelectorAll('.eventBlock').forEach((el) => {
        el.addEventListener('pointerdown', (event) => {
          if (event.target?.classList?.contains('resizeHandle')) return;
          startDrag(event, el.dataset.id, 'move', el);
        });
        el.addEventListener('click', (event) => {
          const ref = el.dataset.reference === 'true';
          if (ref && el.dataset.timelineId) {
            postWithCurrent({ command:'switchTimeline', timelineId: el.dataset.timelineId });
          } else {
            syncFromForm();
            selectedId = el.dataset.id || '';
            render();
          }
          event.stopPropagation();
        });
      });
      svg.querySelectorAll('.resizeHandle').forEach((el) => {
        el.addEventListener('pointerdown', (event) => startDrag(event, el.dataset.id, 'resize', el));
      });
    }

    function renderInspector() {
      const event = selectedEvent();
      $('emptyInspector').hidden = Boolean(event);
      $('eventInspector').hidden = !event;
      if (!event) {
        return;
      }
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

    function renderManager() {
      const metas = timelineMetas();
      $('timelineTree').innerHTML = metas.length
        ? metas.map((timeline) => '<div class="timelineNode ' + (timeline.id === draft?.id ? 'active' : '') + '" style="--depth:' + timelineDepth(timeline) + '" data-id="' + escapeAttr(timeline.id) + '"><strong>' + escapeHtml(timeline.title) + '</strong><span>' + escapeHtml(timeline.calendarName || '自由日历') + ' · ' + timeline.eventCount + ' 个事件</span></div>').join('')
        : '<div class="empty">暂无时间线</div>';
      $('timelineTree').querySelectorAll('.timelineNode').forEach((el) => el.addEventListener('click', () => postWithCurrent({ command:'switchTimeline', timelineId: el.dataset.id || '' })));
      $('timelineTitle').value = draft?.title || '';
      $('calendarName').value = draft?.calendar?.calendarName || '';
      $('showReferenceEvents').checked = showReferences;
      $('deleteTimeline').disabled = !hasTimeline();
      $('syncOrigin').disabled = !hasTimeline() || !draft?.origin;
      renderParentOptions();
      renderReferenceList();
      renderOriginSummary();
      renderConflicts();
    }

    function renderParentOptions() {
      const options = timelineMetas().filter((timeline) => timeline.id !== draft?.id);
      $('parentTimelineId').innerHTML = options.length
        ? '<option value="">选择父时间线</option>' + options.map((timeline) => '<option value="' + escapeAttr(timeline.id) + '">' + escapeHtml(timeline.title) + '</option>').join('')
        : '<option value="">没有可选父时间线</option>';
      renderOriginEventOptions();
    }

    function renderOriginEventOptions() {
      const parentId = $('parentTimelineId').value;
      const selectedOriginId = $('originEventId').value;
      const options = state.timelineEventOptions.filter((event) => event.timelineId === parentId);
      $('originEventId').innerHTML = options.length
        ? '<option value="">选择起点事件</option>' + options.map((event) => '<option value="' + escapeAttr(event.eventId) + '">' + escapeHtml(event.title) + ' · ' + event.sortValue + '</option>').join('')
        : '<option value="">父时间线暂无事件</option>';
      if (selectedOriginId && options.some((event) => event.eventId === selectedOriginId)) {
        $('originEventId').value = selectedOriginId;
      }
      const canCreate = Boolean(parentId && options.some((event) => event.eventId === $('originEventId').value));
      $('newChildTimeline').disabled = !canCreate;
      $('reanchorTimeline').disabled = !hasTimeline() || !canCreate;
      $('childTimelineHint').textContent = parentId && options.length === 0 ? '父时间线至少需要一个事件作为起点。' : '';
    }

    function renderReferenceList() {
      const refs = referenceEvents();
      $('referenceEvents').innerHTML = refs.length
        ? refs.map((event) => '<div class="referenceItem" data-timeline-id="' + escapeAttr(event.timelineId) + '"><strong>' + escapeHtml(event.title) + '</strong><span>' + escapeHtml(event.timelineTitle) + ' · 绝对 ' + escapeHtml(String(event.absoluteStartSortValue)) + '</span></div>').join('')
        : '<div class="empty">暂无祖先参考</div>';
      $('referenceEvents').querySelectorAll('.referenceItem').forEach((el) => el.addEventListener('click', () => postWithCurrent({ command:'switchTimeline', timelineId: el.dataset.timelineId || '' })));
    }

    function renderOriginSummary() {
      const status = state.originStatus || { status:'root', message:'根时间线' };
      const lines = [status.message];
      if (status.parentTimelineTitle) lines.push('父时间线：' + status.parentTimelineTitle);
      if (status.parentEventTitle) lines.push('起点事件：' + status.parentEventTitle);
      if (status.currentParentSortValue !== undefined) lines.push('父级排序值：' + status.currentParentSortValue);
      $('originSummary').innerHTML = lines.map(escapeHtml).join('<br>');
    }

    function renderConflicts() {
      $('conflicts').innerHTML = state.conflicts.length
        ? state.conflicts.map((conflict) => '<div class="conflictItem" data-id="' + escapeAttr(conflict.eventIds[0] || '') + '"><strong>' + escapeHtml(conflict.title) + '</strong><span>' + escapeHtml(conflict.detail) + '</span></div>').join('')
        : '<div class="empty">暂无健康提示</div>';
    }

    function syncFromForm() {
      if (!hasTimeline()) return;
      if ($('timelineTitle')) draft.title = $('timelineTitle').value || draft.title || '新时间线';
      if ($('calendarName')) draft.calendar = { ...(draft.calendar || {}), calendarName: $('calendarName').value || draft.calendar?.calendarName || '自由日历' };
      const event = selectedEvent();
      if (!event || $('eventInspector').hidden) {
        rebuildViewFromDraft();
        return;
      }
      event.title = $('title').value || '未命名事件';
      event.summary = $('summaryText').value;
      event.type = $('eventType').value;
      event.laneType = $('laneType').value;
      event.importance = $('importance').value;
      event.status = $('status').value;
      event.start = { ...event.start, label: $('startLabel').value, sortValue: Number($('startSort').value || 0) };
      event.end = $('endLabel').value || $('endSort').value
        ? { ...(event.end || event.start), label: $('endLabel').value, sortValue: Number($('endSort').value || $('startSort').value || 0) }
        : undefined;
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
      rebuildViewFromDraft();
    }

    function rebuildViewFromDraft() {
      if (!draft) {
        state.document = undefined;
        state.hasTimeline = false;
        state.events = referenceEvents();
        return;
      }
      const refs = referenceEvents();
      const offset = state.activeTimelineOffset || 0;
      const current = draft.events.map((event) => {
        const previous = state.events.find((candidate) => candidate.id === event.id);
        return {
          ...event,
          timelineId: draft.id,
          timelineTitle: draft.title,
          absoluteStartSortValue: offset + event.start.sortValue,
          absoluteEndSortValue: event.end ? offset + event.end.sortValue : undefined,
          isReference: false,
          resolvedLocation: previous?.resolvedLocation,
          resolvedParticipants: previous?.resolvedParticipants || event.participants || [],
          resolvedChapter: previous?.resolvedChapter,
          resolvedScene: previous?.resolvedScene,
          resolvedBeat: previous?.resolvedBeat,
          conflictIds: previous?.conflictIds || []
        };
      });
      state.document = draft;
      state.hasTimeline = true;
      state.activeTimelineId = draft.id;
      state.events = [...refs, ...current];
    }

    function startDrag(pointerEvent, id, mode, element) {
      const event = draft?.events.find((item) => item.id === id);
      if (!event || event.locked || event.status === 'locked' || element.dataset.reference === 'true') return;
      syncFromForm();
      selectedId = id;
      dragging = { id, mode, startX: pointerEvent.clientX, originalStart: event.start.sortValue, originalEnd: event.end?.sortValue };
      element.setPointerCapture?.(pointerEvent.pointerId);
      document.addEventListener('pointermove', onDrag);
      document.addEventListener('pointerup', endDrag);
      pointerEvent.preventDefault();
      pointerEvent.stopPropagation();
    }

    function onDrag(pointerEvent) {
      if (!dragging || !scaleContext || !draft) return;
      const event = draft.events.find((item) => item.id === dragging.id);
      if (!event) return;
      const delta = scaleContext.unscale(scaleContext.left + pointerEvent.clientX - dragging.startX) - scaleContext.unscale(scaleContext.left);
      if (dragging.mode === 'resize') {
        event.end = { ...(event.end || event.start), sortValue: Math.max(event.start.sortValue, Math.round((dragging.originalEnd ?? event.start.sortValue + 8) + delta)) };
      } else {
        event.start.sortValue = Math.round(dragging.originalStart + delta);
        if (event.end && dragging.originalEnd !== undefined) event.end.sortValue = Math.round(dragging.originalEnd + delta);
      }
      rebuildViewFromDraft();
      renderEventList();
      renderSvg();
      renderInspector();
    }

    function endDrag() {
      document.removeEventListener('pointermove', onDrag);
      document.removeEventListener('pointerup', endDrag);
      dragging = null;
      if (draft) {
        vscode.postMessage({ command:'saveDocument', document: draft, selectedEventId: selectedId, hiddenEventIds: [...hiddenEventIds] });
      }
    }

    function svgEvents() {
      const refs = showReferences ? referenceEvents() : [];
      return [...refs, ...currentEvents()].filter((event) => event.isReference || visibleTypes.has(event.type || 'plot'));
    }

    function visibleLanes(events) {
      return buildLanesFromEvents(events).filter((lane) => lane.type === 'world' || lane.type === 'plot' || events.some((event) => eventInLane(event, lane)));
    }

    function eventInLane(event, lane) {
      if (lane.id === 'world') return event.laneType === 'world' || event.type === 'world';
      if (lane.id === 'plot') return event.laneType === 'plot' || (!event.participantIds?.length && !event.locationId && event.type !== 'world');
      if (lane.type === 'character') return (event.participantIds || []).includes(lane.refId);
      if (lane.type === 'custom-character') return !(event.participantIds || []).length && (event.participants || []).includes(lane.refName);
      if (lane.type === 'location') return event.locationId === lane.refId;
      if (lane.type === 'chapter') return event.chapterId === lane.refId;
      return false;
    }

    function buildLanesFromEvents(events) {
      const lanes = [
        { id:'world', type:'world', title:'世界线' },
        { id:'plot', type:'plot', title:'剧情线' }
      ];
      const seen = new Set(lanes.map((lane) => lane.id));
      for (const event of events) {
        for (const id of event.participantIds || []) {
          const laneId = 'character:' + id;
          if (!seen.has(laneId)) {
            seen.add(laneId);
            lanes.push({ id: laneId, type:'character', refId: id, title: characterName(id) });
          }
        }
        if (!(event.participantIds || []).length) {
          for (const name of event.participants || []) {
            const laneId = 'character-name:' + name;
            if (!seen.has(laneId)) {
              seen.add(laneId);
              lanes.push({ id: laneId, type:'custom-character', refName: name, title: name });
            }
          }
        }
        if (event.locationId) {
          const laneId = 'location:' + event.locationId;
          if (!seen.has(laneId)) {
            seen.add(laneId);
            lanes.push({ id: laneId, type:'location', refId: event.locationId, title: locationName(event.locationId) });
          }
        }
        if (event.chapterId) {
          const laneId = 'chapter:' + event.chapterId;
          if (!seen.has(laneId)) {
            seen.add(laneId);
            lanes.push({ id: laneId, type:'chapter', refId: event.chapterId, title: chapterTitle(event.chapterId) });
          }
        }
      }
      return lanes;
    }

    function postWithCurrent(message) {
      syncFromForm();
      if (draft) message.currentDocument = draft;
      message.selectedEventId = selectedId;
      message.hiddenEventIds = [...hiddenEventIds];
      vscode.postMessage(message);
    }

    function openCreateTimelineDialog() {
      $('createTimelineDialog').hidden = false;
      $('newTimelineTitle').focus();
    }

    function closeCreateTimelineDialog() {
      $('createTimelineDialog').hidden = true;
    }

    function openManager() {
      renderManager();
      $('managerModal').hidden = false;
    }

    function closeManager() {
      $('managerModal').hidden = true;
    }

    function createRootTimeline() {
      postWithCurrent({
        command:'createRootTimeline',
        title: $('newTimelineTitle').value || '新时间线',
        calendarName: $('newTimelineCalendar').value
      });
    }

    function createChildTimeline() {
      const parentTimelineId = $('parentTimelineId').value;
      const originEventId = $('originEventId').value;
      if (!parentTimelineId || !originEventId) return;
      postWithCurrent({
        command:'createChildTimeline',
        title: $('newChildTimelineTitle').value || '子时间线',
        calendarName: $('newChildTimelineCalendar').value,
        parentTimelineId,
        originEventId
      });
    }

    function saveCurrent() {
      syncFromForm();
      vscode.postMessage({ command:'saveDocument', document: draft, selectedEventId: selectedId, hiddenEventIds: [...hiddenEventIds] });
    }

    function timelineDepth(meta) {
      let depth = 0;
      let current = meta;
      const seen = new Set();
      while (current?.parentId && !seen.has(current.id)) {
        seen.add(current.id);
        depth += 1;
        current = timelineMetas().find((item) => item.id === current.parentId);
      }
      return depth;
    }

    function conflictBadge(event) { return conflictIdsFor(event.id).length ? '<span class="pill">提示</span>' : ''; }
    function toggleEventVisibility(id) {
      if (!id) return;
      if (hiddenEventIds.has(id)) {
        hiddenEventIds.delete(id);
      } else {
        hiddenEventIds.add(id);
      }
      renderEventList();
      renderSvg();
    }
    function participantsSummary(event) {
      const names = (event.participantIds || []).map(characterName).concat((event.participantIds || []).length ? [] : (event.participants || []));
      return names.length ? ' · ' + names.slice(0, 3).map((name) => escapeHtml(name)).join('、') + (names.length > 3 ? ' 等 ' + names.length + ' 人' : '') : '';
    }
    function characterName(id) { return state.characters.find((item) => item.id === id)?.name || id; }
    function locationName(id) { return state.locations.find((item) => item.id === id)?.name || id; }
    function chapterTitle(id) { return state.chapters.find((item) => item.id === id)?.title || id; }
    function setMulti(id, values) { [...$(id).querySelectorAll('input[type="checkbox"]')].forEach((input) => input.checked = values.includes(input.value)); }
    function getMulti(id) { return [...$(id).querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value).filter(Boolean); }
    function makeTicks(min, max) { const step = Math.max(10, Math.ceil((max - min) / 9 / 10) * 10); const ticks = []; for (let value = Math.floor(min / step) * step; value <= max + step; value += step) ticks.push(value); return ticks; }
    function short(value, length) { return Array.from(value || '').slice(0, length).join(''); }
    function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char])); }
    function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }

    $('openCreateTimeline').addEventListener('click', openCreateTimelineDialog);
    $('emptyCreateTimeline').addEventListener('click', openCreateTimelineDialog);
    $('closeCreateTimeline').addEventListener('click', closeCreateTimelineDialog);
    $('newRootTimeline').addEventListener('click', createRootTimeline);
    $('openTimelineManager').addEventListener('click', openManager);
    $('closeTimelineManager').addEventListener('click', closeManager);
    $('timelineSelect').addEventListener('input', () => postWithCurrent({ command:'switchTimeline', timelineId: $('timelineSelect').value }));
    $('newEvent').addEventListener('click', () => postWithCurrent({ command:'createEvent' }));
    $('save').addEventListener('click', saveCurrent);
    $('refresh').addEventListener('click', () => vscode.postMessage({ command:'refresh' }));
    $('duplicate').addEventListener('click', () => { if (selectedEvent()) postWithCurrent({ command:'duplicateEvent', timelineId: draft.id, eventId: selectedId }); });
    $('deleteEvent').addEventListener('click', () => { if (selectedEvent()) postWithCurrent({ command:'deleteEvent', timelineId: draft.id, eventId: selectedId }); });
    $('saveTimelineMeta').addEventListener('click', saveCurrent);
    $('deleteTimeline').addEventListener('click', () => { if (draft) postWithCurrent({ command:'deleteTimeline', timelineId: draft.id }); });
    $('newChildTimeline').addEventListener('click', createChildTimeline);
    $('parentTimelineId').addEventListener('input', renderOriginEventOptions);
    $('originEventId').addEventListener('input', renderOriginEventOptions);
    $('reanchorTimeline').addEventListener('click', () => {
      const parentTimelineId = $('parentTimelineId').value;
      const originEventId = $('originEventId').value;
      if (draft && parentTimelineId && originEventId) postWithCurrent({ command:'reanchorTimeline', timelineId: draft.id, parentTimelineId, originEventId });
    });
    $('syncOrigin').addEventListener('click', () => { if (draft) postWithCurrent({ command:'syncTimelineOrigin', timelineId: draft.id }); });
    $('showReferenceEvents').addEventListener('input', () => { showReferences = $('showReferenceEvents').checked; renderSvg(); });
    ['title','summaryText','eventType','laneType','importance','status','startLabel','startSort','endLabel','endSort','color','locked','participantIds','locationId','chapterId','sceneId','beatId','result','notes','visibility'].forEach((id) => {
      $(id).addEventListener('input', () => { syncFromForm(); renderEventList(); renderSvg(); });
    });
    ['timelineTitle','calendarName'].forEach((id) => {
      $(id).addEventListener('input', () => { syncFromForm(); renderTopbar(); renderManager(); });
    });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { saveCurrent(); event.preventDefault(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { $('duplicate').click(); event.preventDefault(); }
      if (event.key === 'Delete' && selectedId) { $('deleteEvent').click(); event.preventDefault(); }
      if (event.key === 'Escape') { closeCreateTimelineDialog(); closeManager(); }
    });

    rebuildViewFromDraft();
    render();
  </script>
</body>
</html>`;
}

function selectField(id: string, label: string, options: Array<{ id: string; name?: string; title?: string }>): string {
  return `<div class="field"><label>${escapeHtml(label)}</label><select id="${id}"><option value="">未绑定</option>${options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name || option.title || option.id)}</option>`).join('')}</select></div>`;
}

function checkboxGroupField(id: string, label: string, options: Array<{ id: string; name?: string; title?: string }>): string {
  const body = options.length
    ? options.map((option) => {
      const name = option.name || option.title || option.id;
      return `<label class="checkboxItem"><input type="checkbox" value="${escapeHtml(option.id)}"><span title="${escapeHtml(name)}">${escapeHtml(name)}</span></label>`;
    }).join('')
    : '<div class="empty">暂无可选人物</div>';
  return `<div class="field"><label>${escapeHtml(label)}</label><div id="${id}" class="checkboxGroup">${body}</div></div>`;
}

function eventTypeOptions(selected = 'plot'): string {
  const labels: Record<TimelineEventType | 'all', string> = {
    all: '全部类型',
    world: '世界事件',
    plot: '剧情事件',
    character: '人物事件',
    location: '地点事件',
    relationship: '关系事件',
    custom: '自定义'
  };
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
