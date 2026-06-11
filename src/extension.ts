import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  buildConsistencyMessages,
  buildContextPackage,
  buildContinuationMessages,
  buildPolishMessages,
  buildSummaryMessages,
  filterContextPackage
} from './core/contextBuilder';
import { SECRET_API_KEY } from './core/constants';
import { ExportFormat, LoreDockStorage } from './core/storage';
import { decodeTextBuffer, makeId, nowIso, stripUtf8Bom } from './core/utils';
import { AIClient, ModelInfo, normalizeApiKey } from './services/aiClient';
import {
  CreativeAssistantDraft,
  CreativeAssistantMessage,
  CreativeAssistantState,
  showCreativeAssistantPanel
} from './webviews/creativeAssistantPanel';
import { showCodexFormPanel } from './webviews/codexFormPanel';
import { showContextPreview } from './webviews/contextPreviewPanel';
import { showDiffApplyPanel } from './webviews/diffApplyPanel';
import { showHistoryPanel } from './webviews/historyPanel';
import { AIResultAction, showResultPanel } from './webviews/resultPanel';
import { SettingsPanelAction, SettingsPanelState, showSettingsPanel } from './webviews/settingsPanel';
import { PlanPanelState, showPlanPanel } from './webviews/planPanel';
import { showStatsPanel } from './webviews/statsPanel';
import { CodexTreeProvider, isCodexEntryNode } from './views/codexTree';
import { ChapterNode, isChapterNode, isProjectNode, isVolumeNode, ManuscriptTreeProvider } from './views/manuscriptTree';
import {
  AIConfigFile,
  BeatPlan,
  AIJobRecord,
  AIProvider,
  AISettings,
  AITaskType,
  ChapterRef,
  ChapterSummary,
  ChapterStatus,
  ChatThread,
  CharacterCard,
  CharacterRelationship,
  CodexCard,
  CodexEntry,
  CodexInference,
  CodexSourceRef,
  ConsistencyIssue,
  ForeshadowingCard,
  LocationCard,
  PromptTemplate,
  ProjectManifest,
  ScenePlan,
  Snippet,
  TimelineEvent,
  VolumeMeta,
  WorldRule
} from './types';

interface AIStatusRefreshTarget {
  refresh(): void;
}

export function activate(context: vscode.ExtensionContext): void {
  const getStorage = () => {
    const root = getWorkspaceRoot();
    return root ? new LoreDockStorage(root.fsPath) : undefined;
  };

  const manuscriptTree = new ManuscriptTreeProvider(getStorage);
  const codexTree = new CodexTreeProvider(getStorage);
  let refreshAIStatus = () => {};
  const aiStatus: AIStatusRefreshTarget = {
    refresh: () => refreshAIStatus()
  };
  const aiModelStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  refreshAIStatus = () => {
    void updateAIModelStatusBar(getStorage, aiModelStatusBar);
  };
  aiModelStatusBar.command = 'loredock.selectAIModel';
  void updateAIModelStatusBar(getStorage, aiModelStatusBar);

  context.subscriptions.push(
    aiModelStatusBar,
    vscode.window.registerTreeDataProvider('loredock.manuscript', manuscriptTree),
    vscode.window.registerTreeDataProvider('loredock.codex', codexTree),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      manuscriptTree.refresh();
      codexTree.refresh();
      aiStatus.refresh();
    }),
    registerCommand('loredock.refreshViews', () => {
      manuscriptTree.refresh();
      codexTree.refresh();
      aiStatus.refresh();
    }),
    registerCommand('loredock.openSettings', () => openSettings(context, getStorage, aiStatus)),
    registerCommand('loredock.showManuscriptActions', () => showManuscriptActions(context, getStorage, manuscriptTree, codexTree)),
    registerCommand('loredock.showCodexActions', () => showCodexActions(getStorage, codexTree)),
    registerCommand('loredock.initProject', () => initProject(getStorage, manuscriptTree, codexTree)),
    registerCommand('loredock.createVolume', () => createVolume(getStorage, manuscriptTree)),
    registerCommand('loredock.deleteProject', (node?: unknown) => deleteProject(getStorage, manuscriptTree, codexTree, node)),
    registerCommand('loredock.deleteVolume', (node?: unknown) => deleteVolume(getStorage, manuscriptTree, node)),
    registerCommand('loredock.createChapter', (node?: unknown) => createChapter(getStorage, manuscriptTree, node)),
    registerCommand('loredock.openChapter', (node?: unknown) => openChapter(getStorage, node)),
    registerCommand('loredock.renameChapter', (node?: unknown) => renameChapter(getStorage, manuscriptTree, node)),
    registerCommand('loredock.setChapterStatus', (node?: unknown) => setChapterStatus(getStorage, manuscriptTree, node)),
    registerCommand('loredock.deleteChapter', (node?: unknown) => deleteChapter(getStorage, manuscriptTree, node)),
    registerCommand('loredock.createCharacter', () => createCharacter(getStorage, codexTree)),
    registerCommand('loredock.createLocation', () => createLocation(getStorage, codexTree)),
    registerCommand('loredock.createWorldRule', () => createWorldRule(getStorage, codexTree)),
    registerCommand('loredock.createForeshadowing', () => createForeshadowing(getStorage, codexTree)),
    registerCommand('loredock.createTimelineEvent', () => createTimelineEvent(getStorage, codexTree)),
    registerCommand('loredock.createScene', () => createScene(getStorage, codexTree)),
    registerCommand('loredock.createBeat', () => createBeat(getStorage, codexTree)),
    registerCommand('loredock.openCreativeAssistant', () => openCreativeAssistant(context, getStorage, manuscriptTree, codexTree)),
    registerCommand('loredock.openPlanView', () => openPlanView(context, getStorage)),
    registerCommand('loredock.importOutlineToPlan', () => importOutlineToPlan(getStorage, manuscriptTree, codexTree)),
    registerCommand('loredock.rebuildReferenceIndex', () => rebuildReferenceIndex(getStorage)),
    registerCommand('loredock.showReferenceIndex', () => showReferenceIndex(getStorage)),
    registerCommand('loredock.openPromptLibrary', () => openPromptLibrary(getStorage)),
    registerCommand('loredock.previewPromptTemplate', () => previewPromptTemplate(getStorage)),
    registerCommand('loredock.showChatThreads', () => showChatThreads(getStorage)),
    registerCommand('loredock.saveSelectionAsSnippet', () => saveSelectionAsSnippet(getStorage)),
    registerCommand('loredock.exportCodexZip', () => exportCodexZip(getStorage)),
    registerCommand('loredock.importCodexZip', () => importCodexZip(getStorage, codexTree)),
    registerCommand('loredock.reviewPendingInferences', () => reviewPendingInferences(getStorage, codexTree)),
    registerCommand('loredock.openCodexEntry', (node?: unknown) => openCodexEntry(getStorage, node)),
    registerCommand('loredock.editCodexEntryForm', (node?: unknown) => editCodexEntryForm(getStorage, codexTree, node)),
    registerCommand('loredock.filterCodexEntries', () => filterCodexEntries(getStorage)),
    registerCommand('loredock.deleteCodexEntry', (node?: unknown) => deleteCodexEntry(getStorage, codexTree, node)),
    registerCommand('loredock.showForeshadowingBoard', () => showForeshadowingBoard(getStorage)),
    registerCommand('loredock.showTimelineBoard', () => showTimelineBoard(getStorage)),
    registerCommand('loredock.showSceneBeatBoard', () => showSceneBeatBoard(getStorage)),
    registerCommand('loredock.normalizeSceneOrder', () => normalizeSceneOrder(getStorage, codexTree)),
    registerCommand('loredock.normalizeBeatOrder', () => normalizeBeatOrder(getStorage, codexTree)),
    registerCommand('loredock.expandBeat', (node?: unknown) => expandBeat(context, getStorage, manuscriptTree, codexTree, node)),
    registerCommand('loredock.reviewPendingCodexUpdates', () => reviewPendingCodexUpdates(getStorage, codexTree)),
    registerCommand('loredock.configureAI', () => openSettings(context, getStorage, aiStatus)),
    registerCommand('loredock.configureOpenRouter', () => configureOpenRouter(getStorage, true, aiStatus)),
    registerCommand('loredock.configureFromClaudeCli', () => configureFromClaudeCli(getStorage, true, aiStatus)),
    registerCommand('loredock.selectAIModel', () => selectAIModel(getStorage, aiStatus)),
    registerCommand('loredock.showAIModelPicker', () => selectAIModel(getStorage, aiStatus)),
    registerCommand('loredock.diagnoseAIConfig', () => diagnoseAIConfig(getStorage)),
    registerCommand('loredock.preflightAIRequest', () => preflightAIRequest(context, getStorage)),
    registerCommand('loredock.testAIConnection', () => testAIConnection(context, getStorage)),
    registerCommand('loredock.openStyleGuide', () => openStyleGuide(getStorage)),
    registerCommand('loredock.configureExportStyle', () => configureExportStyle(getStorage)),
    registerCommand('loredock.setWritingGoals', () => setWritingGoals(getStorage)),
    registerCommand('loredock.importManuscript', () => importManuscript(getStorage, manuscriptTree)),
    registerCommand('loredock.exportManuscript', () => exportManuscript(getStorage)),
    registerCommand('loredock.showStats', () => showWritingStats(getStorage)),
    registerCommand('loredock.showAIHistory', () => showAIHistory(getStorage)),
    registerCommand('loredock.continueChapter', (node?: unknown) => continueChapter(context, getStorage, manuscriptTree, node)),
    registerCommand('loredock.polishSelection', () => polishSelection(context, getStorage, manuscriptTree)),
    registerCommand('loredock.generateChapterSummary', (node?: unknown) => generateChapterSummary(context, getStorage, manuscriptTree, node)),
    registerCommand('loredock.runLocalConsistencyCheck', (node?: unknown) => runLocalConsistencyCheck(getStorage, node)),
    registerCommand('loredock.checkConsistency', (node?: unknown) => checkConsistency(context, getStorage, node))
  );
}

export function deactivate(): void {
  // No background resources to clean up.
}

function registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    try {
      await callback(...args);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  });
}

async function updateAIModelStatusBar(
  getStorage: () => LoreDockStorage | undefined,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const storage = getStorage();
  if (!storage) {
    statusBar.hide();
    return;
  }

  try {
    if (!(await storage.manifestExists())) {
      statusBar.text = '$(sparkle) LoreDock';
      statusBar.tooltip = 'LoreDock：初始化小说项目后配置 AI 模型';
      statusBar.command = 'loredock.initProject';
      statusBar.show();
      return;
    }

    const config = await storage.readAIConfig();
    const provider = config.activeProvider;
    const providerConfig = config.providers[provider] ?? (provider === 'anthropic' ? config.providers.claude : undefined);
    const model = providerConfig?.model || '未选择模型';
    const baseUrl = providerConfig?.baseUrl || '未配置 baseUrl';

    statusBar.text = `$(sparkle) ${shortenStatusText(model)}`;
    statusBar.tooltip = `LoreDock 当前模型\n${model}\nprovider: ${provider}\nbaseUrl: ${baseUrl}\n\n点击弹出模型列表`;
    statusBar.command = 'loredock.selectAIModel';
    statusBar.show();
  } catch (error) {
    statusBar.text = '$(sparkle) LoreDock AI';
    statusBar.tooltip = `LoreDock 模型状态读取失败：${error instanceof Error ? error.message : String(error)}`;
    statusBar.command = 'loredock.openSettings';
    statusBar.show();
  }
}

function shortenStatusText(value: string): string {
  const normalized = value.trim() || '未选择模型';
  return normalized.length > 34 ? `${normalized.slice(0, 31)}...` : normalized;
}

async function showManuscriptActions(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider
): Promise<void> {
  const actions: Array<{ label: string; description?: string; run: () => Promise<void> | void }> = [
    {
      label: '打开创作助手',
      description: '左边聊天，右边沉淀标题、文风和世界观草稿',
      run: () => openCreativeAssistant(context, getStorage, manuscriptTree, codexTree)
    },
    {
      label: '打开 Plan / Matrix',
      description: '按 Grid、Matrix、Outline 查看章节、场景、Beat 和资料卡引用',
      run: () => openPlanView(context, getStorage)
    },
    {
      label: '从大纲创建规划',
      description: '读取当前选区或剪贴板，批量创建卷、章、场景和 Beat',
      run: () => importOutlineToPlan(getStorage, manuscriptTree, codexTree)
    },
    {
      label: '初始化小说项目',
      description: '创建 LoreDock 本地项目结构',
      run: () => initProject(getStorage, manuscriptTree, codexTree)
    },
    {
      label: '显示写作统计',
      description: '查看卷、章节、字数和状态分布',
      run: () => showWritingStats(getStorage)
    },
    {
      label: '设置写作目标',
      description: '配置每日目标和全书目标字数',
      run: () => setWritingGoals(getStorage)
    },
    {
      label: '打开文风指南',
      description: '编辑全局文风和禁止事项',
      run: () => openStyleGuide(getStorage)
    },
    {
      label: '配置导出样式',
      description: '编辑 DOCX/EPUB/PDF 导出样式',
      run: () => configureExportStyle(getStorage)
    },
    {
      label: '导入已有手稿',
      description: '从 Markdown/TXT 按标题拆章导入',
      run: () => importManuscript(getStorage, manuscriptTree)
    },
    {
      label: '导出整本书',
      description: '导出为 Markdown/TXT/DOCX/EPUB/PDF',
      run: () => exportManuscript(getStorage)
    },
    {
      label: '查看 AI 历史',
      description: '查看、复制或清空 AI 操作历史',
      run: () => showAIHistory(getStorage)
    },
    {
      label: '应用摘要建议',
      description: '逐条确认摘要里的资料库更新',
      run: () => reviewPendingCodexUpdates(getStorage, codexTree)
    },
    {
      label: '重建引用索引',
      description: '扫描手稿、摘要、场景、Beat、聊天和片段中的资料卡引用',
      run: () => rebuildReferenceIndex(getStorage)
    },
    {
      label: 'Prompt Library',
      description: '查看和编辑本地 Prompt 模板',
      run: () => openPromptLibrary(getStorage)
    },
    {
      label: '聊天线程',
      description: '查看、导出或删除创作助手聊天线程',
      run: () => showChatThreads(getStorage)
    },
    {
      label: '保存选区为 Snippet',
      description: '把当前编辑器选中文本保存为可复用片段',
      run: () => saveSelectionAsSnippet(getStorage)
    },
    {
      label: '本地一致性检查',
      description: '不用 AI，先跑确定性规则检查',
      run: () => runLocalConsistencyCheck(getStorage)
    }
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: 'LoreDock 手稿操作'
  });
  await picked?.run();
}

async function showCodexActions(
  getStorage: () => LoreDockStorage | undefined,
  codexTree: CodexTreeProvider
): Promise<void> {
  const actions: Array<{ label: string; description?: string; run: () => Promise<void> | void }> = [
    {
      label: '打开资料卡',
      description: '从资料库选择一个 JSON 卡片打开',
      run: () => openCodexEntry(getStorage)
    },
    {
      label: '表单编辑资料卡',
      description: '用表单维护常用字段，保留 JSON 扩展能力',
      run: () => editCodexEntryForm(getStorage, codexTree)
    },
    {
      label: '按标签/类型筛选',
      description: '从资料库中快速定位卡片',
      run: () => filterCodexEntries(getStorage)
    },
    {
      label: '查看引用索引',
      description: '查看资料卡在手稿、摘要、场景、Beat、聊天中的出现位置',
      run: () => showReferenceIndex(getStorage)
    },
    {
      label: '处理 AI 推测',
      description: '接受或拒绝资料卡里的 pending 推测',
      run: () => reviewPendingInferences(getStorage, codexTree)
    },
    {
      label: '导出资料库 ZIP',
      description: '备份或迁移整个 codex 目录',
      run: () => exportCodexZip(getStorage)
    },
    {
      label: '导入资料库 ZIP',
      description: '从 LoreDock codex zip 导入资料卡',
      run: () => importCodexZip(getStorage, codexTree)
    },
    {
      label: '刷新',
      description: '刷新资料库树',
      run: () => codexTree.refresh()
    }
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: 'LoreDock 资料库操作'
  });
  await picked?.run();
}

async function openPlanView(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  showPlanPanel(context, await loadPlanPanelState(storage), async (action) => {
    if (action.command === 'import-outline') {
      await importOutlineToPlan(() => storage);
    }
    return loadPlanPanelState(storage);
  });
}

async function loadPlanPanelState(storage: LoreDockStorage): Promise<PlanPanelState> {
  const [manifest, refs, entries, index] = await Promise.all([
    storage.requireManifest(),
    storage.getFlatChapterRefs(),
    storage.listCodexEntries(),
    storage.buildReferenceIndex()
  ]);
  const scenes = entries.filter((entry) => entry.card.kind === 'scene').map((entry) => entry.card as ScenePlan);
  const beats = entries.filter((entry) => entry.card.kind === 'beat').map((entry) => entry.card as BeatPlan);
  const references = new Map<string, Set<string>>();
  const sceneChapter = new Map(scenes.map((scene) => [scene.id, scene.chapterId]));
  const beatChapter = new Map(beats.map((beat) => [beat.id, beat.chapterId]));
  for (const occurrence of index.occurrences) {
    const chapterId =
      occurrence.sourceKind === 'chapter' || occurrence.sourceKind === 'summary'
        ? occurrence.sourceId
        : occurrence.sourceKind === 'scene'
          ? sceneChapter.get(occurrence.sourceId)
          : occurrence.sourceKind === 'beat'
            ? beatChapter.get(occurrence.sourceId)
            : undefined;
    if (!chapterId) {
      continue;
    }
    const key = `${occurrence.cardId}|${chapterId}`;
    references.set(key, new Set([...(references.get(key) ?? []), occurrence.excerpt]));
  }
  return {
    title: manifest.title,
    chapters: refs.map((ref) => ({
      ref,
      scenes: scenes.filter((scene) => scene.chapterId === ref.chapter.id).sort((a, b) => a.order - b.order),
      beats: beats.filter((beat) => beat.chapterId === ref.chapter.id).sort((a, b) => a.order - b.order)
    })),
    codexCards: entries.map((entry) => entry.card),
    references
  };
}

