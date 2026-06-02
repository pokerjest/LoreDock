import * as vscode from 'vscode';
import { AIConfigFile, AIProvider } from '../types';
import { cspSource, escapeHtml, nonce } from './webviewUtils';

export interface SettingsPanelState {
  workspaceName: string;
  config: AIConfigFile;
  envValues: Record<string, string>;
}

export type SettingsPanelAction =
  | { command: 'save'; config: AIConfigFile; envValues: Record<string, string> }
  | { command: 'select-model' }
  | { command: 'preflight' }
  | { command: 'test' }
  | { command: 'configure-openrouter' }
  | { command: 'configure-claude-cli' }
  | { command: 'open-files' }
  | { command: 'refresh' };

const PROVIDERS: AIProvider[] = ['gpt', 'claude', 'gemini', 'openai-compatible', 'openrouter', 'lm-studio', 'ollama', 'deepseek', 'custom'];
const ENV_KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'];

export function showSettingsPanel(
  context: vscode.ExtensionContext,
  state: SettingsPanelState,
  onAction: (action: SettingsPanelAction) => Promise<SettingsPanelState | undefined>
): void {
  const panel = vscode.window.createWebviewPanel('loredock.settings', 'LoreDock Settings', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = (nextState: SettingsPanelState) => {
    panel.webview.html = renderSettingsPanel(nextState);
  };

  render(state);
  panel.webview.onDidReceiveMessage(async (action: SettingsPanelAction) => {
    const nextState = await onAction(action);
    if (nextState) {
      render(nextState);
      panel.webview.postMessage({ command: 'saved' });
    }
  }, undefined, context.subscriptions);
}

function renderSettingsPanel(state: SettingsPanelState): string {
  const scriptNonce = nonce();
  const config = normalizeConfigForView(state.config);
  const activeProvider = config.activeProvider;
  const provider = { ...providerDefaults(activeProvider), ...(config.providers[activeProvider] ?? {}) };
  const currentModel = provider.model || '未选择模型';
  const providerOptions = PROVIDERS.map((item) => `<option value="${item}" ${item === activeProvider ? 'selected' : ''}>${providerLabel(item)}</option>`).join('');
  const envControls = ENV_KEYS.map((key) => renderEnvInput(key, state.envValues[key] ?? '')).join('\n');
  const providerData = scriptJson(config.providers);
  const envData = scriptJson(state.envValues);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${cspSource(scriptNonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreDock Settings</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    .shell { display: grid; grid-template-columns: 176px minmax(0, 1fr); min-height: 100vh; }
    aside { border-right: 1px solid var(--vscode-panel-border); padding: 22px 10px; background: var(--vscode-sideBar-background); }
    .nav { display: grid; gap: 6px; }
    .nav button { text-align: left; border: 0; border-radius: 7px; padding: 9px 12px; color: var(--vscode-sideBar-foreground); background: transparent; cursor: pointer; font: inherit; }
    .nav button.active { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    main { padding: 26px 34px 96px; max-width: 920px; }
    h1 { font-size: 20px; margin: 0 0 22px; font-weight: 700; }
    h2 { font-size: 14px; margin: 28px 0 10px; color: var(--vscode-descriptionForeground); }
    .panel { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; background: var(--vscode-sideBar-background); }
    .row { display: grid; grid-template-columns: minmax(150px, 240px) minmax(220px, 1fr); gap: 18px; align-items: center; padding: 13px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    .row:last-child { border-bottom: 0; }
    .label { font-weight: 600; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; line-height: 1.35; }
    input, select { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 8px 10px; font: inherit; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
    button.action { border: 1px solid var(--vscode-button-border, transparent); padding: 8px 12px; border-radius: 5px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .status { position: fixed; left: 176px; right: 0; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 34px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .model { color: var(--vscode-textLink-foreground); cursor: pointer; border: 0; background: transparent; padding: 0; font: inherit; font-weight: 600; }
    .saved { color: var(--vscode-testing-iconPassed); opacity: 0; transition: opacity 160ms ease; }
    .saved.show { opacity: 1; }
    section { display: none; }
    section.active { display: block; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); }
      .row { grid-template-columns: 1fr; gap: 8px; }
      .status { left: 0; padding: 12px 18px; }
      main { padding: 22px 18px 96px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <nav class="nav">
        <button class="active" data-tab="general">常规</button>
        <button data-tab="ai">AI 配置</button>
        <button data-tab="keys">API Key</button>
        <button data-tab="tools">诊断</button>
      </nav>
    </aside>
    <main>
      <section id="general" class="active">
        <h1>常规</h1>
        <div class="panel">
          <div class="row">
            <div><div class="label">项目</div><div class="hint">当前 workspace</div></div>
            <div>${escapeHtml(state.workspaceName)}</div>
          </div>
          <div class="row">
            <div><div class="label">语言</div><div class="hint">AI 默认输出语言</div></div>
            <input id="defaultLanguage" value="${escapeHtml(config.defaultLanguage || 'zh-CN')}">
          </div>
        </div>
      </section>
      <section id="ai">
        <h1>AI 配置</h1>
        <div class="actions">
          <button class="action secondary" data-command="configure-claude-cli">使用 Claude CLI 配置</button>
          <button class="action secondary" data-command="configure-openrouter">套用 OpenRouter</button>
          <button class="action secondary" data-command="open-files">打开配置文件</button>
        </div>
        <div class="panel">
          <div class="row">
            <div><div class="label">供应商</div><div class="hint">选择实际请求协议和平台</div></div>
            <select id="activeProvider">${providerOptions}</select>
          </div>
          <div class="row">
            <div><div class="label">Base URL</div><div class="hint">OpenRouter 是 https://openrouter.ai/api/v1；Claude 代理可填代理地址</div></div>
            <input id="baseUrl" value="${escapeHtml(provider.baseUrl ?? '')}">
          </div>
          <div class="row">
            <div><div class="label">模型</div><div class="hint">底部模型名也可以点击切换</div></div>
            <input id="model" value="${escapeHtml(provider.model ?? '')}">
          </div>
          <div class="row">
            <div><div class="label">Key 环境变量</div><div class="hint">保存时不会把 key 写入 ai.local.jsonc</div></div>
            <input id="apiKeyEnv" value="${escapeHtml(provider.apiKeyEnv ?? defaultEnvForProvider(activeProvider))}">
          </div>
          <div class="row">
            <div><div class="label">Temperature</div><div class="hint">生成随机度</div></div>
            <input id="temperature" type="number" min="0" max="2" step="0.1" value="${escapeHtml(String(provider.temperature ?? 0.7))}">
          </div>
          <div class="row">
            <div><div class="label">最大输出 tokens</div><div class="hint">单次 AI 输出上限</div></div>
            <input id="maxOutputTokens" type="number" min="128" step="128" value="${escapeHtml(String(provider.maxOutputTokens ?? 1200))}">
          </div>
          <div class="row">
            <div><div class="label">超时 ms</div><div class="hint">网络慢时可以调大</div></div>
            <input id="timeoutMs" type="number" min="5000" step="1000" value="${escapeHtml(String(provider.timeoutMs ?? 60000))}">
          </div>
        </div>
      </section>
      <section id="keys">
        <h1>API Key</h1>
        <div class="panel">${envControls}</div>
      </section>
      <section id="tools">
        <h1>诊断</h1>
        <div class="actions">
          <button class="action" data-command="preflight">AI 请求预检</button>
          <button class="action" data-command="test">测试 AI 连接</button>
          <button class="action secondary" data-command="refresh">刷新设置页</button>
        </div>
        <div class="panel">
          <div class="row">
            <div><div class="label">当前 provider</div><div class="hint">保存后生效</div></div>
            <div>${escapeHtml(providerLabel(activeProvider))}</div>
          </div>
          <div class="row">
            <div><div class="label">当前模型</div><div class="hint">点击底部模型名可切换</div></div>
            <div>${escapeHtml(currentModel)}</div>
          </div>
        </div>
      </section>
    </main>
  </div>
  <footer class="status">
    <div>当前模型：<button class="model" id="footerModel">${escapeHtml(currentModel)}</button><span> · ${escapeHtml(providerLabel(activeProvider))}</span></div>
    <div class="actions">
      <span id="saved" class="saved">已保存</span>
      <button class="action secondary" data-command="select-model">选择模型</button>
      <button class="action" id="save">保存设置</button>
    </div>
  </footer>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const providers = ${providerData};
    const envValues = ${envData};
    const providerDefaults = ${scriptJson(Object.fromEntries(PROVIDERS.map((provider) => [provider, providerDefaults(provider)])))};
    const activeProvider = document.getElementById('activeProvider');

    function numberValue(id, fallback) {
      const parsed = Number(document.getElementById(id).value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    function collectState() {
      const provider = activeProvider.value;
      const nextProviders = { ...providers };
      nextProviders[provider] = {
        ...(nextProviders[provider] || providerDefaults[provider]),
        baseUrl: document.getElementById('baseUrl').value.trim(),
        model: document.getElementById('model').value.trim(),
        apiKey: '',
        apiKeyEnv: document.getElementById('apiKeyEnv').value.trim(),
        temperature: numberValue('temperature', 0.7),
        maxOutputTokens: numberValue('maxOutputTokens', 1200),
        timeoutMs: numberValue('timeoutMs', 60000)
      };
      const nextEnv = {};
      document.querySelectorAll('input[data-env-key]').forEach((input) => {
        nextEnv[input.dataset.envKey] = input.value;
      });
      return {
        command: 'save',
        config: {
          schemaVersion: 1,
          activeProvider: provider,
          defaultLanguage: document.getElementById('defaultLanguage').value.trim() || 'zh-CN',
          providers: nextProviders
        },
        envValues: nextEnv
      };
    }
    function loadProvider(provider) {
      const next = { ...(providerDefaults[provider] || {}), ...(providers[provider] || {}) };
      document.getElementById('baseUrl').value = next.baseUrl || '';
      document.getElementById('model').value = next.model || '';
      document.getElementById('apiKeyEnv').value = next.apiKeyEnv || '';
      document.getElementById('temperature').value = next.temperature ?? 0.7;
      document.getElementById('maxOutputTokens').value = next.maxOutputTokens ?? 1200;
      document.getElementById('timeoutMs').value = next.timeoutMs ?? 60000;
    }
    activeProvider.addEventListener('change', () => loadProvider(activeProvider.value));
    document.getElementById('save').addEventListener('click', () => vscode.postMessage(collectState()));
    document.getElementById('footerModel').addEventListener('click', () => vscode.postMessage({ command: 'select-model' }));
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
    document.querySelectorAll('.nav button').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.nav button').forEach((item) => item.classList.remove('active'));
        document.querySelectorAll('main section').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        document.getElementById(button.dataset.tab).classList.add('active');
      });
    });
    window.addEventListener('message', (event) => {
      if (event.data.command === 'saved') {
        const saved = document.getElementById('saved');
        saved.classList.add('show');
        setTimeout(() => saved.classList.remove('show'), 1200);
      }
    });
  </script>
</body>
</html>`;
}

function renderEnvInput(key: string, value: string): string {
  return `<div class="row">
    <div><div class="label">${escapeHtml(key)}</div><div class="hint">${escapeHtml(envHint(key))}</div></div>
    <input data-env-key="${escapeHtml(key)}" type="password" value="${escapeHtml(value)}">
  </div>`;
}

function normalizeConfigForView(config: AIConfigFile): AIConfigFile {
  const providers = { ...config.providers };
  for (const provider of PROVIDERS) {
    providers[provider] = { ...providerDefaults(provider), ...(providers[provider] ?? {}) };
  }
  return {
    ...config,
    activeProvider: config.activeProvider || 'claude',
    defaultLanguage: config.defaultLanguage || 'zh-CN',
    providers
  };
}

function providerDefaults(provider: AIProvider) {
  const defaults: Record<AIProvider, { baseUrl: string; model: string; apiKey: string; apiKeyEnv: string; temperature: number; maxOutputTokens: number; timeoutMs: number }> = {
    gpt: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', apiKeyEnv: 'OPENAI_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    claude: { baseUrl: 'https://api.anthropic.com', model: '', apiKey: '', apiKeyEnv: 'ANTHROPIC_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    anthropic: { baseUrl: 'https://api.anthropic.com', model: '', apiKey: '', apiKeyEnv: 'ANTHROPIC_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '', apiKey: '', apiKeyEnv: 'GEMINI_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    'openai-compatible': { baseUrl: 'http://localhost:1234/v1', model: '', apiKey: '', apiKeyEnv: 'OPENAI_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '', apiKey: '', apiKeyEnv: 'OPENROUTER_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    'lm-studio': { baseUrl: 'http://localhost:1234/v1', model: '', apiKey: '', apiKeyEnv: '', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', apiKeyEnv: '', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: '', apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 },
    custom: { baseUrl: '', model: '', apiKey: '', apiKeyEnv: '', temperature: 0.7, maxOutputTokens: 1200, timeoutMs: 60000 }
  };
  return defaults[provider];
}

function defaultEnvForProvider(provider: AIProvider): string {
  return providerDefaults(provider).apiKeyEnv;
}

function providerLabel(provider: AIProvider): string {
  const labels: Record<AIProvider, string> = {
    gpt: 'GPT / OpenAI',
    claude: 'Claude / Anthropic',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    'openai-compatible': 'OpenAI Compatible',
    openrouter: 'OpenRouter',
    'lm-studio': 'LM Studio',
    ollama: 'Ollama',
    deepseek: 'DeepSeek',
    custom: 'Custom'
  };
  return labels[provider];
}

function envHint(key: string): string {
  if (key === 'OPENROUTER_API_KEY') {
    return 'OpenRouter 或多模型路由 key';
  }
  if (key === 'ANTHROPIC_API_KEY') {
    return 'Claude 官方或兼容代理 key';
  }
  if (key === 'OPENAI_API_KEY') {
    return 'OpenAI / GPT key';
  }
  if (key === 'GEMINI_API_KEY') {
    return 'Google Gemini key';
  }
  return 'DeepSeek key';
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
