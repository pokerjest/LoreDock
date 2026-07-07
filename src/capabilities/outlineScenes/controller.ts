import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import type { DiagnosticItem, OperationPlan } from "../../kernel/types";
import type { ManuscriptOutlineVolumeInput, ManuscriptService, ChapterId, VolumeId } from "../manuscript/types";
import type { StoryBibleReader } from "../storyBible/types";
import { createOutlineScenesTrashItemId, createSceneId, slugSegmentFromTitle } from "./ids";
import {
  createSceneTemplateBody,
  isOutlineSceneContentPath,
  isOutlineSceneTrashPath,
  outlineScenesTrashMetadataPath,
  readOutlineScenes,
  stringifySceneMarkdown,
  type ParsedSceneCard
} from "./files";
import {
  OUTLINE_SCENES_TRASH_DIR,
  OUTLINES_DIR,
  SCENES_DIR,
  type OutlineChapterDraftDto,
  type OutlineDocumentDto,
  type OutlineDraftScope,
  type OutlineImportOptions,
  type OutlineListItemDto,
  type OutlineSceneActionResult,
  type OutlineSceneActions,
  type OutlineSceneChangeEvent,
  type OutlineSceneChangeType,
  type OutlineSceneReadResult,
  type OutlineSceneReader,
  type OutlineSceneService,
  type OutlineScenesTrashItemDto,
  type OutlineScenesTrashItemId,
  type OutlineSceneDraftDto,
  type OutlineVolumeDraftDto,
  type SceneCardDto,
  type SceneCardInput,
  type SceneCardMetadataPatch,
  type SceneId,
  type SceneProjectionDto,
  type SceneSearchQuery,
  type SceneStatus,
  type StructureSkeletonDto
} from "./types";

interface OutlineSceneControllerOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  output: vscode.OutputChannel;
  diagnostics: {
    add(item: DiagnosticItem): void;
    clearMatching(workspaceFolderPath: string, predicate: (item: DiagnosticItem) => boolean): void;
  };
  confirmOperationPlan(plan: OperationPlan): Promise<boolean>;
  confirmDestructiveDelete(message: string): Promise<boolean>;
  getManuscriptService(): ManuscriptService | undefined;
  getStoryBibleReader?(): StoryBibleReader | undefined;
  now(): Date;
}

export class OutlineSceneController implements OutlineSceneReader, OutlineSceneActions, OutlineSceneService {
  public readonly reader: OutlineSceneReader = this;
  public readonly actions: OutlineSceneActions = this;

  private readonly emitter = new vscode.EventEmitter<OutlineSceneChangeEvent>();

  public constructor(private readonly options: OutlineSceneControllerOptions) {}

