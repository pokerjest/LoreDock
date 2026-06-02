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
import { AIClient, normalizeApiKey } from './services/aiClient';
import { showCodexFormPanel } from './webviews/codexFormPanel';
import { showContextPreview } from './webviews/contextPreviewPanel';
import { showDiffApplyPanel } from './webviews/diffApplyPanel';
import { showHistoryPanel } from './webviews/historyPanel';
import { AIResultAction, showResultPanel } from './webviews/resultPanel';
import { SettingsPanelAction, SettingsPanelState, showSettingsPanel } from './webviews/settingsPanel';
import { showStatsPanel } from './webviews/statsPanel';
import { AIStatusTreeProvider } from './views/aiStatusTree';
import { CodexTreeProvider, isCodexEntryNode } from './views/codexTree';
import { ChapterNode, isChapterNode, isProjectNode, isVolumeNode, ManuscriptTreeProvider } from './views/manuscriptTree';
import {
  AIConfigFile,
  BeatPlan,
  AIJobRecord,
  AIProvider,
  AISettings,
  ChapterRef,
  ChapterSummary,
  ChapterStatus,
  CodexCard,
  CodexEntry,
  ConsistencyIssue,
  ForeshadowingCard,
  LocationCard,
  ProjectManifest,
  ScenePlan,
  TimelineEvent,
  VolumeMeta
} from './types';

export function activate(context: vscode.ExtensionContext): void {
  const getStorage = () => {
    const root = getWorkspaceRoot();
    return root ? new LoreDockStorage(root.fsPath) : undefined;
  };

  const manuscriptTree = new ManuscriptTreeProvider(getStorage);
  const codexTree = new CodexTreeProvider(getStorage);
  const aiStatusTree = new AIStatusTreeProvider(getStorage);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('loredock.manuscript', manuscriptTree),
    vscode.window.registerTreeDataProvider('loredock.codex', codexTree),
    vscode.window.registerTreeDataProvider('loredock.aiStatus', aiStatusTree),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      manuscriptTree.refresh();
      codexTree.refresh();
      aiStatusTree.refresh();
    }),
    registerCommand('loredock.refreshViews', () => {
      manuscriptTree.refresh();
      codexTree.refresh();
      aiStatusTree.refresh();
    }),
    registerCommand('loredock.openSettings', () => openSettings(context, getStorage, aiStatusTree)),
    registerCommand('loredock.showManuscriptActions', () => showManuscriptActions(getStorage, manuscriptTree, codexTree)),
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
    registerCommand('loredock.configureAI', () => openSettings(context, getStorage, aiStatusTree)),
    registerCommand('loredock.configureOpenRouter', () => configureOpenRouter(getStorage, true, aiStatusTree)),
    registerCommand('loredock.configureFromClaudeCli', () => configureFromClaudeCli(getStorage, true, aiStatusTree)),
    registerCommand('loredock.selectAIModel', () => selectAIModel(getStorage, aiStatusTree)),
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

async function showManuscriptActions(
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider
): Promise<void> {
  const actions: Array<{ label: string; description?: string; run: () => Promise<void> | void }> = [
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
  vscode.window.showInformationMessage('LoreDock 小说项目已初始化。标题、文风和设定可以之后慢慢补。');
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
  aiStatusTree: AIStatusTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  showSettingsPanel(context, await loadSettingsPanelState(storage), async (action) => {
    await handleSettingsPanelAction(context, getStorage, storage, aiStatusTree, action);
    return loadSettingsPanelState(storage);
  });
}

async function handleSettingsPanelAction(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  storage: LoreDockStorage,
  aiStatusTree: AIStatusTreeProvider,
  action: SettingsPanelAction
): Promise<void> {
  if (action.command === 'save') {
    await saveSettingsPanelState(storage, action.config, action.envValues);
    aiStatusTree.refresh();
    vscode.window.showInformationMessage('LoreDock AI 设置已保存。');
    return;
  }
  if (action.command === 'select-model') {
    await selectAIModel(getStorage, aiStatusTree);
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
    await configureOpenRouter(getStorage, false, aiStatusTree);
    return;
  }
  if (action.command === 'configure-claude-cli') {
    await configureFromClaudeCli(getStorage, false, aiStatusTree);
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
    await selectAIModel(getStorage);
  }
}

async function configureOpenRouter(
  getStorage: () => LoreDockStorage | undefined,
  openFiles = true,
  aiStatusTree?: AIStatusTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  const config = await storage.configureOpenRouterProfile();
  if (openFiles) {
    await openAIConfigFiles(storage);
  }
  const envValues = await storage.readAIEnv();
  const hasKey = Boolean(resolveApiKey(config.providers.openrouter, 'openrouter', envValues));
  aiStatusTree?.refresh();
  const answer = await vscode.window.showInformationMessage(
    hasKey
      ? '已切换到 OpenRouter。请确认 key 后可以选择模型。'
      : '已切换到 OpenRouter。请先在 ai.env 的 OPENROUTER_API_KEY= 或 ANTHROPIC_API_KEY= 后填入你的 sk key。',
    hasKey ? '选择 AI 模型' : '知道了'
  );
  if (answer === '选择 AI 模型') {
    await selectAIModel(getStorage, aiStatusTree);
  }
}

async function configureFromClaudeCli(
  getStorage: () => LoreDockStorage | undefined,
  openFiles = true,
  aiStatusTree?: AIStatusTreeProvider
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
  aiStatusTree?.refresh();
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

async function selectAIModel(getStorage: () => LoreDockStorage | undefined, aiStatusTree?: AIStatusTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  const { client, settings } = await createAIClient(undefined, storage, { allowMissingModel: true });
  if (await offerOpenRouterSwitchForLocalDefault(getStorage, settings)) {
    return;
  }
  const models = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `LoreDock 正在读取 ${settings.provider} 可用模型...` },
    () => client.listModels()
  );
  if (models.length === 0) {
    vscode.window.showInformationMessage('没有读取到可用模型。请检查 baseUrl、apiKey 和 provider。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.id,
      description: model.label && model.label !== model.id ? model.label : undefined,
      model
    })),
    { placeHolder: `选择 ${settings.provider} 模型` }
  );
  if (!picked) {
    return;
  }
  await storage.updateActiveAIModel(picked.model.id);
  aiStatusTree?.refresh();
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
      'Markdown / TXT': ['md', 'markdown', 'txt']
    },
    openLabel: '导入手稿'
  });
  const uri = picked?.[0];
  if (!uri) {
    return;
  }
  const content = decodeTextBuffer(await vscode.workspace.fs.readFile(uri));
  const chapters = await storage.importManuscript(uri.fsPath, content);
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