async function importOutlineToPlan(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree?: ManuscriptTreeProvider,
  codexTree?: CodexTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const editor = vscode.window.activeTextEditor;
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
  const clipboard = selected ? '' : await vscode.env.clipboard.readText();
  const text = selected || clipboard;
  if (!text.trim()) {
    vscode.window.showInformationMessage('请先选中大纲文本，或把大纲复制到剪贴板。');
    return;
  }
  const imported = await createPlanFromOutline(storage, text);
  manuscriptTree?.refresh();
  codexTree?.refresh();
  vscode.window.showInformationMessage(`已从大纲创建：卷 ${imported.volumes}，章节 ${imported.chapters}，场景 ${imported.scenes}，Beat ${imported.beats}。`);
}

async function createPlanFromOutline(storage: LoreDockStorage, outline: string): Promise<{ volumes: number; chapters: number; scenes: number; beats: number }> {
  const result = { volumes: 0, chapters: 0, scenes: 0, beats: 0 };
  let currentVolume: VolumeMeta | undefined;
  let currentChapter: ChapterRef | undefined;
  let currentScene: ScenePlan | undefined;
  const defaultVolume = async () => {
    if (!currentVolume) {
      currentVolume = await storage.createVolume('大纲导入');
      result.volumes += 1;
    }
    return currentVolume;
  };
  for (const rawLine of outline.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading?.[1] === '#') {
      currentVolume = await storage.createVolume(heading[2].trim());
      currentChapter = undefined;
      currentScene = undefined;
      result.volumes += 1;
      continue;
    }
    if (heading?.[1] === '##') {
      const volume = await defaultVolume();
      const chapter = await storage.createChapter(volume.id, heading[2].trim());
      currentChapter = await storage.getChapterRef(chapter.id);
      currentScene = undefined;
      result.chapters += 1;
      continue;
    }
    if (heading?.[1] === '###' || /^场景[:：]/.test(line)) {
      const chapter = currentChapter ?? await createFallbackOutlineChapter(storage, await defaultVolume(), result);
      currentScene = await storage.createScene({
        name: heading?.[2]?.trim() || line.replace(/^场景[:：]\s*/, ''),
        chapterId: chapter.chapter.id
      });
      result.scenes += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const chapter = currentChapter ?? await createFallbackOutlineChapter(storage, await defaultVolume(), result);
      const beat = await storage.createBeat({
        name: shortTitle(line.replace(/^[-*]\s+/, ''), 'Beat'),
        detail: line.replace(/^[-*]\s+/, ''),
        chapterId: chapter.chapter.id
      });
      if (currentScene) {
        const entry = await storage.findCodexEntryById(beat.id);
        if (entry && entry.card.kind === 'beat') {
          await storage.writeCodexEntry(entry.relativePath, { ...entry.card, sceneId: currentScene.id });
        }
      }
      result.beats += 1;
      continue;
    }
    const chapter = currentChapter ?? await createFallbackOutlineChapter(storage, await defaultVolume(), result);
    currentScene = await storage.createScene({
      name: shortTitle(line, '场景'),
      detail: line,
      chapterId: chapter.chapter.id
    });
    result.scenes += 1;
  }
  return result;
}

async function createFallbackOutlineChapter(storage: LoreDockStorage, volume: VolumeMeta, result: { chapters: number }): Promise<ChapterRef> {
  const chapter = await storage.createChapter(volume.id, `大纲章节 ${result.chapters + 1}`);
  result.chapters += 1;
  return storage.getChapterRef(chapter.id);
}

async function rebuildReferenceIndex(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const index = await storage.buildReferenceIndex();
  vscode.window.showInformationMessage(`引用索引已重建：${index.occurrences.length} 个引用。`);
}

async function showReferenceIndex(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const index = await storage.buildReferenceIndex();
  const grouped = new Map<string, typeof index.occurrences>();
  for (const occurrence of index.occurrences) {
    grouped.set(occurrence.cardName, [...(grouped.get(occurrence.cardName) ?? []), occurrence]);
  }
  const lines = ['# LoreDock 引用索引', '', `生成时间：${index.generatedAt}`, `引用总数：${index.occurrences.length}`, ''];
  for (const [name, occurrences] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${name}（${occurrences.length}）`, '');
    for (const occurrence of occurrences.slice(0, 30)) {
      lines.push(`- ${occurrence.sourceKind} · ${occurrence.sourceTitle}：${occurrence.excerpt}`);
    }
    lines.push('');
  }
  await showMarkdownDocument('LoreDock 引用索引', lines.join('\n'));
}

async function openPromptLibrary(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const prompts = await storage.ensurePromptLibrary();
  const lines = [
    '# LoreDock Prompt Library',
    '',
    '这些模板保存在 `.loredock/prompts/*.json`。可以直接编辑 JSON，自定义 system/user、默认模型、温度和标签。',
    '',
    ...prompts.map((prompt) => `- **${prompt.title}** · ${prompt.kind} · ${prompt.description}`)
  ];
  await showMarkdownDocument('LoreDock Prompt Library', lines.join('\n'));
  const first = prompts[0];
  if (first) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(`.loredock/prompts/${first.id}.json`)));
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }
}

async function previewPromptTemplate(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const prompts = await storage.ensurePromptLibrary();
  const picked = await vscode.window.showQuickPick(
    prompts.map((prompt) => ({ label: prompt.title, description: prompt.kind, detail: prompt.description, prompt })),
    { placeHolder: '选择要预览的 Prompt' }
  );
  if (!picked) {
    return;
  }
  const ref = await resolveChapter(storage);
  if (!ref) {
    return;
  }
  const contextPackage = await buildContextPackage({
    storage,
    chapterId: ref.chapter.id,
    taskType: promptKindToTaskType(picked.prompt.kind),
    userInstruction: ''
  });
  const rendered = renderPromptTemplate(picked.prompt, contextPackage.assembledText, '');
  await showMarkdownDocument(`Prompt 预览：${picked.prompt.title}`, rendered);
}

async function showChatThreads(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const threads = await storage.listChatThreads();
  if (threads.length === 0) {
    vscode.window.showInformationMessage('还没有创作助手聊天线程。打开创作助手并发送消息后会自动保存。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    threads.map((thread) => ({
      label: `${thread.pinned ? '★ ' : ''}${thread.title}`,
      description: `${thread.messages.length} 条 · ${thread.updatedAt}`,
      thread
    })),
    { placeHolder: '选择聊天线程' }
  );
  if (!picked) {
    return;
  }
  const action = await vscode.window.showQuickPick(
    [
      { label: '打开 JSON', action: 'open' as const },
      { label: '导出 Markdown', action: 'export' as const },
      { label: picked.thread.pinned ? '取消置顶' : '置顶', action: 'pin' as const },
      { label: '删除', action: 'delete' as const }
    ],
    { placeHolder: picked.thread.title }
  );
  if (!action) {
    return;
  }
  if (action.action === 'open') {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(`.loredock/chats/${picked.thread.id}.json`)));
    await vscode.window.showTextDocument(document, { preview: false });
  } else if (action.action === 'export') {
    const relativePath = await storage.exportChatThreadMarkdown(picked.thread.id);
    vscode.window.showInformationMessage(`聊天已导出：${relativePath}`);
  } else if (action.action === 'pin') {
    await storage.saveChatThread({ ...picked.thread, pinned: !picked.thread.pinned });
  } else {
    const answer = await vscode.window.showWarningMessage(`确认删除聊天“${picked.thread.title}”？`, { modal: true }, '删除');
    if (answer === '删除') {
      await storage.deleteChatThread(picked.thread.id);
    }
  }
}

async function saveSelectionAsSnippet(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const editor = vscode.window.activeTextEditor;
  const text = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
  if (!text.trim()) {
    vscode.window.showInformationMessage('请先在编辑器里选中要保存为 Snippet 的文本。');
    return;
  }
  const title = await promptInput('Snippet 标题', shortTitle(text, '片段'));
  if (!title) {
    return;
  }
  await storage.saveSnippet({
    schemaVersion: 1,
    id: makeId('snippet'),
    title,
    content: text,
    tags: [],
    sourceRefs: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  vscode.window.showInformationMessage(`已保存 Snippet：${title}`);
}

async function exportCodexZip(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const relativePath = await storage.exportCodexZip();
  vscode.window.showInformationMessage(`资料库已导出：${relativePath}`);
}

async function importCodexZip(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  const picked = await vscode.window.showOpenDialog({
    title: '选择 LoreDock Codex ZIP',
    canSelectMany: false,
    filters: { ZIP: ['zip'] }
  });
  const uri = picked?.[0];
  if (!uri) {
    return;
  }
  const count = await storage.importCodexZip(Buffer.from(await vscode.workspace.fs.readFile(uri)));
  codexTree.refresh();
  vscode.window.showInformationMessage(`已导入 ${count} 张资料卡。`);
}

async function reviewPendingInferences(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  const entries = await storage.listCodexEntries();
  const items = entries.flatMap((entry) =>
    (entry.card.inferences ?? [])
      .map((inference, index) => ({ entry, inference, index }))
      .filter((item) => item.inference.status === 'pending')
      .map((item) => ({
        label: `${entry.card.name} · ${item.inference.field}`,
        description: item.inference.confidence,
        detail: item.inference.value,
        item
      }))
  );
  if (items.length === 0) {
    vscode.window.showInformationMessage('没有 pending AI 推测。');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要处理的 AI 推测' });
  if (!picked) {
    return;
  }
  const action = await vscode.window.showQuickPick(
    [
      { label: '接受为已确认推测', status: 'accepted' as const },
      { label: '拒绝', status: 'rejected' as const }
    ],
    { placeHolder: picked.detail }
  );
  if (!action) {
    return;
  }
  const next = [...(picked.item.entry.card.inferences ?? [])];
  next[picked.item.index] = { ...next[picked.item.index], status: action.status, updatedAt: nowIso() };
  await storage.writeCodexEntry(picked.item.entry.relativePath, { ...picked.item.entry.card, inferences: next } as CodexCard);
  codexTree.refresh();
  vscode.window.showInformationMessage(`已${action.status === 'accepted' ? '接受' : '拒绝'}推测。`);
}

async function loadCreativeAssistantThread(storage: LoreDockStorage, projectTitle: string): Promise<ChatThread> {
  const threads = await storage.listChatThreads();
  const existing = threads.find((thread) => thread.pinned) ?? threads[0];
  if (existing) {
    return existing;
  }
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    id: makeId('chat'),
    title: `创作助手 · ${projectTitle || new Date().toLocaleDateString('zh-CN')}`,
    pinned: false,
    messages: [{ role: 'assistant', content: creativeAssistantIntroMessage() }],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function creativeAssistantIntroMessage(): string {
  return '你可以直接描述想写的故事、世界观、主角、题材或氛围。我会把聊天内容整理成右侧设定草稿，确认后再写入 LoreDock 项目。';
}

function toCreativeMessages(messages: ChatThread['messages']): CreativeAssistantMessage[] {
  return messages
    .filter((message): message is { role: 'user' | 'assistant'; content: string } => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));
}

async function persistCreativeAssistantThread(storage: LoreDockStorage, state: CreativeAssistantState): Promise<void> {
  if (!state.threadId) {
    return;
  }
  const existing = (await storage.listChatThreads()).find((thread) => thread.id === state.threadId);
  await storage.saveChatThread({
    schemaVersion: 1,
    id: state.threadId,
    title: state.threadTitle || existing?.title || '创作助手',
    pinned: existing?.pinned ?? false,
    messages: state.messages.map((message) => ({ role: message.role, content: message.content })),
    draft: state.draft,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso()
  });
}

async function openCreativeAssistant(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  const manifest = await storage.requireManifest();
  const thread = await loadCreativeAssistantThread(storage, manifest.title);
  let state: CreativeAssistantState = {
    threadId: thread.id,
    threadTitle: thread.title,
    workspaceName: vscode.workspace.name || path.basename(storage.workspaceRoot),
    projectTitle: manifest.title,
    messages: toCreativeMessages(thread.messages).length > 0 ? toCreativeMessages(thread.messages) : [{ role: 'assistant', content: creativeAssistantIntroMessage() }],
    draft: thread.draft as CreativeAssistantDraft | undefined,
    busy: false
  };

  showCreativeAssistantPanel(context, state, async (action, update) => {
    if (action.command === 'discard-draft') {
      state = { ...state, draft: undefined, status: '草稿已清空。', error: undefined };
      await persistCreativeAssistantThread(storage, state);
      return state;
    }

    if (action.command === 'send') {
      const text = action.text.trim();
      if (!text) {
        return state;
      }
      state = {
        ...state,
        messages: [...state.messages, { role: 'user', content: text }],
        busy: true,
        status: 'AI 正在整理设定...',
        error: undefined
      };
      update(state);
      await persistCreativeAssistantThread(storage, state);
      try {
        const result = await runCreativeAssistantAI(context, storage, state);
        state = {
          ...state,
          messages: [...state.messages, { role: 'assistant', content: result.message }],
          draft: mergeCreativeDraft(state.draft, result.draft),
          busy: false,
          status: result.structured ? '已生成设定草稿，确认后可以写入项目。' : 'AI 未返回结构化 JSON，已按普通回复保留并提取可用问题。',
          error: undefined
        };
      } catch (error) {
        state = {
          ...state,
          busy: false,
          status: undefined,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      await persistCreativeAssistantThread(storage, state);
      return state;
    }

    if (!state.draft) {
      return { ...state, status: '还没有可应用的设定草稿。' };
    }

    const sections =
      action.command === 'apply-all'
        ? ['project', 'style', 'codex', 'plan'] as const
        : action.command === 'apply-project'
          ? ['project'] as const
          : action.command === 'apply-style'
            ? ['style'] as const
            : action.command === 'apply-plan'
              ? ['plan'] as const
              : ['codex'] as const;
    const applied = await applyCreativeDraft(storage, state.draft, sections);
    manuscriptTree.refresh();
    codexTree.refresh();
    state = {
      ...state,
      projectTitle: (await storage.requireManifest()).title,
      status: `已应用：项目 ${applied.project}，文风 ${applied.style}，资料卡 ${applied.codex}，规划 ${applied.plan}。`,
      error: undefined
    };
    await persistCreativeAssistantThread(storage, state);
    return state;
  });
}

async function runCreativeAssistantAI(
  context: vscode.ExtensionContext,
  storage: LoreDockStorage,
  state: CreativeAssistantState
): Promise<{ message: string; draft: CreativeAssistantDraft; structured: boolean }> {
  const { client } = await createAIClient(context, storage);
  const response = await client.chat({
    taskType: 'worldbuild',
    messages: await buildCreativeAssistantMessages(storage, state),
    temperature: 0.7,
    maxTokens: 2200
  });
  return parseCreativeAssistantResponse(response.content, state);
}

async function buildCreativeAssistantMessages(storage: LoreDockStorage, state: CreativeAssistantState) {
  const manifest = await storage.requireManifest();
  const styleGuide = await storage.readStyleGuide();
  const codex = await storage.listCodexEntries();
  const contextText = JSON.stringify(
    {
      project: {
        title: manifest.title,
        author: manifest.author,
        genre: manifest.genre,
        language: manifest.language,
        defaultStyle: manifest.defaultStyle
      },
      styleGuide,
      existingMemory: buildCreativeMemorySnapshot(codex),
      currentDraft: state.draft ?? null
    },
    null,
    2
  );

  return [
    {
      role: 'system' as const,
      content:
        '你是 LoreDock 的中文长篇小说创作助手。你的任务是通过对话帮助作者从零构建小说项目，并把聊天内容沉淀成可写入项目的结构化草稿。\n' +
        '必须只输出一个 JSON 对象，不要输出 Markdown、代码围栏或额外解释。JSON 结构：\n' +
        '{\n' +
        '  "assistantMessage": "给作者的简短自然语言回复，可继续追问关键问题",\n' +
        '  "draft": {\n' +
        '    "project": {"title": "", "author": "", "genre": "", "language": "zh-CN", "defaultStyle": "", "premise": ""},\n' +
        '    "styleGuide": "# 文风指南\\n\\n...",\n' +
        '    "worldRules": [{"name": "", "category": "", "content": "", "rules": [], "scope": [], "relatedCharacters": [], "relatedLocations": [], "relatedFactions": [], "knownExceptions": [], "importance": "normal|important|absolute", "hidden": false, "tags": [], "sourceRefs": []}],\n' +
        '    "characters": [{"name": "", "identity": "", "fixedSetting": "", "personality": "", "speechStyle": "", "goals": "", "abilities": "", "weaknesses": "", "currentState": "", "relationships": [], "knows": [], "doesNotKnow": [], "secrets": "", "hiddenSecrets": "", "tags": [], "sourceRefs": []}],\n' +
        '    "locations": [{"name": "", "type": "", "region": "", "visualFeatures": "", "atmosphere": "", "history": "", "rules": "", "relatedCharacters": [], "relatedEvents": [], "currentState": "", "secrets": "", "hiddenSecrets": "", "tags": [], "sourceRefs": []}],\n' +
        '    "timelineEvents": [{"name": "", "sequence": 1, "storyTime": "", "chapterId": "", "location": "", "participants": [], "causes": [], "consequences": [], "knownBy": [], "unknownBy": [], "result": "", "visibility": "reader-unknown|character-unknown|public", "tags": [], "sourceRefs": []}],\n' +
        '    "relationships": [{"character": "", "target": "", "type": "", "status": "", "description": "", "reason": "", "knownBy": []}],\n' +
        '    "references": [{"kind": "character|location|world-rule|timeline-event|chapter-summary|conversation", "id": "", "name": "", "reason": ""}],\n' +
        '    "inferences": [{"subject": "", "field": "", "value": "", "basis": [], "confidence": "low|medium|high", "targetKind": "character|location|world-rule|timeline-event", "targetName": "", "sourceRefs": []}],\n' +
        '    "conflicts": [{"severity": "high|medium|low", "title": "", "detail": "", "suggestedFix": "", "sourceRefs": []}],\n' +
        '    "questions": [{"question": "", "why": "", "blocks": []}],\n' +
        '    "outline": [{"title": "", "summary": "", "purpose": "", "viewpointCharacter": "", "location": "", "conflict": "", "outcome": "", "beats": [], "tags": []}],\n' +
        '    "notes": []\n' +
        '  }\n' +
        '}\n' +
        '从零构建是持续多轮访谈：不要限制总共要问几个问题，不要说“先问 3 个问题”或一次列出问题清单；每轮只问 1 个当前最关键的问题，等作者回答后再问下一个。\n' +
        '如果信息不足，assistantMessage 只包含这一个问题；draft.questions 也只放这一个当前待回答的问题。draft 仍要尽量保留已确定的信息。不要编造用户明确否定的设定。\n' +
        '必须区分三层：用户明确确认或本地 existingMemory 中 confirmed 的事实写入资料卡；AI 根据事实推出来的性格、动机、关系倾向只能写入 inferences，并写明 basis/sourceRefs；不确定或会影响长篇一致性的内容写入 questions。\n' +
        '输出角色、国家、力量体系、政治体系、事件和关系时，尽量引用 existingMemory 里的相关人物、地点、规则、时间线事件。发现前后矛盾时写入 conflicts，不要悄悄改掉。\n' +
        '隐藏真相、反转、幕后原因应放入 hiddenSecrets 或 hidden=true 的规则。outline 用于章节/场景规划和 beats。'
    },
    {
      role: 'user' as const,
      content: `当前 LoreDock 项目上下文：\n${contextText}`
    },
    ...state.messages.slice(-12).map((message) => ({
      role: message.role,
      content: message.content
    }))
  ];
}

function buildCreativeMemorySnapshot(entries: CodexEntry[]) {
  const visible = entries.filter((entry) => entry.card.allowInContext !== false);
  return {
    characters: visible
      .filter((entry) => entry.card.kind === 'character')
      .slice(0, 60)
      .map((entry) => {
        const card = entry.card as CharacterCard;
        return {
          id: card.id,
          name: card.name,
          memoryStatus: card.memoryStatus ?? 'draft',
          summary: card.summary,
          tags: card.tags,
          identity: card.identity,
          fixedSetting: card.fixedSetting,
          personality: card.personality,
          goals: card.goals,
          currentState: card.currentState,
          relationships: card.relationships?.filter((relationship) => !relationship.hidden).map((relationship) => ({
            target: relationship.target,
            type: relationship.type,
            status: relationship.status,
            description: relationship.description,
            reason: relationship.reason,
            knownBy: relationship.knownBy
          })),
          knows: card.knows,
          doesNotKnow: card.doesNotKnow,
          sourceRefs: card.sourceRefs,
          inferences: card.inferences?.filter((inference) => inference.status !== 'rejected')
        };
      }),
    locations: visible
      .filter((entry) => entry.card.kind === 'location')
      .slice(0, 40)
      .map((entry) => {
        const card = entry.card as LocationCard;
        return {
          id: card.id,
          name: card.name,
          memoryStatus: card.memoryStatus ?? 'draft',
          summary: card.summary,
          tags: card.tags,
          type: card.type,
          region: card.region,
          atmosphere: card.atmosphere,
          rules: card.rules,
          currentState: card.currentState,
          relatedCharacters: card.relatedCharacters,
          relatedEvents: card.relatedEvents,
          sourceRefs: card.sourceRefs,
          inferences: card.inferences?.filter((inference) => inference.status !== 'rejected')
        };
      }),
    worldRules: visible
      .filter((entry) => entry.card.kind === 'world-rule')
      .filter((entry) => !(entry.card as WorldRule).hidden)
      .slice(0, 60)
      .map((entry) => {
        const card = entry.card as WorldRule;
        return {
          id: card.id,
          name: card.name,
          memoryStatus: card.memoryStatus ?? 'draft',
          summary: card.summary,
          tags: card.tags,
          importance: card.importance,
          category: card.category,
          content: card.content,
          rules: card.rules,
          scope: card.scope,
          relatedCharacters: card.relatedCharacters,
          relatedLocations: card.relatedLocations,
          relatedFactions: card.relatedFactions,
          knownExceptions: card.knownExceptions,
          sourceRefs: card.sourceRefs,
          inferences: card.inferences?.filter((inference) => inference.status !== 'rejected')
        };
      }),
    timelineEvents: visible
      .filter((entry) => entry.card.kind === 'timeline-event')
      .slice(0, 80)
      .map((entry) => {
        const card = entry.card as TimelineEvent;
        return {
          id: card.id,
          name: card.name,
          memoryStatus: card.memoryStatus ?? 'draft',
          summary: card.summary,
          sequence: card.sequence,
          storyTime: card.storyTime,
          chapterId: card.chapterId,
          location: card.location,
          participants: card.participants,
          causes: card.causes,
          consequences: card.consequences,
          knownBy: card.knownBy,
          unknownBy: card.unknownBy,
          result: card.result,
          visibility: card.visibility,
          sourceRefs: card.sourceRefs,
          inferences: card.inferences?.filter((inference) => inference.status !== 'rejected')
        };
      })
  };
}

function parseCreativeAssistantResponse(
  content: string,
  state: CreativeAssistantState
): { message: string; draft: CreativeAssistantDraft; structured: boolean } {
  const raw = stripUtf8Bom(content).trim();
  const json = extractJsonObject(raw);
  if (!json) {
    return parsePlainCreativeAssistantResponse(raw, state, 'AI 这次没有返回结构化 JSON，LoreDock 已把普通回复保存到聊天。');
  }
  try {
    const parsed = JSON.parse(json) as {
      assistantMessage?: string;
      message?: string;
      draft?: CreativeAssistantDraft;
    } & CreativeAssistantDraft;
    const draft = limitQuestionsIfNeeded(normalizeCreativeDraft(parsed.draft ?? parsed), state);
    return {
      message: limitAssistantMessageIfNeeded(
        stringValue(parsed.assistantMessage) || stringValue(parsed.message) || '我整理了一版设定草稿，你可以继续补充或直接应用。',
        state
      ),
      draft,
      structured: true
    };
  } catch (error) {
    return parsePlainCreativeAssistantResponse(
      raw,
      state,
      `AI 返回了类似 JSON 的内容，但解析失败：${error instanceof Error ? error.message : String(error)}。LoreDock 已保留普通回复。`
    );
  }
}

function extractJsonObject(content: string): string | undefined {
  const trimmed = stripUtf8Bom(content).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return candidate.slice(start, end + 1);
}

function parsePlainCreativeAssistantResponse(
  content: string,
  state: CreativeAssistantState,
  note: string
): { message: string; draft: CreativeAssistantDraft; structured: boolean } {
  const message = limitAssistantMessageIfNeeded(content.trim() || '我需要再确认一个关键问题，才能继续沉淀设定。', state);
  const questions = extractPlainQuestions(message, shouldAskOneQuestionAtATime(state) ? 1 : 4);
  const draft = normalizeCreativeDraft({
    questions,
    notes: [
      note,
      questions.length === 0 ? `普通回复摘录：${shortTitle(message, 'AI 普通回复')}` : ''
    ].filter(Boolean)
  });
  return {
    message,
    draft,
    structured: false
  };
}

function extractPlainQuestions(content: string, limit: number): NonNullable<CreativeAssistantDraft['questions']> {
  const rawLines = content
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?=\d+[.、]\s*)/))
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+[.、]\s*/, '')
        .replace(/^问题\s*\d*[:：]\s*/, '')
        .trim()
    )
    .filter(Boolean);
  const questionSignals = /[？?]|什么|谁|如何|为什么|是否|哪|有没有|能否|要不要|想要|希望|属于|核心冲突|主角|世界/;
  const seen = new Set<string>();
  const questions: NonNullable<CreativeAssistantDraft['questions']> = [];
  for (const line of rawLines) {
    if (!questionSignals.test(line) || line.length < 4) {
      continue;
    }
    const normalized = line.replace(/\s+/g, '');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    questions.push({
      question: line,
      why: '来自 AI 普通回复的自动提取，等待作者确认。',
      blocks: ['project', 'worldRules', 'characters', 'outline']
    });
    if (questions.length >= limit) {
      break;
    }
  }
  return questions;
}

