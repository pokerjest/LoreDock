import { randomBytes } from "crypto";
import * as vscode from "vscode";
import type { KernelContext } from "../../kernel/types";
import {
  resolveExistingSafeStoryBiblePath
} from "./files";
import type { StoryBibleController } from "./controller";
import {
  STORY_BIBLE_CARD_TYPES,
  STORY_BIBLE_STATUSES,
  STORY_BIBLE_VISIBILITIES,
  type StoryBibleCardDto,
  type StoryBibleCardId
} from "./types";

type GalleryMessage =
  | { type: "ready" }
  | { type: "saveCard"; payload: SaveCardPayload }
  | { type: "openMarkdown"; cardId: StoryBibleCardId }
  | { type: "refresh" };

interface SaveCardPayload {
  id: StoryBibleCardId;
  name: string;
  aliases: string[];
  extraTags: string[];
  summary: string;
  visibility: string;
  status: string;
  chapterRefs: string[];
}

interface GalleryPanelState {
  panel: vscode.WebviewPanel;
  refresh(selectedCardId?: StoryBibleCardId): Promise<void>;
  changeDisposable: vscode.Disposable;
}

const galleryPanels = new Map<string, GalleryPanelState>();

export function closeStoryBibleGallery(workspaceRoot: string): void {
  const existing = galleryPanels.get(workspaceRoot);
  if (!existing) {
    return;
  }

  existing.panel.dispose();
}

export function openStoryBibleGallery(
  context: KernelContext,
  controller: StoryBibleController,
  initialCardId?: StoryBibleCardId
): void {
  const panelKey = context.workspaceFolder.uri.fsPath;
  const existing = galleryPanels.get(panelKey);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.One);
    void existing.refresh(initialCardId);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "loredock.storyBible.gallery",
    "故事圣经条目库",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  const nonce = createNonce();
  panel.webview.html = buildStoryBibleGalleryHtml(panel.webview, nonce);

  const refresh = async (selectedCardId?: StoryBibleCardId): Promise<void> => {
    const [cards, keywords] = await Promise.all([controller.listCards(), controller.listKeywords()]);
    await panel.webview.postMessage({
      type: "state",
      cards,
      keywords,
      cardTypes: STORY_BIBLE_CARD_TYPES,
      visibilities: STORY_BIBLE_VISIBILITIES,
      statuses: STORY_BIBLE_STATUSES,
      selectedCardId
    });
  };

  const changeDisposable = controller.onDidChange(() => {
    void refresh();
  });
  galleryPanels.set(panelKey, { panel, refresh, changeDisposable });
  panel.onDidDispose(() => {
    changeDisposable.dispose();
    galleryPanels.delete(panelKey);
  });

  panel.webview.onDidReceiveMessage(async (message: GalleryMessage) => {
    if (message.type === "ready") {
      await refresh(initialCardId);
      return;
    }

    if (message.type === "refresh") {
      await refresh();
      return;
    }

    if (message.type === "openMarkdown") {
      await openCardMarkdown(context.workspaceFolder, controller, message.cardId);
      return;
    }

    if (message.type === "saveCard") {
      await saveCardFromWebview(controller, message.payload);
      await refresh(message.payload.id);
    }
  });
}

