import * as vscode from 'vscode';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export interface CreativeAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CreativeProjectDraft {
  title?: string;
  author?: string;
  genre?: string;
  language?: string;
  defaultStyle?: string;
  premise?: string;
}

export interface CreativeWorldRuleDraft {
  name: string;
  content: string;
  importance?: 'normal' | 'important' | 'absolute';
  category?: string;
  rules?: string[];
  scope?: string[];
  relatedCharacters?: string[];
  relatedLocations?: string[];
  relatedFactions?: string[];
  knownExceptions?: string[];
  hidden?: boolean;
  sourceRefs?: CreativeSourceRefDraft[];
  tags?: string[];
}

export interface CreativeSourceRefDraft {
  kind: string;
  id?: string;
  name?: string;
  reason?: string;
}

export interface CreativeRelationshipDraft {
  character: string;
  target: string;
  type?: string;
  status?: string;
  description: string;
  reason?: string;
  knownBy?: string[];
}

export interface CreativeInferenceDraft {
  subject: string;
  field: string;
  value: string;
  basis?: string[];
  confidence?: 'low' | 'medium' | 'high';
  targetKind?: 'character' | 'location' | 'world-rule' | 'timeline-event';
  targetName?: string;
  sourceRefs?: CreativeSourceRefDraft[];
}

export interface CreativeConflictDraft {
  severity?: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  suggestedFix?: string;
  sourceRefs?: CreativeSourceRefDraft[];
}

export interface CreativeQuestionDraft {
  question: string;
  why?: string;
  blocks?: string[];
}

export interface CreativeCharacterDraft {
  name: string;
  identity?: string;
  fixedSetting?: string;
  personality?: string;
  speechStyle?: string;
  goals?: string;
  abilities?: string;
  weaknesses?: string;
  currentState?: string;
  secrets?: string;
  hiddenSecrets?: string;
  relationships?: CreativeRelationshipDraft[];
  knows?: string[];
  doesNotKnow?: string[];
  sourceRefs?: CreativeSourceRefDraft[];
  tags?: string[];
}

export interface CreativeLocationDraft {
  name: string;
  type?: string;
  region?: string;
  visualFeatures?: string;
  atmosphere?: string;
  history?: string;
  rules?: string;
  currentState?: string;
  secrets?: string;
  hiddenSecrets?: string;
  relatedCharacters?: string[];
  relatedEvents?: string[];
  sourceRefs?: CreativeSourceRefDraft[];
  tags?: string[];
}

export interface CreativeTimelineEventDraft {
  name: string;
  sequence?: number;
  storyTime?: string;
  chapterId?: string;
  location?: string;
  participants?: string[];
  causes?: string[];
  consequences?: string[];
  knownBy?: string[];
  unknownBy?: string[];
  result?: string;
  visibility?: 'reader-unknown' | 'character-unknown' | 'public';
  tags?: string[];
  sourceRefs?: CreativeSourceRefDraft[];
}

export interface CreativeOutlineDraft {
  title: string;
  summary?: string;
  purpose?: string;
  viewpointCharacter?: string;
  location?: string;
  conflict?: string;
  outcome?: string;
  beats?: string[];
  tags?: string[];
}

export interface CreativeAssistantDraft {
  project?: CreativeProjectDraft;
  styleGuide?: string;
  worldRules?: CreativeWorldRuleDraft[];
  characters?: CreativeCharacterDraft[];
  locations?: CreativeLocationDraft[];
  timelineEvents?: CreativeTimelineEventDraft[];
  relationships?: CreativeRelationshipDraft[];
  references?: CreativeSourceRefDraft[];
  inferences?: CreativeInferenceDraft[];
  conflicts?: CreativeConflictDraft[];
  questions?: CreativeQuestionDraft[];
  outline?: CreativeOutlineDraft[];
  notes?: string[];
}