function limitQuestionsIfNeeded(draft: CreativeAssistantDraft, state: CreativeAssistantState): CreativeAssistantDraft {
  if (!shouldAskOneQuestionAtATime(state) || (draft.questions?.length ?? 0) <= 1) {
    return draft;
  }
  return {
    ...draft,
    questions: draft.questions?.slice(0, 1),
    notes: [
      ...(draft.notes ?? []),
      '作者要求一个一个问题地问，LoreDock 已只保留第一个待确认问题。'
    ]
  };
}

function limitAssistantMessageIfNeeded(message: string, state: CreativeAssistantState): string {
  if (!shouldAskOneQuestionAtATime(state)) {
    return message;
  }
  const firstQuestion = extractPlainQuestions(message, 1)[0]?.question;
  return firstQuestion || message;
}

function shouldAskOneQuestionAtATime(state: CreativeAssistantState): boolean {
  const latestUser = [...state.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  return /从零|构建|世界观|一个.?一个|一次.?一个|一个问题|逐个|逐步|一步.?一步/.test(latestUser);
}

function normalizeCreativeDraft(value: CreativeAssistantDraft | undefined): CreativeAssistantDraft {
  const draft = value ?? {};
  return {
    project: draft.project ? normalizeProjectDraft(draft.project) : undefined,
    styleGuide: stringValue(draft.styleGuide),
    worldRules: normalizeDraftArray(draft.worldRules, (item) => ({
      name: stringValue(item.name),
      category: stringValue(item.category),
      content: stringValue(item.content),
      rules: stringArray(item.rules),
      scope: stringArray(item.scope),
      relatedCharacters: stringArray(item.relatedCharacters),
      relatedLocations: stringArray(item.relatedLocations),
      relatedFactions: stringArray(item.relatedFactions),
      knownExceptions: stringArray(item.knownExceptions),
      importance: normalizeImportance(item.importance),
      hidden: Boolean(item.hidden),
      tags: stringArray(item.tags),
      sourceRefs: normalizeSourceRefs(item.sourceRefs)
    })),
    characters: normalizeDraftArray(draft.characters, (item) => ({
      name: stringValue(item.name),
      identity: stringValue(item.identity),
      fixedSetting: stringValue(item.fixedSetting),
      personality: stringValue(item.personality),
      speechStyle: stringValue(item.speechStyle),
      goals: stringValue(item.goals),
      abilities: stringValue(item.abilities),
      weaknesses: stringValue(item.weaknesses),
      currentState: stringValue(item.currentState),
      secrets: stringValue(item.secrets),
      hiddenSecrets: stringValue(item.hiddenSecrets),
      relationships: normalizeRelationships(item.relationships, stringValue(item.name)),
      knows: stringArray(item.knows),
      doesNotKnow: stringArray(item.doesNotKnow),
      sourceRefs: normalizeSourceRefs(item.sourceRefs),
      tags: stringArray(item.tags)
    })),
    locations: normalizeDraftArray(draft.locations, (item) => ({
      name: stringValue(item.name),
      type: stringValue(item.type),
      region: stringValue(item.region),
      visualFeatures: stringValue(item.visualFeatures),
      atmosphere: stringValue(item.atmosphere),
      history: stringValue(item.history),
      rules: stringValue(item.rules),
      currentState: stringValue(item.currentState),
      secrets: stringValue(item.secrets),
      hiddenSecrets: stringValue(item.hiddenSecrets),
      relatedCharacters: stringArray(item.relatedCharacters),
      relatedEvents: stringArray(item.relatedEvents),
      sourceRefs: normalizeSourceRefs(item.sourceRefs),
      tags: stringArray(item.tags)
    })),
    timelineEvents: normalizeDraftArray(draft.timelineEvents, (item) => ({
      name: stringValue(item.name),
      sequence: numberValue(item.sequence),
      storyTime: stringValue(item.storyTime),
      chapterId: stringValue(item.chapterId),
      location: stringValue(item.location),
      participants: stringArray(item.participants),
      causes: stringArray(item.causes),
      consequences: stringArray(item.consequences),
      knownBy: stringArray(item.knownBy),
      unknownBy: stringArray(item.unknownBy),
      result: stringValue(item.result),
      visibility: normalizeVisibility(item.visibility),
      tags: stringArray(item.tags),
      sourceRefs: normalizeSourceRefs(item.sourceRefs)
    })),
    relationships: normalizeRelationships(draft.relationships),
    references: normalizeSourceRefs(draft.references),
    inferences: Array.isArray(draft.inferences)
      ? draft.inferences
          .map((item) => ({
            subject: stringValue(item.subject),
            field: stringValue(item.field),
            value: stringValue(item.value),
            basis: stringArray(item.basis),
            confidence: normalizeConfidence(item.confidence),
            targetKind: normalizeInferenceTargetKind(item.targetKind),
            targetName: stringValue(item.targetName),
            sourceRefs: normalizeSourceRefs(item.sourceRefs)
          }))
          .filter((item) => item.subject && item.value)
      : [],
    conflicts: Array.isArray(draft.conflicts)
      ? draft.conflicts
          .map((item) => ({
            severity: normalizeConflictSeverity(item.severity),
            title: stringValue(item.title),
            detail: stringValue(item.detail),
            suggestedFix: stringValue(item.suggestedFix),
            sourceRefs: normalizeSourceRefs(item.sourceRefs)
          }))
          .filter((item) => item.title)
      : [],
    questions: Array.isArray(draft.questions)
      ? draft.questions
          .map((item) => ({
            question: stringValue(item.question),
            why: stringValue(item.why),
            blocks: stringArray(item.blocks)
          }))
          .filter((item) => item.question)
      : [],
    outline: normalizeDraftArray(draft.outline, (item) => ({
      title: stringValue(item.title),
      summary: stringValue(item.summary),
      purpose: stringValue(item.purpose),
      viewpointCharacter: stringValue(item.viewpointCharacter),
      location: stringValue(item.location),
      conflict: stringValue(item.conflict),
      outcome: stringValue(item.outcome),
      beats: stringArray(item.beats),
      tags: stringArray(item.tags),
      name: stringValue(item.title)
    })).map(({ name: _name, ...item }) => item),
    notes: stringArray(draft.notes)
  };
}

function normalizeProjectDraft(project: CreativeAssistantDraft['project']): CreativeAssistantDraft['project'] {
  return {
    title: stringValue(project?.title),
    author: stringValue(project?.author),
    genre: stringValue(project?.genre),
    language: stringValue(project?.language),
    defaultStyle: stringValue(project?.defaultStyle),
    premise: stringValue(project?.premise)
  };
}

function normalizeDraftArray<TInput, TOutput extends { name: string }>(
  value: TInput[] | undefined,
  mapper: (item: TInput) => TOutput
): TOutput[] {
  return Array.isArray(value) ? value.map(mapper).filter((item) => item.name.trim()) : [];
}

function mergeCreativeDraft(
  current: CreativeAssistantDraft | undefined,
  incoming: CreativeAssistantDraft
): CreativeAssistantDraft {
  return {
    project: { ...(current?.project ?? {}), ...(incoming.project ?? {}) },
    styleGuide: incoming.styleGuide || current?.styleGuide,
    worldRules: mergeByName(current?.worldRules, incoming.worldRules),
    characters: mergeByName(current?.characters, incoming.characters),
    locations: mergeByName(current?.locations, incoming.locations),
    timelineEvents: mergeByName(current?.timelineEvents, incoming.timelineEvents),
    relationships: mergeRelationshipsDraft(current?.relationships, incoming.relationships),
    references: mergeSourceRefDrafts(current?.references, incoming.references),
    inferences: mergeInferencesDraft(current?.inferences, incoming.inferences),
    conflicts: mergeByTitle(current?.conflicts, incoming.conflicts),
    questions: incoming.questions?.length ? incoming.questions : current?.questions ?? [],
    outline: mergeByTitle(current?.outline, incoming.outline),
    notes: [...(current?.notes ?? []), ...(incoming.notes ?? [])].filter(Boolean)
  };
}

function mergeByName<T extends { name: string }>(left: T[] | undefined, right: T[] | undefined): T[] {
  const map = new Map<string, T>();
  for (const item of left ?? []) {
    map.set(item.name.trim().toLowerCase(), item);
  }
  for (const item of right ?? []) {
    const key = item.name.trim().toLowerCase();
    map.set(key, { ...(map.get(key) ?? ({} as T)), ...item });
  }
  return [...map.values()];
}

function mergeByTitle<T extends { title: string }>(left: T[] | undefined, right: T[] | undefined): T[] {
  const map = new Map<string, T>();
  for (const item of left ?? []) {
    map.set(item.title.trim().toLowerCase(), item);
  }
  for (const item of right ?? []) {
    const key = item.title.trim().toLowerCase();
    map.set(key, { ...(map.get(key) ?? ({} as T)), ...item });
  }
  return [...map.values()];
}

async function applyCreativeDraft(
  storage: LoreDockStorage,
  draft: CreativeAssistantDraft,
  sections: readonly ('project' | 'style' | 'codex' | 'plan')[]
): Promise<{ project: number; style: number; codex: number; plan: number }> {
  const result = { project: 0, style: 0, codex: 0, plan: 0 };
  if (sections.includes('project') && draft.project) {
    result.project = await applyCreativeProjectDraft(storage, draft.project);
  }
  if (sections.includes('style') && draft.styleGuide) {
    await storage.writeStyleGuide(formatStyleGuide(draft.styleGuide));
    const manifest = await storage.requireManifest();
    const projectStyle = draft.project?.defaultStyle || firstContentLine(draft.styleGuide);
    if (projectStyle) {
      manifest.defaultStyle = projectStyle;
      await storage.writeManifest(manifest);
    }
    result.style = 1;
  }
  if (sections.includes('codex')) {
    result.codex = await applyCreativeCodexDraft(storage, draft);
  }
  if (sections.includes('plan')) {
    result.plan = await applyCreativePlanDraft(storage, draft);
  }
  return result;
}

async function applyCreativeProjectDraft(storage: LoreDockStorage, project: NonNullable<CreativeAssistantDraft['project']>): Promise<number> {
  const manifest = await storage.requireManifest();
  let changed = 0;
  changed += assignIfText(manifest, 'title', project.title);
  changed += assignIfText(manifest, 'author', project.author);
  changed += assignIfText(manifest, 'genre', project.genre);
  changed += assignIfText(manifest, 'language', project.language);
  changed += assignIfText(manifest, 'defaultStyle', project.defaultStyle);
  if (changed > 0) {
    await storage.writeManifest(manifest);
  }
  return changed;
}

async function applyCreativeCodexDraft(storage: LoreDockStorage, draft: CreativeAssistantDraft): Promise<number> {
  let changed = 0;
  const conversationRefs = toCodexSourceRefs(draft.references, '创作助手对话');
  for (const rule of draft.worldRules ?? []) {
    if (!rule.name.trim()) {
      continue;
    }
    const entry = await findCodexByName(storage, 'world-rule', rule.name);
    const card = entry ? entry.card as WorldRule : await storage.createWorldRule({ name: rule.name, detail: rule.content });
    const updated: WorldRule = {
      ...card,
      memoryStatus: 'confirmed',
      summary: card.summary || firstSentence(rule.content),
      category: rule.category || card.category,
      content: rule.content || card.content,
      rules: mergeTags(card.rules ?? [], rule.rules),
      scope: mergeTags(card.scope ?? [], rule.scope),
      relatedCharacters: mergeTags(card.relatedCharacters ?? [], rule.relatedCharacters),
      relatedLocations: mergeTags(card.relatedLocations ?? [], rule.relatedLocations),
      relatedFactions: mergeTags(card.relatedFactions ?? [], rule.relatedFactions),
      knownExceptions: mergeTags(card.knownExceptions ?? [], rule.knownExceptions),
      importance: rule.importance ?? card.importance,
      hidden: typeof rule.hidden === 'boolean' ? rule.hidden : card.hidden,
      tags: mergeTags(card.tags, rule.tags),
      sourceRefs: mergeCodexSourceRefs(card.sourceRefs, toCodexSourceRefs(rule.sourceRefs, '创作助手提取'), conversationRefs)
    };
    await storage.writeCodexEntry(entry?.relativePath ?? await requireCodexPath(storage, card.id), updated);
    changed += 1;
  }
  for (const character of draft.characters ?? []) {
    if (!character.name.trim()) {
      continue;
    }
    const entry = await findCodexByName(storage, 'character', character.name);
    const card = entry ? entry.card as CharacterCard : await storage.createCharacter({ name: character.name, detail: character.identity || character.fixedSetting });
    const updated: CharacterCard = {
      ...card,
      memoryStatus: 'confirmed',
      summary: card.summary || firstSentence(character.identity || character.fixedSetting || character.currentState),
      identity: character.identity || card.identity,
      fixedSetting: character.fixedSetting || card.fixedSetting,
      personality: character.personality || card.personality,
      speechStyle: character.speechStyle || card.speechStyle,
      goals: character.goals || card.goals,
      abilities: character.abilities || card.abilities,
      weaknesses: character.weaknesses || card.weaknesses,
      currentState: character.currentState || card.currentState,
      relationships: mergeCharacterRelationships(card.relationships, toCharacterRelationships(character.relationships ?? [])),
      knows: mergeTags(card.knows ?? [], character.knows),
      doesNotKnow: mergeTags(card.doesNotKnow ?? [], character.doesNotKnow),
      secrets: character.secrets || card.secrets,
      hiddenSecrets: character.hiddenSecrets || card.hiddenSecrets,
      tags: mergeTags(card.tags, character.tags),
      sourceRefs: mergeCodexSourceRefs(card.sourceRefs, toCodexSourceRefs(character.sourceRefs, '创作助手提取'), conversationRefs)
    };
    await storage.writeCodexEntry(entry?.relativePath ?? await requireCodexPath(storage, card.id), updated);
    changed += 1;
  }
  for (const location of draft.locations ?? []) {
    if (!location.name.trim()) {
      continue;
    }
    const entry = await findCodexByName(storage, 'location', location.name);
    const card = entry ? entry.card as LocationCard : await storage.createLocation({ name: location.name, detail: location.type || location.region });
    const updated: LocationCard = {
      ...card,
      memoryStatus: 'confirmed',
      summary: card.summary || firstSentence(location.type || location.region || location.currentState),
      type: location.type || card.type,
      region: location.region || card.region,
      visualFeatures: location.visualFeatures || card.visualFeatures,
      atmosphere: location.atmosphere || card.atmosphere,
      history: location.history || card.history,
      rules: location.rules || card.rules,
      currentState: location.currentState || card.currentState,
      secrets: location.secrets || card.secrets,
      hiddenSecrets: location.hiddenSecrets || card.hiddenSecrets,
      relatedCharacters: mergeTags(card.relatedCharacters, location.relatedCharacters),
      relatedEvents: mergeTags(card.relatedEvents ?? [], location.relatedEvents),
      tags: mergeTags(card.tags, location.tags),
      sourceRefs: mergeCodexSourceRefs(card.sourceRefs, toCodexSourceRefs(location.sourceRefs, '创作助手提取'), conversationRefs)
    };
    await storage.writeCodexEntry(entry?.relativePath ?? await requireCodexPath(storage, card.id), updated);
    changed += 1;
  }
  for (const event of draft.timelineEvents ?? []) {
    if (!event.name.trim()) {
      continue;
    }
    const entry = await findCodexByName(storage, 'timeline-event', event.name);
    const card = entry ? entry.card as TimelineEvent : await storage.createTimelineEvent({ name: event.name, detail: event.result });
    const updated: TimelineEvent = {
      ...card,
      memoryStatus: 'confirmed',
      summary: card.summary || firstSentence(event.result),
      sequence: event.sequence ?? card.sequence,
      storyTime: event.storyTime || card.storyTime,
      chapterId: event.chapterId || card.chapterId,
      location: event.location || card.location,
      participants: mergeTags(card.participants, event.participants),
      causes: mergeTags(card.causes ?? [], event.causes),
      consequences: mergeTags(card.consequences ?? [], event.consequences),
      knownBy: mergeTags(card.knownBy ?? [], event.knownBy),
      unknownBy: mergeTags(card.unknownBy ?? [], event.unknownBy),
      result: event.result || card.result,
      visibility: event.visibility ?? card.visibility,
      tags: mergeTags(card.tags, event.tags),
      sourceRefs: mergeCodexSourceRefs(card.sourceRefs, toCodexSourceRefs(event.sourceRefs, '创作助手提取'), conversationRefs)
    };
    await storage.writeCodexEntry(entry?.relativePath ?? await requireCodexPath(storage, card.id), updated);
    changed += 1;
  }
  changed += await applyCreativeRelationships(storage, draft.relationships ?? []);
  changed += await applyCreativeInferences(storage, draft.inferences ?? [], conversationRefs);
  return changed;
}

async function applyCreativeRelationships(
  storage: LoreDockStorage,
  relationships: NonNullable<CreativeAssistantDraft['relationships']>
): Promise<number> {
  let changed = 0;
  for (const relationship of relationships) {
    if (!relationship.character.trim() || !relationship.target.trim()) {
      continue;
    }
    const entry = await findCodexByName(storage, 'character', relationship.character);
    const card = entry ? entry.card as CharacterCard : await storage.createCharacter({ name: relationship.character });
    const updated: CharacterCard = {
      ...card,
      memoryStatus: card.memoryStatus === 'confirmed' ? card.memoryStatus : 'draft',
      relationships: mergeCharacterRelationships(card.relationships, toCharacterRelationships([relationship]))
    };
    await storage.writeCodexEntry(entry?.relativePath ?? await requireCodexPath(storage, card.id), updated);
    changed += 1;
  }
  return changed;
}

async function applyCreativeInferences(
  storage: LoreDockStorage,
  inferences: NonNullable<CreativeAssistantDraft['inferences']>,
  conversationRefs: CodexSourceRef[]
): Promise<number> {
  let changed = 0;
  for (const inference of inferences) {
    const targetName = inference.targetName || inference.subject;
    const targetKind = inference.targetKind ?? await guessInferenceTargetKind(storage, targetName);
    if (!targetKind || !targetName.trim()) {
      continue;
    }
    const entry = await ensureInferenceTargetEntry(storage, targetKind, targetName);
    if (!entry) {
      continue;
    }
    const timestamp = nowIso();
    const codexInference: CodexInference = {
      subject: inference.subject,
      field: inference.field || 'general',
      value: inference.value,
      basis: inference.basis ?? [],
      confidence: inference.confidence ?? 'medium',
      status: 'pending',
      sourceRefs: mergeCodexSourceRefs(toCodexSourceRefs(inference.sourceRefs, '创作助手推测'), conversationRefs),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await storage.writeCodexEntry(entry.relativePath, {
      ...entry.card,
      inferences: mergeCodexInferences(entry.card.inferences, [codexInference])
    } as CodexCard);
    changed += 1;
  }
  return changed;
}

async function ensureInferenceTargetEntry(
  storage: LoreDockStorage,
  kind: 'character' | 'location' | 'world-rule' | 'timeline-event',
  name: string
): Promise<CodexEntry | undefined> {
  const existing = await findCodexByName(storage, kind, name);
  if (existing) {
    return existing;
  }
  if (kind === 'character') {
    const card = await storage.createCharacter({ name });
    return storage.findCodexEntryById(card.id);
  }
  if (kind === 'location') {
    const card = await storage.createLocation({ name });
    return storage.findCodexEntryById(card.id);
  }
  if (kind === 'world-rule') {
    const card = await storage.createWorldRule({ name });
    return storage.findCodexEntryById(card.id);
  }
  const card = await storage.createTimelineEvent({ name });
  return storage.findCodexEntryById(card.id);
}

async function guessInferenceTargetKind(
  storage: LoreDockStorage,
  name: string
): Promise<'character' | 'location' | 'world-rule' | 'timeline-event' | undefined> {
  for (const kind of ['character', 'location', 'world-rule', 'timeline-event'] as const) {
    if (await findCodexByName(storage, kind, name)) {
      return kind;
    }
  }
  return undefined;
}

function toCharacterRelationships(
  relationships: Array<{ target: string; type?: string; status?: string; description: string; reason?: string; knownBy?: string[] }>
): CharacterRelationship[] {
  return relationships.map((relationship) => ({
    target: relationship.target,
    type: relationship.type,
    status: relationship.status,
    description: relationship.description,
    reason: relationship.reason,
    knownBy: relationship.knownBy ?? [],
    sourceRefs: []
  }));
}

function mergeCharacterRelationships(left: CharacterRelationship[] | undefined, right: CharacterRelationship[] | undefined): CharacterRelationship[] {
  const map = new Map<string, CharacterRelationship>();
  for (const relationship of [...(left ?? []), ...(right ?? [])]) {
    const key = [relationship.target, relationship.type].filter(Boolean).join('|').toLowerCase();
    if (!key) {
      continue;
    }
    map.set(key, {
      ...(map.get(key) ?? { target: relationship.target, description: '' }),
      ...relationship,
      knownBy: mergeTags(map.get(key)?.knownBy ?? [], relationship.knownBy),
      sourceRefs: mergeCodexSourceRefs(map.get(key)?.sourceRefs, relationship.sourceRefs)
    });
  }
  return [...map.values()];
}

function toCodexSourceRefs(
  refs: Array<{ kind: string; id?: string; name?: string; reason?: string }> | undefined,
  fallbackReason: string
): CodexSourceRef[] {
  const normalized = (refs ?? []).map((ref) => ({
    kind: normalizeSourceKind(ref.kind),
    id: stringValue(ref.id),
    name: stringValue(ref.name),
    reason: stringValue(ref.reason) || fallbackReason
  }));
  if (normalized.length > 0) {
    return normalized;
  }
  return [{ kind: 'conversation', reason: fallbackReason }];
}

function normalizeSourceKind(kind: string): CodexSourceRef['kind'] {
  const allowed: CodexSourceRef['kind'][] = [
    'character',
    'location',
    'world-rule',
    'foreshadowing',
    'timeline-event',
    'scene',
    'beat',
    'project',
    'style-guide',
    'chapter',
    'chapter-summary',
    'conversation',
    'manual'
  ];
  return allowed.includes(kind as CodexSourceRef['kind']) ? kind as CodexSourceRef['kind'] : 'conversation';
}

function mergeCodexSourceRefs(...groups: Array<CodexSourceRef[] | undefined>): CodexSourceRef[] {
  const map = new Map<string, CodexSourceRef>();
  for (const ref of groups.flatMap((group) => group ?? [])) {
    const key = [ref.kind, ref.id, ref.name, ref.reason].filter(Boolean).join('|').toLowerCase();
    if (key) {
      map.set(key, ref);
    }
  }
  return [...map.values()];
}

function mergeCodexInferences(left: CodexInference[] | undefined, right: CodexInference[]): CodexInference[] {
  const map = new Map<string, CodexInference>();
  for (const inference of [...(left ?? []), ...right]) {
    const key = [inference.subject, inference.field, inference.value].filter(Boolean).join('|').toLowerCase();
    if (!key) {
      continue;
    }
    map.set(key, {
      ...(map.get(key) ?? inference),
      ...inference,
      basis: mergeTags(map.get(key)?.basis ?? [], inference.basis),
      sourceRefs: mergeCodexSourceRefs(map.get(key)?.sourceRefs, inference.sourceRefs)
    });
  }
  return [...map.values()];
}

function firstSentence(value: string | undefined): string {
  const clean = stringValue(value).replace(/\s+/g, ' ');
  if (!clean) {
    return '';
  }
  return Array.from(clean.split(/[。.!！?？]/)[0] || clean).slice(0, 80).join('');
}

async function applyCreativePlanDraft(storage: LoreDockStorage, draft: CreativeAssistantDraft): Promise<number> {
  let changed = 0;
  for (const item of draft.outline ?? []) {
    if (!item.title.trim()) {
      continue;
    }
    const sceneEntry = await findCodexByName(storage, 'scene', item.title);
    const scene = sceneEntry
      ? sceneEntry.card as ScenePlan
      : await storage.createScene({ name: item.title, detail: item.conflict || item.summary });
    const updatedScene: ScenePlan = {
      ...scene,
      viewpointCharacter: item.viewpointCharacter || scene.viewpointCharacter,
      location: item.location || scene.location,
      conflict: item.conflict || item.summary || scene.conflict,
      turn: item.purpose || scene.turn,
      outcome: item.outcome || scene.outcome,
      tags: mergeTags(scene.tags, item.tags)
    };
    await storage.writeCodexEntry(sceneEntry?.relativePath ?? await requireCodexPath(storage, scene.id), updatedScene);
    changed += 1;

    for (const [index, beat] of (item.beats ?? []).entries()) {
      const name = `${item.title} · Beat ${index + 1}`;
      const beatEntry = await findCodexByName(storage, 'beat', name);
      const beatCard = beatEntry
        ? beatEntry.card as BeatPlan
        : await storage.createBeat({ name, detail: beat });
      const updatedBeat: BeatPlan = {
        ...beatCard,
        sceneId: updatedScene.id,
        content: beat || beatCard.content,
        purpose: item.purpose || beatCard.purpose,
        order: beatCard.order || index + 1,
        status: beatCard.status === 'discarded' ? 'planned' : beatCard.status,
        tags: mergeTags(beatCard.tags, item.tags)
      };
      await storage.writeCodexEntry(beatEntry?.relativePath ?? await requireCodexPath(storage, beatCard.id), updatedBeat);
      changed += 1;
    }
  }
  return changed;
}

async function findCodexByName(storage: LoreDockStorage, kind: CodexCard['kind'], name: string): Promise<CodexEntry | undefined> {
  const normalized = name.trim().toLowerCase();
  return (await storage.listCodexEntries(kind)).find((entry) => entry.card.name.trim().toLowerCase() === normalized);
}

async function requireCodexPath(storage: LoreDockStorage, cardId: string): Promise<string> {
  const entry = await storage.findCodexEntryById(cardId);
  if (!entry) {
    throw new Error(`找不到刚创建的资料卡：${cardId}`);
  }
  return entry.relativePath;
}

function assignIfText<T, K extends keyof T>(target: T, key: K, value: string | undefined): number {
  const next = stringValue(value);
  if (!next || target[key] === next) {
    return 0;
  }
  target[key] = next as T[K];
  return 1;
}

function formatStyleGuide(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '# 文风指南\n\n';
  }
  return trimmed.startsWith('#') ? `${trimmed}\n` : `# 文风指南\n\n${trimmed}\n`;
}

function firstContentLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) ?? '';
}