  public onDidChange(listener: (event: OutlineSceneChangeEvent) => unknown): vscode.Disposable {
    return this.emitter.event(listener);
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  public async refreshDiagnostics(): Promise<DiagnosticItem[]> {
    this.options.diagnostics.clearMatching(this.workspaceRoot, isOutlineSceneDiagnostic);
    const result = await this.readCatalog();
    for (const item of result.diagnostics) {
      this.options.diagnostics.add(item);
    }
    return result.diagnostics;
  }

  public notifyFileChanged(relativePath: string, type?: OutlineSceneChangeType): void {
    const normalized = normalizeRelativePath(relativePath);
    this.emit(type ?? (normalized.startsWith(`${OUTLINES_DIR}/`) ? "outline" : "content"), { path: normalized });
  }

  public async listOutlines(): Promise<OutlineListItemDto[]> {
    return (await this.readCatalog()).outlineItems;
  }

  public async parseOutline(relativePath: string): Promise<OutlineDocumentDto> {
    const normalized = normalizeRelativePath(relativePath);
    const outline = (await this.readCatalog()).outlines.find((item) => item.path === normalized);
    if (!outline) {
      throw new Error(`未找到大纲 "${relativePath}"。`);
    }
    return outline;
  }

  public async getStructureSkeleton(): Promise<StructureSkeletonDto> {
    const catalog = await this.readCatalog();
    const manuscript = this.requireManuscriptService().reader;
    const [volumes, chapters] = await Promise.all([manuscript.listVolumes(), manuscript.listChapters()]);
    const scenes = sortScenes(catalog.scenes.map((scene) => scene.dto));
    const scenesByChapter = groupScenesByChapter(scenes);
    const chapterIds = new Set(chapters.map((chapter) => chapter.id));

    return {
      volumes: volumes.map((volume) => ({
        id: volume.id,
        title: volume.title,
        index: volume.index,
        chapters: volume.chapterIds
          .map((chapterId) => chapters.find((chapter) => chapter.id === chapterId))
          .filter((chapter): chapter is NonNullable<typeof chapter> => Boolean(chapter))
          .map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            index: chapter.index,
            scenes: scenesByChapter.get(chapter.id) ?? []
          }))
      })),
      orphanScenes: scenes.filter((scene) => !scene.chapterRefs.some((chapterRef) => chapterIds.has(chapterRef))),
      outlineDrafts: catalog.outlines,
      diagnostics: catalog.diagnostics.map((item) => item.message)
    };
  }

  public async listScenes(query: SceneSearchQuery = {}): Promise<SceneCardDto[]> {
    const scenes = (await this.readCatalog()).scenes.map((scene) => scene.dto);
    return filterScenes(scenes, query);
  }

  public async getScene(sceneId: SceneId): Promise<SceneCardDto | undefined> {
    return (await this.readCatalog()).scenes.find((scene) => scene.dto.id === sceneId)?.dto;
  }

  public async resolveScenePath(sceneId: SceneId): Promise<string | undefined> {
    return (await this.getScene(sceneId))?.path;
  }

  public async readSceneText(sceneId: SceneId): Promise<OutlineSceneReadResult> {
    const scene = (await this.readCatalog()).scenes.find((item) => item.dto.id === sceneId);
    if (!scene) {
      return { ok: false, error: `未找到场景卡 "${sceneId}"。` };
    }
    return { ok: true, text: scene.body };
  }

  public async getSceneProjection(): Promise<SceneProjectionDto> {
    const skeleton = await this.getStructureSkeleton();
    return {
      chapters: skeleton.volumes.flatMap((volume) =>
        volume.chapters.map((chapter) => ({
          chapterId: chapter.id,
          title: chapter.title,
          volumeId: volume.id,
          index: chapter.index,
          scenes: chapter.scenes
        }))
      ),
      orphanScenes: skeleton.orphanScenes
    };
  }

  public async listTrashItems(): Promise<OutlineScenesTrashItemDto[]> {
    return (await this.readCatalog()).trashItems;
  }

  public async createOutlineTemplate(title = "main", scope: OutlineDraftScope = "book"): Promise<OutlineSceneActionResult> {
    const basename = slugSegmentFromTitle(title || "main");
    const outlinePath = await allocateMarkdownPath(this.workspaceRoot, OUTLINES_DIR, basename);
    const content = createOutlineTemplateBody(scope);
    const plan = outlinePlan(`新建${outlineScopeLabel(scope)}“${title}”。`, [OUTLINES_DIR], [outlinePath]);
    return this.applyPlan(plan, async (writer) => {
      await writer.ensureDirectory(OUTLINES_DIR);
      await writer.writeFile(outlinePath, content);
    }, [{ type: "outline", path: outlinePath }]);
  }

  public async deleteOutline(relativePath: string): Promise<OutlineSceneActionResult> {
    const outline = await this.parseOutline(relativePath);
    const plan = outlinePlan(`删除规划草稿“${outline.title}”。`);
    plan.filesToDelete = [outline.path];
    return this.applyPlan(plan, async (writer) => {
      await writer.deleteFile(outline.path);
    }, [{ type: "outline", path: outline.path }]);
  }

  public async importOutline(relativePath: string, options: OutlineImportOptions = {}): Promise<OutlineSceneActionResult> {
    const outline = await this.parseOutline(relativePath);
    const catalog = await this.readCatalog();
    const existingSourceKeys = new Set(
      catalog.scenes
        .map((scene) => scene.dto)
        .filter((scene) => scene.sourceOutline && scene.sourceLine)
        .map((scene) => sourceKey(scene.sourceOutline!, scene.sourceLine!))
    );
    const manuscriptInputs: ManuscriptOutlineVolumeInput[] = [];
    const sceneDrafts: Array<{
      chapterClientId: string;
      title: string;
      beats: string[];
      sourceOutline: string;
      sourceLine: number;
    }> = [];
    const outlineChapters = chaptersForImport(outline, options);

    for (const item of outlineChapters) {
      const importableScenes = item.scenes.filter((scene) => !existingSourceKeys.has(sourceKey(scene.sourcePath, scene.line)));
      if (importableScenes.length === 0 && item.scenes.length > 0) {
        continue;
      }

      let volumeInput = manuscriptInputs.find((candidate) =>
        candidate.existingVolumeId === item.volume.existingVolumeId &&
        candidate.title === item.volume.title
      );
      if (!volumeInput) {
        volumeInput = {
          title: item.volume.title,
          ...(item.volume.existingVolumeId ? { existingVolumeId: item.volume.existingVolumeId } : {}),
          chapters: []
        };
        manuscriptInputs.push(volumeInput);
      }

      volumeInput.chapters.push({
        clientId: item.chapterClientId,
        title: item.chapter.title,
        ...(item.chapter.existingChapterId ? { existingChapterId: item.chapter.existingChapterId } : {})
      });
      for (const scene of importableScenes) {
        sceneDrafts.push({
          chapterClientId: item.chapterClientId,
          title: scene.title,
          beats: scene.beats.map((beat) => beat.title),
          sourceOutline: scene.sourcePath,
          sourceLine: scene.line
        });
      }
    }

    if (manuscriptInputs.length === 0 && sceneDrafts.length === 0) {
      return { applied: false, plan: emptyPlan(`大纲“${outline.path}”没有新的可导入场景。`) };
    }

    const prepared = await this.requireManuscriptService().actions.prepareStructureFromOutline(manuscriptInputs);
    const timestamp = this.timestamp();
    const sceneWrites: Array<{ path: string; content: string; sceneId: SceneId }> = [];
    const nextOrderByChapter = new Map<string, number>();
    const existingScenesByChapter = groupScenesByChapter(catalog.scenes.map((scene) => scene.dto));
    const reservedScenePaths = new Set<string>();
    for (const draft of sceneDrafts) {
      const chapterId = prepared.chapterIdsByClientId[draft.chapterClientId];
      const order = nextOrderByChapter.get(chapterId) ?? nextSceneOrder(existingScenesByChapter.get(chapterId) ?? []);
      nextOrderByChapter.set(chapterId, order + 1);
      const scenePath = await allocateScenePath(this.workspaceRoot, reservedScenePaths);
      reservedScenePaths.add(scenePath);
      const scene = {
        id: createSceneId(),
        title: draft.title,
        chapterRefs: [chapterId],
        order,
        pov: "",
        locationRefs: [],
        characterRefs: [],
        plotlineRefs: [],
        conflict: "",
        turn: "",
        outcome: "",
        status: "outline" as SceneStatus,
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceOutline: draft.sourceOutline,
        sourceLine: draft.sourceLine
      };
      sceneWrites.push({
        path: scenePath,
        content: stringifySceneMarkdown(scene, createSceneTemplateBody(draft.title, draft.beats)),
        sceneId: scene.id
      });
    }

    const plan = mergePlans(`导入大纲“${outline.path}”。`, prepared.plan, {
      summary: "创建大纲导入场景卡。",
      directoriesToCreate: [SCENES_DIR],
      filesToCreate: sceneWrites.map((write) => write.path),
      filesToModify: []
    });
    plan.fileContentPreviews = [{
      relativePath: outline.path,
      title: "导入预览",
      content: createImportPreview(outline, manuscriptInputs, sceneDrafts)
    }, ...sceneWrites.slice(0, 5).map((write) => ({
      relativePath: write.path,
      title: "场景卡 frontmatter",
      content: extractFrontmatterPreview(write.content)
    }))];

    return this.applyPlan(plan, async (writer) => {
      await prepared.apply(writer);
      await writer.ensureDirectory(SCENES_DIR);
      for (const write of sceneWrites) {
        await writer.writeFile(write.path, write.content);
      }
    }, sceneWrites.map((write) => ({ type: "structure", sceneId: write.sceneId, path: write.path })));
  }

  public async createSceneCard(input: SceneCardInput): Promise<OutlineSceneActionResult> {
    const manuscript = this.requireManuscriptService().reader;
    const chapterRefs = unique(input.chapterRefs ?? (input.chapterId ? [input.chapterId] : [])) as ChapterId[];
    for (const chapterRef of chapterRefs) {
      const chapter = await manuscript.getChapter(chapterRef);
      if (!chapter) {
        throw new Error(`未找到章节 "${chapterRef}"。`);
      }
    }
    const title = assertNonEmpty(input.title, "场景标题");
    const primaryChapterRef = chapterRefs[0];
    const existingScenes = primaryChapterRef ? await this.listScenes({ chapterId: primaryChapterRef }) : await this.listScenes();
    const order = input.order ?? nextSceneOrder(existingScenes);
    const timestamp = this.timestamp();
    const scenePath = await allocateScenePath(this.workspaceRoot);
    const scene = {
      id: createSceneId(),
      title,
      chapterRefs,
      order,
      pov: input.pov ?? "",
      locationRefs: input.locationRefs ?? [],
      characterRefs: input.characterRefs ?? [],
      plotlineRefs: input.plotlineRefs ?? [],
      conflict: input.conflict ?? "",
      turn: input.turn ?? "",
      outcome: input.outcome ?? "",
      status: input.status ?? "outline",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.sourceOutline ? { sourceOutline: input.sourceOutline } : {}),
      ...(input.sourceLine ? { sourceLine: input.sourceLine } : {})
    };
    const content = stringifySceneMarkdown(scene, createSceneTemplateBody(title));
    const plan = outlinePlan(`新建场景卡“${title}”。`, [SCENES_DIR], [scenePath]);
    plan.fileContentPreviews = [{ relativePath: scenePath, title: "初始 frontmatter", content: extractFrontmatterPreview(content) }];
    return this.applyPlan(plan, async (writer) => {
      await writer.ensureDirectory(SCENES_DIR);
      await writer.writeFile(scenePath, content);
    }, [{ type: "structure", sceneId: scene.id, path: scenePath }]);
  }

  public async createSceneCardFromChapter(chapterId: string, title?: string): Promise<OutlineSceneActionResult> {
    const chapter = await this.requireManuscriptService().reader.getChapter(chapterId as ChapterId);
    if (!chapter) {
      throw new Error(`未找到章节 "${chapterId}"。`);
    }
    return this.createSceneCard({ chapterId, title: title ?? chapter.title });
  }

  public async bindSceneToChapters(sceneId: SceneId, chapterRefs: string[]): Promise<OutlineSceneActionResult> {
    const parsed = requireParsedScene((await this.readCatalog()).scenes, sceneId);
    return this.updateSceneMetadata(sceneId, {
      chapterRefs: unique([...parsed.dto.chapterRefs, ...chapterRefs])
    });
  }

  public async bindScenesToChapter(sceneIds: SceneId[], chapterId: string): Promise<OutlineSceneActionResult> {
    const chapter = await this.requireManuscriptService().reader.getChapter(chapterId as ChapterId);
    if (!chapter) {
      throw new Error(`未找到章节 "${chapterId}"。`);
    }
    const catalog = await this.readCatalog();
    const scenes = sceneIds.map((sceneId) => requireParsedScene(catalog.scenes, sceneId));
    const changes = scenes
      .filter((scene) => !scene.dto.chapterRefs.includes(chapter.id))
      .map((scene) => ({
        parsed: scene,
        next: {
          ...scene.dto,
          chapterRefs: unique([...scene.dto.chapterRefs, chapter.id]) as ChapterId[],
          updatedAt: this.timestamp()
        }
      }));
    if (changes.length === 0) {
      return { applied: false, plan: emptyPlan(`场景卡已绑定到章节“${chapter.title}”。`) };
    }

    const plan = outlinePlan(
      `绑定 ${changes.length} 张场景卡到章节“${chapter.title}”。`,
      [],
      [],
      changes.map((change) => change.parsed.dto.path)
    );
    return this.applyPlan(plan, async (writer) => {
      for (const change of changes) {
        await writer.writeFile(
          change.parsed.dto.path,
          stringifySceneMarkdown(change.next, change.parsed.body, change.parsed.frontmatter)
        );
      }
    }, changes.map((change) => ({ type: "structure", sceneId: change.parsed.dto.id, path: change.parsed.dto.path })));
  }

  public async createChapterAndBindScene(sceneId: SceneId, volumeId: string, title: string): Promise<OutlineSceneActionResult> {
    const catalog = await this.readCatalog();
    const parsed = requireParsedScene(catalog.scenes, sceneId);
    const prepared = await this.requireManuscriptService().actions.prepareChapterInVolume(volumeId as VolumeId, title);
    const next: SceneCardDto = {
      ...parsed.dto,
      chapterRefs: unique([...parsed.dto.chapterRefs, prepared.chapterId]) as ChapterId[],
      updatedAt: this.timestamp()
    };
    const plan = mergePlans(`新建章节“${title}”并绑定场景卡“${parsed.dto.title}”。`, prepared.plan, {
      summary: "绑定场景卡到新章节。",
      directoriesToCreate: [],
      filesToCreate: [],
      filesToModify: [parsed.dto.path]
    });
    plan.fileContentPreviews = [{
      relativePath: parsed.dto.path,
      title: "更新后的场景卡 frontmatter",
      content: extractFrontmatterPreview(stringifySceneMarkdown(next, parsed.body, parsed.frontmatter))
    }];

    return this.applyPlan(plan, async (writer) => {
      await prepared.apply(writer);
      await writer.writeFile(parsed.dto.path, stringifySceneMarkdown(next, parsed.body, parsed.frontmatter));
    }, [{ type: "structure", sceneId, path: parsed.dto.path }]);
  }

  public async updateSceneMetadata(sceneId: SceneId, patch: SceneCardMetadataPatch): Promise<OutlineSceneActionResult> {
    const catalog = await this.readCatalog();
    const parsed = requireParsedScene(catalog.scenes, sceneId);
    const nextChapterRefs = unique(patch.chapterRefs ?? (patch.chapterId ? [patch.chapterId] : parsed.dto.chapterRefs)) as ChapterId[];
    for (const chapterRef of nextChapterRefs) {
      if (!(await this.requireManuscriptService().reader.getChapter(chapterRef))) {
        throw new Error(`未找到章节 "${chapterRef}"。`);
      }
    }
    const next: SceneCardDto = {
      ...parsed.dto,
      title: patch.title === undefined ? parsed.dto.title : assertNonEmpty(patch.title, "场景标题"),
      chapterRefs: nextChapterRefs,
      order: patch.order ?? parsed.dto.order,
      pov: patch.pov ?? parsed.dto.pov,
      locationRefs: patch.locationRefs ?? parsed.dto.locationRefs,
      characterRefs: patch.characterRefs ?? parsed.dto.characterRefs,
      plotlineRefs: patch.plotlineRefs ?? parsed.dto.plotlineRefs,
      conflict: patch.conflict ?? parsed.dto.conflict,
      turn: patch.turn ?? parsed.dto.turn,
      outcome: patch.outcome ?? parsed.dto.outcome,
      status: patch.status ?? parsed.dto.status,
      updatedAt: this.timestamp()
    };
    if (!Number.isInteger(next.order) || next.order <= 0) {
      throw new Error("场景 order 必须是正整数。");
    }
    const plan = outlinePlan(`更新场景卡“${parsed.dto.title}”元数据。`, [], [], [parsed.dto.path]);
    return this.applyPlan(plan, async (writer) => {
      await writer.writeFile(parsed.dto.path, stringifySceneMarkdown(next, parsed.body, parsed.frontmatter));
    }, [{ type: "metadata", sceneId, path: parsed.dto.path }]);
  }

  public async deleteSceneCard(sceneId: SceneId): Promise<OutlineSceneActionResult> {
    const parsed = requireParsedScene((await this.readCatalog()).scenes, sceneId);
    const trashItemId = createOutlineScenesTrashItemId();
    const trashPath = normalizeRelativePath(`${OUTLINE_SCENES_TRASH_DIR}/${trashItemId}`);
    const movedPath = normalizeRelativePath(`${trashPath}/${path.basename(parsed.dto.path)}`);
    const metadataPath = outlineScenesTrashMetadataPath(trashPath);
    const timestamp = this.timestamp();
    const metadata: OutlineScenesTrashItemDto = {
      id: trashItemId,
      title: parsed.dto.title,
      deletedAt: timestamp,
      originalPath: parsed.dto.path,
      trashPath,
      originalFileName: path.basename(parsed.dto.path),
      sceneId: parsed.dto.id
    };
    const plan = outlinePlan(`将场景卡“${parsed.dto.title}”移入资源垃圾桶。`, trashDirectoriesFor(trashPath), [metadataPath]);
    plan.filesToMove = [{ from: parsed.dto.path, to: movedPath }];
    return this.applyPlan(plan, async (writer) => {
      for (const directory of trashDirectoriesFor(trashPath)) {
        await writer.ensureDirectory(directory);
      }
      await writer.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      await writer.moveFile(parsed.dto.path, movedPath);
    }, [{ type: "structure", sceneId, trashItemId, path: parsed.dto.path }]);
  }

  public async restoreTrashItem(trashItemId: OutlineScenesTrashItemId): Promise<OutlineSceneActionResult> {
    const item = requireTrashItem(await this.listTrashItems(), trashItemId);
    const movedPath = normalizeRelativePath(`${item.trashPath}/${item.originalFileName}`);
    if (await pathExists(path.join(this.workspaceRoot, item.originalPath))) {
      throw new Error(`还原目标 "${item.originalPath}" 已存在。`);
    }
    const metadataPath = outlineScenesTrashMetadataPath(item.trashPath);
    const plan = outlinePlan(`还原场景卡“${item.title}”。`, [], [], []);
    plan.filesToMove = [{ from: movedPath, to: item.originalPath }];
    plan.filesToDelete = [metadataPath];
    plan.directoriesToDelete = [item.trashPath];
    return this.applyPlan(plan, async (writer) => {
      await writer.moveFile(movedPath, item.originalPath);
      await writer.deleteFile(metadataPath);
      await writer.deleteDirectoryRecursive(item.trashPath);
    }, [{ type: "structure", trashItemId, path: item.originalPath }]);
  }

  public async permanentlyDeleteTrashItem(trashItemId: OutlineScenesTrashItemId): Promise<OutlineSceneActionResult> {
    const item = requireTrashItem(await this.listTrashItems(), trashItemId);
    const plan = outlinePlan(`永久删除场景卡资源“${item.title}”。`);
    plan.directoriesToDelete = [item.trashPath];
    return this.applyPlan(plan, async (writer) => {
      await writer.deleteDirectoryRecursive(item.trashPath);
    }, [{ type: "structure", trashItemId, path: item.trashPath }], `永久删除场景卡资源“${item.title}”？此操作不可撤销。`);
  }

  public async reorderChapterScenes(chapterId: string, sceneIds: SceneId[]): Promise<OutlineSceneActionResult> {
    const catalog = await this.readCatalog();
    const scenes = sceneIds.map((sceneId) => requireParsedScene(catalog.scenes, sceneId));
    if (scenes.some((scene) => !scene.dto.chapterRefs.includes(chapterId as ChapterId))) {
      throw new Error("只能重排绑定到同一章节的场景。");
    }
    const timestamp = this.timestamp();
    const plan = outlinePlan(
      `重排章节 "${chapterId}" 的场景。`,
      [],
      [],
      scenes.map((scene) => scene.dto.path)
    );
    return this.applyPlan(plan, async (writer) => {
      let order = 1;
      for (const parsed of scenes) {
        const next = { ...parsed.dto, order, updatedAt: timestamp };
        await writer.writeFile(parsed.dto.path, stringifySceneMarkdown(next, parsed.body, parsed.frontmatter));
        order += 1;
      }
    }, scenes.map((scene) => ({ type: "structure", sceneId: scene.dto.id, path: scene.dto.path })));
  }

  private async applyPlan(
    plan: OperationPlan,
    apply: (writer: SafeFileWriter) => Promise<void>,
    events: Partial<OutlineSceneChangeEvent>[],
    destructiveDeleteMessage?: string
  ): Promise<OutlineSceneActionResult> {
    assertSafeOutlineSceneOperations(plan);
    const confirmed = await this.options.confirmOperationPlan(plan);
    if (!confirmed) {
      this.options.output.appendLine(`已取消结构规划操作：${plan.summary}`);
      return { applied: false, plan };
    }
    if (destructiveDeleteMessage && !(await this.options.confirmDestructiveDelete(destructiveDeleteMessage))) {
      this.options.output.appendLine(`已取消危险删除：${plan.summary}`);
      return { applied: false, plan };
    }

    const writer = new SafeFileWriter(this.workspaceRoot, plan);
    await apply(writer);
    for (const event of events) {
      this.emit(event.type ?? "metadata", event);
    }
    await this.refreshDiagnostics();
    return { applied: true, plan };
  }

  private async readCatalog() {
    return readOutlineScenes(
      this.workspaceRoot,
      this.options.getManuscriptService()?.reader,
      this.options.getStoryBibleReader?.()
    );
  }

  private requireManuscriptService(): ManuscriptService {
    const service = this.options.getManuscriptService();
    if (!service) {
      throw new Error("结构规划需要先启用 Manuscript。");
    }
    return service;
  }

  private emit(type: OutlineSceneChangeType, event: Partial<OutlineSceneChangeEvent>): void {
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

function outlinePlan(
  summary: string,
  directoriesToCreate: string[] = [],
  filesToCreate: string[] = [],
  filesToModify: string[] = []
): OperationPlan {
  return {
    summary,
    directoriesToCreate,
    filesToCreate,
    filesToModify
  };
}

function emptyPlan(summary: string): OperationPlan {
  return outlinePlan(summary);
}

function mergePlans(summary: string, left: OperationPlan, right: OperationPlan): OperationPlan {
  return {
    summary,
    directoriesToCreate: unique([...left.directoriesToCreate, ...right.directoriesToCreate]),
    filesToCreate: unique([...left.filesToCreate, ...right.filesToCreate]),
    filesToModify: unique([...left.filesToModify, ...right.filesToModify]),
    filesToMove: [...(left.filesToMove ?? []), ...(right.filesToMove ?? [])],
    filesToDelete: [...(left.filesToDelete ?? []), ...(right.filesToDelete ?? [])],
    directoriesToDelete: [...(left.directoriesToDelete ?? []), ...(right.directoriesToDelete ?? [])],
    directoriesToMove: [...(left.directoriesToMove ?? []), ...(right.directoriesToMove ?? [])],
    filesToBackup: [...(left.filesToBackup ?? []), ...(right.filesToBackup ?? [])]
  };
}

function assertSafeOutlineSceneOperations(plan: OperationPlan): void {
  for (const directory of plan.directoriesToCreate) {
    if (
      !isOutlineSceneContentPath(directory) &&
      !isOutlineSceneTrashPath(directory) &&
      !isOutlineSceneTrashParentPath(directory) &&
      !isManuscriptPath(directory)
    ) {
      throw new Error(`结构规划目录操作越界：${directory}`);
    }
  }
  for (const file of [...plan.filesToCreate, ...plan.filesToModify]) {
    if (
      !isOutlineSceneContentPath(file) &&
      !isOutlineSceneTrashPath(file) &&
      file !== "manuscript/manifest.json" &&
      !isManuscriptPath(file)
    ) {
      throw new Error(`结构规划文件操作越界：${file}`);
    }
  }
  for (const operation of plan.filesToMove ?? []) {
    if (
      !(
        isOutlineSceneContentPath(operation.from) &&
        isOutlineSceneTrashPath(operation.to)
      ) &&
      !(isOutlineSceneTrashPath(operation.from) && isOutlineSceneContentPath(operation.to))
    ) {
      throw new Error("场景卡移动必须在 scenes/outlines 和结构规划资源垃圾桶之间进行。");
    }
  }
  for (const file of plan.filesToDelete ?? []) {
    if (!isOutlineSceneTrashPath(file) && !isOutlinePath(file)) {
      throw new Error(`结构规划删除文件操作越界：${file}`);
    }
  }
  for (const directory of plan.directoriesToDelete ?? []) {
    if (!isOutlineSceneTrashPath(directory)) {
      throw new Error(`结构规划删除目录操作越界：${directory}`);
    }
  }
}

function isManuscriptPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === "manuscript" || normalized.startsWith("manuscript/");
}

function isOutlinePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith(`${OUTLINES_DIR}/`);
}

function isOutlineSceneTrashParentPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === ".loredock" || normalized === ".loredock/trash" || normalized === ".loredock/trash/resources";
}

function isOutlineSceneDiagnostic(item: DiagnosticItem): boolean {
  return item.code.startsWith("outlineScenes.") || item.code.startsWith("outline.");
}

function sortScenes(scenes: SceneCardDto[]): SceneCardDto[] {
  return [...scenes].sort((left, right) =>
    primaryChapterRef(left) === primaryChapterRef(right)
      ? left.order - right.order || left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
      : primaryChapterRef(left).localeCompare(primaryChapterRef(right))
  );
}

function groupScenesByChapter(scenes: SceneCardDto[]): Map<string, SceneCardDto[]> {
  const result = new Map<string, SceneCardDto[]>();
  for (const scene of scenes) {
    for (const chapterRef of scene.chapterRefs) {
      const current = result.get(chapterRef) ?? [];
      current.push(scene);
      result.set(chapterRef, current);
    }
  }
  for (const [chapterId, chapterScenes] of result.entries()) {
    result.set(chapterId, sortScenes(chapterScenes));
  }
  return result;
}

interface OutlineImportChapterPlanItem {
  volume: {
    title: string;
    existingVolumeId?: VolumeId;
  };
  chapter: {
    title: string;
    existingChapterId?: ChapterId;
  };
  chapterClientId: string;
  scenes: OutlineSceneDraftDto[];
}

