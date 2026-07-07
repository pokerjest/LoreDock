import * as vscode from "vscode";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import type { DiagnosticItem, OperationPlan } from "../../kernel/types";
import { countMarkdownWords } from "../manuscript/wordCount";
import type { ChapterId, ManuscriptChapterDto, ManuscriptService } from "../manuscript/types";
import { SCENE_STATUSES, type OutlineSceneService, type SceneCardDto, type SceneCardMetadataPatch, type SceneId, type SceneProjectionDto } from "../outlineScenes/types";
import type { KeywordCatalogEntryDto, StoryBibleCardDto, StoryBibleService } from "../storyBible/types";
import { isValidKeywordSlug, keywordLabelFromSlug, normalizeKeywordSlugInput } from "../storyBible/ids";
import {
  BOARDS_DIR,
  PLOT_GRID_CONFIG_PATH,
  type PlotGridActionResult,
  type PlotGridActions,
  type PlotGridChangeEvent,
  type PlotGridChangeType,
  type PlotGridConfigDto,
  type PlotGridConfiguredTrackDto,
  type PlotGridEntityDto,
  type PlotGridFilters,
  type PlotGridProjectionDto,
  type PlotGridReader,
  type PlotGridRowDto,
  type PlotGridService,
  type PlotGridTrackDto,
  type PlotGridTrackInput,
  type PlotGridViewPreferencesPatch,
  type PlotGridVisibleColumn
} from "./types";
import {
  createDefaultPlotGridConfig,
  createInferredTrack,
  isPlotGridContentPath,
  readPlotGridConfig,
  stringifyPlotGridConfig,
  type PlotGridConfigReadResult
} from "./files";

interface PlotGridControllerOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  output: vscode.OutputChannel;
  diagnostics: {
    add(item: DiagnosticItem): void;
    clearMatching(workspaceFolderPath: string, predicate: (item: DiagnosticItem) => boolean): void;
  };
  confirmOperationPlan(plan: OperationPlan): Promise<boolean>;
  getManuscriptService(): ManuscriptService | undefined;
  getOutlineSceneService(): OutlineSceneService | undefined;
  getStoryBibleService?(): StoryBibleService | undefined;
  now(): Date;
}

export class PlotGridController implements PlotGridReader, PlotGridActions, PlotGridService {
  public readonly reader: PlotGridReader = this;
  public readonly actions: PlotGridActions = this;

  private readonly emitter = new vscode.EventEmitter<PlotGridChangeEvent>();

  public constructor(private readonly options: PlotGridControllerOptions) {}