function normalizeImportance(value: unknown): 'normal' | 'important' | 'absolute' {
  return value === 'absolute' || value === 'normal' || value === 'important' ? value : 'important';
}

function normalizeConfidence(value: unknown): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

function normalizeConflictSeverity(value: unknown): 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function normalizeVisibility(value: unknown): TimelineEvent['visibility'] {
  return value === 'reader-unknown' || value === 'character-unknown' || value === 'public' ? value : 'public';
}

function normalizeInferenceTargetKind(value: unknown): 'character' | 'location' | 'world-rule' | 'timeline-event' | undefined {
  return value === 'character' || value === 'location' || value === 'world-rule' || value === 'timeline-event' ? value : undefined;
}

function normalizeSourceRefs(value: unknown): Array<{ kind: string; id?: string; name?: string; reason?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: Array<{ kind: string; id?: string; name?: string; reason?: string }> = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) {
        refs.push({ kind: 'conversation', name });
      }
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const ref = {
      kind: stringValue(raw.kind) || 'conversation',
      id: stringValue(raw.id),
      name: stringValue(raw.name),
      reason: stringValue(raw.reason)
    };
    if (ref.kind || ref.id || ref.name || ref.reason) {
      refs.push(ref);
    }
  }
  return refs;
}

function normalizeRelationships(value: unknown, fallbackCharacter = ''): Array<{
  character: string;
  target: string;
  type?: string;
  status?: string;
  description: string;
  reason?: string;
  knownBy?: string[];
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  const relationships: Array<{
    character: string;
    target: string;
    type?: string;
    status?: string;
    description: string;
    reason?: string;
    knownBy?: string[];
  }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const relationship = {
      character: stringValue(raw.character) || fallbackCharacter,
      target: stringValue(raw.target),
      type: stringValue(raw.type),
      status: stringValue(raw.status),
      description: stringValue(raw.description),
      reason: stringValue(raw.reason),
      knownBy: stringArray(raw.knownBy)
    };
    if (relationship.character && relationship.target && relationship.description) {
      relationships.push(relationship);
    }
  }
  return relationships;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mergeTags(left: string[], right: string[] | undefined): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])].map((tag) => tag.trim()).filter(Boolean))];
}

