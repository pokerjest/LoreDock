import { normalizeBaseUrl } from '../core/utils';
import { AIMessage, AIRequest, AIResponse, AISettings } from '../types';

interface ChatCompletionChoice {
  message?: {
    content?: string;
  };
  text?: string;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
    type?: string;
  };
}

interface ModelInfo {
  id: string;
  label?: string;
}

export interface AIPreflightResult {
  ok: boolean;
  provider: string;
  url: string;
  status?: number;
  statusText?: string;
  authHeader: 'Authorization: Bearer' | 'x-api-key' | 'Gemini query key' | 'none';
  keyPreview: string;
  responsePreview?: string;
  error?: string;
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: string; name?: string }>;
  error?: {
    message?: string;
  };
}

interface ClaudeResponse {
  type?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  error?:
    | {
        type?: string;
        message?: string;
      }
    | {
        error?: {
          type?: string;
          message?: string;
        };
      };
}

interface ClaudeErrorResponse {
  type?: string;
  error?: {
    type?: string;
    message?: string;
  };
}

interface ClaudeModelsResponse {
  data?: Array<{ id?: string; display_name?: string }>;
  error?: {
    message?: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
  error?: {
    message?: string;
  };
}

export class AIClient {
  public constructor(
    private readonly settings: AISettings,
    private readonly apiKey?: string
  ) {}

  public async chat(request: AIRequest): Promise<AIResponse> {
    if (!this.settings.model.trim()) {
      throw new Error('请先配置模型名称。');
    }
    if (!this.settings.baseUrl.trim()) {
      throw new Error('请先配置模型服务地址。');
    }
    validateBaseUrl(this.settings.baseUrl);

    if (isAnthropicProvider(this.settings.provider)) {
      return this.chatClaude(request);
    }
    if (this.settings.provider === 'gemini') {
      return this.chatGemini(request);
    }
    return this.chatOpenAICompatible(request);
  }

  public async listModels(): Promise<ModelInfo[]> {
    if (!this.settings.baseUrl.trim()) {
      throw new Error('请先配置模型服务地址。');
    }
    validateBaseUrl(this.settings.baseUrl);
    if (isAnthropicProvider(this.settings.provider)) {
      return this.listClaudeModels();
    }
    if (this.settings.provider === 'gemini') {
      return this.listGeminiModels();
    }
    return this.listOpenAICompatibleModels();
  }

