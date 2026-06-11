import path from 'node:path';
import * as vscode from 'vscode';
import { ExportFormat, LoreDockStorage } from './core/storage';
import { decodeTextBuffer, nowIso } from './core/utils';
import { BlueprintPanelAction, BlueprintPanelHandle, showBlueprintPanel } from './webviews/blueprintPanel';
import { showCodexFormPanel } from './webviews/codexFormPanel';
import { DashboardPanelAction, showDashboardPanel } from './webviews/dashboardPanel';
import { HealthPanelAction, showHealthPanel } from './webviews/healthPanel';
import { PlanPanelState, showPlanPanel } from './webviews/planPanel';
import { showStatsPanel } from './webviews/statsPanel';
import { showTimelineWorkbench } from './webviews/timelinePanel';
import { CodexTreeProvider, isCodexEntryNode } from './views/codexTree';
import { isChapterNode, isProjectNode, isVolumeNode, ManuscriptTreeProvider } from './views/manuscriptTree';
import { isOutlineDocumentNode, OutlineTreeProvider } from './views/outlineTree';
import {
  BeatPlan,
  BlueprintDocument,
  BlueprintNode,
  ChapterRef,
  ChapterSummary,
  ChapterStatus,
  CodexCard,
  CodexEntry,
  ConsistencyIssue,
  ForeshadowingCard,
  LocationCard,
  ProjectHealthFixReport,
  ProjectHealthCategory,
  ProjectHealthReport,
  ProjectHealthSeverity,
  ProjectManifest,
  ScenePlan,
  VolumeMeta,
  WorldRule
} from './types';