export interface CreativeAssistantState {
  threadId?: string;
  threadTitle?: string;
  workspaceName: string;
  projectTitle: string;
  messages: CreativeAssistantMessage[];
  draft?: CreativeAssistantDraft;
  busy: boolean;
  status?: string;
  error?: string;
}

export type CreativeAssistantAction =
  | { command: 'send'; text: string }
  | { command: 'apply-all' }
  | { command: 'apply-project' }
  | { command: 'apply-style' }
  | { command: 'apply-codex' }
  | { command: 'apply-plan' }
  | { command: 'discard-draft' };

export function showCreativeAssistantPanel(
  context: vscode.ExtensionContext,
  state: CreativeAssistantState,
  onAction: (action: CreativeAssistantAction, update: (nextState: CreativeAssistantState) => void) => Promise<CreativeAssistantState>
): void {
  const panel = vscode.window.createWebviewPanel('loredock.creativeAssistant', 'LoreDock 创作助手', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = (nextState: CreativeAssistantState) => {
    state = nextState;
    panel.webview.html = renderCreativeAssistantPanel(state);
  };

  render(state);
  panel.webview.onDidReceiveMessage(async (action: CreativeAssistantAction) => {
    try {
      const nextState = await onAction(action, render);
      render(nextState);
    } catch (error) {
      render({
        ...state,
        busy: false,
        status: undefined,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, undefined, context.subscriptions);
}

function renderCreativeAssistantPanel(state: CreativeAssistantState): string {
  const scriptNonce = nonce();
  const visibleMessages: CreativeAssistantMessage[] = state.busy
    ? [...state.messages, { role: 'assistant', content: '正在思考并整理设定' }]
    : state.messages;
  const messages = visibleMessages.map(renderMessage).join('\n');
  const draft = state.draft;
  const draftStats = renderDraftStats(draft);
  const promptChips = renderPromptChips();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 创作助手</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h1 { font-size: 17px; margin: 0; font-weight: 650; }
    .subtle { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .layout { display: grid; grid-template-columns: minmax(330px, 0.9fr) minmax(380px, 1.1fr); min-height: calc(100vh - 54px); }
    .chat, .draft { min-width: 0; display: grid; grid-template-rows: auto 1fr auto; }
    .chat { border-right: 1px solid var(--vscode-panel-border); }
    .section-title { padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .section-title strong { color: var(--vscode-foreground); font-size: 13px; }
    .messages { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    .message { border-left: 3px solid var(--vscode-panel-border); padding: 8px 11px; line-height: 1.55; white-space: pre-wrap; border-radius: 0 5px 5px 0; }
    .message.user { border-color: var(--vscode-textLink-foreground); background: var(--vscode-input-background); }
    .message.assistant { border-color: var(--vscode-testing-iconPassed); }
    .message.pending { opacity: 0.82; }
    .message.pending::after { content: ''; display: inline-block; width: 1.2em; animation: dots 1.2s steps(4, end) infinite; }
    @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75%, 100% { content: '...'; } }
    .message .role { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 4px; }
    .composer { border-top: 1px solid var(--vscode-panel-border); padding: 12px 16px; display: grid; gap: 8px; }
    textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 86px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 5px; padding: 9px 10px; font: inherit; line-height: 1.5; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 5px 7px; border-radius: 999px; font-size: 12px; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 7px 10px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .draft-body { padding: 14px 16px 88px; overflow: auto; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
    .stat { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 9px; background: var(--vscode-sideBar-background); }
    .stat b { display: block; font-size: 16px; margin-bottom: 2px; }
    .stat span { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .group { margin-bottom: 18px; }
    .group h2 { font-size: 13px; margin: 0 0 8px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 8px; }
    .badge { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .kv { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; padding: 5px 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border), transparent 45%); }
    .key { color: var(--vscode-descriptionForeground); }
    .value { white-space: pre-wrap; overflow-wrap: anywhere; }
    .item { border-left: 3px solid var(--vscode-panel-border); padding: 7px 10px; margin: 8px 0; background: var(--vscode-sideBar-background); }
    .item strong { display: block; margin-bottom: 4px; }
    .empty { color: var(--vscode-descriptionForeground); line-height: 1.6; padding: 12px 0; }
    .bar { position: sticky; bottom: 0; padding: 12px 16px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .error { color: var(--vscode-errorForeground); }
    .ok { color: var(--vscode-testing-iconPassed); }
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; }
      .chat { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); min-height: 460px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>LoreDock 创作助手</h1>
      <div class="subtle">${escapeHtml(state.workspaceName)} · ${escapeHtml(state.projectTitle)}</div>
    </div>
    <div class="${state.error ? 'error' : 'ok'}">${escapeHtml(state.error || state.status || (state.busy ? 'AI 正在整理设定...' : ''))}</div>
  </header>
  <main class="layout">
    <section class="chat">
      <div class="section-title"><strong>Workshop Chat</strong><span>Enter 发送 · Shift+Enter 换行</span></div>
      <div class="messages" id="messages">${messages}</div>
      <div class="composer">
        <div class="chips">${promptChips}</div>
        <textarea id="input" ${state.busy ? 'disabled' : ''} placeholder="例如：我想写一个赛博修仙长篇，主角是失忆维修工，世界偏黑暗，第一卷围绕城市阵法展开。"></textarea>
        <div class="actions">
          <button id="send" ${state.busy ? 'disabled' : ''}>${state.busy ? '思考中...' : '发送并整理设定'}</button>
          <span id="localStatus" class="subtle">${state.busy ? '已发送，AI 正在思考。' : 'AI 会先生成草稿，应用前不会改项目文件。'}</span>
        </div>
      </div>
    </section>
    <section class="draft">
      <div class="section-title"><strong>Codex Memory</strong><span>确认后才写入本地文件</span></div>
      <div class="draft-body">${draftStats}${renderDraft(draft)}</div>
      <div class="bar">
        <div class="actions">
          <button data-command="apply-all" ${!draft || state.busy ? 'disabled' : ''}>应用全部</button>
          <button class="secondary" data-command="apply-project" ${!draft?.project || state.busy ? 'disabled' : ''}>应用项目</button>
          <button class="secondary" data-command="apply-style" ${!draft?.styleGuide || state.busy ? 'disabled' : ''}>应用文风</button>
          <button class="secondary" data-command="apply-codex" ${!hasCodexDraft(draft) || state.busy ? 'disabled' : ''}>应用资料库/记忆</button>
          <button class="secondary" data-command="apply-plan" ${!hasPlanDraft(draft) || state.busy ? 'disabled' : ''}>应用规划</button>
        </div>
        <button class="secondary" data-command="discard-draft" ${!draft || state.busy ? 'disabled' : ''}>清空草稿</button>
      </div>
    </section>
  </main>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const messages = document.getElementById('messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    if (input && !input.disabled) input.focus();
    if (send) {
      send.addEventListener('click', () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        input.disabled = true;
        send.disabled = true;
        send.textContent = '思考中...';
        const localStatus = document.getElementById('localStatus');
        if (localStatus) localStatus.textContent = '已发送，AI 正在思考。';
        if (messages) {
          messages.insertAdjacentHTML('beforeend', '<div class="message user"><span class="role">你</span>' + escapeForHtml(text) + '</div><div class="message assistant pending"><span class="role">LoreDock AI</span>正在思考并整理设定</div>');
          messages.scrollTop = messages.scrollHeight;
        }
        vscode.postMessage({ command: 'send', text });
      });
    }
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send?.click();
        }
      });
    }
    document.querySelectorAll('[data-prompt]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!input || input.disabled) return;
        input.value = button.dataset.prompt || '';
        input.focus();
      });
    });
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
    function escapeForHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
}

function renderMessage(message: CreativeAssistantMessage): string {
  const role = message.role === 'user' ? '你' : 'LoreDock AI';
  const pending = message.role === 'assistant' && message.content.includes('正在思考');
  return `<div class="message ${message.role}${pending ? ' pending' : ''}"><span class="role">${role}</span>${escapeHtml(message.content)}</div>`;
}

function renderDraft(draft: CreativeAssistantDraft | undefined): string {
  if (!draft) {
    return `<div class="empty">还没有设定草稿。先在左边和 AI 聊你的小说方向，右边会自动沉淀标题、文风、人物、地点和世界规则。</div>`;
  }
  const parts = [
    renderProjectDraft(draft.project),
    renderTextGroup('文风指南', draft.styleGuide),
    renderItems('世界规则', draft.worldRules, (item) => [
      item.category ? `类别：${item.category}` : '',
      item.content,
      item.rules?.length ? `规则条目：\n${item.rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}` : '',
      item.scope?.length ? `适用范围：${item.scope.join('、')}` : '',
      item.relatedCharacters?.length ? `相关人物：${item.relatedCharacters.join('、')}` : '',
      item.relatedLocations?.length ? `相关地点：${item.relatedLocations.join('、')}` : '',
      item.relatedFactions?.length ? `相关组织/国家：${item.relatedFactions.join('、')}` : '',
      item.knownExceptions?.length ? `已知例外：${item.knownExceptions.join('；')}` : '',
      item.importance ? `重要性：${item.importance}` : '',
      item.hidden ? '隐藏规则' : ''
    ]),
    renderItems('人物', draft.characters, (item) => [
      item.identity,
      item.fixedSetting,
      item.personality,
      item.goals,
      item.currentState,
      item.relationships?.length ? `关系：\n${item.relationships.map(formatRelationshipDraft).join('\n')}` : '',
      item.knows?.length ? `已知信息：${item.knows.join('；')}` : '',
      item.doesNotKnow?.length ? `未知信息：${item.doesNotKnow.join('；')}` : '',
      item.hiddenSecrets ? `隐藏秘密：${item.hiddenSecrets}` : ''
    ]),
    renderItems('地点', draft.locations, (item) => [
      item.type,
      item.region,
      item.visualFeatures,
      item.atmosphere,
      item.rules,
      item.currentState,
      item.relatedCharacters?.length ? `相关人物：${item.relatedCharacters.join('、')}` : '',
      item.relatedEvents?.length ? `相关事件：${item.relatedEvents.join('、')}` : ''
    ]),
    renderItems('时间线事件', draft.timelineEvents, (item) => [
      item.sequence ? `顺序：${item.sequence}` : '',
      item.storyTime ? `故事时间：${item.storyTime}` : '',
      item.location ? `地点：${item.location}` : '',
      item.participants?.length ? `参与人物：${item.participants.join('、')}` : '',
      item.causes?.length ? `原因：${item.causes.join('；')}` : '',
      item.consequences?.length ? `后果：${item.consequences.join('；')}` : '',
      item.knownBy?.length ? `知情者：${item.knownBy.join('、')}` : '',
      item.unknownBy?.length ? `不知情者：${item.unknownBy.join('、')}` : '',
      item.result ? `结果：${item.result}` : ''
    ]),
    renderRelationships(draft.relationships),
    renderReferences(draft.references),
    renderInferences(draft.inferences),
    renderConflicts(draft.conflicts),
    renderQuestions(draft.questions),
    renderOutlineItems(draft.outline),
    renderListGroup('备注', draft.notes)
  ].filter(Boolean);
  return parts.join('\n') || `<div class="empty">AI 已回复，但暂时没有可应用的结构化草稿。</div>`;
}

function renderDraftStats(draft: CreativeAssistantDraft | undefined): string {
  const projectCount = draft?.project ? Object.values(draft.project).filter(Boolean).length : 0;
  const codexCount = (draft?.characters?.length ?? 0) + (draft?.locations?.length ?? 0) + (draft?.worldRules?.length ?? 0) + (draft?.timelineEvents?.length ?? 0);
  const planCount = draft?.outline?.length ?? 0;
  const noteCount = (draft?.notes?.length ?? 0) + (draft?.inferences?.length ?? 0) + (draft?.conflicts?.length ?? 0) + (draft?.questions?.length ?? 0);
  return `<div class="stats">
    <div class="stat"><b>${projectCount}</b><span>项目字段</span></div>
    <div class="stat"><b>${codexCount}</b><span>资料卡</span></div>
    <div class="stat"><b>${planCount}</b><span>规划条目</span></div>
    <div class="stat"><b>${noteCount}</b><span>推测/问题</span></div>
  </div>`;
}

function renderPromptChips(): string {
  const prompts = [
    ['从零构建', '我们从零开始构建这本小说。不要限制总共要问几个问题；请像访谈一样每轮只问我一个当前最关键的问题，等我回答后再问下一个。每次都根据已有信息更新标题、题材、核心冲突、文风、人物、地点和世界规则草稿。'],
    ['深化主角', '帮我深化主角：身份、欲望、恐惧、缺陷、秘密、说话习惯、能力边界，以及第一卷里的变化弧线。'],
    ['提取资料库', '请把我们刚才聊到的内容提取成可写入资料库的角色、地点、世界规则、时间线事件、人物关系和 AI 推测。每条推测都要写明依据，不要把推测当正史。'],
    ['第一卷规划', '请基于当前设定生成第一卷规划：章节/场景标题、每场的目的、冲突、转折、结果和 3-5 个 beats。'],
    ['追问漏洞', '请像严厉编辑一样检查当前设定缺口，只问会影响长篇连载一致性的关键问题，并标出潜在矛盾、相关来源和需要我确认的点。']
  ];
  return prompts
    .map(([label, prompt]) => `<button class="chip" data-prompt="${escapeHtml(prompt)}" type="button">${escapeHtml(label)}</button>`)
    .join('');
}

function renderProjectDraft(project: CreativeProjectDraft | undefined): string {
  if (!project) {
    return '';
  }
  const rows = [
    ['标题', project.title],
    ['作者', project.author],
    ['类型', project.genre],
    ['语言', project.language],
    ['基调', project.defaultStyle],
    ['一句话', project.premise]
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `<div class="kv"><div class="key">${escapeHtml(key || '')}</div><div class="value">${escapeHtml(value || '')}</div></div>`)
    .join('');
  return rows ? `<div class="group"><h2>项目</h2>${rows}</div>` : '';
}

function renderTextGroup(title: string, value: string | undefined): string {
  return value ? `<div class="group"><h2>${escapeHtml(title)}</h2><div class="item">${escapeHtml(value)}</div></div>` : '';
}

function renderListGroup(title: string, values: string[] | undefined): string {
  const items = (values ?? []).filter(Boolean);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>${escapeHtml(title)}</h2>${items.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join('')}</div>`;
}

function renderItems<T extends { name: string }>(title: string, values: T[] | undefined, linesForItem: (item: T) => Array<string | undefined>): string {
  const items = (values ?? []).filter((item) => item?.name);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>${escapeHtml(title)} <span class="badge">${items.length}</span></h2>${items
    .map((item) => {
      const body = linesForItem(item).filter(Boolean).join('\n');
      return `<div class="item"><strong>${escapeHtml(item.name)}</strong>${escapeHtml(body)}</div>`;
    })
    .join('')}</div>`;
}

function renderRelationships(values: CreativeRelationshipDraft[] | undefined): string {
  const items = (values ?? []).filter((item) => item.character && item.target);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>人物关系 <span class="badge">${items.length}</span></h2>${items
    .map((item) => `<div class="item"><strong>${escapeHtml(item.character)} -> ${escapeHtml(item.target)}</strong>${escapeHtml(formatRelationshipDraft(item))}</div>`)
    .join('')}</div>`;
}

function renderReferences(values: CreativeSourceRefDraft[] | undefined): string {
  const items = (values ?? []).filter((item) => item.kind || item.name || item.id);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>参考设定 <span class="badge">${items.length}</span></h2>${items
    .map((item) => `<div class="item"><strong>${escapeHtml([item.kind, item.name || item.id].filter(Boolean).join(' · '))}</strong>${escapeHtml(item.reason || '')}</div>`)
    .join('')}</div>`;
}

function renderInferences(values: CreativeInferenceDraft[] | undefined): string {
  const items = (values ?? []).filter((item) => item.subject && item.value);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>AI 推测 <span class="badge">${items.length}</span></h2>${items
    .map((item) => {
      const body = [
        item.field ? `字段：${item.field}` : '',
        item.confidence ? `置信度：${item.confidence}` : '',
        item.value,
        item.basis?.length ? `依据：${item.basis.join('；')}` : ''
      ].filter(Boolean).join('\n');
      return `<div class="item"><strong>${escapeHtml(item.subject)}</strong>${escapeHtml(body)}</div>`;
    })
    .join('')}</div>`;
}

function renderConflicts(values: CreativeConflictDraft[] | undefined): string {
  const items = (values ?? []).filter((item) => item.title);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>潜在矛盾 <span class="badge">${items.length}</span></h2>${items
    .map((item) => {
      const body = [
        item.severity ? `严重度：${item.severity}` : '',
        item.detail,
        item.suggestedFix ? `建议：${item.suggestedFix}` : ''
      ].filter(Boolean).join('\n');
      return `<div class="item"><strong>${escapeHtml(item.title)}</strong>${escapeHtml(body)}</div>`;
    })
    .join('')}</div>`;
}

function renderQuestions(values: CreativeQuestionDraft[] | undefined): string {
  const items = (values ?? []).filter((item) => item.question);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>待确认问题 <span class="badge">${items.length}</span></h2>${items
    .map((item) => {
      const body = [
        item.question,
        item.why ? `原因：${item.why}` : '',
        item.blocks?.length ? `影响：${item.blocks.join('、')}` : ''
      ].filter(Boolean).join('\n');
      return `<div class="item">${escapeHtml(body)}</div>`;
    })
    .join('')}</div>`;
}

function formatRelationshipDraft(item: CreativeRelationshipDraft): string {
  return [
    `${item.character} -> ${item.target}`,
    item.type ? `类型：${item.type}` : '',
    item.status ? `状态：${item.status}` : '',
    item.description,
    item.reason ? `原因：${item.reason}` : '',
    item.knownBy?.length ? `知情者：${item.knownBy.join('、')}` : ''
  ].filter(Boolean).join('；');
}

function renderOutlineItems(values: CreativeOutlineDraft[] | undefined): string {
  const items = (values ?? []).filter((item) => item?.title);
  if (items.length === 0) {
    return '';
  }
  return `<div class="group"><h2>章节 / 场景规划 <span class="badge">${items.length}</span></h2>${items
    .map((item) => {
      const body = [
        item.summary,
        item.purpose ? `作用：${item.purpose}` : '',
        item.viewpointCharacter ? `视角：${item.viewpointCharacter}` : '',
        item.location ? `地点：${item.location}` : '',
        item.conflict ? `冲突：${item.conflict}` : '',
        item.outcome ? `结果：${item.outcome}` : '',
        item.beats?.length ? `Beats：\n${item.beats.map((beat, index) => `${index + 1}. ${beat}`).join('\n')}` : ''
      ].filter(Boolean).join('\n');
      return `<div class="item"><strong>${escapeHtml(item.title)}</strong>${escapeHtml(body)}</div>`;
    })
    .join('')}</div>`;
}

function hasCodexDraft(draft: CreativeAssistantDraft | undefined): boolean {
  return Boolean(
    (draft?.characters?.length ?? 0) +
      (draft?.locations?.length ?? 0) +
      (draft?.worldRules?.length ?? 0) +
      (draft?.timelineEvents?.length ?? 0) +
      (draft?.relationships?.length ?? 0) +
      (draft?.inferences?.length ?? 0)
  );
}

function hasPlanDraft(draft: CreativeAssistantDraft | undefined): boolean {
  return Boolean(draft?.outline?.length);
}