  public onDidChange(listener: (event: PlotGridChangeEvent) => unknown): vscode.Disposable {
    return this.emitter.event(listener);
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  public notifyProjectionChanged(path?: string): void {
    this.emit("projection", { path });
  }

  public notifyConfigChanged(path = PLOT_GRID_CONFIG_PATH): void {
    this.emit("config", { path });
  }

  public async refreshDiagnostics(): Promise<DiagnosticItem[]> {
    this.options.diagnostics.clearMatching(this.workspaceRoot, isPlotGridDiagnostic);
    const diagnostics = await this.validateConfig();
    for (const item of diagnostics) {
      this.options.diagnostics.add(item);
    }
    return diagnostics;
  }

  public async getConfig(): Promise<PlotGridConfigDto> {
    return (await readPlotGridConfig(this.workspaceRoot)).config;
  }

  public async validateConfig(): Promise<DiagnosticItem[]> {
    return (await readPlotGridConfig(this.workspaceRoot)).diagnostics;
  }

  public async listTracks(): Promise<PlotGridTrackDto[]> {
    const [configRead, scenes] = await Promise.all([
      this.readConfig(),
      this.listBoundScenes()
    ]);
    return buildTracks(configRead.config, scenes);
  }

  public async getProjection(filters: PlotGridFilters = {}): Promise<PlotGridProjectionDto> {
    const [configRead, sceneProjection, chapters, storyEntities] = await Promise.all([
      this.readConfig(),
      this.requireOutlineSceneService().reader.getSceneProjection(),
      this.requireManuscriptService().reader.listChapters(),
      this.createStoryEntities()
    ]);
    const chapterById = new Map(chapters.map((chapter) => [chapter.id as string, chapter]));
    const diagnostics = configRead.diagnostics.map((item) => item.message);
    const chapterStats = await this.readChapterStats(chapters, diagnostics);
    const boundScenes = sceneProjection.chapters.flatMap((chapter) => chapter.scenes);
    const tracks = buildTracks(configRead.config, boundScenes);
    const rows = buildRows(configRead.config, sceneProjection, chapterById, chapterStats);
    const filteredRows = filterRowsPreservingStructure(rows, filters);
    const visibleTracks = filterTracksByRows(tracks, filteredRows, configRead.config.view.showEmptyTracks);

    return {
      rowMode: configRead.config.view.rowMode,
      visibleColumns: configRead.config.view.visibleColumns,
      tracks: visibleTracks,
      rows: filteredRows,
      filters: buildFilterOptions(rows, tracks, storyEntities),
      entities: storyEntities,
      diagnostics
    };
  }

  public async enablePlotGrid(): Promise<PlotGridActionResult> {
    const read = await this.readConfig();
    if (read.status !== "missing") {
      return { applied: false, plan: emptyPlan("Plot Grid 配置已存在。") };
    }

    const config = createDefaultPlotGridConfig(this.options.now());
    const plan = plotGridPlan("创建 Plot Grid 配置。", [BOARDS_DIR], [PLOT_GRID_CONFIG_PATH], []);
    return this.applyPlan(plan, async (writer) => {
      await writer.ensureDirectory(BOARDS_DIR);
      await writer.writeFile(PLOT_GRID_CONFIG_PATH, stringifyPlotGridConfig(config));
    });
  }

  public async upsertTrack(input: PlotGridTrackInput): Promise<PlotGridActionResult> {
    const trackId = assertTrackId(input.id);
    const read = await this.readConfig();
    const tracks = [...read.config.tracks];
    const index = tracks.findIndex((track) => track.id === trackId);
    const existing = index >= 0 ? tracks[index] : undefined;
    const nextTrack: PlotGridConfiguredTrackDto = {
      id: trackId,
      label: assertLabel(input.label ?? existing?.label ?? keywordLabelFromSlug(trackId)),
      ...(input.color ?? existing?.color ? { color: assertColor(input.color ?? existing?.color) } : {}),
      order: existing?.order ?? nextTrackOrder(tracks),
      visible: input.visible ?? existing?.visible ?? true
    };

    if (index >= 0) {
      tracks[index] = nextTrack;
    } else {
      tracks.push(nextTrack);
    }

    return this.writeConfig(read, {
      ...read.config,
      tracks: sortConfiguredTracks(tracks),
      updatedAt: this.timestamp()
    }, `${existing ? "更新" : "创建"}剧情线轨道“${nextTrack.label}”。`);
  }

  public async deleteTrack(trackId: string): Promise<PlotGridActionResult> {
    const id = normalizeTrackId(trackId);
    const read = await this.readConfig();
    const existing = read.config.tracks.find((track) => track.id === id);
    if (!existing) {
      return { applied: false, plan: emptyPlan(`剧情线轨道 "${trackId}" 不存在。`) };
    }

    return this.writeConfig(read, {
      ...read.config,
      tracks: read.config.tracks.filter((track) => track.id !== id),
      updatedAt: this.timestamp()
    }, `删除剧情线轨道“${existing.label}”。`);
  }

  public async reorderTracks(trackIds: string[]): Promise<PlotGridActionResult> {
    const read = await this.readConfig();
    const normalizedIds = unique(trackIds.map(normalizeTrackId));
    const configuredById = new Map(read.config.tracks.map((track) => [track.id, track]));
    const ordered: PlotGridConfiguredTrackDto[] = [];
    for (const id of normalizedIds) {
      const track = configuredById.get(id);
      if (track && !ordered.some((item) => item.id === id)) {
        ordered.push(track);
      }
    }
    for (const track of read.config.tracks) {
      if (!ordered.some((item) => item.id === track.id)) {
        ordered.push(track);
      }
    }

    const tracks = ordered.map((track, index) => ({ ...track, order: index + 1 }));
    return this.writeConfig(read, {
      ...read.config,
      tracks,
      updatedAt: this.timestamp()
    }, "调整剧情线轨道顺序。");
  }

  public async updateViewPreferences(patch: PlotGridViewPreferencesPatch): Promise<PlotGridActionResult> {
    const read = await this.readConfig();
    const visibleColumns = patch.visibleColumns
      ? normalizeVisibleColumns(patch.visibleColumns)
      : read.config.view.visibleColumns;

    return this.writeConfig(read, {
      ...read.config,
      view: {
        ...read.config.view,
        ...(patch.rowMode ? { rowMode: patch.rowMode } : {}),
        visibleColumns,
        ...(patch.showEmptyTracks !== undefined ? { showEmptyTracks: patch.showEmptyTracks } : {}),
        ...(patch.compact !== undefined ? { compact: patch.compact } : {})
      },
      updatedAt: this.timestamp()
    }, "更新 Plot Grid 视图偏好。");
  }

  public async assignSceneTrack(sceneId: SceneId, trackId: string, assigned: boolean): Promise<PlotGridActionResult> {
    const id = assertTrackId(trackId);
    const scene = await this.requireOutlineSceneService().reader.getScene(sceneId);
    if (!scene) {
      throw new Error(`未找到场景卡 "${sceneId}"。`);
    }

    const currentPlotlineRefs = scene.plotlineRefs.map(normalizeTrackId).filter(Boolean);
    const plotlineRefs = assigned
      ? unique([...currentPlotlineRefs, id])
      : currentPlotlineRefs.filter((ref) => ref !== id);
    if (arraysEqual(plotlineRefs, currentPlotlineRefs)) {
      return { applied: false, plan: emptyPlan(`场景卡“${scene.title}”的剧情线无需更新。`) };
    }

    const result = await this.requireOutlineSceneService().actions.updateSceneMetadata(sceneId, { plotlineRefs });
    if (result.applied) {
      this.emit("projection", { path: scene.path });
    }
    return result;
  }

  public async updateSceneMetadata(sceneId: SceneId, patch: SceneCardMetadataPatch): Promise<PlotGridActionResult> {
    const scene = await this.requireOutlineSceneService().reader.getScene(sceneId);
    if (!scene) {
      throw new Error(`未找到场景卡 "${sceneId}"。`);
    }

    const sanitized = sanitizeSceneMetadataPatch(patch);
    if (Object.keys(sanitized).length === 0) {
      return { applied: false, plan: emptyPlan(`场景卡“${scene.title}”没有需要更新的字段。`) };
    }

    const result = await this.requireOutlineSceneService().actions.updateSceneMetadata(sceneId, sanitized);
    if (result.applied) {
      this.emit("projection", { path: scene.path });
    }
    return result;
  }

  public async reorderChapterScenes(chapterId: string, sceneIds: SceneId[]): Promise<PlotGridActionResult> {
    const result = await this.requireOutlineSceneService().actions.reorderChapterScenes(chapterId, sceneIds);
    if (result.applied) {
      this.emit("projection", { path: PLOT_GRID_CONFIG_PATH });
    }
    return result;
  }

  private async readConfig(): Promise<PlotGridConfigReadResult> {
    return readPlotGridConfig(this.workspaceRoot);
  }

  private async writeConfig(
    read: PlotGridConfigReadResult,
    config: PlotGridConfigDto,
    summary: string
  ): Promise<PlotGridActionResult> {
    const plan = plotGridPlan(
      summary,
      [BOARDS_DIR],
      read.status === "missing" ? [PLOT_GRID_CONFIG_PATH] : [],
      read.status === "missing" ? [] : [PLOT_GRID_CONFIG_PATH]
    );
    plan.fileContentPreviews = [{
      relativePath: PLOT_GRID_CONFIG_PATH,
      title: "Plot Grid 配置",
      content: stringifyPlotGridConfig(config, read.raw)
    }];
    return this.applyPlan(plan, async (writer) => {
      await writer.ensureDirectory(BOARDS_DIR);
      await writer.writeFile(PLOT_GRID_CONFIG_PATH, stringifyPlotGridConfig(config, read.raw));
    });
  }

  private async applyPlan(
    plan: OperationPlan,
    apply: (writer: SafeFileWriter) => Promise<void>
  ): Promise<PlotGridActionResult> {
    assertSafePlotGridOperations(plan);
    const confirmed = await this.options.confirmOperationPlan(plan);
    if (!confirmed) {
      this.options.output.appendLine(`已取消 Plot Grid 操作：${plan.summary}`);
      return { applied: false, plan };
    }

    const writer = new SafeFileWriter(this.workspaceRoot, plan);
    await apply(writer);
    this.emit("config", { path: PLOT_GRID_CONFIG_PATH });
    await this.refreshDiagnostics();
    return { applied: true, plan };
  }

  private async listBoundScenes(): Promise<SceneCardDto[]> {
    const projection = await this.requireOutlineSceneService().reader.getSceneProjection();
    return projection.chapters.flatMap((chapter) => chapter.scenes);
  }

  private async readChapterStats(
    chapters: ManuscriptChapterDto[],
    diagnostics: string[]
  ): Promise<Map<string, { wordCount?: number; isEmpty?: boolean; targetWordCount?: number }>> {
    const result = new Map<string, { wordCount?: number; isEmpty?: boolean; targetWordCount?: number }>();
    const manuscript = this.requireManuscriptService().reader;
    await Promise.all(chapters.map(async (chapter) => {
      const read = await manuscript.readChapterText(chapter.id);
      if (!read.ok || read.text === undefined) {
        diagnostics.push(read.error ?? `无法读取章节“${chapter.title}”。`);
        result.set(chapter.id, { targetWordCount: chapter.targetWordCount });
        return;
      }
      const counted = countMarkdownWords(read.text);
      result.set(chapter.id, {
        wordCount: counted.count,
        isEmpty: counted.isEmpty,
        targetWordCount: chapter.targetWordCount
      });
    }));
    return result;
  }

  private async createStoryEntities(): Promise<Record<string, PlotGridEntityDto>> {
    const service = this.options.getStoryBibleService?.();
    if (!service) {
      return {};
    }

    const [cards, keywords] = await Promise.all([
      service.reader.listCards(),
      service.reader.listKeywords()
    ]);
    const cardBodies = await Promise.all(cards.map(async (card) => {
      const read = await service.reader.readCardText(card.id);
      return [card.id, read.ok ? read.text ?? "" : ""] as const;
    }));
    const bodyByCardId = new Map(cardBodies);
    const entities: Record<string, PlotGridEntityDto> = {};
    for (const card of cards) {
      const entity = cardEntity(card, bodyByCardId.get(card.id));
      entities[card.id] = entity;
      entities[card.primaryKeyword] = entity;
      for (const tag of card.tags) {
        entities[tag] = entities[tag] ?? { ...entity, ref: tag };
      }
    }
    for (const keyword of keywords) {
      entities[keyword.slug] = entities[keyword.slug] ?? keywordEntity(keyword);
    }
    return entities;
  }

  private requireManuscriptService(): ManuscriptService {
    const service = this.options.getManuscriptService();
    if (!service) {
      throw new Error("Plot Grid 需要先启用 Manuscript。");
    }
    return service;
  }

  private requireOutlineSceneService(): OutlineSceneService {
    const service = this.options.getOutlineSceneService();
    if (!service) {
      throw new Error("Plot Grid 需要先启用结构规划。");
    }
    return service;
  }

  private emit(type: PlotGridChangeType, event: Partial<PlotGridChangeEvent>): void {
    this.emitter.fire({
      type,
      workspaceFolder: this.options.workspaceFolder,
      ...event
    });
  }

  private get workspaceRoot(): string {
    return this.options.workspaceFolder.uri.fsPath;
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

function buildTracks(config: PlotGridConfigDto, scenes: SceneCardDto[]): PlotGridTrackDto[] {
  const configured = sortConfiguredTracks(config.tracks).map((track) => ({ ...track, source: "configured" as const }));
  const configuredIds = new Set(configured.map((track) => track.id));
  const inferredIds = unique(scenes.flatMap((scene) => scene.plotlineRefs.map(normalizeTrackId)))
    .filter((id) => id !== "" && !configuredIds.has(id))
    .sort((left, right) => left.localeCompare(right));
  const startOrder = configured.reduce((max, track) => Math.max(max, track.order), 0) + 1;
  const inferred = inferredIds.map((id, index) => ({
    ...createInferredTrack(id, startOrder + index),
    source: "inferred" as const
  }));
  return [...configured, ...inferred];
}

function buildRows(
  config: PlotGridConfigDto,
  sceneProjection: SceneProjectionDto,
  chapterById: Map<string, ManuscriptChapterDto>,
  chapterStats: Map<string, { wordCount?: number; isEmpty?: boolean; targetWordCount?: number }>
): PlotGridRowDto[] {
  const rows: PlotGridRowDto[] = [];

  for (const chapterProjection of sceneProjection.chapters) {
    const chapter = chapterById.get(chapterProjection.chapterId);
    const stats = chapterStats.get(chapterProjection.chapterId) ?? {};
    const chapterRow = chapterToRow(chapterProjection, chapter, stats);
    rows.push(chapterRow);

    if (config.view.rowMode !== "chapter") {
      for (const scene of chapterProjection.scenes) {
        rows.push(sceneToRow(scene, chapterProjection.chapterId));
      }
    }
  }

  return rows;
}

function filterRowsPreservingStructure(rows: PlotGridRowDto[], filters: PlotGridFilters): PlotGridRowDto[] {
  const result: PlotGridRowDto[] = [];
  let currentChapter: PlotGridRowDto | undefined;
  let currentScenes: PlotGridRowDto[] = [];

  const flush = () => {
    if (!currentChapter) {
      result.push(...currentScenes.filter((row) => rowMatchesFilters(row, filters)));
      currentScenes = [];
      return;
    }

    const chapterMatches = rowMatchesFilters(currentChapter, filters);
    const matchingScenes = currentScenes.filter((row) => rowMatchesFilters(row, filters));
    if (chapterMatches || matchingScenes.length > 0) {
      result.push(currentChapter, ...matchingScenes);
    }
    currentChapter = undefined;
    currentScenes = [];
  };

  for (const row of rows) {
    if (row.type === "chapter") {
      flush();
      currentChapter = row;
      continue;
    }
    currentScenes.push(row);
  }
  flush();

  return result;
}

function chapterToRow(
  chapterProjection: SceneProjectionDto["chapters"][number],
  chapter: ManuscriptChapterDto | undefined,
  stats: { wordCount?: number; isEmpty?: boolean; targetWordCount?: number }
): PlotGridRowDto {
  const scenes = chapterProjection.scenes;
  return {
    id: `chapter:${chapterProjection.chapterId}`,
    type: "chapter",
    title: chapterProjection.title,
    chapterId: chapterProjection.chapterId,
    volumeId: chapterProjection.volumeId,
    path: chapter?.path,
    status: chapter?.status,
    characterRefs: unique(scenes.flatMap((scene) => scene.characterRefs)),
    locationRefs: unique(scenes.flatMap((scene) => scene.locationRefs)),
    ruleRefs: [],
    plotlineRefs: unique(scenes.flatMap((scene) => scene.plotlineRefs.map(normalizeTrackId))),
    wordCount: stats.wordCount,
    targetWordCount: stats.targetWordCount,
    isEmpty: stats.isEmpty,
    diagnostics: chapter ? [] : ["章节在 Manuscript 中无法解析。"],
    sourceType: "chapter"
  };
}

function sceneToRow(scene: SceneCardDto, chapterId?: ChapterId): PlotGridRowDto {
  return {
    id: `scene:${scene.id}:${chapterId ?? "orphan"}`,
    type: "scene",
    title: scene.title,
    chapterId,
    sceneId: scene.id,
    path: scene.path,
    status: scene.status,
    pov: scene.pov,
    characterRefs: scene.characterRefs,
    locationRefs: scene.locationRefs,
    ruleRefs: [],
    plotlineRefs: scene.plotlineRefs.map(normalizeTrackId).filter(Boolean),
    conflict: scene.conflict,
    turn: scene.turn,
    outcome: scene.outcome,
    diagnostics: [],
    sourceType: "scene"
  };
}

function rowMatchesFilters(row: PlotGridRowDto, filters: PlotGridFilters): boolean {
  if (filters.status && row.status !== filters.status) {
    return false;
  }
  if (filters.characterRef && !row.characterRefs.includes(filters.characterRef)) {
    return false;
  }
  if (filters.locationRef && !row.locationRefs.includes(filters.locationRef)) {
    return false;
  }
  if (filters.plotlineRef && !row.plotlineRefs.includes(normalizeTrackId(filters.plotlineRef))) {
    return false;
  }
  const text = filters.text?.trim().toLowerCase();
  if (!text) {
    return true;
  }
  const fields = [
    row.title,
    row.pov ?? "",
    row.conflict ?? "",
    row.turn ?? "",
    row.outcome ?? "",
    ...row.characterRefs,
    ...row.locationRefs,
    ...row.plotlineRefs
  ];
  return fields.some((field) => field.toLowerCase().includes(text));
}

function filterTracksByRows(
  tracks: PlotGridTrackDto[],
  rows: PlotGridRowDto[],
  showEmptyTracks: boolean
): PlotGridTrackDto[] {
  const visibleTracks = tracks.filter((track) => track.visible);
  if (showEmptyTracks) {
    return visibleTracks;
  }
  const used = new Set(rows.flatMap((row) => row.plotlineRefs));
  return visibleTracks.filter((track) => used.has(track.id));
}

function buildFilterOptions(
  rows: PlotGridRowDto[],
  tracks: PlotGridTrackDto[],
  entities: Record<string, PlotGridEntityDto>
) {
  const statuses = unique(rows.map((row) => row.status).filter((status): status is string => Boolean(status))).sort();
  const characters = refsToEntities(unique(rows.flatMap((row) => row.characterRefs)), entities, "character");
  const locations = refsToEntities(unique(rows.flatMap((row) => row.locationRefs)), entities, "location");
  const plotlines = tracks.map((track) => ({ id: track.id, label: track.label }));
  return { statuses, characters, locations, plotlines };
}

function refsToEntities(
  refs: string[],
  entities: Record<string, PlotGridEntityDto>,
  fallbackType: PlotGridEntityDto["type"]
): PlotGridEntityDto[] {
  return refs
    .map((ref) => entities[ref] ?? { ref, label: keywordLabelFromSlug(ref), type: fallbackType })
    .sort((left, right) => left.label.localeCompare(right.label) || left.ref.localeCompare(right.ref));
}

function cardEntity(card: StoryBibleCardDto, body?: string): PlotGridEntityDto {
  return {
    ref: card.primaryKeyword,
    label: card.name,
    type: card.type,
    path: card.path,
    intro: cardIntro(card.summary, body),
    summary: card.summary,
    aliases: card.aliases,
    status: card.status,
    visibility: card.visibility
  };
}

function cardIntro(summary: string, body?: string): string | undefined {
  const frontmatterSummary = normalizePreviewText(summary);
  if (frontmatterSummary) {
    return truncatePreviewText(frontmatterSummary, 240);
  }

  const bodyIntro = markdownIntro(body ?? "");
  return bodyIntro ? truncatePreviewText(bodyIntro, 240) : undefined;
}

function markdownIntro(body: string): string | undefined {
  let paragraph: string[] = [];
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = previewLine(rawLine);
    if (!line) {
      const candidate = normalizePreviewText(paragraph.join(" "));
      if (candidate) {
        return candidate;
      }
      paragraph = [];
      continue;
    }
    paragraph.push(line);
  }

  return normalizePreviewText(paragraph.join(" ")) || undefined;
}

function previewLine(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">") || trimmed.startsWith("```")) {
    return "";
  }