  public async preflight(): Promise<AIPreflightResult> {
    if (!this.settings.baseUrl.trim()) {
      throw new Error('请先配置模型服务地址。');
    }
    validateBaseUrl(this.settings.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    const url = this.preflightUrl();
    const authHeader = this.authHeaderDescription();
    try {
      const response = await fetch(url, {
        headers: this.preflightHeaders(),
        signal: controller.signal,
        redirect: 'manual'
      });
      const rawText = await response.text();
      return {
        ok: response.ok,
        provider: this.settings.provider,
        url,
        status: response.status,
        statusText: response.statusText,
        authHeader,
        keyPreview: previewApiKey(normalizeApiKey(this.apiKey)),
        responsePreview: rawText.slice(0, 1200)
      };
    } catch (error) {
      const explained = explainFetchError(error, 'AI 请求预检', this.settings);
      return {
        ok: false,
        provider: this.settings.provider,
        url,
        authHeader,
        keyPreview: previewApiKey(normalizeApiKey(this.apiKey)),
        error: explained.message
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatOpenAICompatible(request: AIRequest): Promise<AIResponse> {
    this.ensureOpenAICompatibleAuth('AI 请求');
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(`${normalizeBaseUrl(this.settings.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(buildChatCompletionPayload(this.settings, request)),
        signal: controller.signal,
        redirect: 'manual'
      });

      const rawText = await response.text();
      const parsed = parseJsonMaybe<ChatCompletionResponse>(rawText);
      if (!response.ok) {
        const message = parsed?.error?.message || rawText || `HTTP ${response.status}`;
        throw new Error(`AI 请求失败：${message}${authenticationHint(message, this.settings, this.apiKey)}`);
      }

      const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? '';
      if (!content.trim()) {
        throw new Error('AI 返回为空。');
      }

      return {
        content,
        model: parsed?.model,
        latencyMs: Date.now() - started,
        raw: parsed ?? rawText
      };
    } catch (error) {
      throw explainFetchError(error, 'AI 请求', this.settings);
    } finally {
      clearTimeout(timeout);
    }
  }

  public async testConnection(): Promise<AIResponse> {
    return this.chat({
      taskType: 'test',
      maxTokens: 16,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a connection test endpoint. Reply with OK only.'
        },
        {
          role: 'user',
          content: 'OK?'
        }
      ]
    });
  }

  private async chatClaude(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey?.trim()) {
      throw new Error('Claude 需要在 .loredock/ai.env 或 ai.local.jsonc 中填写 API key。');
    }
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(anthropicEndpoint(this.settings.baseUrl, 'messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey.trim(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(buildClaudePayload(this.settings, request)),
        signal: controller.signal
      });
      const rawText = await response.text();
      const parsed = parseJsonMaybe<ClaudeResponse>(rawText);
      if (!response.ok) {
        throw new Error(`Claude 请求失败：${extractAnthropicError(parsed, rawText) || `HTTP ${response.status}`}`);
      }
      const content = parsed?.content?.map((part) => part.text ?? '').join('').trim() ?? '';
      if (!content) {
        throw new Error('Claude 返回为空。');
      }
      return {
        content,
        model: parsed?.model,
        latencyMs: Date.now() - started,
        raw: parsed ?? rawText
      };
    } catch (error) {
      throw explainFetchError(error, 'Claude 请求', this.settings);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatGemini(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey?.trim()) {
      throw new Error('Gemini 需要在 .loredock/ai.env 或 ai.local.jsonc 中填写 API key。');
    }
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const model = encodeURIComponent(this.settings.model);
      const url = `${normalizeBaseUrl(this.settings.baseUrl)}/models/${model}:generateContent?key=${encodeURIComponent(this.apiKey.trim())}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(buildGeminiPayload(this.settings, request)),
        signal: controller.signal
      });
      const rawText = await response.text();
      const parsed = parseJsonMaybe<GeminiResponse>(rawText);
      if (!response.ok) {
        throw new Error(`Gemini 请求失败：${parsed?.error?.message || rawText || `HTTP ${response.status}`}`);
      }
      const content = parsed?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
      if (!content) {
        throw new Error('Gemini 返回为空。');
      }
      return {
        content,
        model: this.settings.model,
        latencyMs: Date.now() - started,
        raw: parsed ?? rawText
      };
    } catch (error) {
      throw explainFetchError(error, 'Gemini 请求', this.settings);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listOpenAICompatibleModels(): Promise<ModelInfo[]> {
    this.ensureOpenAICompatibleAuth('模型列表请求');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(`${normalizeBaseUrl(this.settings.baseUrl)}/models`, {
        headers: this.headers(),
        signal: controller.signal,
        redirect: 'manual'
      });
      const rawText = await response.text();
      const parsed = parseJsonMaybe<OpenAIModelsResponse>(rawText);
      if (!response.ok) {
        const message = parsed?.error?.message || rawText || `HTTP ${response.status}`;
        throw new Error(`模型列表请求失败：${message}${authenticationHint(message, this.settings, this.apiKey)}`);
      }
      return (parsed?.data ?? [])
        .map((model) => ({ id: model.id || model.name || '', label: model.name || model.id }))
        .filter((model) => model.id);
    } catch (error) {
      throw explainFetchError(error, '模型列表请求', this.settings);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listClaudeModels(): Promise<ModelInfo[]> {
    if (!this.apiKey?.trim()) {
      throw new Error('Claude 需要在 .loredock/ai.env 或 ai.local.jsonc 中填写 API key。');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(`${anthropicEndpoint(this.settings.baseUrl, 'models')}?limit=1000`, {
        headers: {
          'x-api-key': this.apiKey.trim(),
          'anthropic-version': '2023-06-01'
        },
        signal: controller.signal
      });
      const rawText = await response.text();
      const parsed = parseJsonMaybe<ClaudeModelsResponse>(rawText);
      if (!response.ok) {
        throw new Error(`Claude 模型列表请求失败：${extractAnthropicError(parsed, rawText) || `HTTP ${response.status}`}`);
      }
      return (parsed?.data ?? [])
        .map((model) => ({ id: model.id || '', label: model.display_name || model.id }))
        .filter((model) => model.id);
    } catch (error) {
      throw explainFetchError(error, 'Claude 模型列表请求', this.settings);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listGeminiModels(): Promise<ModelInfo[]> {
    if (!this.apiKey?.trim()) {
      throw new Error('Gemini 需要在 .loredock/ai.env 或 ai.local.jsonc 中填写 API key。');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(`${normalizeBaseUrl(this.settings.baseUrl)}/models?key=${encodeURIComponent(this.apiKey.trim())}`, {
        signal: controller.signal
      });
      const rawText = await response.text();
      const parsed = parseJsonMaybe<GeminiModelsResponse>(rawText);
      if (!response.ok) {
        throw new Error(`Gemini 模型列表请求失败：${parsed?.error?.message || rawText || `HTTP ${response.status}`}`);
      }
      return (parsed?.models ?? [])
        .filter((model) => model.supportedGenerationMethods?.includes('generateContent') ?? true)
        .map((model) => ({
          id: (model.name || '').replace(/^models\//, ''),
          label: model.displayName || model.name
        }))
        .filter((model) => model.id);
    } catch (error) {
      throw explainFetchError(error, 'Gemini 模型列表请求', this.settings);
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    const apiKey = normalizeApiKey(this.apiKey);
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (this.settings.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/pokerjest/LoreDock';
      headers['X-Title'] = 'LoreDock';
    }
    return headers;
  }

  private ensureOpenAICompatibleAuth(label: string): void {
    if (!requiresBearerAuthentication(this.settings) || normalizeApiKey(this.apiKey)) {
      return;
    }
    throw new Error(
      `${label}需要 API key，但 LoreDock 没有读到 key。请运行“LoreDock: 配置 AI”，在 .loredock/ai.env 里填写 OPENROUTER_API_KEY=sk-...，` +
        `或在当前 provider 的 apiKey/apiKeyEnv 中配置 key。provider=${this.settings.provider}, baseUrl=${this.settings.baseUrl}, model=${this.settings.model || '未选择'}`
    );
  }

  private preflightUrl(): string {
    if (this.settings.provider === 'openrouter') {
      return `${normalizeBaseUrl(this.settings.baseUrl).trim().replace(/\/v1$/i, '/v1')}/key`;
    }
    if (isAnthropicProvider(this.settings.provider)) {
      return `${anthropicEndpoint(this.settings.baseUrl, 'models')}?limit=1`;
    }
    if (this.settings.provider === 'gemini') {
      return `${normalizeBaseUrl(this.settings.baseUrl).trim()}/models?key=${encodeURIComponent(normalizeApiKey(this.apiKey) || '')}`;
    }
    return `${normalizeBaseUrl(this.settings.baseUrl).trim()}/models`;
  }

  private preflightHeaders(): Record<string, string> {
    if (isAnthropicProvider(this.settings.provider)) {
      const apiKey = normalizeApiKey(this.apiKey);
      return {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'anthropic-version': '2023-06-01'
      };
    }
    if (this.settings.provider === 'gemini') {
      return {};
    }
    return this.headers();
  }

  private authHeaderDescription(): AIPreflightResult['authHeader'] {
    if (this.settings.provider === 'gemini') {
      return normalizeApiKey(this.apiKey) ? 'Gemini query key' : 'none';
    }
    if (isAnthropicProvider(this.settings.provider)) {
      return normalizeApiKey(this.apiKey) ? 'x-api-key' : 'none';
    }
    return normalizeApiKey(this.apiKey) ? 'Authorization: Bearer' : 'none';
  }
}

export function buildChatCompletionPayload(settings: AISettings, request: AIRequest): Record<string, unknown> {
  return {
    model: settings.model,
    messages: request.messages,
    temperature: request.temperature ?? settings.temperature,
    max_tokens: request.maxTokens ?? settings.maxOutputTokens
  };
}

export function buildClaudePayload(settings: AISettings, request: AIRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages = normalizeAlternatingMessages(request.messages.filter((message) => message.role !== 'system'));
  return {
    model: settings.model,
    system,
    messages,
    temperature: request.temperature ?? settings.temperature,
    max_tokens: request.maxTokens ?? settings.maxOutputTokens
  };
}

export function buildGeminiPayload(settings: AISettings, request: AIRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      temperature: request.temperature ?? settings.temperature,
      maxOutputTokens: request.maxTokens ?? settings.maxOutputTokens
    }
  };
}

function normalizeAlternatingMessages(messages: AIMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const normalized: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = normalized[normalized.length - 1];
    if (previous?.role === role) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      normalized.push({ role, content: message.content });
    }
  }
  return normalized.length ? normalized : [{ role: 'user', content: 'OK?' }];
}

function isAnthropicProvider(provider: string): boolean {
  return provider === 'claude' || provider === 'anthropic';
}

function requiresBearerAuthentication(settings: AISettings): boolean {
  if (settings.provider === 'lm-studio' || settings.provider === 'ollama') {
    return !isLocalBaseUrl(settings.baseUrl);
  }
  if (settings.provider === 'openai-compatible' || settings.provider === 'custom') {
    return !isLocalBaseUrl(settings.baseUrl);
  }
  return settings.provider !== 'gemini' && !isAnthropicProvider(settings.provider);
}

export function normalizeApiKey(value: string | undefined): string | undefined {
  let normalized = value?.trim() ?? '';
  if (!normalized) {
    return undefined;
  }
  normalized = normalized.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/^Bearer\s+/i, '').trim();
  return normalized || undefined;
}

function previewApiKey(value: string | undefined): string {
  if (!value) {
    return '未读取到';
  }
  if (value.length <= 10) {
    return `长度 ${value.length}`;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}，长度 ${value.length}`;
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function authenticationHint(message: string, settings: AISettings, apiKey?: string): string {
  if (!/missing authentication|unauthorized|authentication/i.test(message)) {
    return '';
  }
  const normalizedApiKey = normalizeApiKey(apiKey);
  const authState = normalizedApiKey
    ? `LoreDock 已读到 key 并会发送 Authorization: Bearer，key=${previewApiKey(normalizedApiKey)}。`
    : 'LoreDock 没有读到 key，因此不会发送 Authorization。';
  return (
    `\n\n认证诊断：${authState}` +
    ` provider=${settings.provider}, baseUrl=${settings.baseUrl}, model=${settings.model || '未选择'}。` +
    '请运行“LoreDock: AI 请求预检”确认服务端是否收到认证；多模型 sk key 建议使用 activeProvider=openrouter，并写入 .loredock/ai.env 的 OPENROUTER_API_KEY=。'
  );
}

function extractAnthropicError(parsed: ClaudeResponse | ClaudeModelsResponse | ClaudeErrorResponse | undefined, rawText: string): string {
  if (!parsed) {
    return rawText;
  }
  const direct = parsed.error && 'message' in parsed.error ? parsed.error.message : undefined;
  const nested = parsed.error && 'error' in parsed.error ? parsed.error.error?.message : undefined;
  const directType = parsed.error && 'type' in parsed.error ? parsed.error.type : undefined;
  const nestedType = parsed.error && 'error' in parsed.error ? parsed.error.error?.type : undefined;
  const message = direct || nested || rawText;
  const type = directType || nestedType;
  return type ? `${type}: ${message}` : message;
}

function parseJsonMaybe<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function anthropicEndpoint(baseUrl: string, resource: 'messages' | 'models'): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/v1')) {
    return `${normalized}/${resource}`;
  }
  return `${normalized}/v1/${resource}`;
}

export function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`AI baseUrl 无效：${baseUrl}。请填写完整 URL，例如 https://openrouter.ai/api/v1 或 http://localhost:1234/v1。`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`AI baseUrl 需要以 http:// 或 https:// 开头：${baseUrl}`);
  }
}

function explainFetchError(error: unknown, action: string, settings: AISettings): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`${action}超时（${settings.timeoutMs} ms）。请检查网络、代理、baseUrl，或调大 timeoutMs。`);
  }
  if (!(error instanceof Error)) {
    return new Error(`${action}失败：${String(error)}`);
  }
  if (!isFetchNetworkError(error)) {
    return error;
  }