function chaptersForImport(outline: OutlineDocumentDto, options: OutlineImportOptions): OutlineImportChapterPlanItem[] {
  switch (outline.scope) {
    case "book":
      return outline.volumes.flatMap((volume) =>
        volume.chapters.map((chapter) => importChapterItem(outline, volume, chapter, options))
      );
    case "volume":
      return volumeScopedChaptersForImport(outline, options);
    case "chapter":
      return chapterScopedChaptersForImport(outline, options);
    case "scene":
      return sceneScopedChaptersForImport(outline, options);
  }
}

function volumeScopedChaptersForImport(
  outline: OutlineDocumentDto,
  options: OutlineImportOptions
): OutlineImportChapterPlanItem[] {
  const chapters = outline.volumes.flatMap((volume) => volume.chapters);
  if (options.target?.volumeId) {
    const volumeTitle = options.target.volumeTitle ?? draftVolumeTitle(outline.volumes[0], outline);
    return chapters.map((chapter) => ({
      volume: { title: volumeTitle, existingVolumeId: options.target!.volumeId as VolumeId },
      chapter: { title: draftChapterTitle(chapter, outline) },
      chapterClientId: chapter.id,
      scenes: chapter.scenes
    }));
  }
  return outline.volumes.flatMap((volume) =>
    volume.chapters.map((chapter) => importChapterItem(outline, volume, chapter, options))
  );
}