  const withoutMarker = trimmed
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim();
  if (!withoutMarker) {
    return "";
  }

  const colonIndex = firstColonIndex(withoutMarker);
  if (colonIndex >= 0) {
    const afterColon = withoutMarker.slice(colonIndex + 1).trim();
    return afterColon ? stripInlineMarkdown(afterColon) : "";
  }

  return stripInlineMarkdown(withoutMarker);
}

function firstColonIndex(value: string): number {
  const western = value.indexOf(":");
  const chinese = value.indexOf("：");
  if (western < 0) {
    return chinese;
  }
  if (chinese < 0) {
    return western;
  }
  return Math.min(western, chinese);
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

function normalizePreviewText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncatePreviewText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function keywordEntity(keyword: KeywordCatalogEntryDto): PlotGridEntityDto {
  return {
    ref: keyword.slug,
    label: keyword.label,
    type: keyword.source === "system-object" ? "unknown" : "keyword",
    path: keyword.definitionPath,
    intro: keyword.description,
    description: keyword.description,
    category: keyword.category,
    status: keyword.source
  };
}

function plotGridPlan(
  summary: string,
  directoriesToCreate: string[] = [],
  filesToCreate: string[] = [],
  filesToModify: string[] = []
): OperationPlan {
  return { summary, directoriesToCreate, filesToCreate, filesToModify };
}

function emptyPlan(summary: string): OperationPlan {
  return plotGridPlan(summary);
}

function assertSafePlotGridOperations(plan: OperationPlan): void {
  for (const directory of plan.directoriesToCreate) {
    if (!isPlotGridContentPath(directory)) {
      throw new Error(`Plot Grid 目录操作越界：${directory}`);
    }
  }
  for (const file of [...plan.filesToCreate, ...plan.filesToModify]) {
    if (!isPlotGridContentPath(file)) {
      throw new Error(`Plot Grid 文件操作越界：${file}`);
    }
  }
  for (const operation of plan.filesToMove ?? []) {
    if (!isPlotGridContentPath(operation.from) || !isPlotGridContentPath(operation.to)) {
      throw new Error("Plot Grid 移动操作越界。");
    }
  }
  for (const file of plan.filesToDelete ?? []) {
    if (!isPlotGridContentPath(file)) {
      throw new Error(`Plot Grid 删除文件操作越界：${file}`);
    }
  }
  for (const directory of plan.directoriesToDelete ?? []) {
    if (!isPlotGridContentPath(directory)) {
      throw new Error(`Plot Grid 删除目录操作越界：${directory}`);
    }
  }
}

function sortConfiguredTracks(tracks: PlotGridConfiguredTrackDto[]): PlotGridConfiguredTrackDto[] {
  return [...tracks].sort((left, right) =>
    left.order - right.order || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  );
}

function nextTrackOrder(tracks: PlotGridConfiguredTrackDto[]): number {
  return tracks.reduce((max, track) => Math.max(max, track.order), 0) + 1;
}

function assertTrackId(value: string): string {
  const id = normalizeTrackId(value);
  if (!isValidKeywordSlug(id)) {
    throw new Error(`剧情线轨道 ID "${value}" 不合法。`);
  }
  return id;
}

function assertLabel(value: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new Error("剧情线轨道名称不能为空。");
  }
  return clean;
}