let activeBlueprintPanel: BlueprintPanelHandle | undefined;
let activeBlueprintRefresh: (() => Promise<void>) | undefined;
let activeBlueprintId: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const getStorage = () => {
    const root = getWorkspaceRoot();
    return root ? new LoreDockStorage(root.fsPath) : undefined;
  };

  const manuscriptTree = new ManuscriptTreeProvider(getStorage);
  const codexTree = new CodexTreeProvider(getStorage);
  const outlineTree = new OutlineTreeProvider(getStorage);
  const blueprintStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  blueprintStatus.text = '$(type-hierarchy) 蓝图';
  blueprintStatus.tooltip = '切换到 LoreDock 大纲蓝图模式';
  blueprintStatus.command = 'loredock.openBlueprintOutline';
  blueprintStatus.show();
  const timelineStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  timelineStatus.text = '$(history) 时间线';
  timelineStatus.tooltip = '打开 LoreDock 时间线工作台';
  timelineStatus.command = 'loredock.openTimelineWorkbench';
  timelineStatus.show();
  const refreshBlueprintPanel = debounceAsync(async () => {
    await activeBlueprintRefresh?.();
  }, 120);
  const codexWatcher = vscode.workspace.createFileSystemWatcher('**/codex/**/*.json');
  const outlineWatcher = vscode.workspace.createFileSystemWatcher('**/.loredock/outlines/**/*.json');
  const refreshCodexAndBlueprint = () => {
    codexTree.refresh();
    void refreshBlueprintPanel();
  };
  const refreshManuscriptCodexAndBlueprint = () => {
    manuscriptTree.refresh();
    codexTree.refresh();
    outlineTree.refresh();
    void refreshBlueprintPanel();
  };
  codexWatcher.onDidCreate(refreshCodexAndBlueprint, undefined, context.subscriptions);
  codexWatcher.onDidChange(refreshCodexAndBlueprint, undefined, context.subscriptions);
  codexWatcher.onDidDelete(refreshCodexAndBlueprint, undefined, context.subscriptions);
  outlineWatcher.onDidCreate(refreshManuscriptCodexAndBlueprint, undefined, context.subscriptions);
  outlineWatcher.onDidChange(refreshManuscriptCodexAndBlueprint, undefined, context.subscriptions);
  outlineWatcher.onDidDelete(refreshManuscriptCodexAndBlueprint, undefined, context.subscriptions);
  context.subscriptions.push(
    blueprintStatus,
    timelineStatus,
    codexWatcher,
    outlineWatcher,
    vscode.window.registerTreeDataProvider('loredock.manuscript', manuscriptTree),
    vscode.window.registerTreeDataProvider('loredock.outlines', outlineTree),
    vscode.window.registerTreeDataProvider('loredock.codex', codexTree),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      manuscriptTree.refresh();
      outlineTree.refresh();
      codexTree.refresh();
    }),
    registerCommand('loredock.refreshViews', () => {
      manuscriptTree.refresh();
      outlineTree.refresh();
      codexTree.refresh();
    }),
    registerCommand('loredock.openSettings', () => openSettings(context, getStorage)),
    registerCommand('loredock.showManuscriptActions', () => showManuscriptActions(context, getStorage, manuscriptTree, codexTree, outlineTree)),
    registerCommand('loredock.showCodexActions', () => showCodexActions(context, getStorage, codexTree, outlineTree)),
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
    registerCommand('loredock.createTimelineEvent', () => createTimelineEvent(context, getStorage)),
    registerCommand('loredock.createScene', () => createScene(getStorage, codexTree)),
    registerCommand('loredock.createBeat', () => createBeat(getStorage, codexTree)),
    registerCommand('loredock.openPlanView', () => openPlanView(context, getStorage)),
    registerCommand('loredock.openBlueprintOutline', () => openBlueprintOutline(context, getStorage, manuscriptTree, codexTree, outlineTree)),
    registerCommand('loredock.openTimelineWorkbench', () => openTimelineWorkbench(context, getStorage)),
    registerCommand('loredock.openBlueprintForOutline', (node?: unknown) => openBlueprintForOutline(context, getStorage, node, manuscriptTree, codexTree, outlineTree)),
    registerCommand('loredock.openOutlineSource', (node?: unknown) => openOutlineSource(getStorage, node)),
    registerCommand('loredock.importOutlineToPlan', () => importOutlineToPlan(getStorage, manuscriptTree, codexTree)),
    registerCommand('loredock.rebuildReferenceIndex', () => rebuildReferenceIndex(getStorage)),
    registerCommand('loredock.showReferenceIndex', () => showReferenceIndex(getStorage)),
    registerCommand('loredock.exportCodexZip', () => exportCodexZip(getStorage)),
    registerCommand('loredock.importCodexZip', () => importCodexZip(getStorage, codexTree)),
    registerCommand('loredock.openCodexEntry', (node?: unknown) => openCodexEntry(getStorage, node)),
    registerCommand('loredock.editCodexEntryForm', (node?: unknown) => editCodexEntryForm(getStorage, codexTree, node)),
    registerCommand('loredock.filterCodexEntries', () => filterCodexEntries(getStorage)),
    registerCommand('loredock.deleteCodexEntry', (node?: unknown) => deleteCodexEntry(getStorage, codexTree, node)),
    registerCommand('loredock.showForeshadowingBoard', () => showForeshadowingBoard(getStorage)),
    registerCommand('loredock.showTimelineBoard', () => openTimelineWorkbench(context, getStorage)),
    registerCommand('loredock.showSceneBeatBoard', () => showSceneBeatBoard(getStorage)),
    registerCommand('loredock.normalizeSceneOrder', () => normalizeSceneOrder(getStorage, codexTree)),
    registerCommand('loredock.normalizeBeatOrder', () => normalizeBeatOrder(getStorage, codexTree)),
    registerCommand('loredock.reviewPendingCodexUpdates', () => reviewPendingCodexUpdates(getStorage, codexTree)),
    registerCommand('loredock.openStyleGuide', () => openStyleGuide(getStorage)),
    registerCommand('loredock.configureExportStyle', () => configureExportStyle(getStorage)),
    registerCommand('loredock.setWritingGoals', () => setWritingGoals(getStorage)),
    registerCommand('loredock.importManuscript', () => importManuscript(getStorage, manuscriptTree)),
    registerCommand('loredock.exportManuscript', () => exportManuscript(getStorage)),
    registerCommand('loredock.showStats', () => showWritingStats(getStorage)),
    registerCommand('loredock.showProjectDashboard', () => showProjectDashboard(context, getStorage)),
    registerCommand('loredock.showProjectHealth', () => showProjectHealth(context, getStorage)),
    registerCommand('loredock.previewProjectHealthFixes', () => previewProjectHealthFixes(getStorage)),
    registerCommand('loredock.fixProjectHealth', () => fixProjectHealth(getStorage)),
    registerCommand('loredock.saveProjectHealthBaseline', () => saveProjectHealthBaseline(getStorage)),
    registerCommand('loredock.clearProjectHealthBaseline', () => clearProjectHealthBaseline(getStorage)),
    registerCommand('loredock.runLocalConsistencyCheck', (node?: unknown) => runLocalConsistencyCheck(getStorage, node))
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

function debounceAsync(callback: () => Promise<void>, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void callback();
    }, delayMs);
  };
}

function refreshActiveBlueprintPanel(): void {
  void activeBlueprintRefresh?.();
}