function chapterScopedChaptersForImport(
  outline: OutlineDocumentDto,
  options: OutlineImportOptions
): OutlineImportChapterPlanItem[] {
  const chapters = outline.volumes.flatMap((volume) => volume.chapters);
  if (options.target?.chapterId) {
    const firstChapter = chapters[0];
    return [{
      volume: { title: options.target.volumeTitle ?? "复用章节所属卷" },
      chapter: {
        title: options.target.chapterTitle ?? draftChapterTitle(firstChapter, outline),
        existingChapterId: options.target.chapterId as ChapterId
      },
      chapterClientId: targetChapterClientId(outline, options.target.chapterId),
      scenes: chapters.flatMap((chapter) => chapter.scenes)
    }];
  }

  const targetVolume = {
    title: options.target?.volumeTitle ?? "导入章节",
    ...(options.target?.volumeId ? { existingVolumeId: options.target.volumeId as VolumeId } : {})
  };
  return chapters.map((chapter) => ({
    volume: targetVolume,
    chapter: {
      title: options.target?.chapterTitle && chapters.length === 1
        ? options.target.chapterTitle
        : draftChapterTitle(chapter, outline)
    },
    chapterClientId: chapter.id,
    scenes: chapter.scenes
  }));
}

function sceneScopedChaptersForImport(
  outline: OutlineDocumentDto,
  options: OutlineImportOptions
): OutlineImportChapterPlanItem[] {
  const scenes = outline.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes));
  const firstScene = scenes[0];
  if (options.target?.chapterId) {
    return [{
      volume: { title: options.target.volumeTitle ?? "复用章节所属卷" },
      chapter: {
        title: options.target.chapterTitle ?? firstScene?.title ?? titleFromOutlinePath(outline.path),
        existingChapterId: options.target.chapterId as ChapterId
      },
      chapterClientId: targetChapterClientId(outline, options.target.chapterId),
      scenes
    }];
  }

  return [{
    volume: {
      title: options.target?.volumeTitle ?? "导入场景",
      ...(options.target?.volumeId ? { existingVolumeId: options.target.volumeId as VolumeId } : {})
    },
    chapter: {
      title: options.target?.chapterTitle ?? firstScene?.title ?? titleFromOutlinePath(outline.path)
    },
    chapterClientId: `${outline.path}:chapter`,
    scenes
  }];
}