function mergeSourceRefDrafts<T extends { kind: string; id?: string; name?: string; reason?: string }>(
  left: T[] | undefined,
  right: T[] | undefined
): T[] {
  const map = new Map<string, T>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const key = [item.kind, item.id, item.name, item.reason].filter(Boolean).join('|').toLowerCase();
    if (key) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

function mergeRelationshipsDraft<T extends { character: string; target: string; type?: string; description: string }>(
  left: T[] | undefined,
  right: T[] | undefined
): T[] {
  const map = new Map<string, T>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const key = [item.character, item.target, item.type].filter(Boolean).join('|').toLowerCase();
    if (key) {
      map.set(key, { ...(map.get(key) ?? ({} as T)), ...item });
    }
  }
  return [...map.values()];
}

function mergeInferencesDraft<T extends { subject: string; field?: string; value: string }>(
  left: T[] | undefined,
  right: T[] | undefined
): T[] {
  const map = new Map<string, T>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const key = [item.subject, item.field, item.value].filter(Boolean).join('|').toLowerCase();
    if (key) {
      map.set(key, { ...(map.get(key) ?? ({} as T)), ...item });
    }
  }
  return [...map.values()];
}

function mergeQuestionsDraft<T extends { question: string }>(left: T[] | undefined, right: T[] | undefined): T[] {
  const map = new Map<string, T>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const key = item.question.trim().toLowerCase();
    if (key) {
      map.set(key, { ...(map.get(key) ?? ({} as T)), ...item });
    }
  }
  return [...map.values()];
}

async function initProject(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  const workspaceName = vscode.workspace.name ?? 'Untitled Novel';
  const exists = await storage.manifestExists();
  let force = false;
  if (exists) {
    const answer = await vscode.window.showWarningMessage(
      '当前 workspace 已经是 LoreDock 项目。重新初始化会覆盖 project.json，但不会删除已有正文和资料卡。',
      { modal: true },
      '重新初始化'
    );
    if (answer !== '重新初始化') {
      return;
    }
    force = true;
  }

  await storage.initializeProject({
    title: workspaceName,
    author: '',
    genre: '',
    language: 'zh-CN',
    defaultStyle: '第三人称，中文长篇小说，保持设定一致，不提前揭露秘密。',
    createSamples: false,
    force
  });
  manuscriptTree.refresh();
  codexTree.refresh();
  vscode.window.showInformationMessage('LoreDock 小说项目已初始化。可以从手稿栏“更多操作”打开创作助手，用聊天方式补标题、文风和设定。');
}

async function createVolume(getStorage: () => LoreDockStorage | undefined, manuscriptTree: ManuscriptTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  const manifest = await storage.requireManifest();
  const title = `第${manifest.volumes.length + 1}卷`;
  await storage.createVolume(title);
  manuscriptTree.refresh();
}

async function deleteProject(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const manifest = isProjectNode(node) ? node.manifest : await storage.requireManifest();
  const warning = await vscode.window.showWarningMessage(
    `确认删除书籍“${manifest.title}”？这会删除 .loredock、manuscript 和 codex，workspace 里的其他文件不会被删除。`,
    { modal: true },
    '继续删除'
  );
  if (warning !== '继续删除') {
    return;
  }
  const typed = await vscode.window.showInputBox({
    title: '确认删除书籍',
    prompt: `请输入书名“${manifest.title}”确认删除`,
    ignoreFocusOut: true
  });
  if (typed !== manifest.title) {
    vscode.window.showInformationMessage('书名不匹配，已取消删除。');
    return;
  }
  await storage.deleteProject();
  manuscriptTree.refresh();
  codexTree.refresh();
  vscode.window.showInformationMessage(`已删除书籍“${manifest.title}”的 LoreDock 项目文件。`);
}

async function deleteVolume(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const volume = isVolumeNode(node) ? node.volume : await pickVolume(await storage.requireManifest());
  if (!volume) {
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `确认删除卷“${volume.title}”？这会删除该卷下 ${volume.chapters.length} 个章节文件。`,
    { modal: true },
    '删除'
  );
  if (answer !== '删除') {
    return;
  }
  await storage.deleteVolume(volume.id);
  manuscriptTree.refresh();
}

async function createChapter(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const manifest = await storage.requireManifest();
  const volume = isVolumeNode(node) ? node.volume : await pickVolume(manifest);
  if (!volume) {
    return;
  }
  const title = `第${volume.chapters.length + 1}章`;
  const chapter = await storage.createChapter(volume.id, title);
  manuscriptTree.refresh();
  await openChapterByMeta(storage, chapter);
}

async function openChapter(getStorage: () => LoreDockStorage | undefined, node?: unknown): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = isChapterNode(node) ? { volume: node.volume, chapter: node.chapter } : await pickChapter(storage);
  if (!ref) {
    return;
  }
  await openChapterByMeta(storage, ref.chapter);
}

async function renameChapter(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = isChapterNode(node) ? { volume: node.volume, chapter: node.chapter } : await pickChapter(storage);
  if (!ref) {
    return;
  }
  const title = await promptInput('新的章节标题', ref.chapter.title);
  if (!title) {
    return;
  }
  await storage.renameChapter(ref.chapter.id, title);
  manuscriptTree.refresh();
}

async function setChapterStatus(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = isChapterNode(node) ? { volume: node.volume, chapter: node.chapter } : await pickChapter(storage);
  if (!ref) {
    return;
  }
  const statuses: Array<{ label: string; status: ChapterStatus }> = [
    { label: '计划中', status: 'planned' },
    { label: '正在写', status: 'drafting' },
    { label: '初稿完成', status: 'draft-complete' },
    { label: '待润色', status: 'needs-polish' },
    { label: '待检查', status: 'needs-check' },
    { label: '完成', status: 'complete' },
    { label: '废弃', status: 'abandoned' }
  ];
  const picked = await vscode.window.showQuickPick(statuses, {
    placeHolder: `设置“${ref.chapter.title}”的章节状态`
  });
  if (!picked) {
    return;
  }
  await storage.updateChapterStatus(ref.chapter.id, picked.status);
  manuscriptTree.refresh();
}

async function deleteChapter(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = isChapterNode(node) ? { volume: node.volume, chapter: node.chapter } : await pickChapter(storage);
  if (!ref) {
    return;
  }
  const answer = await vscode.window.showWarningMessage(`确认删除章节“${ref.chapter.title}”？此操作会删除对应 Markdown 文件。`, { modal: true }, '删除');
  if (answer !== '删除') {
    return;
  }
  await storage.deleteChapter(ref.chapter.id);
  manuscriptTree.refresh();
}

async function createCharacter(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const name = await nextDraftName(storage, 'character', '未命名人物');
  const card = await storage.createCharacter({ name });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function createLocation(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const name = await nextDraftName(storage, 'location', '未命名地点');
  const card = await storage.createLocation({ name });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function createWorldRule(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const name = await nextDraftName(storage, 'world-rule', '未命名规则');
  const card = await storage.createWorldRule({ name });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function createForeshadowing(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'foreshadowing', '未命名伏笔');
  const card = await storage.createForeshadowing({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function createTimelineEvent(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'timeline-event', '未命名事件');
  const card = await storage.createTimelineEvent({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function createScene(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'scene', '未命名场景');
  const card = await storage.createScene({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function createBeat(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'beat', '未命名 Beat');
  const card = await storage.createBeat({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  await openCreatedCodexCard(storage, card.id);
}

async function openCodexEntry(getStorage: () => LoreDockStorage | undefined, node?: unknown): Promise<void> {
  const storage = requireStorage(getStorage);
  if (isCodexEntryNode(node)) {
    await openCodexPath(storage, node.entry.relativePath);
    return;
  }
  const entries = await storage.listCodexEntries();
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.card.name,
      description: entry.card.kind,
      detail: formatCodexSearchDetail(entry),
      entry
    })),
    { placeHolder: '选择资料卡' }
  );
  if (picked) {
    await openCodexPath(storage, picked.entry.relativePath);
  }
}

async function deleteCodexEntry(
  getStorage: () => LoreDockStorage | undefined,
  codexTree: CodexTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const entry = isCodexEntryNode(node) ? node.entry : await pickCodexEntry(storage, { placeHolder: '选择要删除的资料卡' });
  if (!entry) {
    return;
  }
  const answer = await vscode.window.showWarningMessage(`确认删除资料卡“${entry.card.name}”？`, { modal: true }, '删除');
  if (answer !== '删除') {
    return;
  }
  await storage.deleteCodexEntry(entry.relativePath);
  codexTree.refresh();
}

async function editCodexEntryForm(
  getStorage: () => LoreDockStorage | undefined,
  codexTree: CodexTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const entry = isCodexEntryNode(node) ? await storage.readCodexEntry(node.entry.relativePath) : await pickCodexEntry(storage, { placeHolder: '选择要表单编辑的资料卡' });
  if (!entry) {
    return;
  }
  const updated = await showCodexFormPanel(entry.card);
  if (!updated) {
    return;
  }
  await storage.writeCodexEntry(entry.relativePath, updated);
  codexTree.refresh();
  vscode.window.showInformationMessage(`已保存资料卡：${updated.name}`);
}

async function filterCodexEntries(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const entries = await storage.listCodexEntries();
  if (entries.length === 0) {
    vscode.window.showInformationMessage('资料库还没有卡片。');
    return;
  }
  const tags = [...new Set(entries.flatMap((entry) => entry.card.tags))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const kinds = [...new Set(entries.map((entry) => entry.card.kind))].sort();
  const filters: Array<{ label: string; description?: string; match: (entry: CodexEntry) => boolean }> = [
    { label: '全部资料卡', description: `${entries.length} 张`, match: () => true },
    ...kinds.map((kind) => ({
      label: `类型：${kindLabel(kind)}`,
      description: kind,
      match: (entry: CodexEntry) => entry.card.kind === kind
    })),
    ...tags.map((tag) => ({
      label: `标签：${tag}`,
      description: `${entries.filter((entry) => entry.card.tags.includes(tag)).length} 张`,
      match: (entry: CodexEntry) => entry.card.tags.includes(tag)
    })),
    {
      label: '不会进入 AI 上下文',
      description: `${entries.filter((entry) => entry.card.allowInContext === false).length} 张`,
      match: (entry: CodexEntry) => entry.card.allowInContext === false
    }
  ];
  const filter = await vscode.window.showQuickPick(filters, { placeHolder: '选择资料库筛选条件' });
  if (!filter) {
    return;
  }
  const matched = entries.filter(filter.match);
  const picked = await vscode.window.showQuickPick(
    matched.map((entry) => ({
      label: entry.card.name,
      description: kindLabel(entry.card.kind),
      detail: formatCodexSearchDetail(entry),
      entry
    })),
    { placeHolder: `${filter.label} · ${matched.length} 张` }
  );
  if (picked) {
    await openCodexPath(storage, picked.entry.relativePath);
  }
}

async function showForeshadowingBoard(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const cards = (await storage.listCodexEntries('foreshadowing')).map((entry) => entry.card as ForeshadowingCard);
  const statuses: ForeshadowingCard['status'][] = ['planned', 'seeded', 'developing', 'resolved', 'abandoned'];
  const risks = cards.filter((card) => (card.status === 'seeded' || card.status === 'developing') && !card.expectedResolveChapterId);
  const lines = [
    '# LoreDock 伏笔看板',
    '',
    `总数：${cards.length}`,
    risks.length ? `需要补回收计划：${risks.map((card) => card.name).join('、')}` : '需要补回收计划：无',
    '',
    ...statuses.flatMap((status) => formatForeshadowingSection(status, cards.filter((card) => card.status === status)))
  ];
  await showMarkdownDocument('LoreDock 伏笔看板', lines.join('\n'));
}

async function showTimelineBoard(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapterNames = await chapterNameMap(storage);
  const events = (await storage.listCodexEntries('timeline-event'))
    .map((entry) => entry.card as TimelineEvent)
    .sort((a, b) => (a.storyTime || '').localeCompare(b.storyTime || '', 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const lines = [
    '# LoreDock 时间线看板',
    '',
    `总事件：${events.length}`,
    '',
    ...events.map((event) =>
      [
        `## ${event.storyTime || '未填写时间'} · ${event.name}`,
        `- 章节：${event.chapterId ? chapterNames.get(event.chapterId) || event.chapterId : '未关联'}`,
        `- 地点：${event.location || '未填写'}`,
        `- 参与人物：${event.participants.length ? event.participants.join('、') : '未填写'}`,
        `- 可见性：${event.visibility}`,
        `- 结果：${event.result || '未填写'}`,
        ''
      ].join('\n')
    )
  ];
  await showMarkdownDocument('LoreDock 时间线看板', lines.join('\n'));
}

async function showSceneBeatBoard(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const refs = await storage.getFlatChapterRefs();
  const scenes = (await storage.listCodexEntries('scene')).map((entry) => entry.card as ScenePlan);
  const beats = (await storage.listCodexEntries('beat')).map((entry) => entry.card as BeatPlan);
  const lines = ['# LoreDock 场景 / Beat 看板', ''];
  for (const ref of refs) {
    const chapterScenes = scenes.filter((scene) => scene.chapterId === ref.chapter.id).sort((a, b) => a.order - b.order);
    const chapterBeats = beats.filter((beat) => beat.chapterId === ref.chapter.id).sort((a, b) => a.order - b.order);
    lines.push(`## ${ref.volume.title} / ${ref.chapter.title}`, '');
    lines.push('### 场景');
    lines.push(...(chapterScenes.length ? chapterScenes.map(formatSceneLine) : ['- 无']));
    lines.push('', '### Beat');
    lines.push(...(chapterBeats.length ? chapterBeats.map(formatBeatLine) : ['- 无']), '');
  }
  const orphanScenes = scenes.filter((scene) => !scene.chapterId);
  const orphanBeats = beats.filter((beat) => !beat.chapterId);
  if (orphanScenes.length || orphanBeats.length) {
    lines.push('## 未关联章节', '');
    lines.push('### 场景', ...(orphanScenes.length ? orphanScenes.map(formatSceneLine) : ['- 无']), '');
    lines.push('### Beat', ...(orphanBeats.length ? orphanBeats.map(formatBeatLine) : ['- 无']), '');
  }
  await showMarkdownDocument('LoreDock 场景 / Beat 看板', lines.join('\n'));
}

async function normalizeSceneOrder(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  const scope = await pickOrderScope(storage, '场景');
  if (scope === null) {
    return;
  }
  const count = await storage.normalizeSceneOrders(scope);
  codexTree.refresh();
  vscode.window.showInformationMessage(`已整理 ${count} 个场景顺序。`);
}

async function normalizeBeatOrder(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  const scope = await pickOrderScope(storage, 'Beat');
  if (scope === null) {
    return;
  }
  const count = await storage.normalizeBeatOrders(scope);
  codexTree.refresh();
  vscode.window.showInformationMessage(`已整理 ${count} 个 Beat 顺序。`);
}

async function reviewPendingCodexUpdates(
  getStorage: () => LoreDockStorage | undefined,
  codexTree: CodexTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  const summaries = await storage.listSummaries();
  if (summaries.length === 0) {
    vscode.window.showInformationMessage('还没有已保存的章节摘要。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    summaries.map((summary) => ({
      label: summary.chapterTitle,
      description: summary.oneLineSummary,
      detail: summary.updatedAt,
      summary
    })),
    { placeHolder: '选择要应用资料库建议的章节摘要' }
  );
  if (!picked) {
    return;
  }
  const suggestions = collectSummarySuggestions(picked.summary);
  if (suggestions.length === 0) {
    vscode.window.showInformationMessage('这个摘要没有可应用的资料库更新建议。');
    return;
  }
  let applied = 0;
  for (const suggestion of suggestions) {
    const answer = await vscode.window.showQuickPick(
      [
        { label: '接受并写入资料库', action: 'accept' as const },
        { label: '跳过这一条', action: 'skip' as const },
        { label: '停止处理', action: 'stop' as const }
      ],
      { placeHolder: `${suggestion.label}：${suggestion.value}` }
    );
    if (!answer || answer.action === 'stop') {
      break;
    }
    if (answer.action === 'skip') {
      continue;
    }
    const changed = await applySummarySuggestion(storage, picked.summary, suggestion);
    if (changed) {
      applied += 1;
    }
  }
  codexTree.refresh();
  vscode.window.showInformationMessage(`摘要建议处理完成，已写入 ${applied} 条。`);
}

async function openSettings(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  aiStatus: AIStatusRefreshTarget
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  showSettingsPanel(context, await loadSettingsPanelState(storage), async (action) => {
    await handleSettingsPanelAction(context, getStorage, storage, aiStatus, action);
    return loadSettingsPanelState(storage);
  });
}

async function handleSettingsPanelAction(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  storage: LoreDockStorage,
  aiStatus: AIStatusRefreshTarget,
  action: SettingsPanelAction
): Promise<void> {
  if (action.command === 'save') {
    await saveSettingsPanelState(storage, action.config, action.envValues);
    aiStatus.refresh();
    vscode.window.showInformationMessage('LoreDock AI 设置已保存。');
    return;
  }
  if (action.command === 'select-model') {
    await vscode.commands.executeCommand('loredock.showAIModelPicker');
    return;
  }
  if (action.command === 'preflight') {
    await preflightAIRequest(context, getStorage);
    return;
  }
  if (action.command === 'test') {
    await testAIConnection(context, getStorage);
    return;
  }
  if (action.command === 'configure-openrouter') {
    await configureOpenRouter(getStorage, false, aiStatus);
    return;
  }
  if (action.command === 'configure-claude-cli') {
    await configureFromClaudeCli(getStorage, false, aiStatus);
    return;
  }
  if (action.command === 'open-files') {
    await configureAI(getStorage);
  }
}

async function loadSettingsPanelState(storage: LoreDockStorage): Promise<SettingsPanelState> {
  return {
    workspaceName: vscode.workspace.name || path.basename(storage.workspaceRoot),
    config: await storage.readAIConfig(),
    envValues: await storage.readAIEnv()
  };
}

async function saveSettingsPanelState(storage: LoreDockStorage, config: AIConfigFile, envValues: Record<string, string>): Promise<void> {
  const sanitizedProviders = { ...config.providers };
  for (const provider of Object.keys(sanitizedProviders) as AIProvider[]) {
    const providerConfig = sanitizedProviders[provider];
    if (providerConfig) {
      providerConfig.apiKey = '';
    }
  }
  await storage.writeAIConfig({
    ...config,
    schemaVersion: 1,
    providers: sanitizedProviders
  });
  await writeAIEnvValues(storage, envValues);
}

async function configureAI(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await openAIConfigFiles(storage);
  const answer = await vscode.window.showInformationMessage(
    '已打开 AI 配置文件和本地 key 文件。可以在 ai.env 里填写 ANTHROPIC_API_KEY= 或 OPENROUTER_API_KEY=，保存后再选择模型。',
    '选择 AI 模型'
  );
  if (answer === '选择 AI 模型') {
    await vscode.commands.executeCommand('loredock.showAIModelPicker');
  }
}

async function configureOpenRouter(
  getStorage: () => LoreDockStorage | undefined,
  openFiles = true,
  aiStatus?: AIStatusRefreshTarget
): Promise<void> {
  const storage = requireStorage(getStorage);
  const config = await storage.configureOpenRouterProfile();
  if (openFiles) {
    await openAIConfigFiles(storage);
  }
  const envValues = await storage.readAIEnv();
  const hasKey = Boolean(resolveApiKey(config.providers.openrouter, 'openrouter', envValues));
  aiStatus?.refresh();
  const answer = await vscode.window.showInformationMessage(
    hasKey
      ? '已切换到 OpenRouter。请确认 key 后可以选择模型。'
      : '已切换到 OpenRouter。请先在 ai.env 的 OPENROUTER_API_KEY= 或 ANTHROPIC_API_KEY= 后填入你的 sk key。',
    hasKey ? '选择 AI 模型' : '知道了'
  );
  if (answer === '选择 AI 模型') {
    await vscode.commands.executeCommand('loredock.showAIModelPicker');
  }
}

async function configureFromClaudeCli(
  getStorage: () => LoreDockStorage | undefined,
  openFiles = true,
  aiStatus?: AIStatusRefreshTarget
): Promise<void> {
  const storage = requireStorage(getStorage);
  const profile = await readClaudeCliProfile();
  if (!profile.baseUrl || !profile.apiKey) {
    throw new Error('没有在 ~/.claude/settings.json 里读到 ANTHROPIC_BASE_URL 和 ANTHROPIC_API_KEY。');
  }
  const config = await storage.readAIConfig();
  config.activeProvider = 'claude';
  config.providers.claude = {
    baseUrl: profile.baseUrl,
    model: profile.model || config.providers.claude?.model || '',
    apiKey: '',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    temperature: config.providers.claude?.temperature ?? 0.7,
    maxOutputTokens: config.providers.claude?.maxOutputTokens ?? 1200,
    timeoutMs: config.providers.claude?.timeoutMs ?? 60000
  };
  await storage.writeAIConfig(config);
  await storage.ensureAIEnvFile();
  await upsertAIEnvValue(storage, 'ANTHROPIC_API_KEY', profile.apiKey);
  if (openFiles) {
    await openAIConfigFiles(storage);
  }
  aiStatus?.refresh();
  vscode.window.showInformationMessage(`已切换到 Claude CLI 代理：${profile.baseUrl}${profile.model ? `，模型：${profile.model}` : ''}`);
}

async function openAIConfigFiles(storage: LoreDockStorage): Promise<void> {
  const configPath = await storage.ensureAIConfigFile();
  const envPath = await storage.ensureAIEnvFile();
  const configDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(configPath)));
  await vscode.window.showTextDocument(configDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
  const envDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(envPath)));
  await vscode.window.showTextDocument(envDocument, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

async function listAvailableAIModels(getStorage: () => LoreDockStorage | undefined): Promise<ModelInfo[]> {
  const storage = requireStorage(getStorage);
  const { client, settings } = await createAIClient(undefined, storage, { allowMissingModel: true });
  if (await offerOpenRouterSwitchForLocalDefault(getStorage, settings)) {
    throw new Error('已切换到 OpenRouter，请保存 key 后重新读取模型。');
  }
  const models = await client.listModels();
  if (models.length === 0) {
    throw new Error('没有读取到可用模型。请检查 baseUrl、apiKey 和 provider。');
  }
  return models;
}

async function selectAIModel(getStorage: () => LoreDockStorage | undefined, aiStatus?: AIStatusRefreshTarget): Promise<void> {
  const storage = requireStorage(getStorage);
  const config = await storage.readAIConfig();
  const provider = config.activeProvider;
  const models = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `LoreDock 正在读取 ${provider} 可用模型...` },
    () => listAvailableAIModels(getStorage)
  );
  const picked = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.id,
      description: model.label && model.label !== model.id ? model.label : undefined,
      model
    })),
    { placeHolder: `选择 ${provider} 模型` }
  );
  if (!picked) {
    return;
  }
  await storage.updateActiveAIModel(picked.model.id);
  aiStatus?.refresh();
  vscode.window.showInformationMessage(`已选择模型：${picked.model.id}`);
}