async function showManuscriptActions(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree: ManuscriptTreeProvider,
  codexTree: CodexTreeProvider,
  outlineTree: OutlineTreeProvider
): Promise<void> {
  const actions: Array<{ label: string; description?: string; run: () => Promise<void> | void }> = [
    {
      label: '项目仪表盘',
      description: '聚合写作统计、健康问题和近期章节',
      run: () => showProjectDashboard(context, getStorage)
    },
    {
      label: '打开 Plan / Matrix',
      description: '按 Grid、Matrix、Outline 查看章节、场景、Beat 和资料卡引用',
      run: () => openPlanView(context, getStorage)
    },
    {
      label: '打开大纲蓝图',
      description: '用节点画布组织大纲、资料卡、场景和 Beat',
      run: () => openBlueprintOutline(context, getStorage, manuscriptTree, codexTree, outlineTree)
    },
    {
      label: '导入独立大纲',
      description: '读取当前选区或剪贴板，保存到 .loredock/outlines 并创建未绑定手稿的规划卡',
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
      label: '项目健康检查',
      description: '扫描手稿、资料库、规划、时间线、伏笔和引用结构',
      run: () => showProjectHealth(context, getStorage)
    },
    {
      label: '预览项目健康安全修复',
      description: '查看将清理和重排的结构问题',
      run: async () => { await previewProjectHealthFixes(getStorage); }
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
      label: '应用摘要建议',
      description: '逐条确认摘要里的资料库更新',
      run: () => reviewPendingCodexUpdates(getStorage, codexTree)
    },
    {
      label: '重建引用索引',
      description: '扫描手稿、摘要、场景和 Beat 中的资料卡引用',
      run: () => rebuildReferenceIndex(getStorage)
    },
    {
      label: '本地一致性检查',
      description: '运行确定性规则检查',
      run: () => runLocalConsistencyCheck(getStorage)
    }
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: 'LoreDock 手稿操作'
  });
  await picked?.run();
}

async function showCodexActions(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  codexTree: CodexTreeProvider,
  outlineTree: OutlineTreeProvider
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
      description: '查看资料卡在手稿、摘要、场景和 Beat 中的出现位置',
      run: () => showReferenceIndex(getStorage)
    },
    {
      label: '打开大纲蓝图',
      description: '把资料卡拖进可视化大纲画布',
      run: () => openBlueprintOutline(context, getStorage, undefined, codexTree, outlineTree)
    },
    {
      label: '项目健康检查',
      description: '扫描资料库冲突、无效引用和结构风险',
      run: () => showProjectHealth(context, getStorage)
    },
    {
      label: '预览项目健康安全修复',
      description: '先查看会修改哪些结构问题',
      run: async () => { await previewProjectHealthFixes(getStorage); }
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
    if (action.command === 'open-blueprint') {
      await openBlueprintOutline(context, () => storage);
    }
    return loadPlanPanelState(storage);
  });
}

async function loadPlanPanelState(storage: LoreDockStorage): Promise<PlanPanelState> {
  const [manifest, refs, entries, index, outlines] = await Promise.all([
    storage.requireManifest(),
    storage.getFlatChapterRefs(),
    storage.listCodexEntries(),
    storage.buildReferenceIndex(),
    storage.listOutlines()
  ]);
  const scenes = entries.filter((entry) => entry.card.kind === 'scene').map((entry) => entry.card as ScenePlan);
  const beats = entries.filter((entry) => entry.card.kind === 'beat').map((entry) => entry.card as BeatPlan);
  const manuscriptScenes = scenes.filter((scene) => scene.chapterId);
  const manuscriptBeats = beats.filter((beat) => beat.chapterId);
  const outlineScenes = scenes.filter((scene) => scene.outlineId && !scene.chapterId);
  const outlineBeats = beats.filter((beat) => beat.outlineId && !beat.chapterId);
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
      scenes: manuscriptScenes.filter((scene) => scene.chapterId === ref.chapter.id).sort((a, b) => a.order - b.order),
      beats: manuscriptBeats.filter((beat) => beat.chapterId === ref.chapter.id).sort((a, b) => a.order - b.order)
    })),
    outlines,
    outlineScenes: outlineScenes.sort((a, b) => a.order - b.order),
    outlineBeats: outlineBeats.sort((a, b) => a.order - b.order),
    codexCards: entries.map((entry) => entry.card),
    references
  };
}