function importChapterItem(
  outline: OutlineDocumentDto,
  volume: OutlineVolumeDraftDto,
  chapter: OutlineChapterDraftDto,
  options: OutlineImportOptions
): OutlineImportChapterPlanItem {
  return {
    volume: {
      title: draftVolumeTitle(volume, outline, options.target?.volumeTitle)
    },
    chapter: {
      title: draftChapterTitle(chapter, outline, options.target?.chapterTitle)
    },
    chapterClientId: chapter.id,
    scenes: chapter.scenes
  };
}

function draftVolumeTitle(
  volume: OutlineVolumeDraftDto | undefined,
  outline: OutlineDocumentDto,
  fallback?: string
): string {
  if (fallback?.trim()) {
    return fallback.trim();
  }
  if (!volume) {
    return titleFromOutlinePath(outline.path);
  }
  return volume.isVirtual ? titleFromOutlinePath(volume.sourcePath) : volume.title;
}

function draftChapterTitle(
  chapter: OutlineChapterDraftDto | undefined,
  outline: OutlineDocumentDto,
  fallback?: string
): string {
  if (fallback?.trim()) {
    return fallback.trim();
  }
  if (!chapter) {
    return titleFromOutlinePath(outline.path);
  }
  return chapter.isVirtual ? titleFromOutlinePath(chapter.sourcePath) : chapter.title;
}