function assertColor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error("剧情线轨道颜色必须是 #RRGGBB 格式。");
  }
  return value;
}

function sanitizeSceneMetadataPatch(patch: SceneCardMetadataPatch): SceneCardMetadataPatch {
  const sanitized: SceneCardMetadataPatch = {};
  if (patch.title !== undefined) {
    sanitized.title = assertNonEmptyString(patch.title, "场景标题");
  }
  if (patch.status !== undefined) {
    if (!SCENE_STATUSES.includes(patch.status)) {
      throw new Error(`场景状态 "${patch.status}" 不合法。`);
    }
    sanitized.status = patch.status;
  }
  if (patch.order !== undefined) {
    if (!Number.isInteger(patch.order) || patch.order <= 0) {
      throw new Error("场景 order 必须是正整数。");
    }
    sanitized.order = patch.order;
  }
  if (patch.pov !== undefined) {
    sanitized.pov = cleanString(patch.pov);
  }
  if (patch.characterRefs !== undefined) {
    sanitized.characterRefs = cleanStringArray(patch.characterRefs);
  }
  if (patch.locationRefs !== undefined) {
    sanitized.locationRefs = cleanStringArray(patch.locationRefs);
  }
  if (patch.plotlineRefs !== undefined) {
    sanitized.plotlineRefs = cleanStringArray(patch.plotlineRefs).map(normalizeTrackId).filter(Boolean);
  }
  if (patch.conflict !== undefined) {
    sanitized.conflict = cleanString(patch.conflict);
  }
  if (patch.turn !== undefined) {
    sanitized.turn = cleanString(patch.turn);
  }
  if (patch.outcome !== undefined) {
    sanitized.outcome = cleanString(patch.outcome);
  }
  return sanitized;
}