async function openBlueprintOutline(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  manuscriptTree?: ManuscriptTreeProvider,
  codexTree?: CodexTreeProvider,
  outlineTree?: OutlineTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const loadState = async (blueprintId?: string) => storage.getBlueprintPanelState(blueprintId ?? activeBlueprintId);
  const rememberBlueprint = async (statePromise: Promise<Awaited<ReturnType<LoreDockStorage['getBlueprintPanelState']>>>) => {
    const state = await statePromise;
    activeBlueprintId = state.current.id;
    outlineTree?.refresh();
    return state;
  };
  activeBlueprintRefresh = async () => {
    if (activeBlueprintPanel) {
      activeBlueprintPanel.refresh(await rememberBlueprint(loadState()));
    }
  };
  if (activeBlueprintPanel) {
    activeBlueprintPanel.refresh(await rememberBlueprint(loadState()));
    activeBlueprintPanel.reveal();
    return;
  }
  activeBlueprintPanel = showBlueprintPanel(context, await rememberBlueprint(loadState()), async (action: BlueprintPanelAction) => {
    if (action.command === 'refresh') {
      return rememberBlueprint(storage.getBlueprintPanelState(action.blueprintId));
    }
    if (action.command === 'create-blueprint') {
      const blueprint = await storage.createBlueprint(action.title);
      outlineTree?.refresh();
      return rememberBlueprint(storage.getBlueprintPanelState(blueprint.id));
    }
    if (action.command === 'delete-blueprint') {
      const blueprint = await storage.readBlueprint(action.blueprintId);
      if (!blueprint) {
        return storage.getBlueprintPanelState();
      }
      const answer = await vscode.window.showWarningMessage(
        `确定删除蓝图「${blueprint.title}」吗？这不会删除手稿、大纲或资料卡。`,
        { modal: true },
        '删除蓝图'
      );
      if (answer === '删除蓝图') {
        await storage.deleteBlueprint(action.blueprintId);
      }
      activeBlueprintId = undefined;
      outlineTree?.refresh();
      return rememberBlueprint(storage.getBlueprintPanelState());
    }
    if (action.command === 'select-blueprint') {
      return rememberBlueprint(storage.getBlueprintPanelState(action.blueprintId));
    }
    if (action.command === 'save-blueprint') {
      await storage.writeBlueprint(action.document);
      return undefined;
    }
    if (action.command === 'create-from-outline') {
      const blueprint = await storage.createBlueprintFromOutline(action.outlineId);
      outlineTree?.refresh();
      return rememberBlueprint(storage.getBlueprintPanelState(blueprint.id));
    }
    if (action.command === 'add-resource') {
      const blueprint = await addBlueprintResource(storage, action.blueprintId, action.resourceId, action.resourceKind, { x: action.x, y: action.y });
      return rememberBlueprint(storage.getBlueprintPanelState(blueprint.id));
    }
    if (action.command === 'delete-resource') {
      if (action.resourceKind === 'outline' || action.resourceKind === 'outline-node') {
        const outline = (await storage.listOutlines()).find((candidate) => candidate.id === action.resourceId);
        if (!outline) {
          return rememberBlueprint(storage.getBlueprintPanelState(action.blueprintId));
        }
        const answer = await vscode.window.showWarningMessage(
          `确定删除大纲「${outline.title}」吗？这会删除 .loredock/outlines 中的文件，并从所有蓝图移除引用它的节点和连线。`,
          { modal: true },
          '删除大纲'
        );
        if (answer === '删除大纲') {
          await storage.deleteOutlineAndBlueprintReferences(action.resourceId);
          manuscriptTree?.refresh();
          codexTree?.refresh();
          outlineTree?.refresh();
        }
        return rememberBlueprint(storage.getBlueprintPanelState(action.blueprintId));
      }
      const entry = await storage.findCodexEntryById(action.resourceId);
      if (!entry) {
        return rememberBlueprint(storage.getBlueprintPanelState(action.blueprintId));
      }
      const answer = await vscode.window.showWarningMessage(
        `确定删除资料卡「${entry.card.name}」吗？这会删除 ${entry.relativePath}，并从所有蓝图移除引用它的节点和连线。`,
        { modal: true },
        '删除资料卡'
      );
      if (answer === '删除资料卡') {
        await storage.deleteCodexEntryAndBlueprintReferences(action.resourceId);
        codexTree?.refresh();
      }
      return rememberBlueprint(storage.getBlueprintPanelState(action.blueprintId));
    }
    if (action.command === 'add-note') {
      const blueprint = await storage.addNoteNodeToBlueprint(action.blueprintId, { x: action.x, y: action.y });
      return rememberBlueprint(storage.getBlueprintPanelState(blueprint.id));
    }
    if (action.command === 'auto-layout') {
      const blueprint = await storage.autoLayoutBlueprint(action.blueprintId);
      return rememberBlueprint(storage.getBlueprintPanelState(blueprint.id));
    }
    if (action.command === 'preview-sync') {
      return rememberBlueprint(withBlueprintSyncPreview(storage, action.blueprintId));
    }
    if (action.command === 'apply-sync') {
      const deleting = action.decisions.filter((decision) => decision.action === 'delete-source').length;
      if (deleting > 0) {
        const answer = await vscode.window.showWarningMessage(
          `确定通过蓝图同步删除 ${deleting} 个资料库来源吗？这会删除对应 JSON，并从所有蓝图移除引用节点和连线。`,
          { modal: true },
          '删除来源'
        );
        if (answer !== '删除来源') {
          return rememberBlueprint(withBlueprintSyncPreview(storage, action.blueprintId));
        }
      }
      const blueprint = await storage.applyBlueprintSync(action.blueprintId, action.decisions);
      if (deleting > 0) {
        manuscriptTree?.refresh();
        codexTree?.refresh();
      }
      return rememberBlueprint(withBlueprintSyncPreview(storage, blueprint.id, {
        applied: action.decisions.filter((decision) => decision.action !== 'skip').length,
        skipped: action.decisions.filter((decision) => decision.action === 'skip').length,
        pulled: action.decisions.filter((decision) => decision.action === 'pull').length,
        pushed: action.decisions.filter((decision) => decision.action === 'push').length,
        deletedSources: deleting
      }));
    }
    if (action.command === 'open-source') {
      await openHealthSource(storage, action.source);
      return undefined;
    }
    return undefined;
  }, () => {
    activeBlueprintPanel = undefined;
    activeBlueprintRefresh = undefined;
    activeBlueprintId = undefined;
  });
}