async function testAIConnection(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = getStorage();
  const { client, settings } = await createAIClient(context, storage, { allowMissingModel: true });
  if (storage && (await offerOpenRouterSwitchForLocalDefault(getStorage, settings))) {
    return;
  }
  if (!settings.model.trim()) {
    throw new Error('请先在 ai.local.jsonc 中填写 model，或运行“选择 AI 模型”。');
  }
  const response = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'LoreDock 正在测试 AI 连接...' },
    () => client.testConnection()
  );

  if (storage && (await storage.manifestExists())) {
    await storage.appendHistory({
      schemaVersion: 1,
      id: makeId('ai-test'),
      taskType: 'test',
      model: response.model || settings.model,
      provider: settings.provider,
      userInstruction: 'connection test',
      contextPreview: 'connection test',
      output: response.content,
      action: 'test',
      createdAt: nowIso(),
      latencyMs: response.latencyMs
    });
  }

  vscode.window.showInformationMessage(`AI 连接成功：${response.model || settings.model}，耗时 ${response.latencyMs} ms。`);
}

async function diagnoseAIConfig(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const config = await storage.readAIConfig();
  const envValues = await storage.readAIEnv();
  const provider = config.activeProvider;
  const canonicalProvider = provider === 'anthropic' ? 'claude' : provider;
  const providerConfig = config.providers[provider] ?? (provider === 'anthropic' ? config.providers.claude : undefined);
  const keyResolution = resolveApiKeyInfo(providerConfig, canonicalProvider, envValues);
  const candidates = keyEnvCandidates(providerConfig, canonicalProvider);
  const baseUrl = providerConfig?.baseUrl ?? '';
  const authRequired = providerConfig ? requiresApiKey(canonicalProvider, baseUrl) : false;
  const requestAuth = describeRequestAuth(canonicalProvider, keyResolution.value);
  const lines = [
    '# LoreDock AI 配置诊断',
    '',
    `- workspace: ${storage.workspaceRoot}`,
    `- activeProvider: ${provider}`,
    `- 实际请求类型: ${canonicalProvider}`,
    `- baseUrl: ${baseUrl || '未填写'}`,
    `- model: ${providerConfig?.model || '未选择'}`,
    `- apiKeyEnv: ${providerConfig?.apiKeyEnv || '未填写'}`,
    `- provider.apiKey: ${providerConfig?.apiKey?.trim() ? '已填写' : '未填写'}`,
    `- 当前接口是否需要 key: ${authRequired ? '是' : '否'}`,
    `- 已解析 key: ${keyResolution.value ? `是，来源 ${keyResolution.source}，${maskSecret(keyResolution.value)}` : '否'}`,
    `- 请求认证方式: ${requestAuth}`,
    '',
    '## 环境变量候选',
    ...formatEnvCandidates(candidates, envValues),
    '',
    '## 判断',
    ...diagnoseWarnings({
      provider,
      canonicalProvider,
      baseUrl,
      authRequired,
      keySource: keyResolution.source,
      keyValue: keyResolution.value
    })
  ];
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `${lines.join('\n')}\n`
  });
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

async function preflightAIRequest(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = getStorage();
  const { client, settings } = await createAIClient(context, storage, { allowMissingModel: true });
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'LoreDock 正在做 AI 请求预检...' },
    () => client.preflight()
  );
  const lines = [
    '# LoreDock AI 请求预检',
    '',
    `- provider: ${result.provider}`,
    `- baseUrl: ${settings.baseUrl}`,
    `- model: ${settings.model || '未选择'}`,
    `- url: ${result.url}`,
    `- auth: ${result.authHeader}`,
    `- key: ${result.keyPreview}`,
    `- status: ${result.status ? `${result.status} ${result.statusText || ''}`.trim() : '未收到 HTTP 响应'}`,
    `- result: ${result.ok ? '通过' : '失败'}`,
    '',
    '## 服务端响应 / 错误',
    '',
    '```text',
    result.responsePreview || result.error || '无',
    '```',
    '',
    '## 判断',
    '',
    ...preflightAdvice(result)
  ];
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `${lines.join('\n')}\n`
  });
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

async function openStyleGuide(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const relativePath = await storage.ensureStyleGuideFile();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(relativePath)));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function configureExportStyle(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const relativePath = await storage.ensureExportStyleFile();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(relativePath)));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function setWritingGoals(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const goals = await storage.readWritingGoals();
  const daily = await vscode.window.showInputBox({
    title: '每日目标字数',
    value: String(goals.dailyWordTarget),
    ignoreFocusOut: true,
    validateInput: validateNonNegativeInteger
  });
  if (daily === undefined) {
    return;
  }
  const total = await vscode.window.showInputBox({
    title: '全书目标字数',
    value: String(goals.totalWordTarget),
    ignoreFocusOut: true,
    validateInput: validateNonNegativeInteger
  });
  if (total === undefined) {
    return;
  }
  await storage.writeWritingGoals({
    schemaVersion: 1,
    dailyWordTarget: Number(daily),
    totalWordTarget: Number(total),
    updatedAt: nowIso()
  });
  vscode.window.showInformationMessage('写作目标已更新。');
}

async function importManuscript(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: {
      'Markdown / TXT / DOCX': ['md', 'markdown', 'txt', 'docx']
    },
    openLabel: '导入手稿'
  });
  const uri = picked?.[0];
  if (!uri) {
    return;
  }
  const buffer = Buffer.from(await vscode.workspace.fs.readFile(uri));
  const chapters = path.extname(uri.fsPath).toLowerCase() === '.docx'
    ? await storage.importDocxManuscript(uri.fsPath, buffer)
    : await storage.importManuscript(uri.fsPath, decodeTextBuffer(buffer));
  manuscriptTree.refresh();
  vscode.window.showInformationMessage(`已导入 ${chapters.length} 个章节。`);
  if (chapters[0]) {
    await openChapterByMeta(storage, chapters[0]);
  }
}

async function exportManuscript(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const formats: Array<{ label: string; description: string; format: ExportFormat }> = [
    { label: 'Markdown', description: '导出到 exports/*.md', format: 'markdown' },
    { label: 'TXT', description: '导出到 exports/*.txt', format: 'txt' },
    { label: 'DOCX', description: '导出到 exports/*.docx', format: 'docx' },
    { label: 'EPUB', description: '导出到 exports/*.epub', format: 'epub' },
    { label: 'PDF', description: '导出到 exports/*.pdf', format: 'pdf' }
  ];
  const picked = await vscode.window.showQuickPick(
    formats,
    { placeHolder: '选择导出格式' }
  );
  if (!picked) {
    return;
  }
  const relativePath = await storage.exportManuscript(picked.format);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(relativePath)));
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage(`已导出：${relativePath}`);
}

async function offerOpenRouterSwitchForLocalDefault(
  getStorage: () => LoreDockStorage | undefined,
  settings: AISettings
): Promise<boolean> {
  if (!isDefaultLocalCompatibleConfig(settings)) {
    return false;
  }
  const answer = await vscode.window.showWarningMessage(
    '当前 AI 配置仍是默认本地 LM Studio 地址：http://localhost:1234/v1。如果你使用的是一个 sk 开头、可选择 GPT/Claude/DeepSeek 的多模型 key，应该切到 OpenRouter 或模型路由平台。',
    '切到 OpenRouter',
    '继续使用本地'
  );
  if (answer !== '切到 OpenRouter') {
    return false;
  }
  await configureOpenRouter(getStorage);
  return true;
}

function isDefaultLocalCompatibleConfig(settings: AISettings): boolean {
  const normalized = settings.baseUrl.replace(/\/+$/, '').toLowerCase();
  return settings.provider === 'openai-compatible' && (normalized === 'http://localhost:1234/v1' || normalized === 'http://127.0.0.1:1234/v1');
}

async function showWritingStats(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  showStatsPanel(await storage.getWritingStats());
}

async function showAIHistory(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const action = await showHistoryPanel(await storage.listHistory(80));
  if (action !== 'clear') {
    return;
  }
  const answer = await vscode.window.showWarningMessage('确认清空 LoreDock AI 历史？', { modal: true }, '清空');
  if (answer === '清空') {
    await storage.clearHistory();
    vscode.window.showInformationMessage('AI 历史已清空。');
  }
}

async function continueChapter(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = await resolveChapter(storage, node);
  if (!ref) {
    return;
  }
  const editor = await openChapterByMeta(storage, ref.chapter);
  const instruction = (await promptInput('续写要求', '自然接上当前章节末尾，推进当前场景。')) ?? '';

  await runWritingTaskWithResult({
    context,
    storage,
    ref,
    taskTitle: '续写当前章节',
    taskType: 'continue',
    instruction,
    buildMessages: buildContinuationMessages,
    mode: 'continue',
    apply: async (action) => {
      if (action.kind === 'append') {
        await editor.edit((edit) => {
          const end = editor.document.positionAt(editor.document.getText().length);
          edit.insert(end, `\n\n${action.content.trim()}\n`);
        });
      } else if (action.kind === 'insert') {
        await editor.edit((edit) => edit.insert(editor.selection.active, action.content.trim()));
      } else if (action.kind === 'copy') {
        await vscode.env.clipboard.writeText(action.content);
      }
    }
  });
  manuscriptTree.refresh();
}

async function expandBeat(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const entry =
    isCodexEntryNode(node) && node.entry.card.kind === 'beat'
      ? await storage.readCodexEntry(node.entry.relativePath)
      : await pickCodexEntry(storage, { kind: 'beat', placeHolder: '选择要扩写的 Beat' });
  if (!entry || entry.card.kind !== 'beat') {
    return;
  }
  const beat = entry.card as BeatPlan;
  const ref = beat.chapterId ? await storage.getChapterRef(beat.chapterId) : await pickChapter(storage);
  if (!ref) {
    return;
  }
  const editor = await openChapterByMeta(storage, ref.chapter);
  const extra = (await promptInput('Beat 扩写要求', '写成可直接放入正文的一段或数段，保持当前章节文风。')) ?? '';
  const instruction = [
    `请按这个 Beat 扩写正文：${beat.name}`,
    beat.content ? `内容：${beat.content}` : '',
    beat.purpose ? `目的：${beat.purpose}` : '',
    beat.sceneId ? `关联场景：${beat.sceneId}` : '',
    extra ? `额外要求：${extra}` : ''
  ]
    .filter(Boolean)
    .join('\n');
  let appliedToManuscript = false;

  await runWritingTaskWithResult({
    context,
    storage,
    ref,
    taskTitle: '扩写 Beat',
    taskType: 'continue',
    instruction,
    buildMessages: buildContinuationMessages,
    mode: 'continue',
    apply: async (action) => {
      if (action.kind === 'append') {
        await editor.edit((edit) => {
          const end = editor.document.positionAt(editor.document.getText().length);
          edit.insert(end, `\n\n${action.content.trim()}\n`);
        });
        appliedToManuscript = true;
      } else if (action.kind === 'insert') {
        await editor.edit((edit) => edit.insert(editor.selection.active, action.content.trim()));
        appliedToManuscript = true;
      } else if (action.kind === 'copy') {
        await vscode.env.clipboard.writeText(action.content);
      }
    }
  });

  if (appliedToManuscript) {
    await storage.writeCodexEntry(entry.relativePath, { ...beat, status: 'expanded' });
    codexTree.refresh();
    manuscriptTree.refresh();
  }
}