function targetChapterClientId(outline: OutlineDocumentDto, chapterId: string): string {
  return `${outline.path}:chapter:${chapterId}`;
}

function createImportPreview(
  outline: OutlineDocumentDto,
  manuscriptInputs: ManuscriptOutlineVolumeInput[],
  sceneDrafts: Array<{ title: string; sourceOutline: string; sourceLine: number }>
): string {
  const lines = [
    `scope: ${outlineScopeLabel(outline.scope)}`,
    `source: ${outline.path}`,
    "",
    "手稿结构："
  ];
  for (const volume of manuscriptInputs) {
    lines.push(`- ${volume.existingVolumeId ? "复用卷" : "新建卷"}：${volume.title}`);
    for (const chapter of volume.chapters) {
      lines.push(`  - ${chapter.existingChapterId ? "复用章节" : "新建章节"}：${chapter.title}`);
    }
  }
  lines.push("", "场景卡：");
  for (const scene of sceneDrafts) {
    lines.push(`- ${scene.title} (${scene.sourceOutline}:${scene.sourceLine})`);
  }
  return lines.join("\n");
}

function filterScenes(scenes: SceneCardDto[], query: SceneSearchQuery): SceneCardDto[] {
  return sortScenes(scenes).filter((scene) =>
    (query.chapterId === undefined || scene.chapterRefs.includes(query.chapterId as ChapterId)) &&
    (query.status === undefined || scene.status === query.status) &&
    (query.characterRef === undefined || scene.characterRefs.includes(query.characterRef)) &&
    (query.locationRef === undefined || scene.locationRefs.includes(query.locationRef)) &&
    (query.plotlineRef === undefined || scene.plotlineRefs.includes(query.plotlineRef))
  );
}