async function openBlueprintForOutline(
  context: vscode.ExtensionContext,
  getStorage: () => LoreDockStorage | undefined,
  node?: unknown,
  manuscriptTree?: ManuscriptTreeProvider,
  codexTree?: CodexTreeProvider,
  outlineTree?: OutlineTreeProvider
): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const outlineId = isOutlineDocumentNode(node)
    ? node.outline.id
    : undefined;
  if (!outlineId) {
    await openBlueprintOutline(context, getStorage, manuscriptTree, codexTree, outlineTree);
    return;
  }
  const blueprint = await storage.createBlueprintFromOutline(outlineId);
  activeBlueprintId = blueprint.id;
  outlineTree?.refresh();
  await openBlueprintOutline(context, getStorage, manuscriptTree, codexTree, outlineTree);
}

async function openOutlineSource(getStorage: () => LoreDockStorage | undefined, node?: unknown): Promise<void> {
  const storage = requireStorage(getStorage);
  const outlineId = isOutlineDocumentNode(node)
    ? node.outline.id
    : undefined;
  if (!outlineId) {
    return;
  }
  const resource = (await storage.listBlueprintResources()).find((candidate) => candidate.kind === 'outline' && candidate.id === outlineId);
  if (resource) {
    await openHealthSource(storage, resource.relativePath);
  }
}

async function withBlueprintSyncPreview(
  storage: LoreDockStorage,
  blueprintId: string,
  syncResult?: Awaited<ReturnType<LoreDockStorage['getBlueprintPanelState']>>['syncResult']
): Promise<Awaited<ReturnType<LoreDockStorage['getBlueprintPanelState']>>> {
  const state = await storage.getBlueprintPanelState(blueprintId);
  return {
    ...state,
    syncPreview: await storage.previewBlueprintSync(state.current.id),
    syncResult
  };
}

async function addBlueprintResource(
  storage: LoreDockStorage,
  blueprintId: string,
  resourceId: string,
  resourceKind: string,
  position: { x: number; y: number }
): Promise<BlueprintDocument> {
  if (resourceKind !== 'outline') {
    const entry = await storage.findCodexEntryById(resourceId);
    if (!entry) {
      throw new Error(`找不到资料卡：${resourceId}`);
    }
    return storage.addCodexNodeToBlueprint(blueprintId, entry, position);
  }
  const [blueprint, resources] = await Promise.all([
    storage.readBlueprint(blueprintId),
    storage.listBlueprintResources()
  ]);
  if (!blueprint) {
    throw new Error(`找不到蓝图：${blueprintId}`);
  }
  const resource = resources.find((candidate) => candidate.kind === 'outline' && candidate.id === resourceId);
  if (!resource) {
    throw new Error(`找不到大纲：${resourceId}`);
  }
  const node: BlueprintNode = {
    id: `bp-node-${Date.now()}`,
    kind: 'outline',
    title: resource.title,
    refKind: 'outline',
    refId: resource.id,
    refPath: resource.relativePath,
    x: position.x,
    y: position.y,
    width: 240,
    height: 112,
    note: '',
    color: '#4e9aef',
    lastSynced: {
      title: resource.title,
      note: '',
      syncedAt: new Date().toISOString()
    }
  };
  return storage.writeBlueprint({
    ...blueprint,
    nodes: [...blueprint.nodes, node]
  });
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
  codexTree?.refresh();
  vscode.window.showInformationMessage(`已导入独立大纲：卷 ${imported.volumes}，大纲章节 ${imported.outlineChapters}，场景 ${imported.scenes}，Beat ${imported.beats}。手稿未被修改。`);
}