export function buildStoryBibleGalleryHtml(webview: vscode.Webview, nonce: string): string {
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
  <title>故事圣经条目库</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --sidebar: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --panel: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, var(--vscode-editor-background)));
      --panel-strong: var(--vscode-sideBarSectionHeader-background, var(--vscode-input-background, var(--panel)));
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-panel-border, var(--vscode-widget-border, var(--vscode-input-border, transparent)));
      --accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
      --accent-strong: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      --danger: var(--vscode-errorForeground, var(--vscode-foreground));
      --input-bg: var(--vscode-input-background, var(--vscode-editor-background));
      --input-fg: var(--vscode-input-foreground, var(--vscode-foreground));
      --button-bg: var(--vscode-button-secondaryBackground, var(--vscode-input-background, var(--panel)));
      --button-fg: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      --button-hover-bg: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, var(--button-bg)));
      --primary-button-bg: var(--vscode-button-background, var(--button-bg));
      --primary-button-fg: var(--vscode-button-foreground, var(--button-fg));
      --list-hover-bg: var(--vscode-list-hoverBackground, var(--panel-strong));
      --list-active-bg: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground, var(--panel-strong)));
      --list-active-fg: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground));
      --suggest-bg: var(--vscode-editorSuggestWidget-background, var(--vscode-quickInput-background, var(--input-bg)));
      --suggest-fg: var(--vscode-editorSuggestWidget-foreground, var(--vscode-quickInput-foreground, var(--text)));
      --suggest-selected-bg: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-hoverBackground, var(--panel-strong)));
      --modal-overlay: rgba(0, 0, 0, 0.38);
      --shadow: 0 2px 8px rgba(0, 0, 0, 0.10);
      --chip-bg: transparent;
      --chip-fg: var(--vscode-descriptionForeground);
      --chip-primary-bg: transparent;
      --chip-primary-fg: var(--vscode-textLink-foreground, var(--vscode-foreground));
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
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
      grid-template-columns: 236px minmax(0, 1fr);
    }

    .sidebar {
      min-height: 100vh;
      background: var(--sidebar);
      border-right: 1px solid var(--line);
      padding: 12px;
      overflow: auto;
    }

    .brand {
      height: 48px;
      display: flex;
      align-items: center;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .side-tools {
      display: grid;
      gap: 8px;
      margin-bottom: 14px;
    }

    .nav-title {
      margin: 16px 0 6px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    .nav-list {
      display: grid;
      gap: 3px;
    }

    .nav-item {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: var(--text);
      padding: 6px 8px;
      text-align: left;
      cursor: pointer;
    }

    .nav-item:hover {
      background: var(--list-hover-bg);
      color: var(--text);
    }

    .nav-item.active {
      background: var(--list-active-bg);
      color: var(--list-active-fg);
      box-shadow: inset 2px 0 0 var(--accent);
    }

    .nav-count {
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      opacity: 0.78;
    }

    .main {
      min-width: 0;
      min-height: 100vh;
      background: var(--bg);
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 5;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto auto;
      gap: 10px;
      align-items: center;
      padding: 16px 22px;
      border-bottom: 1px solid var(--line);
      background: var(--bg);
      backdrop-filter: blur(10px);
    }

    .title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .title strong {
      font-size: 18px;
      line-height: 1.2;
    }

    .title span {
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .search, .select, .field input, .field textarea, .field select {
      width: 100%;
      color: var(--input-fg);
      border: 1px solid var(--line);
      background: var(--input-bg);
      border-radius: 6px;
      padding: 8px 10px;
      outline: none;
      user-select: text;
    }

    .search:focus, .select:focus, .field input:focus, .field textarea:focus, .field select:focus {
      border-color: var(--accent);
    }

    .button {
      border: 1px solid var(--line);
      background: var(--button-bg);
      color: var(--button-fg);
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
    }

    .button:hover {
      border-color: var(--accent);
      background: var(--button-hover-bg);
      color: var(--accent-strong);
    }

    .content {
      padding: 18px;
    }

    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 18px;
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-left: 2px solid var(--accent);
      border-radius: 4px;
      background: var(--panel);
    }

    .hero h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
    }

    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      color: var(--muted);
    }

    .section {
      margin: 18px 0 24px;
    }

    .section-head {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .section-head h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .section-line {
      height: 1px;
      flex: 1;
      background: var(--line);
    }

    .section-count {
      color: var(--muted);
      font-size: 12px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
    }

    .card {
      position: relative;
      min-height: 154px;
      display: grid;
      border: 1px solid var(--line);
      border-left: 2px solid var(--accent);
      background: var(--panel);
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      text-align: left;
      color: inherit;
      padding: 0;
      box-shadow: var(--shadow);
    }

    .card:hover {
      border-color: var(--accent);
      background: var(--list-hover-bg);
    }

    .cover {
      padding: 12px 12px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-strong);
    }

    .cover.location {
      background: var(--panel-strong);
    }

    .cover.rule {
      background: var(--panel-strong);
    }

    .cover-title {
      font-size: 17px;
      line-height: 1.25;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .card-body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .summary {
      color: var(--text);
      line-height: 1.4;
      min-height: 38px;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: auto;
    }

    .chip {
      max-width: 100%;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--chip-fg);
      background: var(--chip-bg);
      font-size: 12px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chip.primary {
      border-color: var(--accent);
      color: var(--chip-primary-fg);
      background: var(--chip-primary-bg);
    }

    .hero .chip {
      color: var(--muted);
      background: transparent;
      border-color: var(--line);
    }

    .type-label {
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 11px;
      line-height: 1.45;
    }

    .status-label {
      color: var(--muted);
      font-size: 12px;
    }

    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 36px;
      color: var(--muted);
      text-align: center;
    }

    .modal {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: none;
      align-items: stretch;
      justify-content: flex-end;
      padding: 24px;
      background: var(--modal-overlay);
    }

    .modal.open { display: flex; }

    .editor {
      width: min(960px, 100%);
      max-height: calc(100vh - 48px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .editor-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      padding: 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-strong);
    }

    .editor-head h2 {
      margin: 0;
      font-size: 20px;
      overflow-wrap: anywhere;
    }

    .editor-form {
      display: grid;
      gap: 16px;
      padding: 16px;
    }

    .form-section {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: visible;
    }

    .form-section h3 {
      margin: 0;
      padding: 10px 12px;
      font-size: 13px;
      background: var(--panel-strong);
      border-bottom: 1px solid var(--line);
      color: var(--text);
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      padding: 12px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }

    .field.full { grid-column: 1 / -1; }

    .field label {
      color: var(--muted);
      font-size: 12px;
    }

    .field textarea {
      min-height: 78px;
      resize: vertical;
    }

    .locked {
      border: 1px solid var(--line);
      background: var(--input-bg);
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--accent-strong);
      overflow-wrap: anywhere;
    }

    .keyword-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }

    .keyword-display {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--accent-strong);
      font-weight: 600;
    }

    .keyword-id {
      max-width: min(48vw, 420px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    .keyword-picker {
      position: relative;
      display: inline-flex;
    }

    .keyword-suggestions {
      position: absolute;
      z-index: 40;
      top: calc(100% + 4px);
      right: 0;
      width: min(520px, 78vw);
      max-height: 240px;
      overflow: auto;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--suggest-bg);
      color: var(--suggest-fg);
      box-shadow: var(--shadow);
    }

    .keyword-suggestion {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--suggest-fg);
      padding: 8px 12px;
      text-align: left;
      cursor: pointer;
    }

    .keyword-suggestion:hover,
    .keyword-suggestion.active {
      background: var(--suggest-selected-bg);
    }

    .keyword-suggestion-main {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }

    .keyword-suggestion-id {
      min-width: 0;
      max-width: min(40vw, 420px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    .keyword-suggestion-empty {
      padding: 8px 12px;
      color: var(--muted);
    }

    .keyword-chip-list > .keyword-suggestion-empty {
      padding: 4px 0;
    }

    .keyword-editor {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      min-height: 34px;
    }

    .keyword-chip-list {
      display: flex;
      flex: 1;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .keyword-token {
      max-width: 100%;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: transparent;
      color: var(--muted);
      padding: 3px 4px 3px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.4;
    }

    .keyword-token-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .keyword-token-remove,
    .keyword-add-button {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--button-bg);
      color: var(--button-fg);
      cursor: pointer;
      padding: 0;
    }

    .keyword-token-remove {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 13px;
      line-height: 1;
    }

    .keyword-token-remove:hover,
    .keyword-add-button:hover {
      border-color: var(--accent);
      background: var(--button-hover-bg);
      color: var(--accent-strong);
    }

    .editor-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 16px 16px;
      border-top: 1px solid var(--line);
    }

    .button.primary {
      background: var(--primary-button-bg);
      border-color: var(--primary-button-bg);
      color: var(--primary-button-fg);
    }

    .button.danger {
      color: var(--danger);
    }

    @media (max-width: 720px) {
      .topbar {
        grid-template-columns: 1fr;
      }
      .shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        min-height: auto;
      }
      .form-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">LoreDock</div>
      <div class="side-tools">
        <input id="search" class="search" placeholder="搜索条目">
      </div>
      <div class="nav-title">分类</div>
      <nav id="categoryNav" class="nav-list"></nav>
      <div class="nav-title">关键词</div>
      <nav id="keywordNav" class="nav-list"></nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="title">
          <strong>故事圣经条目库</strong>
          <span id="subtitle">人物、地点、规则</span>
        </div>
        <select id="sortMode" class="select" aria-label="排序">
          <option value="name">按名称排序</option>
          <option value="updatedAt">按更新时间排序</option>
          <option value="status">按状态排序</option>
        </select>
        <button id="refresh" class="button" type="button">刷新</button>
      </header>
      <main class="content">
        <section class="hero">
          <h1 id="heroTitle">全部条目</h1>
          <div id="heroMeta" class="hero-meta"></div>
        </section>
        <section id="sections"></section>
        <section id="empty" class="empty" hidden>暂无条目。</section>
      </main>
    </div>
  </div>

  <div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="editorTitle">
    <div class="editor">
      <div class="editor-head">
        <div>
          <h2 id="editorTitle">编辑条目</h2>
          <div id="editorPath" class="meta"></div>
        </div>
        <button id="closeEditor" class="button" type="button">关闭</button>
      </div>
      <form id="editorForm">
        <div class="editor-form">
          <section class="form-section">
            <h3>基础资料</h3>
            <div class="form-grid">
              <div class="field">
                <label for="name">名称</label>
                <input id="name" name="name" required>
              </div>
              <div class="field">
                <label for="type">类型</label>
                <div id="type" class="locked"></div>
              </div>
              <div class="field full">
                <label for="aliases">别名，逗号分隔</label>
                <input id="aliases" name="aliases">
              </div>
              <div class="field full">
                <label for="summary">摘要</label>
                <textarea id="summary" name="summary"></textarea>
              </div>
            </div>
          </section>
          <section class="form-section">
            <h3>关键词</h3>
            <div class="form-grid">
              <div class="field full">
                <label>对象主关键词</label>
                <div id="primaryKeyword" class="locked"></div>
              </div>
              <div class="field full">
                <label>普通/历史关键词</label>
                <div class="keyword-editor">
                  <div id="extraTagList" class="keyword-chip-list"></div>
                  <div class="keyword-picker">
                    <button id="addKeyword" class="keyword-add-button" type="button" title="添加关键词" aria-label="添加关键词">+</button>
                    <div id="keywordSuggestions" class="keyword-suggestions" hidden></div>
                  </div>
                  <input id="extraTags" name="extraTags" type="hidden">
                </div>
              </div>
            </div>
          </section>
          <section class="form-section">
            <h3>状态</h3>
            <div class="form-grid">
              <div class="field">
                <label for="visibility">可见性</label>
                <select id="visibility" name="visibility"></select>
              </div>
              <div class="field">
                <label for="status">状态</label>
                <select id="status" name="status"></select>
              </div>
            </div>
          </section>
          <section class="form-section">
            <h3>引用</h3>
            <div class="form-grid">
              <div class="field full">
                <label for="chapterRefs">章节引用，逗号分隔</label>
                <input id="chapterRefs" name="chapterRefs">
              </div>
            </div>
          </section>
        </div>
        <div class="editor-actions">
          <button id="openMarkdown" class="button" type="button">打开 Markdown</button>
          <button class="button primary" type="submit">保存元数据</button>
        </div>
      </form>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      cards: [],
      keywords: [],
      cardTypes: [],
      visibilities: [],
      statuses: [],
      selectedCardId: undefined
    };

    const els = {
      subtitle: document.getElementById("subtitle"),
      search: document.getElementById("search"),
      sortMode: document.getElementById("sortMode"),
      refresh: document.getElementById("refresh"),
      categoryNav: document.getElementById("categoryNav"),
      keywordNav: document.getElementById("keywordNav"),
      heroTitle: document.getElementById("heroTitle"),
      heroMeta: document.getElementById("heroMeta"),
      sections: document.getElementById("sections"),
      empty: document.getElementById("empty"),
      modal: document.getElementById("modal"),
      editorTitle: document.getElementById("editorTitle"),
      editorPath: document.getElementById("editorPath"),
      closeEditor: document.getElementById("closeEditor"),
      editorForm: document.getElementById("editorForm"),
      name: document.getElementById("name"),
      type: document.getElementById("type"),
      primaryKeyword: document.getElementById("primaryKeyword"),
      aliases: document.getElementById("aliases"),
      extraTagList: document.getElementById("extraTagList"),
      addKeyword: document.getElementById("addKeyword"),
      extraTags: document.getElementById("extraTags"),
      keywordSuggestions: document.getElementById("keywordSuggestions"),
      visibility: document.getElementById("visibility"),
      status: document.getElementById("status"),
      summary: document.getElementById("summary"),
      chapterRefs: document.getElementById("chapterRefs"),
      openMarkdown: document.getElementById("openMarkdown")
    };

    let activeCardId;
    let activeCategory = "";
    let activeKeyword = "";
    let activeKeywordSuggestionIndex = -1;
    let activeExtraTags = [];

    window.addEventListener("message", (event) => {
      if (event.data.type !== "state") return;
      Object.assign(state, event.data);
      renderControls();
      render();
      if (event.data.selectedCardId) {
        openEditor(event.data.selectedCardId);
      }
    });

    els.search.addEventListener("input", render);
    els.sortMode.addEventListener("change", render);
    els.refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    els.closeEditor.addEventListener("click", closeEditor);
    els.modal.addEventListener("click", (event) => {
      if (event.target === els.modal) closeEditor();
    });
    els.addKeyword.addEventListener("click", () => {
      if (els.keywordSuggestions.hidden) {
        renderKeywordSuggestions();
      } else {
        hideKeywordSuggestions();
      }
    });
    els.addKeyword.addEventListener("keydown", handleKeywordSuggestionKeydown);
    document.addEventListener("mousedown", (event) => {
      if (!els.keywordSuggestions.parentElement.contains(event.target) && event.target !== els.addKeyword) {
        hideKeywordSuggestions();
      }
    });
    els.openMarkdown.addEventListener("click", () => {
      if (activeCardId) vscode.postMessage({ type: "openMarkdown", cardId: activeCardId });
    });
    els.editorForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!activeCardId) return;
      vscode.postMessage({
        type: "saveCard",
        payload: {
          id: activeCardId,
          name: els.name.value,
          aliases: splitList(els.aliases.value),
          extraTags: activeExtraTags,
          summary: els.summary.value,
          visibility: els.visibility.value,
          status: els.status.value,
          chapterRefs: splitList(els.chapterRefs.value)
        }
      });
    });

    function renderControls() {
      els.visibility.innerHTML = state.visibilities
        .map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(visibilityLabel(value)) + '</option>')
        .join('');
      els.status.innerHTML = state.statuses
        .map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(statusLabel(value)) + '</option>')
        .join('');
      renderNavigation();
    }

    function render() {
      const text = els.search.value.trim().toLowerCase();
      const cards = sortedCards(state.cards.filter((card) => {
        if (activeCategory && card.type !== activeCategory) return false;
        if (activeKeyword && !card.tags.includes(activeKeyword)) return false;
        if (!text) return true;
        const keywordText = card.tags.map((tag) => {
          const keyword = state.keywords.find((item) => item.slug === tag);
          return [tag, keyword?.label ?? "", keyword?.description ?? ""].join(" ");
        }).join(" ");
        return [card.name, card.title ?? "", card.summary, card.aliases.join(" "), keywordText]
          .join(" ")
          .toLowerCase()
          .includes(text);
      }));

      const counts = countByType(state.cards);
      els.subtitle.textContent = state.cards.length + " 个条目";
      els.heroTitle.textContent = activeKeyword
        ? keywordLabel(activeKeyword)
        : activeCategory
          ? typeLabel(activeCategory)
          : "全部条目";
      els.heroMeta.innerHTML = [
        ["人物", counts.character ?? 0],
        ["地点", counts.location ?? 0],
        ["规则", counts.rule ?? 0],
        ["关键词", state.keywords.length]
      ]
        .filter(([, count]) => count > 0)
        .map(([label, count]) => '<span class="chip">' + escapeHtml(label + " " + count) + '</span>')
        .join('');

      els.sections.innerHTML = sectionHtml(cards);
      els.empty.hidden = cards.length > 0;
      for (const button of els.sections.querySelectorAll("[data-card-id]")) {
        button.addEventListener("click", () => openEditor(button.dataset.cardId));
      }
    }

    function renderNavigation() {
      const counts = countByType(state.cards);
      if (activeCategory && (counts[activeCategory] ?? 0) === 0) {
        activeCategory = "";
      }
      if (activeKeyword && !state.keywords.some((keyword) => keyword.slug === activeKeyword && keyword.usageCount > 0)) {
        activeKeyword = "";
      }
      const categories = [
        ["", "全部条目", state.cards.length],
        ["character", "人物", counts.character ?? 0],
        ["location", "地点", counts.location ?? 0],
        ["rule", "规则", counts.rule ?? 0]
      ].filter(([type, , count]) => type === "" || count > 0);
      els.categoryNav.innerHTML = categories.map(([type, label, count]) =>
        '<button class="nav-item ' + (activeCategory === type && !activeKeyword ? 'active' : '') + '" type="button" data-category="' + escapeHtml(type) + '">' +
          '<span>' + escapeHtml(label) + '</span><span class="nav-count">' + count + '</span>' +
        '</button>'
      ).join('');
      for (const button of els.categoryNav.querySelectorAll("[data-category]")) {
        button.addEventListener("click", () => {
          activeCategory = button.dataset.category;
          activeKeyword = "";
          renderControls();
          render();
        });
      }

      const usedKeywords = state.keywords
        .filter((keyword) => keyword.usageCount > 0)
        .slice(0, 18);
      els.keywordNav.innerHTML = usedKeywords.length === 0
        ? '<div class="nav-item"><span>暂无关键词</span></div>'
        : usedKeywords.map((keyword) =>
          '<button class="nav-item ' + (activeKeyword === keyword.slug ? 'active' : '') + '" type="button" data-keyword="' + escapeHtml(keyword.slug) + '">' +
            '<span>' + escapeHtml(keyword.label) + '</span><span class="nav-count">' + keyword.usageCount + '</span>' +
          '</button>'
        ).join('');
      for (const button of els.keywordNav.querySelectorAll("[data-keyword]")) {
        button.addEventListener("click", () => {
          activeKeyword = button.dataset.keyword;
          activeCategory = "";
          renderControls();
          render();
        });
      }
    }

    function sectionHtml(cards) {
      const groups = activeCategory || activeKeyword
        ? [[activeCategory || "filtered", cards]]
        : state.cardTypes.map((type) => [type, cards.filter((card) => card.type === type)]);
      return groups
        .filter(([, items]) => items.length > 0)
        .map(([type, items]) =>
          '<section class="section">' +
            '<div class="section-head">' +
              '<h2>' + escapeHtml(type === "filtered" ? "筛选结果" : typeLabel(type)) + '</h2>' +
              '<div class="section-line"></div>' +
              '<span class="section-count">' + items.length + '</span>' +
            '</div>' +
            '<div class="grid">' + items.map(cardHtml).join('') + '</div>' +
          '</section>'
        ).join('');
    }

    function cardHtml(card) {
      const primaryLabel = card.keywordLabels[card.primaryKeyword] ?? card.primaryKeyword;
      const secondaryTags = card.tags.slice(1, 4).map((tag) => {
        const keyword = state.keywords.find((item) => item.slug === tag);
        return { slug: tag, label: keyword?.label ?? tag };
      });
      return '<button class="card ' + escapeHtml(card.type) + '" type="button" data-card-id="' + escapeHtml(card.id) + '">' +
        '<div class="cover ' + escapeHtml(card.type) + '">' +
          '<div class="cover-title">' + escapeHtml(card.name) + '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="meta"><span class="type-label">' + escapeHtml(typeLabel(card.type)) + '</span><span class="status-label">' + escapeHtml(statusLabel(card.status)) + '</span></div>' +
          '<div class="summary">' + escapeHtml(card.summary || "未填写摘要") + '</div>' +
          '<div class="chips">' +
            '<span class="chip primary" title="' + escapeHtml(card.primaryKeyword) + '">' + escapeHtml(primaryLabel) + '</span>' +
            secondaryTags.map((tag) =>
              '<span class="chip" title="' + escapeHtml(tag.slug) + '">' + escapeHtml(tag.label) + '</span>'
            ).join('') +
          '</div>' +
        '</div>' +
      '</button>';
    }

    function openEditor(cardId) {
      const card = state.cards.find((item) => item.id === cardId);
      if (!card) return;
      activeCardId = card.id;
      els.editorTitle.textContent = card.name;
      els.editorPath.textContent = card.path;
      els.name.value = card.name;
      els.type.textContent = typeLabel(card.type) + " · " + card.type;
      els.primaryKeyword.innerHTML =
        '<div class="keyword-row">' +
          '<span class="keyword-display">' + escapeHtml(typeLabel(card.type) + "/" + card.name) + '</span>' +
          '<span class="keyword-id">' + escapeHtml(card.primaryKeyword) + '</span>' +
        '</div>';
      els.aliases.value = card.aliases.join(", ");
      activeExtraTags = [...card.tags.slice(1)];
      syncExtraTags();
      els.visibility.value = card.visibility;
      els.status.value = card.status;
      els.summary.value = card.summary;
      els.chapterRefs.value = (card.chapterRefs ?? []).join(", ");
      els.modal.classList.add("open");
    }

    function closeEditor() {
      activeCardId = undefined;
      activeExtraTags = [];
      syncExtraTags();
      hideKeywordSuggestions();
      els.modal.classList.remove("open");
    }

    function renderKeywordSuggestions() {
      if (!activeCardId) {
        hideKeywordSuggestions();
        return;
      }
      const current = state.cards.find((item) => item.id === activeCardId);
      const candidates = state.keywords
        .filter((keyword) => keyword.slug !== current?.primaryKeyword)
        .filter((keyword) => !activeExtraTags.includes(keyword.slug))
        .sort((left, right) => {
          const sourceScore = sourcePriority(left.source) - sourcePriority(right.source);
          if (sourceScore !== 0) return sourceScore;
          return keywordDisplay(left).localeCompare(keywordDisplay(right), "zh-Hans-CN");
        })
        .slice(0, 12);

      activeKeywordSuggestionIndex = -1;
      els.keywordSuggestions.innerHTML = candidates.length === 0
        ? '<div class="keyword-suggestion-empty">没有匹配关键词</div>'
        : candidates.map((keyword) =>
          '<button class="keyword-suggestion" type="button" data-keyword-slug="' + escapeHtml(keyword.slug) + '">' +
            '<span class="keyword-suggestion-main">' + escapeHtml(keywordDisplay(keyword)) + '</span>' +
            '<span class="keyword-suggestion-id">' + escapeHtml(keyword.slug) + '</span>' +
          '</button>'
        ).join('');
      els.keywordSuggestions.hidden = false;
      for (const button of els.keywordSuggestions.querySelectorAll("[data-keyword-slug]")) {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          selectKeywordSuggestion(button.dataset.keywordSlug);
        });
      }
    }

    function hideKeywordSuggestions() {
      activeKeywordSuggestionIndex = -1;
      els.keywordSuggestions.hidden = true;
      els.keywordSuggestions.innerHTML = "";
    }

    function handleKeywordSuggestionKeydown(event) {
      const buttons = Array.from(els.keywordSuggestions.querySelectorAll("[data-keyword-slug]"));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (els.keywordSuggestions.hidden) {
          renderKeywordSuggestions();
          return;
        }
        if (buttons.length === 0) return;
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        activeKeywordSuggestionIndex = (activeKeywordSuggestionIndex + delta + buttons.length) % buttons.length;
        updateKeywordSuggestionActive(buttons);
        return;
      }
      if (event.key === "Enter" && !els.keywordSuggestions.hidden && buttons.length > 0) {
        event.preventDefault();
        const selected = buttons[Math.max(activeKeywordSuggestionIndex, 0)];
        selectKeywordSuggestion(selected.dataset.keywordSlug);
        return;
      }
      if (event.key === "Escape") {
        hideKeywordSuggestions();
      }
    }

    function updateKeywordSuggestionActive(buttons) {
      buttons.forEach((button, index) => {
        button.classList.toggle("active", index === activeKeywordSuggestionIndex);
      });
      const selected = buttons[activeKeywordSuggestionIndex];
      if (selected) selected.scrollIntoView({ block: "nearest" });
    }

    function selectKeywordSuggestion(slug) {
      if (!slug) return;
      if (!activeExtraTags.includes(slug)) {
        activeExtraTags = [...activeExtraTags, slug];
        syncExtraTags();
      }
      hideKeywordSuggestions();
      els.addKeyword.focus();
    }

    function syncExtraTags() {
      els.extraTags.value = activeExtraTags.join(", ");
      els.extraTagList.innerHTML = activeExtraTags.length === 0
        ? '<span class="keyword-suggestion-empty">未添加普通/历史关键词</span>'
        : activeExtraTags.map((slug) => {
          const label = keywordDisplayBySlug(slug);
          return '<span class="keyword-token" title="' + escapeHtml(slug) + '">' +
            '<span class="keyword-token-id">' + escapeHtml(label) + '</span>' +
            '<button class="keyword-token-remove" type="button" data-remove-keyword="' + escapeHtml(slug) + '" title="移除 ' + escapeHtml(label) + '" aria-label="移除 ' + escapeHtml(label) + '">×</button>' +
          '</span>';
        }).join('');
      for (const button of els.extraTagList.querySelectorAll("[data-remove-keyword]")) {
        button.addEventListener("click", () => {
          activeExtraTags = activeExtraTags.filter((slug) => slug !== button.dataset.removeKeyword);
          syncExtraTags();
          renderKeywordSuggestions();
        });
      }
    }

    function keywordDisplay(keyword) {
      const objectType = objectTypeFromKeywordSlug(keyword.slug);
      if (objectType) return typeLabel(objectType) + "/" + keyword.label;
      if (keyword.category) return keyword.category + "/" + keyword.label;
      return keyword.label;
    }

    function keywordDisplayBySlug(slug) {
      const keyword = state.keywords.find((item) => item.slug === slug);
      if (keyword) return keywordDisplay(keyword);
      const objectType = objectTypeFromKeywordSlug(slug);
      if (objectType) return typeLabel(objectType) + "/" + slug.split("/").slice(1).join("/");
      return slug;
    }

    function objectTypeFromKeywordSlug(slug) {
      const type = String(slug).split("/")[0];
      return state.cardTypes.includes(type) ? type : undefined;
    }

    function sourcePriority(source) {
      if (source === "system-object") return 0;
      if (source === "user-defined") return 1;
      return 2;
    }

    function countByType(cards) {
      return cards.reduce((counts, card) => {
        counts[card.type] = (counts[card.type] ?? 0) + 1;
        return counts;
      }, {});
    }

    function sortedCards(cards) {
      const mode = els.sortMode.value;
      return [...cards].sort((left, right) => {
        if (mode === "updatedAt") return right.updatedAt.localeCompare(left.updatedAt);
        if (mode === "status") return left.status.localeCompare(right.status) || left.name.localeCompare(right.name);
        return left.name.localeCompare(right.name);
      });
    }

    function keywordLabel(slug) {
      const keyword = state.keywords.find((item) => item.slug === slug);
      return keyword ? keyword.label : slug;
    }

    function splitList(value) {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }

    function typeLabel(type) {
      if (type === "character") return "人物";
      if (type === "location") return "地点";
      if (type === "rule") return "规则";
      return type;
    }

    function visibilityLabel(value) {
      if (value === "public") return "公开";
      if (value === "spoiler") return "剧透";
      if (value === "private") return "私有";
      return value;
    }

    function statusLabel(value) {
      if (value === "draft") return "草稿";
      if (value === "canon") return "正典";
      if (value === "archived") return "归档";
      return value;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

async function saveCardFromWebview(controller: StoryBibleController, payload: SaveCardPayload): Promise<void> {
  const current = await controller.getCard(payload.id);
  if (!current) {
    throw new Error(`未找到故事圣经条目 "${payload.id}"。`);
  }

  await controller.updateCardMetadata(payload.id, {
    name: payload.name,
    aliases: payload.aliases,
    tags: [current.primaryKeyword, ...payload.extraTags],
    summary: payload.summary,
    visibility: payload.visibility as StoryBibleCardDto["visibility"],
    status: payload.status as StoryBibleCardDto["status"],
    chapterRefs: payload.chapterRefs
  });
}

async function openCardMarkdown(
  workspaceFolder: vscode.WorkspaceFolder,
  controller: StoryBibleController,
  cardId: StoryBibleCardId
): Promise<void> {
  const relativePath = await controller.resolveCardPath(cardId);
  if (!relativePath) {
    void vscode.window.showWarningMessage("条目文件缺失或路径不安全。");
    return;
  }

  const absolutePath = await resolveExistingSafeStoryBiblePath(workspaceFolder.uri.fsPath, relativePath);
  if (!absolutePath) {
    void vscode.window.showWarningMessage("条目文件缺失或路径不安全。");
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

function createNonce(): string {
  return randomBytes(16).toString("hex");
}