function primaryChapterRef(scene: SceneCardDto): string {
  return scene.chapterRefs[0] ?? "";
}

async function allocateMarkdownPath(workspaceRoot: string, directory: string, basename: string): Promise<string> {
  let suffix = 1;
  let candidate = normalizeRelativePath(`${directory}/${basename}.md`);
  while (await pathExists(path.join(workspaceRoot, candidate))) {
    suffix += 1;
    candidate = normalizeRelativePath(`${directory}/${basename}-${suffix}.md`);
  }
  return candidate;
}

async function allocateScenePath(workspaceRoot: string, reserved: Set<string> = new Set()): Promise<string> {
  let next = 1;
  let candidate: string;
  do {
    candidate = normalizeRelativePath(`${SCENES_DIR}/scene-${String(next).padStart(3, "0")}.md`);
    next += 1;
  } while (reserved.has(candidate) || (await pathExists(path.join(workspaceRoot, candidate))));
  return candidate;
}

function nextSceneOrder(scenes: SceneCardDto[]): number {
  return scenes.reduce((max, scene) => Math.max(max, scene.order), 0) + 1;
}

function requireParsedScene(scenes: ParsedSceneCard[], sceneId: SceneId): ParsedSceneCard {
  const scene = scenes.find((candidate) => candidate.dto.id === sceneId);
  if (!scene) {
    throw new Error(`未找到场景卡 "${sceneId}"。`);
  }
  return scene;
}

function requireTrashItem(items: OutlineScenesTrashItemDto[], trashItemId: OutlineScenesTrashItemId): OutlineScenesTrashItemDto {
  const item = items.find((candidate) => candidate.id === trashItemId);
  if (!item) {
    throw new Error(`未找到结构规划垃圾桶项目 "${trashItemId}"。`);
  }
  return item;
}

function assertNonEmpty(value: string, label: string): string {
  const clean = value.trim();
  if (clean === "") {
    throw new Error(`${label}不能为空。`);
  }
  return clean;
}

function trashDirectoriesFor(trashPath: string): string[] {
  return [".loredock", ".loredock/trash", ".loredock/trash/resources", OUTLINE_SCENES_TRASH_DIR, trashPath];
}

function sourceKey(sourceOutline: string, sourceLine: number): string {
  return `${normalizeRelativePath(sourceOutline)}:${sourceLine}`;
}

function extractFrontmatterPreview(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end >= 0 ? lines.slice(0, end + 1).join("\n") : normalized;
}

function createOutlineTemplateBody(scope: OutlineDraftScope): string {
  const examples: Record<OutlineDraftScope, string[]> = {
    book: [
      "# 第一卷",
      "",
      "## 第一章",
      "",
      "### 第一个场景",
      "",
      "- 这个场景要解决的问题",
      "- 冲突如何升级",
      "- 场景结束时发生了什么变化",
      "",
      "## 第二章",
      "",
      "### 第二个场景",
      "",
      "- "
    ],
    volume: [
      "# 第一卷",
      "",
      "## 第一章",
      "",
      "### 第一个场景",
      "",
      "- 这个场景要解决的问题"
    ],
    chapter: [
      "# 第一章",
      "",
      "## 第一个场景",
      "",
      "- 这个场景要解决的问题",
      "- 场景结束时发生了什么变化"
    ],
    scene: [
      "# 第一个场景",
      "",
      "- 这个场景要解决的问题",
      "- 冲突如何升级",
      "",
      "## 备注",
      "",
      "这里可以写场景正文提示；在场景大纲里，二级标题不会创建章节。"
    ]
  };
  return [
    `@scope ${scope}`,
    "",
    "<!--",
    "规划草稿写法：",
    "1. @scope 声明这个文件的粒度：book / volume / chapter / scene，也可以写 书 / 卷 / 章 / 场景。",
    "2. @include ./relative.md 可以包含更小粒度的草稿；路径相对当前文件，且必须留在 outlines/ 内。",
    "3. 指令必须写在文件开头、首个标题前；旧文件没有 @scope 时会按 book 解析。",
    "",
    "相对标题规则：",
    "- book：# 卷，## 章节，### 场景。",
    "- volume：# 卷标题，## 章节，### 场景；没有 # 时会用文件名作为卷标题。",
    "- chapter：# 章节，## 场景。",
    "- scene：# 场景；## 及更深标题只是场景正文小节，不创建结构层级。",
    "",
    "导入流程：",
    "1. 在“结构规划 > 规划草稿”里右键本文件，选择“预览导入大纲到结构骨架”。",
    "2. volume / chapter / scene 草稿会在导入时选择复用或创建父级。",
    "3. 确认 preview 后，LoreDock 才会创建手稿卷章和场景卡；原草稿不会被改写。",
    "4. 修改草稿不会自动同步已经落地的章节或场景卡，需要再次预览导入。",
    "-->",
    "",
    ...examples[scope],
    ""
  ].join("\n");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function outlineScopeLabel(scope: OutlineDraftScope): string {
  switch (scope) {
    case "book":
      return "书籍大纲";
    case "volume":
      return "卷大纲";
    case "chapter":
      return "章大纲";
    case "scene":
      return "场景大纲";
  }
}

function titleFromOutlinePath(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  return name.replace(/\.md$/i, "");
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