  const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
  const code = cause?.code;
  const reason = explainNetworkCode(code, cause?.message || error.message);
  return new Error(
    `${action}网络失败：${reason}\n` +
      `provider=${settings.provider}, baseUrl=${settings.baseUrl}, model=${settings.model || '未选择'}\n` +
      '如果你使用模型路由平台，请确认 activeProvider 是 openrouter 或 openai-compatible，baseUrl 包含 /v1，且当前网络/代理能访问该地址。'
  );
}

function isFetchNetworkError(error: Error): boolean {
  const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
  return /fetch failed|Failed to parse URL|Invalid URL/i.test(error.message) || Boolean(cause?.code);
}

function explainNetworkCode(code: string | undefined, fallback: string): string {
  if (code === 'ENOTFOUND') {
    return 'DNS 找不到域名。请检查 baseUrl 域名是否写错，或当前网络/代理是否可用。';
  }
  if (code === 'ECONNREFUSED') {
    return '连接被拒绝。若是 LM Studio/Ollama，请确认本地服务已启动且端口正确。';
  }
  if (code === 'ECONNRESET') {
    return '连接被重置。可能是网络、代理或服务端中断连接。';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return '连接超时。请检查网络、代理或服务地址。';
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'TLS/证书验证失败。请检查代理证书、公司网络证书或服务端 HTTPS 配置。';
  }
  return fallback || '底层 fetch failed，但没有返回 HTTP 响应。';
}