function assertNonEmptyString(value: string, label: string): string {
  const clean = cleanString(value);
  if (!clean) {
    throw new Error(`${label}不能为空。`);
  }
  return clean;
}

function cleanString(value: string): string {
  return value.trim();
}

function cleanStringArray(values: string[]): string[] {
  if (!Array.isArray(values)) {
    throw new Error("场景引用字段必须是字符串数组。");
  }
  return unique(values.map((value) => {
    if (typeof value !== "string") {
      throw new Error("场景引用字段必须是字符串数组。");
    }
    return value.trim();
  }).filter(Boolean));
}

function normalizeVisibleColumns(columns: PlotGridVisibleColumn[]): PlotGridVisibleColumn[] {
  const allowed = new Set<PlotGridVisibleColumn>(["status", "pov", "characters", "locations", "rules", "wordCount", "targetWordCount"]);
  const normalized = unique(columns).filter((column) => allowed.has(column));
  if (normalized.length === 0) {
    throw new Error("至少需要保留一个 Plot Grid 信息列。");
  }
  return normalized;
}

function unique<T>(items: T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isPlotGridDiagnostic(item: DiagnosticItem): boolean {
  return item.code.startsWith("plotGrid.");
}

function normalizeTrackId(value: string): string {
  return normalizeKeywordSlugInput(value);
}
