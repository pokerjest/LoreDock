import * as vscode from 'vscode';
import { CodexCard } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

interface Field {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'checkbox' | 'select' | 'array' | 'json';
  options?: string[];
}

export function showCodexFormPanel(card: CodexCard): Promise<CodexCard | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('loredock.codexForm', `LoreDock 资料卡：${card.name}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    let settled = false;
    const finish = (value: CodexCard | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      panel.dispose();
    };
    panel.webview.html = renderCodexForm(card);
    panel.webview.onDidReceiveMessage((message: { command?: string; card?: CodexCard; error?: string }) => {
      if (message.command === 'cancel') {
        finish(undefined);
      }
      if (message.command === 'error') {
        vscode.window.showErrorMessage(message.error || '资料卡表单校验失败。');
      }
      if (message.command === 'save' && message.card) {
        finish(message.card);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}

function renderCodexForm(card: CodexCard): string {
  const scriptNonce = nonce();
  const fields = [...commonFields(), ...fieldsForKind(card.kind)];
  const controls = fields.map((field) => renderField(field, card)).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock 资料卡</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { font-size: 17px; margin: 0; }
    main { padding: 16px 20px 84px; max-width: 920px; }
    label { display: block; margin: 12px 0 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    input, textarea, select { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; font-family: var(--vscode-font-family); }
    textarea { min-height: 88px; resize: vertical; line-height: 1.45; }
    input[type="checkbox"] { width: auto; margin-right: 8px; }
    .check { display: flex; align-items: center; gap: 6px; margin-top: 14px; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); display: flex; justify-content: flex-end; gap: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 8px 12px; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(kindLabel(card.kind))} · ${escapeHtml(card.name)}</h1></header>
  <main>${controls}</main>
  <div class="bar"><button class="secondary" id="cancel">取消</button><button id="save">保存</button></div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const original = ${scriptJson(card)};
    function parseValue(input) {
      const type = input.dataset.type;
      if (type === 'checkbox') return input.checked;
      if (type === 'array') return input.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
      if (type === 'json') {
        try { return JSON.parse(input.value || '[]'); } catch { throw new Error(input.dataset.key + ' 不是合法 JSON'); }
      }
      if (type === 'number') return Number(input.value || 0);
      return input.value;
    }
    document.getElementById('save').addEventListener('click', () => {
      try {
        const next = { ...original };
        document.querySelectorAll('[data-key]').forEach((input) => {
          next[input.dataset.key] = parseValue(input);
        });
        if (!String(next.name || '').trim()) {
          vscode.postMessage({ command: 'error', error: '名称不能为空。' });
          return;
        }
        vscode.postMessage({ command: 'save', card: next });
      } catch (error) {
        vscode.postMessage({ command: 'error', error: String(error.message || error) });
      }
    });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  </script>
</body>
</html>`;
}

function commonFields(): Field[] {
  return [
    { key: 'name', label: '名称', type: 'text' },
    { key: 'aliases', label: '别名（逗号分隔）', type: 'array' },
    { key: 'tags', label: '标签（逗号分隔）', type: 'array' },
    { key: 'allowInContext', label: '允许纳入结构上下文', type: 'checkbox' },
    { key: 'alwaysIncludeInContext', label: '总是纳入结构上下文', type: 'checkbox' },
    { key: 'doNotTrack', label: '不要按名称/别名自动追踪', type: 'checkbox' },
    { key: 'nestedRefs', label: '嵌套引用资料卡 ID/名称（逗号分隔）', type: 'array' },
    { key: 'memoryStatus', label: '记忆状态', type: 'select', options: ['draft', 'pending', 'confirmed', 'deprecated'] },
    { key: 'summary', label: '一句话摘要', type: 'textarea' },
    { key: 'sourceRefs', label: '来源引用 JSON', type: 'json' },
    { key: 'inferences', label: '待确认推测 JSON', type: 'json' },
    { key: 'progressions', label: 'Progressions/Additions JSON', type: 'json' }
  ];
}