async function polishSelection(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.selection.isEmpty) {
    vscode.window.showInformationMessage('请先在章节正文中选择一段文本。');
    return;
  }
  const ref = await storage.getChapterRefByFilePath(activeEditor.document.uri.fsPath);
  if (!ref) {
    vscode.window.showInformationMessage('当前编辑器不是 LoreDock 章节文件。');
    return;
  }

  const document = activeEditor.document;
  const selection = activeEditor.selection;
  const selectedText = document.getText(selection);
  const instruction = (await promptInput('润色模式 / 要求', '轻度润色，保留原意和剧情事实。')) ?? '';

  await runWritingTaskWithResult({
    context,
    storage,
    ref,
    taskTitle: '润色选中文本',
    taskType: 'polish',
    instruction,
    selectedText,
    original: selectedText,
    buildMessages: buildPolishMessages,
    mode: 'polish',
    apply: async (action) => {
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      if (action.kind === 'replace') {
        await editor.edit((edit) => edit.replace(selection, action.content.trim()));
      } else if (action.kind === 'apply-blocks') {
        const merged = await showDiffApplyPanel(selectedText, action.content.trim(), `润色选区 · ${ref.chapter.title}`);
        if (merged !== undefined) {
          await editor.edit((edit) => edit.replace(selection, merged.trim()));
        }
      } else if (action.kind === 'insert') {
        await editor.edit((edit) => edit.insert(selection.end, `\n${action.content.trim()}`));
      } else if (action.kind === 'copy') {
        await vscode.env.clipboard.writeText(action.content);
      }
    }
  });
  manuscriptTree.refresh();
}

async function generateChapterSummary(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = await resolveChapter(storage, node);
  if (!ref) {
    return;
  }
  const instruction = (await promptInput('摘要额外要求', '')) ?? '';

  await runWritingTaskWithResult({
    context,
    storage,
    ref,
    taskTitle: '生成章节摘要',
    taskType: 'summary',
    instruction,
    buildMessages: buildSummaryMessages,
    mode: 'summary',
    apply: async (action) => {
      if (action.kind === 'copy') {
        await vscode.env.clipboard.writeText(action.content);
        return;
      }
      if (action.kind !== 'save-summary') {
        return;
      }
      const summary = parseSummary(action.content, ref);
      const saved = await storage.saveSummary(summary);
      const pendingPath = await storage.savePendingCodexUpdates(saved);
      const uri = vscode.Uri.file(storage.resolve(`.loredock/summaries/${saved.id}.json`));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      if (pendingPath) {
        const answer = await vscode.window.showInformationMessage('已生成资料库更新建议，需要现在打开确认吗？', '打开建议');
        if (answer === '打开建议') {
          const pendingDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(pendingPath)));
          await vscode.window.showTextDocument(pendingDocument, { preview: false });
        }
      }
      vscode.window.showInformationMessage('章节摘要已保存，后续章节会引用它作为长期记忆。');
    }
  });
  manuscriptTree.refresh();
}

async function runLocalConsistencyCheck(getStorage: () => LoreDockStorage | undefined, node?: unknown): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = await resolveChapter(storage, node);
  if (!ref) {
    return;
  }
  const issues = await storage.runDeterministicConsistencyCheck(ref.chapter.id);
  await showConsistencyIssueReport(ref, issues);
}

async function checkConsistency(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  node?: unknown
): Promise<void> {
  const storage = requireStorage(getStorage);
  const ref = await resolveChapter(storage, node);
  if (!ref) {
    return;
  }
  const localIssues = await storage.runDeterministicConsistencyCheck(ref.chapter.id);
  if (localIssues.length > 0) {
    const answer = await vscode.window.showWarningMessage(`本地规则先发现 ${localIssues.length} 个一致性风险。`, '打开本地报告', '继续 AI 检查');
    if (answer === '打开本地报告') {
      await showConsistencyIssueReport(ref, localIssues);
    }
  }
  const instruction = (await promptInput('一致性检查重点', '检查人物、地点、世界规则、上一章摘要和秘密公开状态。')) ?? '';
  await runWritingTaskWithResult({
    context,
    storage,
    ref,
    taskTitle: '一致性检查',
    taskType: 'consistency',
    instruction,
    buildMessages: buildConsistencyMessages,
    mode: 'consistency',
    apply: async (action) => {
      if (action.kind === 'copy') {
        await vscode.env.clipboard.writeText(action.content);
      }
    }
  });
}

interface WritingTaskOptions {
  context: vscode.ExtensionContext;
  storage: LoreDockStorage;
  ref: ChapterRef;
  taskTitle: string;
  taskType: 'continue' | 'polish' | 'summary' | 'consistency';
  instruction: string;
  selectedText?: string;
  original?: string;
  buildMessages: (contextPackage: Awaited<ReturnType<typeof buildContextPackage>>) => ReturnType<typeof buildContinuationMessages>;
  mode: 'continue' | 'polish' | 'summary' | 'consistency';
  apply: (action: AIResultAction) => Promise<void>;
}

async function runWritingTaskWithResult(options: WritingTaskOptions): Promise<void> {
  const initialContextPackage = await buildContextPackage({
    storage: options.storage,
    chapterId: options.ref.chapter.id,
    taskType: options.taskType,
    userInstruction: options.instruction,
    selectedText: options.selectedText
  });

  const selectedSectionIds = await showContextPreview(options.context, initialContextPackage);
  if (!selectedSectionIds) {
    return;
  }
  const contextPackage = filterContextPackage(initialContextPackage, selectedSectionIds);

  const { client, settings } = await createAIClient(options.context, options.storage);
  let action: AIResultAction = { kind: 'regenerate', content: '' };
  let output = '';
  let latencyMs = 0;
  let model = settings.model;

  while (action.kind === 'regenerate' || action.kind === 'diff') {
    if (action.kind === 'regenerate') {
      const response = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `LoreDock ${options.taskTitle}...` },
        () =>
          client.chat({
            taskType: options.taskType,
            messages: options.buildMessages(contextPackage)
          })
      );
      output = response.content.trim();
      latencyMs = response.latencyMs;
      model = response.model || model;
    }
    action = await showResultPanel({
      title: `${options.taskTitle} · ${options.ref.chapter.title}`,
      mode: options.mode,
      output,
      original: options.original
    });
    if (action.kind === 'diff') {
      await openDiffPreview(options.original ?? '', action.content || output, `${options.taskTitle} · ${options.ref.chapter.title}`);
    }
  }

  if (action.kind !== 'discard') {
    await options.apply(action);
  }

  await options.storage.appendHistory({
    schemaVersion: 1,
    id: makeId(`ai-${options.taskType}`),
    taskType: options.taskType,
    chapterId: options.ref.chapter.id,
    chapterTitle: options.ref.chapter.title,
    model,
    provider: settings.provider,
    userInstruction: options.instruction,
    contextPreview: contextPackage.assembledText,
    output: action.content || output,
    action: toHistoryAction(action.kind),
    createdAt: nowIso(),
    latencyMs
  });
}

interface SummarySuggestion {
  kind: 'character-change' | 'location-change' | 'new-setting' | 'new-foreshadowing' | 'resolved-foreshadowing' | 'unresolved-question';
  label: string;
  value: string;
}

function collectSummarySuggestions(summary: ChapterSummary): SummarySuggestion[] {
  return [
    ...summary.characterChanges.map((value) => ({ kind: 'character-change' as const, label: '人物状态变化', value })),
    ...summary.locationChanges.map((value) => ({ kind: 'location-change' as const, label: '地点状态变化', value })),
    ...summary.newSettings.map((value) => ({ kind: 'new-setting' as const, label: '新增设定', value })),
    ...summary.newForeshadowing.map((value) => ({ kind: 'new-foreshadowing' as const, label: '新增伏笔', value })),
    ...summary.resolvedForeshadowing.map((value) => ({ kind: 'resolved-foreshadowing' as const, label: '回收伏笔', value })),
    ...summary.unresolvedQuestions.map((value) => ({ kind: 'unresolved-question' as const, label: '未解决问题', value }))
  ].filter((suggestion) => suggestion.value.trim());
}

async function applySummarySuggestion(
  storage: LoreDockStorage,
  summary: ChapterSummary,
  suggestion: SummarySuggestion
): Promise<boolean> {
  if (suggestion.kind === 'character-change') {
    const target = await pickCardForSuggestion(storage, 'character', suggestion.value, '选择要写入的人物卡');
    if (!target || target.card.kind !== 'character') {
      return false;
    }
    await storage.writeCodexEntry(target.relativePath, {
      ...target.card,
      currentState: appendDatedLine(target.card.currentState, suggestion.value)
    });
    return true;
  }

  if (suggestion.kind === 'location-change') {
    const target = await pickCardForSuggestion(storage, 'location', suggestion.value, '选择要写入的地点卡');
    if (!target || target.card.kind !== 'location') {
      return false;
    }
    await storage.writeCodexEntry(target.relativePath, {
      ...target.card,
      currentState: appendDatedLine(target.card.currentState, suggestion.value)
    });
    return true;
  }

  if (suggestion.kind === 'new-setting') {
    await storage.createWorldRule({
      name: shortTitle(suggestion.value, '新增设定'),
      detail: suggestion.value
    });
    return true;
  }

  if (suggestion.kind === 'new-foreshadowing' || suggestion.kind === 'unresolved-question') {
    const card = await storage.createForeshadowing({
      name: shortTitle(suggestion.value, suggestion.kind === 'new-foreshadowing' ? '新增伏笔' : '未解决问题'),
      detail: suggestion.value,
      chapterId: summary.chapterId
    });
    if (suggestion.kind === 'unresolved-question') {
      const entry = await storage.findCodexEntryById(card.id);
      if (entry && entry.card.kind === 'foreshadowing') {
        await storage.writeCodexEntry(entry.relativePath, {
          ...entry.card,
          tags: [...new Set([...entry.card.tags, '未解决问题'])]
        });
      }
    }
    return true;
  }

  const target = await pickCardForSuggestion(storage, 'foreshadowing', suggestion.value, '选择已回收的伏笔');
  if (!target || target.card.kind !== 'foreshadowing') {
    return false;
  }
  await storage.writeCodexEntry(target.relativePath, {
    ...target.card,
    status: 'resolved',
    expectedResolveChapterId: target.card.expectedResolveChapterId || summary.chapterId,
    description: appendDatedLine(target.card.description, `回收：${suggestion.value}`)
  });
  return true;
}

async function pickCardForSuggestion(
  storage: LoreDockStorage,
  kind: CodexCard['kind'],
  text: string,
  placeHolder: string
): Promise<CodexEntry | undefined> {
  const entries = await storage.listCodexEntries(kind);
  if (entries.length === 0) {
    vscode.window.showInformationMessage(`没有可写入的${kindLabel(kind)}。`);
    return undefined;
  }
  const items = entries
    .map((entry) => {
      const matched = mentionsCard(text, entry.card);
      return {
        label: entry.card.name,
        description: matched ? '疑似匹配' : kindLabel(entry.card.kind),
        detail: formatCodexSearchDetail(entry),
        entry,
        matched
      };
    })
    .sort((a, b) => Number(b.matched) - Number(a.matched) || a.label.localeCompare(b.label, 'zh-Hans-CN'));
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.entry;
}

function mentionsCard(text: string, card: CodexCard): boolean {
  const names = [card.name, ...card.aliases].map((item) => item.trim()).filter(Boolean);
  return names.some((name) => text.includes(name));
}

function appendDatedLine(existing: string, value: string): string {
  const clean = value.trim();
  if (!clean) {
    return existing;
  }
  if (existing.includes(clean)) {
    return existing;
  }
  const line = `- ${nowIso().slice(0, 10)}：${clean}`;
  return existing.trim() ? `${existing.trim()}\n${line}` : line;
}

function shortTitle(value: string, fallback: string): string {
  const clean = value.replace(/[#*\[\]`"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(clean || fallback).slice(0, 24).join('');
}

async function pickOrderScope(storage: LoreDockStorage, label: string): Promise<string | undefined | null> {
  const active = await resolveOptionalChapter(storage);
  const choices: Array<{ label: string; description?: string; chapterId?: string }> = [
    { label: '全书', description: `整理所有${label}` }
  ];
  if (active) {
    choices.unshift({
      label: `当前章节：${active.chapter.title}`,
      description: active.volume.title,
      chapterId: active.chapter.id
    });
  }
  const picked = await vscode.window.showQuickPick(choices, { placeHolder: `选择要整理的${label}范围` });
  return picked ? picked.chapterId : null;
}

async function chapterNameMap(storage: LoreDockStorage): Promise<Map<string, string>> {
  const refs = await storage.getFlatChapterRefs();
  return new Map(refs.map((ref) => [ref.chapter.id, `${ref.volume.title} / ${ref.chapter.title}`]));
}

function formatForeshadowingSection(status: ForeshadowingCard['status'], cards: ForeshadowingCard[]): string[] {
  const lines = [`## ${foreshadowingStatusLabel(status)}（${cards.length}）`, ''];
  if (cards.length === 0) {
    return [...lines, '- 无', ''];
  }
  for (const card of cards) {
    lines.push(
      `- **${card.name}** · ${importanceLabel(card.importance)} · 首次：${card.firstSeedChapterId || '未填写'} · 预计回收：${card.expectedResolveChapterId || '未填写'}`,
      card.description ? `  - 描述：${card.description}` : '',
      card.publicHint ? `  - 公开提示：${card.publicHint}` : '',
      card.relatedCharacters.length ? `  - 相关人物：${card.relatedCharacters.join('、')}` : ''
    );
  }
  return [...lines.filter(Boolean), ''];
}

function formatSceneLine(scene: ScenePlan): string {
  return `- ${scene.order}. **${scene.name}** · 视角：${scene.viewpointCharacter || '未填'} · 地点：${scene.location || '未填'} · 冲突：${scene.conflict || '未填'} · 结果：${scene.outcome || '未填'}`;
}

function formatBeatLine(beat: BeatPlan): string {
  return `- ${beat.order}. **${beat.name}** · ${beat.status} · ${beat.content || '未填写内容'}${beat.purpose ? ` · 目的：${beat.purpose}` : ''}`;
}

async function showConsistencyIssueReport(ref: ChapterRef, issues: ConsistencyIssue[]): Promise<void> {
  const severities: ConsistencyIssue['severity'][] = ['严重问题', '中等问题', '轻微问题', '建议优化'];
  const lines = [
    `# 本地一致性检查：${ref.volume.title} / ${ref.chapter.title}`,
    '',
    issues.length ? `发现 ${issues.length} 个确定性风险。` : '未发现确定性风险。',
    ''
  ];
  for (const severity of severities) {
    const group = issues.filter((issue) => issue.severity === severity);
    if (group.length === 0) {
      continue;
    }
    lines.push(`## ${severity}`, '');
    for (const issue of group) {
      lines.push(`- **${issue.title}**`, `  - 来源：${issue.source}`, `  - 说明：${issue.detail}`, `  - 建议：${issue.suggestion}`, '');
    }
  }
  await showMarkdownDocument('LoreDock 本地一致性检查', lines.join('\n'));
}

async function showMarkdownDocument(title: string, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `${content.trimEnd()}\n`
  });
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

function validateNonNegativeInteger(value: string): string | undefined {
  return /^\d+$/.test(value.trim()) ? undefined : '请输入 0 或正整数。';
}

function kindLabel(kind: CodexCard['kind']): string {
  const labels: Record<CodexCard['kind'], string> = {
    character: '人物卡',
    location: '地点卡',
    'world-rule': '世界规则',
    foreshadowing: '伏笔',
    'timeline-event': '时间线事件',
    scene: '场景',
    beat: 'Beat'
  };
  return labels[kind];
}

function foreshadowingStatusLabel(status: ForeshadowingCard['status']): string {
  const labels: Record<ForeshadowingCard['status'], string> = {
    planned: '计划中',
    seeded: '已埋设',
    developing: '推进中',
    resolved: '已回收',
    abandoned: '废弃'
  };
  return labels[status];
}

function importanceLabel(importance: ForeshadowingCard['importance']): string {
  if (importance === 'absolute') {
    return '绝对';
  }
  if (importance === 'important') {
    return '重要';
  }
  return '普通';
}

async function resolveChapter(storage: LoreDockStorage, node?: unknown): Promise<ChapterRef | undefined> {
  if (isChapterNode(node)) {
    return { volume: node.volume, chapter: node.chapter };
  }
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeRef = await storage.getChapterRefByFilePath(activeEditor.document.uri.fsPath);
    if (activeRef) {
      return activeRef;
    }
  }
  return pickChapter(storage);
}

async function resolveOptionalChapter(storage: LoreDockStorage): Promise<ChapterRef | undefined> {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeRef = await storage.getChapterRefByFilePath(activeEditor.document.uri.fsPath);
    if (activeRef) {
      return activeRef;
    }
  }
  return pickChapter(storage);
}

async function pickChapter(storage: LoreDockStorage): Promise<ChapterRef | undefined> {
  const refs = await storage.getFlatChapterRefs();
  const picked = await vscode.window.showQuickPick(
    refs.map((ref) => ({
      label: ref.chapter.title,
      description: ref.volume.title,
      detail: ref.chapter.filePath,
      ref
    })),
    { placeHolder: '选择章节' }
  );
  return picked?.ref;
}

async function pickVolume(manifest: ProjectManifest): Promise<VolumeMeta | undefined> {
  if (manifest.volumes.length === 1) {
    return manifest.volumes[0];
  }
  const picked = await vscode.window.showQuickPick(
    manifest.volumes
      .sort((a, b) => a.order - b.order)
      .map((volume) => ({
        label: volume.title,
        description: `${volume.chapters.length} 章`,
        volume
      })),
    { placeHolder: '选择卷' }
  );
  return picked?.volume;
}