async function createPlanFromOutline(storage: LoreDockStorage, outline: string) {
  return storage.importOutlineToPlan(outline);
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
  refreshActiveBlueprintPanel();
  await openCreatedCodexCard(storage, card.id);
}

async function createLocation(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const name = await nextDraftName(storage, 'location', '未命名地点');
  const card = await storage.createLocation({ name });
  codexTree.refresh();
  refreshActiveBlueprintPanel();
  await openCreatedCodexCard(storage, card.id);
}

async function createWorldRule(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const name = await nextDraftName(storage, 'world-rule', '未命名规则');
  const card = await storage.createWorldRule({ name });
  codexTree.refresh();
  refreshActiveBlueprintPanel();
  await openCreatedCodexCard(storage, card.id);
}

async function createForeshadowing(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'foreshadowing', '未命名伏笔');
  const card = await storage.createForeshadowing({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  refreshActiveBlueprintPanel();
  await openCreatedCodexCard(storage, card.id);
}

async function createTimelineEvent(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const document = await storage.readTimelineDocumentIfExists();
  if (!document) {
    await vscode.window.showInformationMessage('请先在时间线工作台中新建一条时间线。');
    await showTimelineWorkbench(context, storage);
    return;
  }
  await storage.createTimelineEvent({ name: `未命名事件 ${document.events.length + 1}`, chapterId: chapter?.chapter.id });
  await showTimelineWorkbench(context, storage);
}

async function createScene(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'scene', '未命名场景');
  const card = await storage.createScene({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  refreshActiveBlueprintPanel();
  await openCreatedCodexCard(storage, card.id);
}

async function createBeat(getStorage: () => LoreDockStorage | undefined, codexTree: CodexTreeProvider): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const chapter = await resolveOptionalChapter(storage);
  const name = await nextDraftName(storage, 'beat', '未命名 Beat');
  const card = await storage.createBeat({ name, chapterId: chapter?.chapter.id });
  codexTree.refresh();
  refreshActiveBlueprintPanel();
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
      label: '不纳入上下文',
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

async function openTimelineWorkbench(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  await showTimelineWorkbench(context, storage);
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

async function openSettings(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.requireManifest();
  const actions: Array<{ label: string; description?: string; run: () => Promise<void> | void }> = [
    {
      label: '项目仪表盘',
      description: '查看写作统计、健康问题和近期章节',
      run: () => showProjectDashboard(context, getStorage)
    },
    {
      label: '打开大纲蓝图',
      description: '可视化组织大纲和资料卡关系',
      run: () => openBlueprintOutline(context, getStorage)
    },
    {
      label: '打开文风指南',
      description: '维护叙事视角、表达偏好和禁用事项',
      run: () => openStyleGuide(getStorage)
    },
    {
      label: '配置导出样式',
      description: '维护 DOCX/EPUB/PDF 导出格式',
      run: () => configureExportStyle(getStorage)
    },
    {
      label: '设置写作目标',
      description: '维护每日目标和全书目标字数',
      run: () => setWritingGoals(getStorage)
    },
    {
      label: '显示写作统计',
      description: '查看卷、章节、字数和状态分布',
      run: () => showWritingStats(getStorage)
    },
    {
      label: '项目健康检查',
      description: '输出只读结构问题清单',
      run: () => showProjectHealth(context, getStorage)
    },
    {
      label: '预览项目健康安全修复',
      description: '清理失效 summaryId，整理重复的场景/Beat order',
      run: async () => { await previewProjectHealthFixes(getStorage); }
    },
    {
      label: '保存当前健康问题为基线',
      description: '以后只突出新增/未忽略问题',
      run: () => saveProjectHealthBaseline(getStorage)
    },
    {
      label: '清空健康基线',
      description: '重新显示所有健康问题',
      run: () => clearProjectHealthBaseline(getStorage)
    },
    {
      label: '查看引用索引',
      description: '查看资料卡在手稿和规划中的出现位置',
      run: () => showReferenceIndex(getStorage)
    }
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: 'LoreDock 结构设置'
  });
  await picked?.run();
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

async function showWritingStats(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  showStatsPanel(await storage.getWritingStats());
}

async function showProjectDashboard(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  showDashboardPanel(context, await storage.getProjectDashboard(), async (action: DashboardPanelAction) => {
    if (action.command === 'refresh') {
      return storage.getProjectDashboard();
    }
    if (action.command === 'show-health') {
      await showProjectHealth(context, () => storage);
      return undefined;
    }
    if (action.command === 'show-stats') {
      await showWritingStats(() => storage);
      return undefined;
    }
    if (action.command === 'open-source') {
      await openHealthSource(storage, action.source);
      return undefined;
    }
    return undefined;
  });
}

async function showProjectHealth(context: vscode.ExtensionContext, getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  showHealthPanel(context, await storage.buildProjectHealthReport(), async (action: HealthPanelAction) => {
    if (action.command === 'refresh') {
      return storage.buildProjectHealthReport();
    }
    if (action.command === 'preview-fix') {
      await previewProjectHealthFixes(() => storage);
      return undefined;
    }
    if (action.command === 'fix') {
      await fixProjectHealth(() => storage);
      return storage.buildProjectHealthReport();
    }
    if (action.command === 'save-baseline') {
      await saveProjectHealthBaseline(() => storage);
      return storage.buildProjectHealthReport();
    }
    if (action.command === 'clear-baseline') {
      await clearProjectHealthBaseline(() => storage);
      return storage.buildProjectHealthReport();
    }
    if (action.command === 'open-source') {
      await openHealthSource(storage, action.source);
      return undefined;
    }
    return undefined;
  });
}

async function previewProjectHealthFixes(getStorage: () => LoreDockStorage | undefined): Promise<ProjectHealthFixReport> {
  const storage = requireStorage(getStorage);
  const preview = await storage.previewProjectHealthBasicsFixes();
  const healthReport = await storage.buildProjectHealthReport();
  await showMarkdownDocument('LoreDock 项目健康安全修复预览', formatProjectHealthFixReport(preview, healthReport, storage.workspaceRoot, true));
  return preview;
}

async function fixProjectHealth(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const preview = await storage.previewProjectHealthBasicsFixes();
  const willChange = preview.actions.some((action) => action.willChange);
  await showMarkdownDocument('LoreDock 项目健康安全修复预览', formatProjectHealthFixReport(preview, await storage.buildProjectHealthReport(), storage.workspaceRoot, true));
  if (!willChange) {
    vscode.window.showInformationMessage('没有可执行的安全修复。');
    return;
  }
  const answer = await vscode.window.showWarningMessage('确认执行项目健康安全修复？', { modal: true }, '执行安全修复');
  if (answer !== '执行安全修复') {
    return;
  }
  const fixReport = await storage.fixProjectHealthBasics();
  const healthReport = await storage.buildProjectHealthReport();
  await showMarkdownDocument('LoreDock 项目健康安全修复', formatProjectHealthFixReport(fixReport, healthReport, storage.workspaceRoot));
}

async function saveProjectHealthBaseline(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  const baseline = await storage.saveCurrentProjectHealthBaseline();
  vscode.window.showInformationMessage(`已保存健康基线：${baseline.fingerprints.length} 个问题将作为已知项。`);
}

async function clearProjectHealthBaseline(getStorage: () => LoreDockStorage | undefined): Promise<void> {
  const storage = requireStorage(getStorage);
  await storage.clearProjectHealthBaseline();
  vscode.window.showInformationMessage('已清空健康基线。');
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

function formatProjectHealthReport(report: ProjectHealthReport, workspaceRoot: string): string {
  const severities: ProjectHealthSeverity[] = ['error', 'warning', 'info'];
  const categories: ProjectHealthCategory[] = ['manuscript', 'codex', 'plan', 'timeline', 'foreshadowing', 'references'];
  const lines = [
    `# LoreDock 项目健康检查：${report.projectTitle}`,
    '',
    `生成时间：${report.generatedAt}`,
    `未忽略汇总：${healthSeverityLabel('error')} ${report.summary.error} · ${healthSeverityLabel('warning')} ${report.summary.warning} · ${healthSeverityLabel('info')} ${report.summary.info}`,
    `全部汇总：${healthSeverityLabel('error')} ${report.totalSummary.error} · ${healthSeverityLabel('warning')} ${report.totalSummary.warning} · ${healthSeverityLabel('info')} ${report.totalSummary.info} · 已忽略 ${report.ignoredCount}`,
    ''
  ];

  if (report.issues.length === 0) {
    lines.push('未发现结构问题。');
    return lines.join('\n');
  }

  for (const severity of severities) {
    const severityIssues = report.issues.filter((issue) => issue.severity === severity);
    if (severityIssues.length === 0) {
      continue;
    }
    lines.push(`## ${healthSeverityLabel(severity)}（${severityIssues.length}）`, '');
    for (const category of categories) {
      const categoryIssues = severityIssues.filter((issue) => issue.category === category);
      if (categoryIssues.length === 0) {
        continue;
      }
      lines.push(`### ${healthCategoryLabel(category)}（${categoryIssues.length}）`, '');
      for (const issue of categoryIssues) {
        lines.push(
          `- **${issue.title}**`,
          issue.ignored ? '  - 状态：已在健康基线中忽略' : '',
          `  - 来源：${formatHealthSource(issue.source, workspaceRoot)}`,
          `  - 说明：${issue.detail}`,
          `  - 建议：${issue.suggestion}`,
          ''
        );
      }
    }
  }
  return lines.join('\n');
}

function formatProjectHealthFixReport(fixReport: ProjectHealthFixReport, healthReport: ProjectHealthReport, workspaceRoot: string, preview = false): string {
  const lines = [
    `# LoreDock 项目健康安全修复${preview ? '预览' : ''}：${healthReport.projectTitle}`,
    '',
    `${preview ? '预览时间' : '修复时间'}：${fixReport.fixedAt}`,
    '',
    preview ? '## 将执行的动作' : '## 执行动作',
    ''
  ];
  for (const action of fixReport.actions) {
    const state = preview ? (action.willChange ? '将修改' : '无需修改') : (action.changed ? '已修改' : '无需修改');
    lines.push(`- **${action.title}**：${state}`, `  - ${action.detail}`);
    if (action.affectedSources?.length) {
      lines.push(`  - 影响：${action.affectedSources.map((source) => formatHealthSource(source, workspaceRoot)).join('、')}`);
    }
  }
  lines.push(
    '',
    '## 修复后健康概况',
    '',
    `汇总：${healthSeverityLabel('error')} ${healthReport.summary.error} · ${healthSeverityLabel('warning')} ${healthReport.summary.warning} · ${healthSeverityLabel('info')} ${healthReport.summary.info}`,
    ''
  );
  if (healthReport.issues.length === 0) {
    lines.push('未发现结构问题。');
  } else {
    lines.push('仍需人工处理的问题：', '');
    for (const issue of healthReport.issues.slice(0, 30)) {
      lines.push(`- **${healthSeverityLabel(issue.severity)} / ${healthCategoryLabel(issue.category)} / ${issue.title}**`);
      lines.push(`  - 来源：${formatHealthSource(issue.source, workspaceRoot)}`);
      lines.push(`  - 建议：${issue.suggestion}`);
    }
    if (healthReport.issues.length > 30) {
      lines.push('', `其余 ${healthReport.issues.length - 30} 个问题请重新运行项目健康检查查看完整列表。`);
    }
  }
  return lines.join('\n');
}

function isSafelyFixableHealthIssue(issue: { title: string }): boolean {
  return ['章节摘要引用缺失', '场景顺序重复', 'Beat顺序重复'].includes(issue.title);
}

async function openHealthSource(storage: LoreDockStorage, source: string): Promise<void> {
  const clean = source.split(',')[0]?.trim();
  if (!clean || !isWorkspaceRelativeSource(clean)) {
    vscode.window.showInformationMessage(`无法直接打开来源：${source}`);
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storage.resolve(clean)));
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function formatHealthSource(source: string | undefined, workspaceRoot: string): string {
  if (!source) {
    return '未指定';
  }
  return source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!isWorkspaceRelativeSource(item)) {
        return escapeMarkdownInline(item);
      }
      const uri = vscode.Uri.file(path.join(workspaceRoot, ...item.split('/'))).toString();
      return `[${escapeMarkdownInline(item)}](${uri})`;
    })
    .join('、');
}

function isWorkspaceRelativeSource(source: string): boolean {
  return (
    source === '.loredock/project.json' ||
    source.startsWith('.loredock/') ||
    source.startsWith('manuscript/') ||
    source.startsWith('codex/') ||
    source.startsWith('exports/')
  );
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_\[\]()#])/g, '\\$1');
}

function healthSeverityLabel(severity: ProjectHealthSeverity): string {
  const labels: Record<ProjectHealthSeverity, string> = {
    error: '错误',
    warning: '警告',
    info: '提示'
  };
  return labels[severity];
}

function healthCategoryLabel(category: ProjectHealthCategory): string {
  const labels: Record<ProjectHealthCategory, string> = {
    manuscript: '手稿结构',
    codex: '资料库结构',
    plan: '规划结构',
    timeline: '时间线结构',
    foreshadowing: '伏笔结构',
    references: '引用结构'
  };
  return labels[category];
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