function fieldsForKind(kind: CodexCard['kind']): Field[] {
  if (kind === 'character') {
    return [
      { key: 'identity', label: '身份', type: 'text' },
      { key: 'fixedSetting', label: '固定设定', type: 'textarea' },
      { key: 'personality', label: '性格', type: 'textarea' },
      { key: 'speechStyle', label: '说话习惯', type: 'textarea' },
      { key: 'goals', label: '目标', type: 'textarea' },
      { key: 'abilities', label: '能力', type: 'textarea' },
      { key: 'weaknesses', label: '弱点', type: 'textarea' },
      { key: 'relationships', label: '人物关系 JSON', type: 'json' },
      { key: 'knows', label: '已知信息（逗号分隔）', type: 'array' },
      { key: 'doesNotKnow', label: '未知/不可知信息（逗号分隔）', type: 'array' },
      { key: 'relationshipNotes', label: '关系网备注', type: 'textarea' },
      { key: 'currentState', label: '当前状态', type: 'textarea' },
      { key: 'secrets', label: '普通秘密', type: 'textarea' },
      { key: 'hiddenSecrets', label: '隐藏秘密（默认不纳入上下文）', type: 'textarea' },
      { key: 'forbiddenActions', label: '禁止事项（逗号分隔）', type: 'array' }
    ];
  }
  if (kind === 'location') {
    return [
      { key: 'type', label: '类型', type: 'text' },
      { key: 'region', label: '区域', type: 'text' },
      { key: 'visualFeatures', label: '视觉特征', type: 'textarea' },
      { key: 'atmosphere', label: '氛围', type: 'textarea' },
      { key: 'history', label: '历史', type: 'textarea' },
      { key: 'rules', label: '地点规则', type: 'textarea' },
      { key: 'relatedCharacters', label: '相关人物（逗号分隔）', type: 'array' },
      { key: 'currentState', label: '当前状态', type: 'textarea' },
      { key: 'secrets', label: '普通秘密', type: 'textarea' },
      { key: 'hiddenSecrets', label: '隐藏秘密', type: 'textarea' },
      { key: 'relatedEvents', label: '相关事件 ID/名称（逗号分隔）', type: 'array' }
    ];
  }
  if (kind === 'world-rule') {
    return [
      { key: 'importance', label: '重要性', type: 'select', options: ['normal', 'important', 'absolute'] },
      { key: 'category', label: '类别', type: 'text' },
      { key: 'content', label: '规则内容', type: 'textarea' },
      { key: 'rules', label: '规则条目（逗号分隔）', type: 'array' },
      { key: 'scope', label: '适用范围（逗号分隔）', type: 'array' },
      { key: 'relatedCharacters', label: '相关人物（逗号分隔）', type: 'array' },
      { key: 'relatedLocations', label: '相关地点（逗号分隔）', type: 'array' },
      { key: 'relatedFactions', label: '相关组织/国家（逗号分隔）', type: 'array' },
      { key: 'knownExceptions', label: '已知例外（逗号分隔）', type: 'array' },
      { key: 'hidden', label: '隐藏规则', type: 'checkbox' }
    ];
  }
  if (kind === 'foreshadowing') {
    return [
      { key: 'status', label: '状态', type: 'select', options: ['planned', 'seeded', 'developing', 'resolved', 'abandoned'] },
      { key: 'importance', label: '重要性', type: 'select', options: ['normal', 'important', 'absolute'] },
      { key: 'description', label: '描述', type: 'textarea' },
      { key: 'firstSeedChapterId', label: '首次埋设章节 ID', type: 'text' },
      { key: 'expectedResolveChapterId', label: '预计回收章节 ID', type: 'text' },
      { key: 'relatedCharacters', label: '相关人物（逗号分隔）', type: 'array' },
      { key: 'publicHint', label: '可公开提示', type: 'textarea' },
      { key: 'hiddenTruth', label: '隐藏真相', type: 'textarea' },
      { key: 'allowRevealInContext', label: '允许上下文包含隐藏真相', type: 'checkbox' }
    ];
  }
  if (kind === 'scene') {
    return [
      { key: 'chapterId', label: '章节 ID', type: 'text' },
      { key: 'viewpointCharacter', label: '视角人物', type: 'text' },
      { key: 'location', label: '地点', type: 'text' },
      { key: 'conflict', label: '冲突', type: 'textarea' },
      { key: 'turn', label: '转折', type: 'textarea' },
      { key: 'outcome', label: '结果', type: 'textarea' },
      { key: 'order', label: '顺序', type: 'text' }
    ];
  }
  return [
    { key: 'chapterId', label: '章节 ID', type: 'text' },
    { key: 'sceneId', label: '场景 ID', type: 'text' },
    { key: 'content', label: '内容', type: 'textarea' },
    { key: 'purpose', label: '目的', type: 'textarea' },
    { key: 'order', label: '顺序', type: 'text' },
    { key: 'status', label: '状态', type: 'select', options: ['planned', 'expanded', 'discarded'] }
  ];
}

function renderField(field: Field, card: CodexCard): string {
  const value = (card as unknown as Record<string, unknown>)[field.key];
  if (field.type === 'checkbox') {
    return `<label class="check"><input data-key="${field.key}" data-type="checkbox" type="checkbox" ${value ? 'checked' : ''}>${escapeHtml(field.label)}</label>`;
  }
  if (field.type === 'select') {
    const options = (field.options ?? []).map((option) => `<option value="${escapeHtml(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('');
    return `<label>${escapeHtml(field.label)}</label><select data-key="${field.key}" data-type="text">${options}</select>`;
  }
  if (field.type === 'textarea') {
    return `<label>${escapeHtml(field.label)}</label><textarea data-key="${field.key}" data-type="text">${escapeHtml(String(value ?? ''))}</textarea>`;
  }
  if (field.type === 'array') {
    return `<label>${escapeHtml(field.label)}</label><input data-key="${field.key}" data-type="array" value="${escapeHtml(Array.isArray(value) ? value.join('，') : '')}">`;
  }
  if (field.type === 'json') {
    return `<label>${escapeHtml(field.label)}</label><textarea data-key="${field.key}" data-type="json">${escapeHtml(JSON.stringify(value ?? [], null, 2))}</textarea>`;
  }
  return `<label>${escapeHtml(field.label)}</label><input data-key="${field.key}" data-type="${field.key === 'order' || field.key === 'sequence' ? 'number' : 'text'}" value="${escapeHtml(String(value ?? ''))}">`;
}

function kindLabel(kind: CodexCard['kind']): string {
  const labels: Record<CodexCard['kind'], string> = {
    character: '人物卡',
    location: '地点卡',
    'world-rule': '世界规则',
    foreshadowing: '伏笔',
    scene: '场景',
    beat: 'Beat'
  };
  return labels[kind];
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