async function pickCodexEntry(
  storage: LoreDockStorage,
  options: { kind?: CodexCard['kind']; placeHolder?: string } = {}
): Promise<CodexEntry | undefined> {
  const entries = await storage.listCodexEntries(options.kind);
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.card.name,
      description: kindLabel(entry.card.kind),
      detail: formatCodexSearchDetail(entry),
      entry
    })),
    { placeHolder: options.placeHolder ?? '选择资料卡' }
  );
  return picked?.entry;
}

function formatCodexSearchDetail(entry: Awaited<ReturnType<LoreDockStorage['listCodexEntries']>>[number]): string {
  const tags = entry.card.tags.length ? `标签：${entry.card.tags.join('、')}` : '';
  const aliases = entry.card.aliases.length ? `别名：${entry.card.aliases.join('、')}` : '';
  return [entry.relativePath, tags, aliases].filter(Boolean).join(' · ');
}

async function nextDraftName(storage: LoreDockStorage, kind: CodexCard['kind'], prefix: string): Promise<string> {
  const entries = await storage.listCodexEntries(kind);
  return `${prefix} ${entries.length + 1}`;
}

async function openChapterByMeta(storage: LoreDockStorage, chapter: { filePath: string }): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(storage.resolve(chapter.filePath));
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preview: false });
}

async function openCodexPath(storage: LoreDockStorage, relativePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(relativePath)));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function openDiffPreview(original: string, revised: string, title: string): Promise<void> {
  const left = await vscode.workspace.openTextDocument({ language: 'markdown', content: original });
  const right = await vscode.workspace.openTextDocument({ language: 'markdown', content: revised });
  await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `LoreDock Diff：${title}`);
}

async function openCreatedCodexCard(storage: LoreDockStorage, cardId: string): Promise<void> {
  const entries = await storage.listCodexEntries();
  const entry = entries.find((candidate) => candidate.card.id === cardId);
  if (entry) {
    await openCodexPath(storage, entry.relativePath);
  }
}

function requireStorage(getStorage: () => LoreDockStorage | undefined): LoreDockStorage {
  const storage = getStorage();
  if (!storage) {
    throw new Error('请先在 VS Code 中打开一个文件夹。');
  }
  return storage;
}

function getWorkspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function promptInput(title: string, value: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    value,
    ignoreFocusOut: true
  });
}

function getAISettings(): AISettings {
  const config = vscode.workspace.getConfiguration('loredock.ai');
  return {
    provider: (config.get<string>('provider') || 'openai-compatible') as AIProvider,
    baseUrl: config.get<string>('baseUrl') || 'http://localhost:1234/v1',
    model: config.get<string>('model') || '',
    temperature: config.get<number>('temperature') ?? 0.7,
    maxOutputTokens: config.get<number>('maxOutputTokens') ?? 1200,
    timeoutMs: config.get<number>('timeoutMs') ?? 60000,
    defaultLanguage: config.get<string>('defaultLanguage') || 'zh-CN'
  };
}

interface ResolvedAIClient {
  client: AIClient;
  settings: AISettings;
}

async function createAIClient(
  context: vscode.ExtensionContext | undefined,
  storage: LoreDockStorage | undefined,
  options?: { allowMissingModel?: boolean }
): Promise<ResolvedAIClient> {
  if (storage && (await storage.manifestExists())) {
    const config = await storage.readAIConfig();
    const envValues = await storage.readAIEnv();
    const settings = resolveAISettingsFromConfig(config, options, envValues);
    const providerConfig = config.providers[config.activeProvider] ?? (config.activeProvider === 'anthropic' ? config.providers.claude : undefined);
    return {
      client: new AIClient(settings, resolveApiKey(providerConfig, settings.provider, envValues)),
      settings
    };
  }
  const settings = getAISettings();
  const apiKey = context ? await context.secrets.get(SECRET_API_KEY) : undefined;
  return {
    client: new AIClient(settings, apiKey),
    settings
  };
}

function resolveAISettingsFromConfig(
  config: AIConfigFile,
  options?: { allowMissingModel?: boolean },
  envValues: Record<string, string> = {}
): AISettings {
  const provider = config.activeProvider;
  const canonicalProvider = provider === 'anthropic' ? 'claude' : provider;
  const providerConfig = config.providers[provider] ?? (provider === 'anthropic' ? config.providers.claude : undefined);
  if (!providerConfig) {
    throw new Error(`AI 配置中找不到 activeProvider：${provider}`);
  }
  if (!providerConfig.model?.trim() && !options?.allowMissingModel) {
    throw new Error('请先在 ai.local.jsonc 中填写 model，或运行“选择 AI 模型”。');
  }
  const apiKey = resolveApiKey(providerConfig, canonicalProvider, envValues);
  if (requiresApiKey(canonicalProvider, providerConfig.baseUrl) && !apiKey) {
    const envHints = keyEnvCandidates(providerConfig, canonicalProvider).join(' / ');
    throw new Error(
      `当前 provider=${provider} 需要 API key，但没有读取到认证信息。请在 .loredock/ai.env 填写 ${envHints}=，` +
        `或在 ai.local.jsonc 的 ${provider}.apiKey 填写 key。`
    );
  }
  if (canonicalProvider === 'claude' && apiKey && isOfficialAnthropicBaseUrl(providerConfig.baseUrl) && !apiKey.startsWith('sk-ant-')) {
    throw new Error('当前 activeProvider 是 Claude/Anthropic 原生接口，baseUrl 是官方 Anthropic，但 apiKey 看起来不像 Anthropic API key。Anthropic 原生 key 通常以 sk-ant- 开头。如果你使用的是 Claude 兼容代理，请把 claude.baseUrl 改成代理地址。');
  }
  return {
    provider: canonicalProvider,
    baseUrl: providerConfig.baseUrl,
    model: providerConfig.model ?? '',
    temperature: providerConfig.temperature ?? 0.7,
    maxOutputTokens: providerConfig.maxOutputTokens ?? 1200,
    timeoutMs: providerConfig.timeoutMs ?? 60000,
    defaultLanguage: config.defaultLanguage || 'zh-CN'
  };
}

function resolveApiKey(
  providerConfig: AIConfigFile['providers'][AIProvider] | undefined,
  provider: AIProvider,
  envValues: Record<string, string> = {}
): string | undefined {
  return resolveApiKeyInfo(providerConfig, provider, envValues).value;
}

function resolveApiKeyInfo(
  providerConfig: AIConfigFile['providers'][AIProvider] | undefined,
  provider: AIProvider,
  envValues: Record<string, string> = {}
): { value?: string; source: string } {
  const direct = providerConfig?.apiKey?.trim();
  const normalizedDirect = normalizeApiKey(direct);
  if (normalizedDirect) {
    return { value: normalizedDirect, source: 'ai.local.jsonc provider.apiKey' };
  }
  for (const envName of keyEnvCandidates(providerConfig, provider)) {
    const localValue = normalizeApiKey(envValues[envName]);
    if (localValue) {
      return { value: localValue, source: `.loredock/ai.env ${envName}` };
    }
    const processValue = normalizeApiKey(process.env[envName]);
    if (processValue) {
      return { value: processValue, source: `进程环境变量 ${envName}` };
    }
  }
  return { source: '未读取到' };
}

function keyEnvCandidates(providerConfig: AIConfigFile['providers'][AIProvider] | undefined, provider: AIProvider): string[] {
  const candidates = [
    providerConfig?.apiKeyEnv?.trim(),
    provider === 'gpt' ? 'OPENAI_API_KEY' : undefined,
    provider === 'claude' || provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined,
    provider === 'gemini' ? 'GEMINI_API_KEY' : undefined,
    provider === 'openrouter' ? 'OPENROUTER_API_KEY' : undefined,
    provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : undefined,
    provider === 'openai-compatible' || provider === 'custom' ? 'OPENAI_API_KEY' : undefined,
    provider === 'openai-compatible' || provider === 'custom' ? 'OPENROUTER_API_KEY' : undefined,
    provider === 'openai-compatible' || provider === 'custom' ? 'ANTHROPIC_API_KEY' : undefined,
    provider === 'openrouter' ? 'OPENAI_API_KEY' : undefined,
    provider === 'openrouter' ? 'ANTHROPIC_API_KEY' : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates)];
}

function requiresApiKey(provider: AIProvider, baseUrl: string): boolean {
  if (provider === 'lm-studio' || provider === 'ollama') {
    return !isLocalBaseUrl(baseUrl);
  }
  if (provider === 'openai-compatible' || provider === 'custom') {
    return !isLocalBaseUrl(baseUrl);
  }
  return true;
}

function isOfficialAnthropicBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function describeRequestAuth(provider: AIProvider, apiKey?: string): string {
  if (!apiKey?.trim()) {
    return '不会发送认证头，因为没有读到 key';
  }
  if (provider === 'claude' || provider === 'anthropic') {
    return '会发送 x-api-key';
  }
  if (provider === 'gemini') {
    return '会把 key 放在 Gemini 请求参数里';
  }
  return '会发送 Authorization: Bearer ***';
}

function formatEnvCandidates(candidates: string[], envValues: Record<string, string>): string[] {
  if (candidates.length === 0) {
    return ['- 无'];
  }
  return candidates.map((name) => {
    const localValue = normalizeApiKey(envValues[name]);
    const processValue = normalizeApiKey(process.env[name]);
    return `- ${name}: ai.env=${localValue ? `有，${maskSecret(localValue)}` : '无'}；进程环境=${processValue ? '有' : '无'}`;
  });
}

function diagnoseWarnings(options: {
  provider: AIProvider;
  canonicalProvider: AIProvider;
  baseUrl: string;
  authRequired: boolean;
  keySource: string;
  keyValue?: string;
}): string[] {
  const warnings: string[] = [];
  if (options.authRequired && !options.keyValue) {
    warnings.push('- 现在没有读到 key，请先保存 `.loredock/ai.env`，例如 `OPENROUTER_API_KEY=sk-...`。');
  }
  if (!options.authRequired && !options.keyValue) {
    warnings.push('- 当前 provider/baseUrl 被识别为本地免 key 模式；如果远端仍返回 Missing Authentication header，请把 provider 改为 `openrouter` 或远程 `openai-compatible`，并在 `.loredock/ai.env` 填 key。');
  }
  if ((options.provider === 'lm-studio' || options.provider === 'ollama') && !isLocalBaseUrl(options.baseUrl)) {
    warnings.push('- 当前 provider 是本地模型专用模式，但 baseUrl 不是 localhost；远程模型路由平台请改用 `openrouter` 或 `openai-compatible`。');
  }
  if (options.canonicalProvider === 'claude' && options.keyValue && !options.keyValue.startsWith('sk-ant-') && isOfficialAnthropicBaseUrl(options.baseUrl)) {
    warnings.push('- 当前是 Anthropic 官方接口，但 key 不像 `sk-ant-`；如果这是 Claude 兼容代理 key，请把 `claude.baseUrl` 改为代理地址。');
  }
  if (options.canonicalProvider === 'claude' && options.keyValue && !options.keyValue.startsWith('sk-ant-') && !isOfficialAnthropicBaseUrl(options.baseUrl)) {
    warnings.push('- 当前是 Claude 兼容代理地址，允许使用非 `sk-ant-` 的代理 key。');
  }
  if (options.provider === 'openrouter' && options.keySource.includes('ANTHROPIC_API_KEY')) {
    warnings.push('- OpenRouter 已兼容读取 `ANTHROPIC_API_KEY`，但建议后续把多模型 key 放到 `OPENROUTER_API_KEY`，避免和 Anthropic 原生接口混淆。');
  }
  if (warnings.length === 0) {
    warnings.push('- 配置看起来可以发送认证信息。若仍报 Missing Authentication header，请检查 baseUrl 是否属于当前 provider，或重启 Extension Development Host 以加载最新编译结果。');
  }
  return warnings;
}

function preflightAdvice(result: Awaited<ReturnType<AIClient['preflight']>>): string[] {
  const response = result.responsePreview || result.error || '';
  const lines: string[] = [];
  if (result.ok) {
    lines.push('- 预检通过：服务端接受了当前认证。若聊天仍失败，请检查 model 名称是否可用，或运行“选择 AI 模型”重新选择。');
  } else if (result.authHeader === 'none') {
    lines.push('- 当前请求没有认证信息。请在 `.loredock/ai.env` 填写 `OPENROUTER_API_KEY=sk-or-v1-...`，或检查 activeProvider 对应的 `apiKeyEnv`。');
  } else if (/missing authentication|no authorization|authorization header/i.test(response)) {
    lines.push('- 服务端仍认为没有认证头。请确认 baseUrl 没有被代理/网关改写；OpenRouter 应为 `https://openrouter.ai/api/v1`。');
    lines.push('- 如果你填的是 `Bearer sk-...`，现在 LoreDock 会自动清理为 `sk-...`；请重新编译并重启 Extension Development Host 后再试。');
  } else if (/invalid|incorrect|user not found|unauthorized/i.test(response)) {
    lines.push('- 服务端收到了认证，但 key 不被当前平台接受。OpenRouter key 通常以 `sk-or-v1-` 开头；如果你的 key 来自其他路由平台，请把 baseUrl 改成该平台的 `/v1`。');
  } else if (result.status && result.status >= 300 && result.status < 400) {
    lines.push('- 服务端返回重定向。为了避免 Authorization 在重定向中丢失，请把 baseUrl 直接改成重定向后的最终 `/v1` 地址。');
  } else {
    lines.push('- 预检失败但不是典型认证错误，请看上面的服务端响应或网络错误。');
  }
  return lines;
}

function promptKindToTaskType(kind: PromptTemplate['kind']): AITaskType {
  if (kind === 'beat') {
    return 'continue';
  }
  if (kind === 'chat') {
    return 'worldbuild';
  }
  return kind;
}

function renderPromptTemplate(prompt: PromptTemplate, contextText: string, userInstruction: string): string {
  const variables: Record<string, string> = {
    context: contextText,
    userInstruction,
    instruction: userInstruction,
    selection: '',
    chapter: contextText
  };
  const applyVariables = (value: string) =>
    value.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
  return [
    `# ${prompt.title}`,
    '',
    `类型：${prompt.kind}`,
    prompt.defaultModel ? `默认模型：${prompt.defaultModel}` : '',
    prompt.temperature !== undefined ? `温度：${prompt.temperature}` : '',
    '',
    '## System',
    '',
    applyVariables(prompt.system),
    '',
    '## User',
    '',
    applyVariables(prompt.user)
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function readClaudeCliProfile(): Promise<{ baseUrl?: string; apiKey?: string; model?: string }> {
  const home = os.homedir() || process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    return {};
  }
  const candidates = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.config', 'claude', 'settings.json'),
    ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, 'claude', 'settings.json')] : []),
    ...(process.env.APPDATA
      ? [path.join(process.env.APPDATA, 'Claude', 'settings.json'), path.join(process.env.APPDATA, 'claude', 'settings.json')]
      : [])
  ];
  for (const filePath of [...new Set(candidates)]) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(stripUtf8Bom(raw)) as {
        model?: string;
        env?: Record<string, string>;
      };
      return {
        baseUrl: parsed.env?.ANTHROPIC_BASE_URL?.trim(),
        apiKey: normalizeApiKey(parsed.env?.ANTHROPIC_API_KEY),
        model: parsed.model?.trim()
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`读取 Claude CLI 配置失败：${filePath}，${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return {};
}

async function upsertAIEnvValue(storage: LoreDockStorage, key: string, value: string): Promise<void> {
  const relativePath = await storage.ensureAIEnvFile();
  const absolutePath = storage.resolve(relativePath);
  let raw = await fs.readFile(absolutePath, 'utf8');
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (pattern.test(raw)) {
    raw = raw.replace(pattern, line);
  } else {
    raw = `${raw.trimEnd()}\n${line}\n`;
  }
  await fs.writeFile(absolutePath, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
}

async function writeAIEnvValues(storage: LoreDockStorage, values: Record<string, string>): Promise<void> {
  const relativePath = await storage.ensureAIEnvFile();
  const absolutePath = storage.resolve(relativePath);
  let raw = await fs.readFile(absolutePath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value.trim()}`;
    const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}=.*$`, 'm');
    if (pattern.test(raw)) {
      raw = raw.replace(pattern, line);
    } else {
      raw = `${raw.trimEnd()}\n${line}\n`;
    }
  }
  await fs.writeFile(absolutePath, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return `长度 ${trimmed.length}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}，长度 ${trimmed.length}`;
}

function toHistoryAction(action: AIResultAction['kind']): AIJobRecord['action'] {
  if (action === 'save-summary') {
    return 'save-summary';
  }
  if (action === 'apply-blocks') {
    return 'replace';
  }
  if (action === 'append' || action === 'insert' || action === 'replace' || action === 'copy' || action === 'discard') {
    return action;
  }
  return 'none';
}

function parseSummary(raw: string, ref: ChapterRef): ChapterSummary {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<ChapterSummary>;
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    id: ref.chapter.summaryId || `${ref.chapter.id}-summary`,
    chapterId: ref.chapter.id,
    chapterTitle: ref.chapter.title,
    oneLineSummary: parsed.oneLineSummary ?? '',
    majorEvents: asStringArray(parsed.majorEvents),
    characterChanges: asStringArray(parsed.characterChanges),
    locationChanges: asStringArray(parsed.locationChanges),
    newSettings: asStringArray(parsed.newSettings),
    newForeshadowing: asStringArray(parsed.newForeshadowing),
    resolvedForeshadowing: asStringArray(parsed.resolvedForeshadowing),
    unresolvedQuestions: asStringArray(parsed.unresolvedQuestions),
    nextChapterHooks: asStringArray(parsed.nextChapterHooks),
    facts: asStringArray(parsed.facts),
    inferences: asStringArray(parsed.inferences),
    createdAt: parsed.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item)).filter(Boolean);
}
