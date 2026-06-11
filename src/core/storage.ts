import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  BEATS_DIR,
  BLUEPRINTS_DIR,
  CHARACTERS_DIR,
  CODEX_DIR,
  EXPORTS_DIR,
  EXPORT_STYLE_FILE,
  HEALTH_BASELINE_FILE,
  FORESHADOWING_DIR,
  LEGACY_TIMELINE_DIR,
  LORE_DIR,
  LOCATIONS_DIR,
  MANUSCRIPT_DIR,
  OUTLINES_DIR,
  PENDING_UPDATES_DIR,
  PROJECT_FILE,
  REFERENCE_INDEX_FILE,
  SCENES_DIR,
  STYLE_GUIDE_FILE,
  SUMMARY_DIR,
  TIMELINE_DOCUMENT_FILE,
  TIMELINE_WORKSPACE_DIR,
  WORLD_RULES_DIR,
  WRITING_GOALS_FILE
} from './constants';
import { countWords } from './wordCount';
import {
  ChapterMeta,
  ChapterRef,
  ChapterStatus,
  ChapterSummary,
  CharacterRelationship,
  CharacterCard,
  BlueprintDocument,
  BlueprintEdgeSemanticIssue,
  BlueprintNode,
  BlueprintNodeSemanticSummary,
  BlueprintPanelState,
  BlueprintRefKind,
  BlueprintSyncDecision,
  BlueprintSyncFieldDiff,
  BlueprintSyncItem,
  BlueprintSyncPreview,
  BlueprintSyncSnapshot,
  BlueprintSyncStatus,
  CodexCard,
  CodexEntry,
  CodexReferenceIndex,
  CodexReferenceOccurrence,
  CodexSourceKind,
  ConsistencyIssue,
  CreateCodexInput,
  BeatPlan,
  ExportStyle,
  ForeshadowingCard,
  LocationCard,
  OutlineDocument,
  OutlineImportResult,
  OutlineNode,
  ProjectHealthFixReport,
  ProjectHealthBaseline,
  ProjectInitOptions,
  ProjectHealthIssue,
  ProjectHealthReport,
  ProjectHealthSeverity,
  ProjectDashboard,
  ProjectManifest,
  ScenePlan,
  TimelineDocument,
  TimelineEvent,
  TimelineConflict,
  TimelineLane,
  TimelineResolvedEvent,
  TimelineResolvedView,
  TimelinePoint,
  VolumeMeta,
  WorldRule,
  WritingGoals,
  WritingStats
} from '../types';
import { makeId, nextNumberedId, nowIso, posixPath, slugify, stripUtf8Bom } from './utils';

export type ExportFormat = 'markdown' | 'txt' | 'docx' | 'epub' | 'pdf';

interface ExportChapter {
  title: string;
  body: string;
}

interface ExportVolume {
  title: string;
  chapters: ExportChapter[];
}

interface ManuscriptExport {
  title: string;
  author: string;
  volumes: ExportVolume[];
}

interface BlueprintSyncSource {
  title: string;
  note: string;
  refPath?: string;
  updatedAt?: string;
}

interface LegacyTimelineCard {
  schemaVersion: 1;
  id: string;
  kind: 'timeline-event';
  name: string;
  aliases?: string[];
  tags?: string[];
  allowInContext?: boolean;
  summary?: string;
  sequence?: number;
  storyTime?: string;
  chapterId?: string;
  location?: string;
  participants?: string[];
  causes?: string[];
  consequences?: string[];
  knownBy?: string[];
  unknownBy?: string[];
  relationshipEffects?: CharacterRelationship[];
  result?: string;
  visibility?: TimelineEvent['visibility'];
  createdAt?: string;
  updatedAt?: string;
}

const CODEX_DIRECTORIES: Array<{ kind: CodexCard['kind']; directory: string }> = [
  { kind: 'character', directory: CHARACTERS_DIR },
  { kind: 'location', directory: LOCATIONS_DIR },
  { kind: 'world-rule', directory: WORLD_RULES_DIR },
  { kind: 'foreshadowing', directory: FORESHADOWING_DIR },
  { kind: 'scene', directory: SCENES_DIR },
  { kind: 'beat', directory: BEATS_DIR }
];

const SOURCE_KIND_TO_CARD_KIND: Partial<Record<CodexSourceKind, CodexCard['kind']>> = {
  character: 'character',
  location: 'location',
  'world-rule': 'world-rule',
  foreshadowing: 'foreshadowing',
  scene: 'scene',
  beat: 'beat'
};

const REFERENCE_STOP_WORDS = new Set([
  '主角',
  '配角',
  '城市',
  '地点',
  '规则',
  '伏笔',
  '事件',
  '场景',
  '章节',
  '人物',
  '世界',
  '秘密'
]);

export class LoreDockStorage {
  public constructor(public readonly workspaceRoot: string) {}

  public resolve(relativePath: string): string {
    const normalized = toWorkspaceRelativePath(relativePath);
    if (!normalized) {
      return this.workspaceRoot;
    }
    return path.join(this.workspaceRoot, ...normalized.split('/'));
  }

  public async manifestExists(): Promise<boolean> {
    return this.exists(PROJECT_FILE);
  }

  public async initializeProject(options: ProjectInitOptions): Promise<ProjectManifest> {
    const alreadyInitialized = await this.manifestExists();
    if (alreadyInitialized && !options.force) {
      throw new Error('LoreDock project already exists.');
    }

    await this.ensureProjectDirectories();

    const timestamp = nowIso();
    const volume: VolumeMeta = {
      id: 'volume-001',
      title: '第一卷',
      order: 1,
      chapters: [
        {
          id: 'chapter-001',
          title: '第一章',
          status: 'drafting',
          filePath: posixPath(MANUSCRIPT_DIR, 'volume-001', 'chapter-001.md'),
          order: 1,
          wordCount: 0
        }
      ]
    };

    const manifest: ProjectManifest = {
      schemaVersion: 1,
      title: options.title,
      author: options.author,
      genre: options.genre,
      language: options.language,
      defaultStyle: options.defaultStyle,
      createdAt: timestamp,
      updatedAt: timestamp,
      volumes: [volume]
    };

    const chapterPath = this.resolve(volume.chapters[0].filePath);
    await fs.mkdir(path.dirname(chapterPath), { recursive: true });
    if (!(await this.exists(volume.chapters[0].filePath))) {
      await fs.writeFile(chapterPath, `# ${volume.chapters[0].title}\n\n`, 'utf8');
    }

    if (!(await this.exists(STYLE_GUIDE_FILE))) {
      await fs.writeFile(
        this.resolve(STYLE_GUIDE_FILE),
        `# 文风指南\n\n${options.defaultStyle || '第三人称，中文长篇小说，保持设定一致，不提前揭露秘密。'}\n`,
        'utf8'
      );
    }

    if (options.createSamples) {
      await this.createSampleCodexIfMissing(timestamp);
    }

    await this.writeJson(PROJECT_FILE, manifest);
    return manifest;
  }

  public async readManifest(): Promise<ProjectManifest | undefined> {
    if (!(await this.manifestExists())) {
      return undefined;
    }
    return this.readJson<ProjectManifest>(PROJECT_FILE);
  }

  public async requireManifest(): Promise<ProjectManifest> {
    const manifest = await this.readManifest();
    if (!manifest) {
      throw new Error('当前 workspace 还不是 LoreDock 小说项目，请先初始化。');
    }
    return manifest;
  }

  public async writeManifest(manifest: ProjectManifest): Promise<void> {
    manifest.updatedAt = nowIso();
    await this.writeJson(PROJECT_FILE, manifest);
  }

  public async refreshChapterStats(): Promise<ProjectManifest | undefined> {
    const manifest = await this.readManifest();
    if (!manifest) {
      return undefined;
    }

    let changed = false;
    for (const volume of manifest.volumes) {
      for (const chapter of volume.chapters) {
        const absolute = this.resolve(chapter.filePath);
        if (!(await this.exists(chapter.filePath))) {
          continue;
        }
        const text = await fs.readFile(absolute, 'utf8');
        const stats = await fs.stat(absolute);
        const wordCount = countWords(text);
        const lastModifiedAt = stats.mtime.toISOString();
        if (chapter.wordCount !== wordCount || chapter.lastModifiedAt !== lastModifiedAt) {
          chapter.wordCount = wordCount;
          chapter.lastModifiedAt = lastModifiedAt;
          changed = true;
        }
      }
    }

    if (changed) {
      await this.writeManifest(manifest);
    }
    return manifest;
  }

  public async getWritingStats(): Promise<WritingStats> {
    const manifest = await this.refreshChapterStats();
    if (!manifest) {
      throw new Error('当前 workspace 还不是 LoreDock 小说项目，请先初始化。');
    }
    const today = new Date().toISOString().slice(0, 10);
    const statusCounts = {
      planned: 0,
      drafting: 0,
      'draft-complete': 0,
      'needs-polish': 0,
      'needs-check': 0,
      complete: 0,
      abandoned: 0
    };
    let totalWordCount = 0;
    let modifiedTodayWordCount = 0;
    const volumes = manifest.volumes.map((volume) => {
      let wordCount = 0;
      for (const chapter of volume.chapters) {
        wordCount += chapter.wordCount;
        totalWordCount += chapter.wordCount;
        statusCounts[chapter.status] += 1;
        if (chapter.lastModifiedAt?.startsWith(today)) {
          modifiedTodayWordCount += chapter.wordCount;
        }
      }
      return {
        id: volume.id,
        title: volume.title,
        chapterCount: volume.chapters.length,
        wordCount
      };
    });
    const goals = await this.readWritingGoals();
    return {
      projectTitle: manifest.title,
      volumeCount: manifest.volumes.length,
      chapterCount: manifest.volumes.reduce((count, volume) => count + volume.chapters.length, 0),
      totalWordCount,
      modifiedTodayWordCount,
      goals,
      dailyGoalProgress: goals.dailyWordTarget > 0 ? Math.min(1, modifiedTodayWordCount / goals.dailyWordTarget) : undefined,
      totalGoalProgress: goals.totalWordTarget > 0 ? Math.min(1, totalWordCount / goals.totalWordTarget) : undefined,
      statusCounts,
      volumes
    };
  }

  public async readWritingGoals(): Promise<WritingGoals> {
    await this.requireManifest();
    if (!(await this.exists(WRITING_GOALS_FILE))) {
      const goals: WritingGoals = {
        schemaVersion: 1,
        dailyWordTarget: 0,
        totalWordTarget: 0,
        updatedAt: nowIso()
      };
      await this.writeJson(WRITING_GOALS_FILE, goals);
      return goals;
    }
    return this.readJson<WritingGoals>(WRITING_GOALS_FILE);
  }

  public async writeWritingGoals(goals: WritingGoals): Promise<void> {
    await this.requireManifest();
    await this.writeJson(WRITING_GOALS_FILE, { ...goals, schemaVersion: 1, updatedAt: nowIso() });
  }

  public async createVolume(title: string): Promise<VolumeMeta> {
    const manifest = await this.requireManifest();
    const volumeId = nextNumberedId(
      'volume',
      manifest.volumes.map((volume) => volume.id)
    );
    const volume: VolumeMeta = {
      id: volumeId,
      title,
      order: manifest.volumes.length + 1,
      chapters: []
    };
    manifest.volumes.push(volume);
    await fs.mkdir(this.resolve(posixPath(MANUSCRIPT_DIR, volumeId)), { recursive: true });
    await this.writeManifest(manifest);
    return volume;
  }

  public async deleteProject(): Promise<void> {
    await Promise.all(
      [LORE_DIR, MANUSCRIPT_DIR, CODEX_DIR].map((relative) =>
        fs.rm(this.resolve(relative), { recursive: true, force: true })
      )
    );
  }

  public async deleteVolume(volumeId: string): Promise<void> {
    const manifest = await this.requireManifest();
    const index = manifest.volumes.findIndex((volume) => volume.id === volumeId);
    if (index === -1) {
      throw new Error(`找不到卷：${volumeId}`);
    }
    const [volume] = manifest.volumes.splice(index, 1);
    await fs.rm(this.resolve(posixPath(MANUSCRIPT_DIR, volume.id)), { recursive: true, force: true });
    manifest.volumes.forEach((candidate, candidateIndex) => {
      candidate.order = candidateIndex + 1;
    });
    await this.writeManifest(manifest);
  }

  public async createChapter(volumeId: string, title: string): Promise<ChapterMeta> {
    const manifest = await this.requireManifest();
    const volume = manifest.volumes.find((candidate) => candidate.id === volumeId);
    if (!volume) {
      throw new Error(`找不到卷：${volumeId}`);
    }

    const chapterId = nextNumberedId(
      'chapter',
      manifest.volumes.flatMap((candidate) => candidate.chapters.map((chapter) => chapter.id))
    );
    const filePath = posixPath(MANUSCRIPT_DIR, volume.id, `${chapterId}.md`);
    const chapter: ChapterMeta = {
      id: chapterId,
      title,
      status: 'drafting',
      filePath,
      order: volume.chapters.length + 1,
      wordCount: 0
    };

    volume.chapters.push(chapter);
    await fs.mkdir(path.dirname(this.resolve(filePath)), { recursive: true });
    await fs.writeFile(this.resolve(filePath), `# ${title}\n\n`, 'utf8');
    await this.writeManifest(manifest);
    return chapter;
  }

  public async renameChapter(chapterId: string, title: string): Promise<ChapterMeta> {
    const manifest = await this.requireManifest();
    const ref = findChapterRef(manifest, chapterId);
    if (!ref) {
      throw new Error(`找不到章节：${chapterId}`);
    }
    ref.chapter.title = title;
    await this.writeManifest(manifest);
    return ref.chapter;
  }

  public async updateChapterStatus(chapterId: string, status: ChapterStatus): Promise<ChapterMeta> {
    const manifest = await this.requireManifest();
    const ref = findChapterRef(manifest, chapterId);
    if (!ref) {
      throw new Error(`找不到章节：${chapterId}`);
    }
    ref.chapter.status = status;
    await this.writeManifest(manifest);
    return ref.chapter;
  }

  public async deleteChapter(chapterId: string): Promise<void> {
    const manifest = await this.requireManifest();
    for (const volume of manifest.volumes) {
      const index = volume.chapters.findIndex((chapter) => chapter.id === chapterId);
      if (index === -1) {
        continue;
      }
      const [chapter] = volume.chapters.splice(index, 1);
      await fs.rm(this.resolve(chapter.filePath), { force: true });
      volume.chapters.forEach((candidate, candidateIndex) => {
        candidate.order = candidateIndex + 1;
      });
      await this.writeManifest(manifest);
      return;
    }
    throw new Error(`找不到章节：${chapterId}`);
  }

  public async readChapterText(chapterId: string): Promise<string> {
    const ref = await this.getChapterRef(chapterId);
    return fs.readFile(this.resolve(ref.chapter.filePath), 'utf8');
  }

  public async getChapterRef(chapterId: string): Promise<ChapterRef> {
    const manifest = await this.requireManifest();
    const ref = findChapterRef(manifest, chapterId);
    if (!ref) {
      throw new Error(`找不到章节：${chapterId}`);
    }
    return ref;
  }

  public async getChapterRefByFilePath(absolutePath: string): Promise<ChapterRef | undefined> {
    const manifest = await this.readManifest();
    if (!manifest) {
      return undefined;
    }
    const normalized = normalizePathForCompare(absolutePath);
    for (const volume of manifest.volumes) {
      for (const chapter of volume.chapters) {
        if (normalizePathForCompare(this.resolve(chapter.filePath)) === normalized) {
          return { volume, chapter };
        }
      }
    }
    return undefined;
  }

  public async getFlatChapterRefs(): Promise<ChapterRef[]> {
    const manifest = await this.requireManifest();
    return flattenChapterRefs(manifest);
  }

  public async readStyleGuide(): Promise<string> {
    if (!(await this.exists(STYLE_GUIDE_FILE))) {
      return '';
    }
    return fs.readFile(this.resolve(STYLE_GUIDE_FILE), 'utf8');
  }

  public async ensureStyleGuideFile(): Promise<string> {
    await this.requireManifest();
    if (!(await this.exists(STYLE_GUIDE_FILE))) {
      await fs.writeFile(this.resolve(STYLE_GUIDE_FILE), '# 文风指南\n\n第三人称，中文长篇小说，保持设定一致，不提前揭露秘密。\n', 'utf8');
    }
    return STYLE_GUIDE_FILE;
  }

  public async writeStyleGuide(content: string): Promise<void> {
    await this.requireManifest();
    await fs.writeFile(this.resolve(await this.ensureStyleGuideFile()), content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  public async exportManuscript(format: ExportFormat): Promise<string> {
    const manifest = await this.refreshChapterStats();
    if (!manifest) {
      throw new Error('当前 workspace 还不是 LoreDock 小说项目，请先初始化。');
    }
    const extension = extensionForExport(format);
    const fileName = `${slugify(manifest.title || 'novel') || 'novel'}.${extension}`;
    const relativePath = posixPath(EXPORTS_DIR, fileName);
    await fs.mkdir(this.resolve(EXPORTS_DIR), { recursive: true });
    const exported = await this.renderManuscriptExport(manifest);
    const style = await this.readExportStyle();
    if (format === 'markdown') {
      await fs.writeFile(this.resolve(relativePath), renderMarkdownExport(exported, style), 'utf8');
    } else if (format === 'txt') {
      await fs.writeFile(this.resolve(relativePath), renderTextExport(exported, style), 'utf8');
    } else if (format === 'docx') {
      await fs.writeFile(this.resolve(relativePath), renderDocxExport(exported, style));
    } else if (format === 'epub') {
      await fs.writeFile(this.resolve(relativePath), renderEpubExport(exported, style));
    } else {
      await fs.writeFile(this.resolve(relativePath), renderPdfExport(exported, style));
    }
    return relativePath;
  }

  public async ensureExportStyleFile(): Promise<string> {
    await this.requireManifest();
    if (!(await this.exists(EXPORT_STYLE_FILE))) {
      await fs.writeFile(this.resolve(EXPORT_STYLE_FILE), defaultExportStyleJsonc(), 'utf8');
    }
    return EXPORT_STYLE_FILE;
  }

  public async readExportStyle(): Promise<ExportStyle> {
    await this.ensureExportStyleFile();
    const raw = await fs.readFile(this.resolve(EXPORT_STYLE_FILE), 'utf8');
    return { ...defaultExportStyle(), ...(JSON.parse(stripJsonComments(stripUtf8Bom(raw))) as Partial<ExportStyle>), schemaVersion: 1 };
  }

  public async importManuscript(sourceName: string, content: string): Promise<ChapterMeta[]> {
    await this.requireManifest();
    const baseName = path.basename(sourceName.replace(/\\/g, '/')).replace(/\.[^.]+$/, '') || '导入手稿';
    const chapters = splitImportedChapters(content);
    const volume = await this.createVolume(`导入：${baseName}`);
    const created: ChapterMeta[] = [];
    for (const chapter of chapters) {
      const meta = await this.createChapter(volume.id, chapter.title);
      await fs.writeFile(this.resolve(meta.filePath), `# ${chapter.title}\n\n${chapter.body.trim()}\n`, 'utf8');
      created.push(meta);
    }
    await this.refreshChapterStats();
    return created;
  }

  public async importOutlineToPlan(outline: string, title = '导入大纲'): Promise<OutlineImportResult> {
    await this.requireManifest();
    await fs.mkdir(this.resolve(OUTLINES_DIR), { recursive: true });
    const timestamp = nowIso();
    const outlineTitle = shortTitle(outline.split(/\r?\n/).find((line) => line.trim()) || title, title);
    const document: OutlineDocument = {
      schemaVersion: 1,
      id: makeId('outline'),
      title: outlineTitle,
      rawText: outline,
      nodes: parseOutlineNodes(outline),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeJson(posixPath(OUTLINES_DIR, `${document.id}-${slugify(outlineTitle)}.json`), document);

    let volumes = 0;
    let outlineChapters = 0;
    let scenes = 0;
    let beats = 0;
    let currentVolumeTitle = '';
    let currentChapterTitle = '';
    let currentScene: ScenePlan | undefined;

    for (const node of document.nodes) {
      if (node.type === 'volume') {
        volumes += 1;
        currentVolumeTitle = node.title;
        currentChapterTitle = '';
        currentScene = undefined;
      } else if (node.type === 'chapter') {
        outlineChapters += 1;
        currentChapterTitle = node.title;
        currentScene = undefined;
      } else if (node.type === 'scene') {
        const scene = await this.createScene({
          name: node.title,
          detail: node.content
        });
        const entry = await this.findCodexEntryById(scene.id);
        if (entry && entry.card.kind === 'scene') {
          currentScene = {
            ...entry.card,
            outlineId: document.id,
            outlineNodeId: node.id,
            outlineVolumeTitle: currentVolumeTitle,
            outlineChapterTitle: currentChapterTitle,
            tags: [...new Set([...entry.card.tags, '大纲'])],
            sourceRefs: [...(entry.card.sourceRefs ?? []), { kind: 'project', id: document.id, name: document.title }]
          };
          await this.writeCodexEntry(entry.relativePath, currentScene);
        } else {
          currentScene = scene;
        }
        scenes += 1;
      } else if (node.type === 'beat') {
        const beat = await this.createBeat({
          name: shortTitle(node.title, 'Beat'),
          detail: node.content || node.title
        });
        const entry = await this.findCodexEntryById(beat.id);
        if (entry && entry.card.kind === 'beat') {
          await this.writeCodexEntry(entry.relativePath, {
            ...entry.card,
            sceneId: currentScene?.id || '',
            outlineId: document.id,
            outlineNodeId: node.id,
            outlineVolumeTitle: currentVolumeTitle,
            outlineChapterTitle: currentChapterTitle,
            tags: [...new Set([...entry.card.tags, '大纲'])],
            sourceRefs: [...(entry.card.sourceRefs ?? []), { kind: 'project', id: document.id, name: document.title }]
          });
        }
        beats += 1;
      } else {
        currentScene = undefined;
      }
    }

    return {
      document,
      volumes,
      outlineChapters,
      scenes,
      beats
    };
  }

  public async listOutlines(): Promise<OutlineDocument[]> {
    await this.requireManifest();
    return this.listJsonDirectory<OutlineDocument>(
      OUTLINES_DIR,
      (left, right) => right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  public async listBlueprints(): Promise<BlueprintDocument[]> {
    await this.requireManifest();
    return this.listJsonDirectory<BlueprintDocument>(
      BLUEPRINTS_DIR,
      (left, right) => right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  public async ensureBlueprintOutlineBindings(): Promise<BlueprintDocument[]> {
    const [blueprints, outlines] = await Promise.all([
      this.listBlueprints(),
      this.listOutlines()
    ]);
    const outlinesById = new Map(outlines.map((outline) => [outline.id, outline]));
    const resolved: BlueprintDocument[] = [];
    for (const blueprint of blueprints) {
      const outline = blueprint.outlineId ? outlinesById.get(blueprint.outlineId) : undefined;
      if (!outline) {
        const created = await this.createEmptyOutlineForBlueprint(blueprint.title);
        resolved.push(await this.writeBlueprint({
          ...blueprint,
          outlineId: created.id,
          outlinePath: await this.outlineRelativePath(created)
        }));
        continue;
      }
      if (!blueprint.outlinePath) {
        resolved.push(await this.writeBlueprint({
          ...blueprint,
          outlinePath: await this.outlineRelativePath(outline)
        }));
        continue;
      }
      await this.syncBlueprintToOutlineIfNeeded(blueprint);
      resolved.push(blueprint);
    }
    return resolved.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async createBlueprint(title: string): Promise<BlueprintDocument> {
    await this.requireManifest();
    const timestamp = nowIso();
    const outline = await this.createEmptyOutlineForBlueprint(title);
    const document: BlueprintDocument = {
      schemaVersion: 1,
      id: makeId('blueprint'),
      title: title.trim() || '未命名蓝图',
      outlineId: outline.id,
      outlinePath: await this.outlineRelativePath(outline),
      nodes: [],
      edges: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeBlueprint(document);
    return document;
  }

  public async readBlueprint(id: string): Promise<BlueprintDocument | undefined> {
    const blueprints = await this.listBlueprints();
    return blueprints.find((blueprint) => blueprint.id === id);
  }

  public async writeBlueprint(document: BlueprintDocument): Promise<BlueprintDocument> {
    await this.requireManifest();
    const timestamp = nowIso();
    const normalized: BlueprintDocument = {
      ...document,
      schemaVersion: 1,
      title: document.title.trim() || '未命名蓝图',
      outlinePath: document.outlinePath || await this.resolveBlueprintOutlinePath(document.outlineId),
      nodes: document.nodes.map(normalizeBlueprintNode),
      edges: document.edges.map(normalizeBlueprintEdge),
      createdAt: document.createdAt || timestamp,
      updatedAt: timestamp
    };
    await this.writeJson(await this.blueprintRelativePath(normalized), normalized);
    await this.syncBlueprintToOutlineIfNeeded(normalized);
    return normalized;
  }

  public async deleteBlueprint(id: string): Promise<void> {
    await this.requireManifest();
    const blueprint = await this.readBlueprint(id);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${id}`);
    }
    await fs.rm(this.resolve(await this.blueprintRelativePath(blueprint)), { force: true });
    if (blueprint.outlineId) {
      const outline = (await this.listOutlines()).find((candidate) => candidate.id === blueprint.outlineId);
      if (outline) {
        await fs.rm(this.resolve(await this.outlineRelativePath(outline)), { force: true });
      }
    }
  }

  public async addNoteNodeToBlueprint(
    blueprintId: string,
    position: { x: number; y: number },
    title = '备注'
  ): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const node: BlueprintNode = {
      id: makeId('bp-node'),
      kind: 'note',
      title: title.trim() || '备注',
      x: position.x,
      y: position.y,
      width: 220,
      height: 104,
      note: '',
      color: '#808080'
    };
    return this.writeBlueprint({
      ...blueprint,
      nodes: [...blueprint.nodes, node]
    });
  }

  public async deleteBlueprintNodes(blueprintId: string, nodeIds: string[]): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const removing = new Set(nodeIds);
    return this.writeBlueprint({
      ...blueprint,
      nodes: blueprint.nodes.filter((node) => !removing.has(node.id)),
      edges: blueprint.edges.filter((edge) => !removing.has(edge.fromNodeId) && !removing.has(edge.toNodeId))
    });
  }

  public async deleteBlueprintEdges(blueprintId: string, edgeIds: string[]): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const removing = new Set(edgeIds);
    return this.writeBlueprint({
      ...blueprint,
      edges: blueprint.edges.filter((edge) => !removing.has(edge.id))
    });
  }

  public async duplicateBlueprintNodes(blueprintId: string, nodeIds: string[]): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const selected = new Set(nodeIds);
    const copies = blueprint.nodes
      .filter((node) => selected.has(node.id))
      .map((node) => ({
        ...node,
        id: makeId('bp-node'),
        x: node.x + 36,
        y: node.y + 36
      }));
    return this.writeBlueprint({
      ...blueprint,
      nodes: [...blueprint.nodes, ...copies]
    });
  }

  public async autoLayoutBlueprint(blueprintId: string): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const nodes = [...blueprint.nodes].sort(compareBlueprintNodesForLayout);
    const layers = new Map(nodes.map((node) => [node.id, 0]));
    const flowEdges = blueprint.edges
      .filter((edge) => edge.type === 'flow')
      .sort((left, right) => `${left.fromNodeId}:${left.toNodeId}`.localeCompare(`${right.fromNodeId}:${right.toNodeId}`));
    for (let pass = 0; pass < nodes.length; pass += 1) {
      let changed = false;
      for (const edge of flowEdges) {
        if (!layers.has(edge.fromNodeId) || !layers.has(edge.toNodeId)) {
          continue;
        }
        const nextLayer = (layers.get(edge.fromNodeId) ?? 0) + 1;
        if (nextLayer > (layers.get(edge.toNodeId) ?? 0)) {
          layers.set(edge.toNodeId, nextLayer);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
    const rowByLayer = new Map<number, number>();
    const laidOut = nodes.map((node) => {
      const layer = layers.get(node.id) ?? 0;
      const row = rowByLayer.get(layer) ?? 0;
      rowByLayer.set(layer, row + 1);
      return {
        ...node,
        x: 80 + layer * 300,
        y: 80 + row * 150
      };
    });
    const byId = new Map(laidOut.map((node) => [node.id, node]));
    return this.writeBlueprint({
      ...blueprint,
      nodes: blueprint.nodes.map((node) => byId.get(node.id) ?? node)
    });
  }

  public async previewBlueprintSync(blueprintId: string): Promise<BlueprintSyncPreview> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const items: BlueprintSyncItem[] = [];
    for (const node of blueprint.nodes) {
      if (!isSyncableBlueprintNode(node)) {
        continue;
      }
      const source = await this.readBlueprintSyncSource(node);
      const itemId = `${blueprint.id}:${node.id}`;
      if (!source) {
        items.push({
          id: itemId,
          nodeId: node.id,
          nodeTitle: node.title,
          nodeNote: node.note || '',
          refKind: node.refKind,
          refId: node.refId,
          refPath: node.refPath,
          status: 'missing',
          detail: '来源不存在或无法读取。',
          defaultAction: 'skip',
          fieldDiffs: []
        });
        continue;
      }
      const status = getBlueprintSyncStatus(node, source);
      items.push({
        id: itemId,
        nodeId: node.id,
        nodeTitle: node.title,
        nodeNote: node.note || '',
        refKind: node.refKind,
        refId: node.refId,
        refPath: source.refPath || node.refPath,
        sourceTitle: source.title,
        sourceNote: source.note,
        sourceUpdatedAt: source.updatedAt,
        status,
        detail: blueprintSyncDetail(status),
        defaultAction: status === 'pull' ? 'pull' : status === 'push' ? 'push' : 'skip',
        fieldDiffs: blueprintSyncFieldDiffs(node, source)
      });
    }
    return {
      schemaVersion: 1,
      blueprintId,
      generatedAt: nowIso(),
      items,
      summary: summarizeBlueprintSyncItems(items)
    };
  }

  public async applyBlueprintSync(blueprintId: string, decisions: BlueprintSyncDecision[]): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const preview = await this.previewBlueprintSync(blueprintId);
    const actions = new Map(decisions.map((decision) => [decision.itemId, decision.action]));
    const nodes = blueprint.nodes.map((node) => ({ ...node }));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const deletingNodeIds = new Set<string>();

    for (const item of preview.items) {
      const action = actions.get(item.id) ?? 'skip';
      if (action === 'skip' || item.status === 'missing') {
        continue;
      }
      const node = nodesById.get(item.nodeId);
      if (!node) {
        continue;
      }
      if (action === 'delete-source') {
        if (node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId) {
          await this.deleteCodexEntryAndBlueprintReferences(node.refId);
          for (const candidate of nodes) {
            if (candidate.refKind && isCodexBlueprintRefKind(candidate.refKind) && candidate.refId === node.refId) {
              deletingNodeIds.add(candidate.id);
            }
          }
        } else if (node.refKind === 'outline' && node.refId) {
          await this.deleteOutlineAndBlueprintReferences(node.refId);
          for (const candidate of nodes) {
            if (candidate.refKind === 'outline' && candidate.refId === node.refId) {
              deletingNodeIds.add(candidate.id);
            } else if (candidate.refKind === 'outline-node' && candidate.refId && parseOutlineNodeRef(candidate.refId)?.outlineId === node.refId) {
              deletingNodeIds.add(candidate.id);
            }
          }
        } else if (node.refKind === 'outline-node' && node.refId) {
          const ref = parseOutlineNodeRef(node.refId);
          if (ref) {
            await this.deleteOutlineAndBlueprintReferences(ref.outlineId);
            for (const candidate of nodes) {
              if (candidate.refKind === 'outline' && candidate.refId === ref.outlineId) {
                deletingNodeIds.add(candidate.id);
              } else if (candidate.refKind === 'outline-node' && candidate.refId && parseOutlineNodeRef(candidate.refId)?.outlineId === ref.outlineId) {
                deletingNodeIds.add(candidate.id);
              }
            }
          }
        }
      } else if (action === 'pull') {
        if (item.sourceTitle === undefined || item.sourceNote === undefined) {
          continue;
        }
        node.title = item.sourceTitle;
        node.note = item.sourceNote;
        node.lastSynced = createBlueprintSyncSnapshot(item.sourceTitle, item.sourceNote, item.sourceUpdatedAt);
      } else if (action === 'push') {
        const updatedAt = await this.writeBlueprintSyncSource(node, {
          title: node.title,
          note: node.note || ''
        });
        node.lastSynced = createBlueprintSyncSnapshot(node.title, node.note || '', updatedAt);
      }
    }

    return this.writeBlueprint({
      ...blueprint,
      nodes: nodes.filter((node) => !deletingNodeIds.has(node.id)),
      edges: blueprint.edges.filter((edge) => !deletingNodeIds.has(edge.fromNodeId) && !deletingNodeIds.has(edge.toNodeId))
    });
  }

  public async createBlueprintFromOutline(outlineId: string): Promise<BlueprintDocument> {
    const outlines = await this.listOutlines();
    const outline = outlines.find((candidate) => candidate.id === outlineId);
    if (!outline) {
      throw new Error(`找不到大纲：${outlineId}`);
    }
    const existing = (await this.listBlueprints()).find((candidate) => candidate.outlineId === outlineId);
    if (existing) {
      return existing;
    }
    const outlinePath = await this.outlineRelativePath(outline);
    const timestamp = nowIso();
    const blueprint: BlueprintDocument = {
      schemaVersion: 1,
      id: makeId('blueprint'),
      title: `${outline.title} 蓝图`,
      outlineId: outline.id,
      outlinePath,
      nodes: [],
      edges: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const nodes: BlueprintNode[] = [];
    const xByType: Record<OutlineNode['type'], number> = {
      volume: 80,
      chapter: 360,
      scene: 640,
      beat: 920,
      note: 640
    };
    const rows = new Map<OutlineNode['type'], number>();
    for (const node of outline.nodes) {
      const row = rows.get(node.type) ?? 0;
      rows.set(node.type, row + 1);
      nodes.push({
        id: makeId('bp-node'),
        kind: node.type === 'scene' ? 'scene' : node.type === 'beat' ? 'beat' : 'outline',
        title: node.title,
        refKind: 'outline-node',
        refId: `${outline.id}:${node.id}`,
        refPath: outlinePath,
        x: xByType[node.type],
        y: 80 + row * 150,
        width: 220,
        height: 104,
        note: node.content,
        color: blueprintColorForOutlineNode(node.type),
        lastSynced: createBlueprintSyncSnapshot(node.title, node.content, outline.updatedAt)
      });
    }
    const idByOutlineNode = new Map(outline.nodes.map((node, index) => [node.id, nodes[index].id]));
    const edges = outline.nodes
      .filter((node) => node.parentId && idByOutlineNode.has(node.parentId))
      .map((node) => ({
        id: makeId('bp-edge'),
        fromNodeId: idByOutlineNode.get(node.parentId || '') || '',
        toNodeId: idByOutlineNode.get(node.id) || '',
        type: 'flow' as const
      }))
      .filter((edge) => edge.fromNodeId && edge.toNodeId);
    return this.writeBlueprint({
      ...blueprint,
      nodes,
      edges
    });
  }

  public async addCodexNodeToBlueprint(
    blueprintId: string,
    entry: CodexEntry,
    position: { x: number; y: number }
  ): Promise<BlueprintDocument> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      throw new Error(`找不到蓝图：${blueprintId}`);
    }
    const node: BlueprintNode = {
      id: makeId('bp-node'),
      kind: entry.card.kind === 'scene' ? 'scene' : entry.card.kind === 'beat' ? 'beat' : 'codex',
      title: entry.card.name,
      refKind: entry.card.kind,
      refId: entry.card.id,
      refPath: entry.relativePath,
      x: position.x,
      y: position.y,
      width: 220,
      height: 104,
      note: entry.card.summary || '',
      color: blueprintColorForCard(entry.card.kind),
      lastSynced: createBlueprintSyncSnapshot(entry.card.name, entry.card.summary || '', entry.card.updatedAt)
    };
    return this.writeBlueprint({
      ...blueprint,
      nodes: [...blueprint.nodes, node]
    });
  }

  public async getBlueprintPanelState(blueprintId?: string): Promise<BlueprintPanelState> {
    const [blueprints, resources] = await Promise.all([
      this.ensureBlueprintOutlineBindings(),
      this.listBlueprintResources()
    ]);
    const current = blueprintId
      ? blueprints.find((blueprint) => blueprint.id === blueprintId) ?? blueprints[0]
      : blueprints[0];
    const resolvedCurrent = current ?? await this.createBlueprint('大纲蓝图');
    const resolvedBlueprints = current ? blueprints : [resolvedCurrent, ...blueprints.filter((blueprint) => blueprint.id !== resolvedCurrent.id)];
    return {
      blueprints: resolvedBlueprints,
      current: resolvedCurrent,
      resources,
      nodeSemantics: await this.getBlueprintNodeSemantics(resolvedCurrent.id),
      edgeSemanticIssues: await this.analyzeBlueprintEdgeSemantics(resolvedCurrent.id)
    };
  }

  public async listBlueprintResources(): Promise<BlueprintPanelState['resources']> {
    const entries = await this.listCodexEntries();
    const codexResources = entries.map((entry) => ({
      id: entry.card.id,
      title: entry.card.name,
      kind: entry.card.kind,
      relativePath: entry.relativePath,
      detail: kindLabelForBlueprint(entry.card.kind)
    }));
    return codexResources.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }

  public async getBlueprintNodeSemantics(blueprintId: string): Promise<Record<string, BlueprintNodeSemanticSummary>> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      return {};
    }
    const [entries, outlines] = await Promise.all([
      this.listCodexEntries(),
      this.listOutlines()
    ]);
    const entriesById = new Map(entries.map((entry) => [entry.card.id, entry]));
    const outlinesById = new Map(outlines.map((outline) => [outline.id, outline]));
    const summaries: Record<string, BlueprintNodeSemanticSummary> = {};
    for (const node of blueprint.nodes) {
      summaries[node.id] = buildBlueprintNodeSemanticSummary(node, entriesById, outlinesById);
    }
    return summaries;
  }

  public async analyzeBlueprintEdgeSemantics(blueprintId: string): Promise<BlueprintEdgeSemanticIssue[]> {
    const blueprint = await this.readBlueprint(blueprintId);
    if (!blueprint) {
      return [];
    }
    return analyzeBlueprintEdgeSemanticIssues(blueprint);
  }

  public async saveSummary(summary: ChapterSummary): Promise<ChapterSummary> {
    const manifest = await this.requireManifest();
    const summaryId = summary.id || `${summary.chapterId}-summary`;
    const timestamp = nowIso();
    const normalized: ChapterSummary = {
      ...summary,
      schemaVersion: 1,
      id: summaryId,
      updatedAt: timestamp,
      createdAt: summary.createdAt || timestamp
    };
    await this.writeJson(posixPath(SUMMARY_DIR, `${summaryId}.json`), normalized);

    const ref = findChapterRef(manifest, normalized.chapterId);
    if (ref) {
      ref.chapter.summaryId = summaryId;
      await this.writeManifest(manifest);
    }
    return normalized;
  }

  public async readSummary(summaryId: string): Promise<ChapterSummary | undefined> {
    const relative = posixPath(SUMMARY_DIR, `${summaryId}.json`);
    if (!(await this.exists(relative))) {
      return undefined;
    }
    return this.readJson<ChapterSummary>(relative);
  }

  public async readPreviousSummary(chapterId: string): Promise<ChapterSummary | undefined> {
    const manifest = await this.requireManifest();
    const chapters = flattenChapterRefs(manifest);
    const index = chapters.findIndex((ref) => ref.chapter.id === chapterId);
    if (index <= 0) {
      return undefined;
    }
    const previous = chapters[index - 1].chapter;
    if (!previous.summaryId) {
      return undefined;
    }
    return this.readSummary(previous.summaryId);
  }

  public async createCharacter(input: CreateCodexInput): Promise<CharacterCard> {
    const timestamp = nowIso();
    const card: CharacterCard = {
      schemaVersion: 1,
      id: makeId('character'),
      kind: 'character',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      alwaysIncludeInContext: false,
      doNotTrack: false,
      nestedRefs: [],
      memoryStatus: 'draft',
      summary: '',
      sourceRefs: [],
      inferences: [],
      progressions: [],
      identity: input.detail ?? '',
      fixedSetting: '',
      personality: '',
      speechStyle: '',
      goals: '',
      abilities: '',
      weaknesses: '',
      relationships: [],
      knows: [],
      doesNotKnow: [],
      relationshipNotes: '',
      currentState: '',
      secrets: '',
      hiddenSecrets: '',
      forbiddenActions: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(CHARACTERS_DIR, card);
    return card;
  }

  public async createLocation(input: CreateCodexInput): Promise<LocationCard> {
    const timestamp = nowIso();
    const card: LocationCard = {
      schemaVersion: 1,
      id: makeId('location'),
      kind: 'location',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      alwaysIncludeInContext: false,
      doNotTrack: false,
      nestedRefs: [],
      memoryStatus: 'draft',
      summary: '',
      sourceRefs: [],
      inferences: [],
      progressions: [],
      type: input.detail ?? '',
      region: '',
      visualFeatures: '',
      atmosphere: '',
      history: '',
      rules: '',
      relatedCharacters: [],
      currentState: '',
      secrets: '',
      hiddenSecrets: '',
      relatedEvents: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(LOCATIONS_DIR, card);
    return card;
  }

  public async createWorldRule(input: CreateCodexInput): Promise<WorldRule> {
    const timestamp = nowIso();
    const card: WorldRule = {
      schemaVersion: 1,
      id: makeId('rule'),
      kind: 'world-rule',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      alwaysIncludeInContext: false,
      doNotTrack: false,
      nestedRefs: [],
      memoryStatus: 'draft',
      summary: '',
      sourceRefs: [],
      inferences: [],
      progressions: [],
      importance: 'important',
      category: '',
      content: input.detail ?? '',
      rules: [],
      scope: [],
      relatedCharacters: [],
      relatedLocations: [],
      relatedFactions: [],
      knownExceptions: [],
      hidden: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(WORLD_RULES_DIR, card);
    return card;
  }

  public async createForeshadowing(input: CreateCodexInput): Promise<ForeshadowingCard> {
    const timestamp = nowIso();
    const card: ForeshadowingCard = {
      schemaVersion: 1,
      id: makeId('foreshadowing'),
      kind: 'foreshadowing',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      alwaysIncludeInContext: false,
      doNotTrack: false,
      nestedRefs: [],
      memoryStatus: 'draft',
      summary: '',
      sourceRefs: [],
      inferences: [],
      progressions: [],
      status: 'planned',
      description: input.detail ?? '',
      firstSeedChapterId: input.chapterId,
      expectedResolveChapterId: '',
      relatedCharacters: [],
      importance: 'important',
      allowRevealInContext: false,
      publicHint: '',
      hiddenTruth: '',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(FORESHADOWING_DIR, card);
    return card;
  }

  public async createTimelineEvent(input: CreateCodexInput): Promise<TimelineEvent> {
    const timestamp = nowIso();
    await this.migrateLegacyTimelineEvents();
    const document = await this.readTimelineDocument();
    const event: TimelineEvent = {
      schemaVersion: 1,
      id: makeId('timeline'),
      kind: 'timeline-event',
      title: input.name,
      summary: '',
      type: 'plot',
      laneType: 'plot',
      importance: 'normal',
      status: 'planned',
      start: {
        label: '',
        sortValue: nextTimelineSortValue(document.events)
      },
      chapterId: input.chapterId,
      location: '',
      participants: [],
      participantIds: [],
      causes: [],
      consequences: [],
      knownBy: [],
      unknownBy: [],
      relationshipEffects: [],
      result: input.detail ?? '',
      visibility: 'public',
      tags: [],
      notes: '',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeTimelineDocument({ ...document, events: [...document.events, event] });
    return event;
  }

  public async readTimelineDocument(): Promise<TimelineDocument> {
    await this.migrateLegacyTimelineEvents();
    if (await this.exists(TIMELINE_DOCUMENT_FILE)) {
      return this.readJson<TimelineDocument>(TIMELINE_DOCUMENT_FILE);
    }
    const timestamp = nowIso();
    const document: TimelineDocument = {
      schemaVersion: 1,
      id: 'timeline-main',
      title: '故事时间线',
      calendar: {
        worldCreatedAt: '',
        calendarName: '自由日历',
        eraLabel: '',
        note: ''
      },
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeTimelineDocument(document);
    return document;
  }

  public async readTimelineDocumentIfExists(): Promise<TimelineDocument | undefined> {
    if (!(await this.exists(TIMELINE_DOCUMENT_FILE))) {
      return undefined;
    }
    return this.readJson<TimelineDocument>(TIMELINE_DOCUMENT_FILE);
  }

  public async writeTimelineDocument(document: TimelineDocument): Promise<TimelineDocument> {
    const normalized: TimelineDocument = {
      ...document,
      schemaVersion: 1,
      id: document.id || 'timeline-main',
      title: document.title || '故事时间线',
      calendar: {
        worldCreatedAt: document.calendar?.worldCreatedAt ?? '',
        calendarName: document.calendar?.calendarName || '自由日历',
        eraLabel: document.calendar?.eraLabel ?? '',
        note: document.calendar?.note ?? ''
      },
      events: document.events.map((event) => normalizeTimelineEvent(event)),
      updatedAt: nowIso()
    };
    await this.writeJson(TIMELINE_DOCUMENT_FILE, normalized);
    return normalized;
  }

  public async updateTimelineEvent(event: TimelineEvent): Promise<TimelineEvent> {
    const document = await this.readTimelineDocument();
    const updated = normalizeTimelineEvent({ ...event, updatedAt: nowIso() });
    const events = document.events.map((item) => item.id === updated.id ? updated : item);
    if (!events.some((item) => item.id === updated.id)) {
      events.push(updated);
    }
    await this.writeTimelineDocument({ ...document, events });
    return updated;
  }

  public async updateTimelineEvents(events: TimelineEvent[]): Promise<TimelineDocument> {
    const document = await this.readTimelineDocument();
    const byId = new Map(events.map((event) => [event.id, normalizeTimelineEvent({ ...event, updatedAt: nowIso() })]));
    const nextEvents = document.events.map((event) => byId.get(event.id) ?? event);
    for (const event of byId.values()) {
      if (!nextEvents.some((candidate) => candidate.id === event.id)) {
        nextEvents.push(event);
      }
    }
    return this.writeTimelineDocument({ ...document, events: nextEvents });
  }

  public async moveTimelineEvents(updates: Array<{ id: string; startSortValue: number; endSortValue?: number }>): Promise<TimelineDocument> {
    const document = await this.readTimelineDocument();
    const byId = new Map(updates.map((update) => [update.id, update]));
    return this.writeTimelineDocument({
      ...document,
      events: document.events.map((event) => {
        const update = byId.get(event.id);
        if (!update || event.locked || event.status === 'locked') {
          return event;
        }
        const duration = event.end ? event.end.sortValue - event.start.sortValue : undefined;
        return {
          ...event,
          start: { ...event.start, sortValue: update.startSortValue },
          end: event.end || update.endSortValue !== undefined
            ? {
              ...(event.end ?? event.start),
              sortValue: update.endSortValue ?? update.startSortValue + Math.max(0, duration ?? 0)
            }
            : undefined
        };
      })
    });
  }

  public async getTimelineResolvedView(): Promise<TimelineResolvedView> {
    const [document, entries, refs] = await Promise.all([
      this.readTimelineDocument(),
      this.listCodexEntries(),
      this.getFlatChapterRefs()
    ]);
    const conflicts = analyzeTimelineConflicts(document.events, entries, refs);
    const conflictIdsByEvent = new Map<string, string[]>();
    for (const conflict of conflicts) {
      for (const eventId of conflict.eventIds) {
        conflictIdsByEvent.set(eventId, [...(conflictIdsByEvent.get(eventId) ?? []), conflict.id]);
      }
    }
    const resolved = document.events.map((event): TimelineResolvedEvent => ({
      ...event,
      resolvedLocation: resolveTimelineLocation(event, entries),
      resolvedParticipants: resolveTimelineParticipants(event, entries),
      resolvedChapter: refs.find((ref) => ref.chapter.id === event.chapterId) ? chapterRefTitle(refs.find((ref) => ref.chapter.id === event.chapterId)!) : undefined,
      resolvedScene: resolveCodexName(event.sceneId, 'scene', entries),
      resolvedBeat: resolveCodexName(event.beatId, 'beat', entries),
      conflictIds: conflictIdsByEvent.get(event.id) ?? []
    }));
    return {
      document,
      lanes: buildTimelineLanes(document.events, entries, refs),
      events: resolved,
      conflicts
    };
  }

  public async analyzeTimelineConflicts(): Promise<TimelineConflict[]> {
    const [document, entries, refs] = await Promise.all([
      this.readTimelineDocument(),
      this.listCodexEntries(),
      this.getFlatChapterRefs()
    ]);
    return analyzeTimelineConflicts(document.events, entries, refs);
  }

  public async deleteTimelineEvent(eventId: string): Promise<void> {
    const document = await this.readTimelineDocument();
    await this.writeTimelineDocument({ ...document, events: document.events.filter((event) => event.id !== eventId) });
  }

  public async migrateLegacyTimelineEvents(): Promise<number> {
    if (await this.exists(TIMELINE_DOCUMENT_FILE)) {
      return 0;
    }
    const legacyEntries = await this.listLegacyTimelineEntries();
    if (legacyEntries.length === 0) {
      return 0;
    }
    const timestamp = nowIso();
    const document: TimelineDocument = {
      schemaVersion: 1,
      id: 'timeline-main',
      title: '故事时间线',
      calendar: {
        worldCreatedAt: '',
        calendarName: '自由日历',
        eraLabel: '',
        note: '由旧资料库时间线迁移生成。'
      },
      events: legacyEntries.map(({ card }) => legacyCodexTimelineToEvent(card)),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeTimelineDocument(document);
    return legacyEntries.length;
  }

  public async listLegacyTimelineEntries(): Promise<Array<{ card: LegacyTimelineCard; relativePath: string }>> {
    return this.listTimelineEntriesInDirectory(LEGACY_TIMELINE_DIR);
  }

  public async createScene(input: CreateCodexInput): Promise<ScenePlan> {
    const timestamp = nowIso();
    const sceneCount = (await this.listCodexEntries('scene')).length;
    const card: ScenePlan = {
      schemaVersion: 1,
      id: makeId('scene'),
      kind: 'scene',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      alwaysIncludeInContext: false,
      doNotTrack: false,
      nestedRefs: [],
      memoryStatus: 'draft',
      summary: '',
      sourceRefs: [],
      inferences: [],
      progressions: [],
      chapterId: input.chapterId,
      viewpointCharacter: '',
      location: '',
      conflict: input.detail ?? '',
      turn: '',
      outcome: '',
      order: sceneCount + 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(SCENES_DIR, card);
    return card;
  }

  public async createBeat(input: CreateCodexInput): Promise<BeatPlan> {
    const timestamp = nowIso();
    const beatCount = (await this.listCodexEntries('beat')).length;
    const card: BeatPlan = {
      schemaVersion: 1,
      id: makeId('beat'),
      kind: 'beat',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      alwaysIncludeInContext: false,
      doNotTrack: false,
      nestedRefs: [],
      memoryStatus: 'draft',
      summary: '',
      sourceRefs: [],
      inferences: [],
      progressions: [],
      chapterId: input.chapterId,
      sceneId: '',
      content: input.detail ?? '',
      purpose: '',
      order: beatCount + 1,
      status: 'planned',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(BEATS_DIR, card);
    return card;
  }

  public async listCodexCards(): Promise<CodexCard[]> {
    const [characters, locations, worldRules, foreshadowing, scenes, beats] = await Promise.all([
      this.listEntriesInDirectory<CharacterCard>(CHARACTERS_DIR),
      this.listEntriesInDirectory<LocationCard>(LOCATIONS_DIR),
      this.listEntriesInDirectory<WorldRule>(WORLD_RULES_DIR),
      this.listEntriesInDirectory<ForeshadowingCard>(FORESHADOWING_DIR),
      this.listEntriesInDirectory<ScenePlan>(SCENES_DIR),
      this.listEntriesInDirectory<BeatPlan>(BEATS_DIR)
    ]);
    return [...characters, ...locations, ...worldRules, ...foreshadowing, ...scenes, ...beats].map((entry) => entry.card);
  }

  public async listCodexDirectory(kind: CodexCard['kind']): Promise<CodexCard[]> {
    if (kind === 'character') {
      return (await this.listEntriesInDirectory<CharacterCard>(CHARACTERS_DIR)).map((entry) => entry.card);
    }
    if (kind === 'location') {
      return (await this.listEntriesInDirectory<LocationCard>(LOCATIONS_DIR)).map((entry) => entry.card);
    }
    if (kind === 'world-rule') {
      return (await this.listEntriesInDirectory<WorldRule>(WORLD_RULES_DIR)).map((entry) => entry.card);
    }
    if (kind === 'foreshadowing') {
      return (await this.listEntriesInDirectory<ForeshadowingCard>(FORESHADOWING_DIR)).map((entry) => entry.card);
    }
    if (kind === 'scene') {
      return (await this.listEntriesInDirectory<ScenePlan>(SCENES_DIR)).map((entry) => entry.card);
    }
    return (await this.listEntriesInDirectory<BeatPlan>(BEATS_DIR)).map((entry) => entry.card);
  }

  public async listCodexEntries(kind?: CodexCard['kind']): Promise<CodexEntry[]> {
    if (kind === 'character') {
      return this.listEntriesInDirectory<CharacterCard>(CHARACTERS_DIR);
    }
    if (kind === 'location') {
      return this.listEntriesInDirectory<LocationCard>(LOCATIONS_DIR);
    }
    if (kind === 'world-rule') {
      return this.listEntriesInDirectory<WorldRule>(WORLD_RULES_DIR);
    }
    if (kind === 'foreshadowing') {
      return this.listEntriesInDirectory<ForeshadowingCard>(FORESHADOWING_DIR);
    }
    if (kind === 'scene') {
      return this.listEntriesInDirectory<ScenePlan>(SCENES_DIR);
    }
    if (kind === 'beat') {
      return this.listEntriesInDirectory<BeatPlan>(BEATS_DIR);
    }
    const [characters, locations, worldRules, foreshadowing, scenes, beats] = await Promise.all([
      this.listEntriesInDirectory<CharacterCard>(CHARACTERS_DIR),
      this.listEntriesInDirectory<LocationCard>(LOCATIONS_DIR),
      this.listEntriesInDirectory<WorldRule>(WORLD_RULES_DIR),
      this.listEntriesInDirectory<ForeshadowingCard>(FORESHADOWING_DIR),
      this.listEntriesInDirectory<ScenePlan>(SCENES_DIR),
      this.listEntriesInDirectory<BeatPlan>(BEATS_DIR)
    ]);
    return [...characters, ...locations, ...worldRules, ...foreshadowing, ...scenes, ...beats];
  }

  public async deleteCodexEntry(relativePath: string): Promise<void> {
    const normalized = toWorkspaceRelativePath(relativePath);
    const allowed =
      normalized.startsWith(`${CHARACTERS_DIR}/`) ||
      normalized.startsWith(`${LOCATIONS_DIR}/`) ||
      normalized.startsWith(`${WORLD_RULES_DIR}/`) ||
      normalized.startsWith(`${FORESHADOWING_DIR}/`) ||
      normalized.startsWith(`${SCENES_DIR}/`) ||
      normalized.startsWith(`${BEATS_DIR}/`);
    if (!allowed || !normalized.endsWith('.json')) {
      throw new Error('只能删除 LoreDock 资料库里的 JSON 卡片。');
    }
    await fs.rm(this.resolve(normalized), { force: true });
  }

  public async deleteCodexEntryAndBlueprintReferences(cardId: string): Promise<number> {
    const entry = await this.findCodexEntryById(cardId);
    if (!entry) {
      throw new Error(`找不到资料卡：${cardId}`);
    }
    await this.deleteCodexEntry(entry.relativePath);
    const blueprints = await this.listBlueprints();
    let removedNodes = 0;
    for (const blueprint of blueprints) {
      const removing = new Set(
        blueprint.nodes
          .filter((node) => node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId === cardId)
          .map((node) => node.id)
      );
      if (removing.size === 0) {
        continue;
      }
      removedNodes += removing.size;
      await this.writeBlueprint({
        ...blueprint,
        nodes: blueprint.nodes.filter((node) => !removing.has(node.id)),
        edges: blueprint.edges.filter((edge) => !removing.has(edge.fromNodeId) && !removing.has(edge.toNodeId))
      });
    }
    return removedNodes;
  }

  public async deleteOutlineAndBlueprintReferences(outlineId: string): Promise<number> {
    const outline = (await this.listOutlines()).find((candidate) => candidate.id === outlineId);
    if (!outline) {
      throw new Error(`找不到大纲：${outlineId}`);
    }
    await fs.rm(this.resolve(await this.outlineRelativePath(outline)), { force: true });
    const blueprints = await this.listBlueprints();
    let removedNodes = 0;
    for (const blueprint of blueprints) {
      const removing = new Set(
        blueprint.nodes
          .filter((node) => {
            if (node.refKind === 'outline' && node.refId === outlineId) {
              return true;
            }
            if (node.refKind === 'outline-node' && node.refId) {
              return parseOutlineNodeRef(node.refId)?.outlineId === outlineId;
            }
            return false;
          })
          .map((node) => node.id)
      );
      if (removing.size === 0) {
        continue;
      }
      removedNodes += removing.size;
      await this.writeBlueprint({
        ...blueprint,
        nodes: blueprint.nodes.filter((node) => !removing.has(node.id)),
        edges: blueprint.edges.filter((edge) => !removing.has(edge.fromNodeId) && !removing.has(edge.toNodeId))
      });
    }
    return removedNodes;
  }

  public async readCodexEntry(relativePath: string): Promise<CodexEntry> {
    const normalized = toWorkspaceRelativePath(relativePath);
    const card = await this.readJson<CodexCard>(normalized);
    return { card, relativePath: normalized };
  }

  public async writeCodexEntry(relativePath: string, card: CodexCard): Promise<CodexEntry> {
    const normalized = toWorkspaceRelativePath(relativePath);
    if (!normalized.startsWith(`${CODEX_DIR}/`) || !normalized.endsWith('.json')) {
      throw new Error('只能保存 LoreDock 资料库里的 JSON 卡片。');
    }
    const updated = { ...card, updatedAt: nowIso() } as CodexCard;
    await this.writeJson(normalized, updated);
    return { card: updated, relativePath: normalized };
  }

  public async findCodexEntryById(id: string): Promise<CodexEntry | undefined> {
    return (await this.listCodexEntries()).find((entry) => entry.card.id === id);
  }

  public async normalizeSceneOrders(chapterId?: string): Promise<number> {
    const scenes = (await this.listCodexEntries('scene')).filter((entry) => {
      const card = entry.card as ScenePlan;
      return !chapterId || card.chapterId === chapterId;
    });
    const sorted = scenes.sort((a, b) => {
      const left = a.card as ScenePlan;
      const right = b.card as ScenePlan;
      return left.order - right.order || left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
    for (let index = 0; index < sorted.length; index += 1) {
      const card = sorted[index].card as ScenePlan;
      await this.writeCodexEntry(sorted[index].relativePath, { ...card, order: index + 1 });
    }
    return sorted.length;
  }

  public async normalizeBeatOrders(chapterId?: string): Promise<number> {
    const beats = (await this.listCodexEntries('beat')).filter((entry) => {
      const card = entry.card as BeatPlan;
      return !chapterId || card.chapterId === chapterId;
    });
    const sorted = beats.sort((a, b) => {
      const left = a.card as BeatPlan;
      const right = b.card as BeatPlan;
      return left.order - right.order || left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
    for (let index = 0; index < sorted.length; index += 1) {
      const card = sorted[index].card as BeatPlan;
      await this.writeCodexEntry(sorted[index].relativePath, { ...card, order: index + 1 });
    }
    return sorted.length;
  }

  public async listSummaries(): Promise<ChapterSummary[]> {
    try {
      const entries = await fs.readdir(this.resolve(SUMMARY_DIR), { withFileTypes: true });
      const summaries = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => this.readJson<ChapterSummary>(posixPath(SUMMARY_DIR, entry.name)))
      );
      return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  public async buildReferenceIndex(): Promise<CodexReferenceIndex> {
    await this.requireManifest();
    const [manifest, entries, summaries] = await Promise.all([
      this.requireManifest(),
      this.listCodexEntries(),
      this.listSummaries()
    ]);
    const occurrences = await this.buildReferenceOccurrences(manifest, entries, summaries);

    const index: CodexReferenceIndex = {
      schemaVersion: 1,
      generatedAt: nowIso(),
      occurrences
    };
    await this.writeJson(REFERENCE_INDEX_FILE, index);
    return index;
  }

  public async readReferenceIndex(): Promise<CodexReferenceIndex | undefined> {
    if (!(await this.exists(REFERENCE_INDEX_FILE))) {
      return undefined;
    }
    return this.readJson<CodexReferenceIndex>(REFERENCE_INDEX_FILE);
  }

  public async buildProjectHealthReport(): Promise<ProjectHealthReport> {
    const manifest = await this.requireManifest();
    const issues: ProjectHealthIssue[] = [];
    const addIssue = (issue: ProjectHealthIssue) => issues.push(issue);
    const chapterRefs = flattenChapterRefs(manifest);
    const chapterIds = new Set(chapterRefs.map((ref) => ref.chapter.id));
    const chapterOrder = new Map(chapterRefs.map((ref, index) => [ref.chapter.id, index]));
    const registeredChapterPaths = new Set(chapterRefs.map((ref) => toWorkspaceRelativePath(ref.chapter.filePath)));
    const lastActiveChapter = [...chapterRefs].filter((ref) => ref.chapter.status !== 'abandoned').at(-1);
    const lastActiveOrder = lastActiveChapter ? chapterOrder.get(lastActiveChapter.chapter.id) : undefined;

    addManifestStructureIssues(manifest, addIssue);

    for (const ref of chapterRefs) {
      if (!(await this.exists(ref.chapter.filePath))) {
        addIssue({
          severity: 'error',
          category: 'manuscript',
          title: '章节文件缺失',
          detail: `${ref.volume.title} / ${ref.chapter.title} 在 project.json 中存在，但文件不存在。`,
          source: ref.chapter.filePath,
          suggestion: '恢复章节文件，或从 project.json 中移除/重建这个章节。'
        });
      }
      if (ref.chapter.summaryId) {
        const summaryPath = posixPath(SUMMARY_DIR, `${ref.chapter.summaryId}.json`);
        if (!(await this.exists(summaryPath))) {
          addIssue({
            severity: 'warning',
            category: 'manuscript',
            title: '章节摘要引用缺失',
            detail: `${ref.volume.title} / ${ref.chapter.title} 指向的摘要不存在。`,
            source: summaryPath,
            suggestion: '重新生成或手动补回摘要文件，或清理该章节的 summaryId。'
          });
        }
      }
    }

    for (const relativePath of await this.listFilesRecursive(MANUSCRIPT_DIR, new Set(['.md', '.markdown', '.txt']))) {
      if (!registeredChapterPaths.has(relativePath)) {
        addIssue({
          severity: 'warning',
          category: 'manuscript',
          title: '未登记的手稿文件',
          detail: '这个手稿文件不在 project.json 的卷章结构中。',
          source: relativePath,
          suggestion: '导入为章节、移动到 exports/ 或删除无用草稿。'
        });
      }
    }

    const codex = await this.listCodexEntriesForHealth();
    issues.push(...codex.issues);
    const entries = codex.entries;
    const scenes = entries.filter((entry): entry is CodexEntry & { card: ScenePlan } => entry.card.kind === 'scene');
    const beats = entries.filter((entry): entry is CodexEntry & { card: BeatPlan } => entry.card.kind === 'beat');
    const foreshadowing = entries.filter((entry): entry is CodexEntry & { card: ForeshadowingCard } => entry.card.kind === 'foreshadowing');
    const sceneIds = new Set(scenes.map((entry) => entry.card.id));

    addProjectSchemaIssues(manifest, addIssue);
    addCodexSchemaIssues(entries, addIssue);

    for (const entry of scenes) {
      if (entry.card.chapterId && !chapterIds.has(entry.card.chapterId)) {
        addIssue({
          severity: 'warning',
          category: 'plan',
          title: '场景关联章节不存在',
          detail: `场景「${entry.card.name}」指向不存在的章节 ${entry.card.chapterId}。`,
          source: entry.relativePath,
          suggestion: '修改场景的 chapterId，或创建对应章节。'
        });
      }
    }

    for (const entry of beats) {
      if (entry.card.chapterId && !chapterIds.has(entry.card.chapterId)) {
        addIssue({
          severity: 'warning',
          category: 'plan',
          title: 'Beat 关联章节不存在',
          detail: `Beat「${entry.card.name}」指向不存在的章节 ${entry.card.chapterId}。`,
          source: entry.relativePath,
          suggestion: '修改 Beat 的 chapterId，或创建对应章节。'
        });
      }
      if (entry.card.sceneId && !sceneIds.has(entry.card.sceneId)) {
        addIssue({
          severity: 'warning',
          category: 'plan',
          title: 'Beat 关联场景不存在',
          detail: `Beat「${entry.card.name}」指向不存在的场景 ${entry.card.sceneId}。`,
          source: entry.relativePath,
          suggestion: '修改 Beat 的 sceneId，或创建对应场景。'
        });
      }
    }

    addDuplicateOrderIssues(scenes, '场景', addIssue);
    addDuplicateOrderIssues(beats, 'Beat', addIssue);
    addCodexCollisionIssues(entries, addIssue);
    addStructureQualityIssues(entries, addIssue, lastActiveOrder, chapterOrder);

    for (const entry of foreshadowing) {
      for (const [field, label] of [
        ['firstSeedChapterId', '首次埋设章节'],
        ['expectedResolveChapterId', '预计回收章节']
      ] as const) {
        const chapterId = entry.card[field];
        if (chapterId && !chapterIds.has(chapterId)) {
          addIssue({
            severity: 'warning',
            category: 'foreshadowing',
            title: `${label}不存在`,
            detail: `伏笔「${entry.card.name}」的 ${field} 指向不存在的章节 ${chapterId}。`,
            source: entry.relativePath,
            suggestion: '改为已有章节 ID，或创建对应章节。'
          });
        }
      }
      if (entry.card.status === 'resolved' && !entry.card.expectedResolveChapterId) {
        addIssue({
          severity: 'warning',
          category: 'foreshadowing',
          title: '已回收伏笔缺少回收章节',
          detail: `伏笔「${entry.card.name}」状态为 resolved，但没有填写 expectedResolveChapterId。`,
          source: entry.relativePath,
          suggestion: '补充回收章节，方便后续追踪。'
        });
      }
      const resolveOrder = entry.card.expectedResolveChapterId ? chapterOrder.get(entry.card.expectedResolveChapterId) : undefined;
      if ((entry.card.status === 'seeded' || entry.card.status === 'developing') && resolveOrder !== undefined && lastActiveOrder !== undefined && resolveOrder < lastActiveOrder) {
        addIssue({
          severity: 'warning',
          category: 'foreshadowing',
          title: '伏笔预计回收点已过',
          detail: `伏笔「${entry.card.name}」预计在 ${entry.card.expectedResolveChapterId} 回收，但当前最后非废弃章节已经更靠后。`,
          source: entry.relativePath,
          suggestion: '确认是否已回收、延后预计回收章节，或标记为 abandoned/resolved。'
        });
      }
    }

    const legacyTimelineEntries = await this.listLegacyTimelineEntries();
    if (legacyTimelineEntries.length > 0) {
      addIssue({
        severity: 'info',
        category: 'timeline',
        title: '发现旧资料库时间线数据',
        detail: `codex/timeline 中仍有 ${legacyTimelineEntries.length} 个旧事件文件。`,
        source: LEGACY_TIMELINE_DIR,
        suggestion: '打开时间线工作台会迁移到 .loredock/timeline；确认无误后可清理旧目录。'
      });
    }

    const timelineDocument = await this.readTimelineDocumentIfExists();
    const timelineEvents = timelineDocument?.events ?? legacyTimelineEntries.map(({ card }) => legacyCodexTimelineToEvent(card));
    const timelineEntries = timelineEvents.map((event) => ({ card: event, relativePath: timelineDocument ? TIMELINE_DOCUMENT_FILE : LEGACY_TIMELINE_DIR }));
    for (const entry of timelineEntries) {
      const missing = [
        !entry.card.start.label.trim() ? '开始时间' : '',
        !entry.card.location.trim() ? '地点' : '',
        !entry.card.participants.length ? '参与人物' : ''
      ].filter(Boolean);
      if (missing.length > 0) {
        addIssue({
          severity: 'warning',
          category: 'timeline',
          title: '时间线事件信息不足',
          detail: `事件「${entry.card.title}」缺少：${missing.join('、')}。`,
          source: entry.relativePath,
          suggestion: '补齐时间、地点和参与人物，便于检查同人同时间多地点等问题。'
        });
      }
    }
    for (const conflict of analyzeTimelineConflicts(timelineEvents, entries, chapterRefs)) {
      addIssue({
        severity: conflict.severity,
        category: 'timeline',
        title: conflict.title,
        detail: conflict.detail,
        source: timelineDocument ? `${TIMELINE_DOCUMENT_FILE}#${conflict.eventIds.join(',')}` : LEGACY_TIMELINE_DIR,
        suggestion: timelineSuggestionForConflict(conflict)
      });
    }

    let summaries: ChapterSummary[] = [];
    try {
      summaries = await this.listSummaries();
      addSummaryStructureIssues(summaries, chapterIds, addIssue);
      addSummarySchemaIssues(summaries, addIssue);
    } catch (error) {
      addIssue({
        severity: 'error',
        category: 'manuscript',
        title: '摘要目录无法读取',
        detail: error instanceof Error ? error.message : String(error),
        source: SUMMARY_DIR,
        suggestion: '修复损坏的摘要 JSON 文件后重新检查。'
      });
    }
    addCodexReferenceIssues(entries, {
      chapterRefs,
      summaries,
      timelineEvents,
      addIssue
    });
    try {
      const blueprints = await this.listBlueprints();
      const blueprintPaths = new Map(await Promise.all(blueprints.map(async (blueprint) => [blueprint.id, await this.blueprintRelativePath(blueprint)] as const)));
      addBlueprintHealthIssues(blueprints, {
        entries,
        timelineEvents,
        outlines: await this.listOutlines(),
        blueprintPaths,
        addIssue
      });
    } catch (error) {
      addIssue({
        severity: 'error',
        category: 'plan',
        title: '蓝图目录无法读取',
        detail: error instanceof Error ? error.message : String(error),
        source: BLUEPRINTS_DIR,
        suggestion: '修复损坏的蓝图 JSON 文件后重新检查。'
      });
    }
    const occurrences = await this.buildReferenceOccurrences(manifest, entries, summaries);
    const referencedCardIds = new Set(occurrences.map((occurrence) => occurrence.cardId));
    const manuscriptReferencedCardIds = new Set(
      occurrences
        .filter((occurrence) => occurrence.sourceKind === 'chapter' || occurrence.sourceKind === 'summary')
        .map((occurrence) => occurrence.cardId)
    );
    for (const entry of entries.filter((candidate) => candidate.card.allowInContext !== false && !candidate.card.doNotTrack)) {
      if (!referencedCardIds.has(entry.card.id)) {
        addIssue({
          severity: 'info',
          category: 'references',
          title: '资料卡暂无引用',
          detail: `资料卡「${entry.card.name}」没有在手稿、摘要、场景或 Beat 中出现。`,
          source: entry.relativePath,
          suggestion: '确认它是否仍需要保留，或在相关章节/规划中补充引用。'
        });
      } else if (!manuscriptReferencedCardIds.has(entry.card.id)) {
        addIssue({
          severity: 'info',
          category: 'references',
          title: '资料卡尚未进入手稿',
          detail: `资料卡「${entry.card.name}」只在场景或 Beat 中出现，还没有进入手稿或摘要。`,
          source: entry.relativePath,
          suggestion: '确认它是否应在正文中出场，或继续保留为规划资料。'
        });
      }
    }

    return this.finalizeProjectHealthReport(manifest.title, issues);
  }

  public async readProjectHealthBaseline(): Promise<ProjectHealthBaseline> {
    await this.requireManifest();
    if (!(await this.exists(HEALTH_BASELINE_FILE))) {
      return {
        schemaVersion: 1,
        updatedAt: nowIso(),
        fingerprints: []
      };
    }
    const baseline = await this.readJson<ProjectHealthBaseline>(HEALTH_BASELINE_FILE);
    return {
      schemaVersion: 1,
      updatedAt: baseline.updatedAt || nowIso(),
      fingerprints: Array.isArray(baseline.fingerprints) ? [...new Set(baseline.fingerprints)] : []
    };
  }

  public async saveCurrentProjectHealthBaseline(): Promise<ProjectHealthBaseline> {
    const report = await this.buildProjectHealthReport();
    const baseline: ProjectHealthBaseline = {
      schemaVersion: 1,
      updatedAt: nowIso(),
      fingerprints: [...new Set(report.issues.map((issue) => issue.fingerprint).filter((value): value is string => !!value))]
    };
    await this.writeJson(HEALTH_BASELINE_FILE, baseline);
    return baseline;
  }

  public async clearProjectHealthBaseline(): Promise<void> {
    await this.requireManifest();
    await fs.rm(this.resolve(HEALTH_BASELINE_FILE), { force: true });
  }

  public async previewProjectHealthBasicsFixes(): Promise<ProjectHealthFixReport> {
    return this.describeProjectHealthFixes(false);
  }

  public async fixProjectHealthBasics(): Promise<ProjectHealthFixReport> {
    return this.describeProjectHealthFixes(true);
  }

  public async getProjectDashboard(): Promise<ProjectDashboard> {
    const [stats, health, entries] = await Promise.all([
      this.getWritingStats(),
      this.buildProjectHealthReport(),
      this.listCodexEntries()
    ]);
    const refs = await this.getFlatChapterRefs();
    const topIssues = health.issues
      .filter((issue) => !issue.ignored)
      .sort((a, b) => healthSeverityRank(a.severity) - healthSeverityRank(b.severity))
      .slice(0, 5);
    const overdueForeshadowing = entries
      .map((entry) => entry.card)
      .filter((card): card is ForeshadowingCard => card.kind === 'foreshadowing')
      .filter((card) => card.status === 'seeded' || card.status === 'developing')
      .filter((card) => health.issues.some((issue) => issue.source?.includes(card.id) || (issue.source && entries.some((entry) => entry.card.id === card.id && issue.source === entry.relativePath))));
    const recentChapters = [...refs]
      .filter((ref) => !!ref.chapter.lastModifiedAt)
      .sort((a, b) => (b.chapter.lastModifiedAt || '').localeCompare(a.chapter.lastModifiedAt || ''))
      .slice(0, 5);
    const unreferencedImportantCards = entries
      .filter((entry) => !entry.card.doNotTrack && entry.card.allowInContext !== false)
      .filter((entry) => health.issues.some((issue) => issue.title === '资料卡暂无引用' && issue.source === entry.relativePath))
      .filter((entry) => entry.card.alwaysIncludeInContext || entry.card.memoryStatus === 'confirmed' || entry.card.kind === 'foreshadowing')
      .slice(0, 8);
    return {
      projectTitle: stats.projectTitle,
      generatedAt: nowIso(),
      stats,
      health,
      topIssues,
      overdueForeshadowing,
      recentChapters,
      unreferencedImportantCards
    };
  }

  private async describeProjectHealthFixes(apply: boolean): Promise<ProjectHealthFixReport> {
    const actions: ProjectHealthFixReport['actions'] = [];
    const manifest = await this.requireManifest();
    let clearedSummaryIds = 0;
    const clearedSummarySources: string[] = [];

    for (const ref of flattenChapterRefs(manifest)) {
      if (!ref.chapter.summaryId) {
        continue;
      }
      const summaryPath = posixPath(SUMMARY_DIR, `${ref.chapter.summaryId}.json`);
      if (!(await this.exists(summaryPath))) {
        if (apply) {
          delete ref.chapter.summaryId;
        }
        clearedSummaryIds += 1;
        clearedSummarySources.push(ref.chapter.filePath);
      }
    }
    if (apply && clearedSummaryIds > 0) {
      await this.writeManifest(manifest);
    }
    actions.push({
      title: '清理失效章节摘要引用',
      detail: clearedSummaryIds > 0
        ? `${apply ? '已清理' : '将清理'} ${clearedSummaryIds} 个不存在的 summaryId。`
        : '没有发现需要清理的失效 summaryId。',
      changed: apply && clearedSummaryIds > 0,
      willChange: !apply && clearedSummaryIds > 0,
      affectedSources: clearedSummarySources
    });

    const codex = await this.listCodexEntriesForHealth();
    const scenes = codex.entries.filter((entry): entry is CodexEntry & { card: ScenePlan } => entry.card.kind === 'scene');
    const beats = codex.entries.filter((entry): entry is CodexEntry & { card: BeatPlan } => entry.card.kind === 'beat');
    const sceneOrderDuplicateChapters = duplicateOrderChapterIds(scenes);
    const beatOrderDuplicateChapters = duplicateOrderChapterIds(beats);
    if (sceneOrderDuplicateChapters.length > 0) {
      let count = 0;
      for (const chapterId of sceneOrderDuplicateChapters) {
        count += apply ? await this.normalizeSceneOrders(chapterId) : scenes.filter((entry) => entry.card.chapterId === chapterId).length;
      }
      actions.push({
        title: '归一化场景顺序',
        detail: `检测到重复 order，${apply ? '已' : '将'}在 ${sceneOrderDuplicateChapters.length} 个章节中重新排序 ${count} 个场景。`,
        changed: apply && count > 0,
        willChange: !apply && count > 0,
        affectedSources: scenes.filter((entry) => sceneOrderDuplicateChapters.includes(entry.card.chapterId || '')).map((entry) => entry.relativePath)
      });
    } else {
      actions.push({
        title: '归一化场景顺序',
        detail: '没有发现重复的场景 order。',
        changed: false
      });
    }
    if (beatOrderDuplicateChapters.length > 0) {
      let count = 0;
      for (const chapterId of beatOrderDuplicateChapters) {
        count += apply ? await this.normalizeBeatOrders(chapterId) : beats.filter((entry) => entry.card.chapterId === chapterId).length;
      }
      actions.push({
        title: '归一化 Beat 顺序',
        detail: `检测到重复 order，${apply ? '已' : '将'}在 ${beatOrderDuplicateChapters.length} 个章节中重新排序 ${count} 个 Beat。`,
        changed: apply && count > 0,
        willChange: !apply && count > 0,
        affectedSources: beats.filter((entry) => beatOrderDuplicateChapters.includes(entry.card.chapterId || '')).map((entry) => entry.relativePath)
      });
    } else {
      actions.push({
        title: '归一化 Beat 顺序',
        detail: '没有发现重复的 Beat order。',
        changed: false
      });
    }

    return {
      schemaVersion: 1,
      fixedAt: nowIso(),
      actions
    };
  }

  private async finalizeProjectHealthReport(projectTitle: string, issues: ProjectHealthIssue[]): Promise<ProjectHealthReport> {
    const baseline = await this.readProjectHealthBaseline();
    const baselineFingerprints = new Set(baseline.fingerprints);
    const finalized = issues.map((issue) => {
      const fingerprint = projectHealthFingerprint(issue);
      return {
        ...issue,
        fingerprint,
        ignored: baselineFingerprints.has(fingerprint),
        fixable: isSafelyFixableProjectHealthIssue(issue)
      };
    });
    const active = finalized.filter((issue) => !issue.ignored);
    return {
      schemaVersion: 1,
      generatedAt: nowIso(),
      projectTitle,
      summary: summarizeProjectHealthIssues(active),
      totalSummary: summarizeProjectHealthIssues(finalized),
      ignoredCount: finalized.length - active.length,
      newCount: active.length,
      issues: finalized
    };
  }

  public async setCodexMemoryStatus(cardId: string, status: CodexCard['memoryStatus']): Promise<CodexEntry> {
    const entry = await this.findCodexEntryById(cardId);
    if (!entry) {
      throw new Error(`找不到资料卡：${cardId}`);
    }
    return this.writeCodexEntry(entry.relativePath, { ...entry.card, memoryStatus: status });
  }

  public async exportCodexZip(): Promise<string> {
    await this.requireManifest();
    const entries = await this.listCodexEntries();
    await fs.mkdir(this.resolve(EXPORTS_DIR), { recursive: true });
    const relativePath = posixPath(EXPORTS_DIR, `codex-${new Date().toISOString().slice(0, 10)}.zip`);
    const files = await Promise.all(entries.map(async (entry) => ({
      name: entry.relativePath,
      data: await fs.readFile(this.resolve(entry.relativePath))
    })));
    await fs.writeFile(this.resolve(relativePath), zipFiles(files));
    return relativePath;
  }

  public async importCodexZip(buffer: Buffer): Promise<number> {
    await this.requireManifest();
    const files = unzipFiles(buffer);
    let imported = 0;
    for (const file of files) {
      const normalized = toWorkspaceRelativePath(file.name);
      if (!normalized.startsWith(`${CODEX_DIR}/`) || !normalized.endsWith('.json')) {
        continue;
      }
      JSON.parse(stripUtf8Bom(file.data.toString('utf8')));
      await fs.mkdir(path.dirname(this.resolve(normalized)), { recursive: true });
      await fs.writeFile(this.resolve(normalized), file.data);
      imported += 1;
    }
    return imported;
  }

  public async importDocxManuscript(sourceName: string, buffer: Buffer): Promise<ChapterMeta[]> {
    const text = extractDocxText(buffer);
    return this.importManuscript(sourceName, text);
  }

  public async runDeterministicConsistencyCheck(chapterId: string): Promise<ConsistencyIssue[]> {
    const chapterText = await this.readChapterText(chapterId);
    const cards = await this.listCodexCards();
    const issues: ConsistencyIssue[] = [];

    for (const card of cards) {
      if (card.kind === 'foreshadowing' && card.hiddenTruth && !card.allowRevealInContext && chapterText.includes(card.hiddenTruth)) {
        issues.push({
          severity: '严重问题',
          title: `伏笔“${card.name}”隐藏真相提前出现`,
          detail: `章节正文包含隐藏真相：“${card.hiddenTruth}”。`,
          source: `foreshadowing:${card.id}`,
          suggestion: '删去或改写这段内容，或确认该伏笔已经允许揭露。'
        });
      }
      if (card.kind === 'character' && card.currentState && /死亡|已死|离场|失踪/.test(card.currentState) && chapterText.includes(card.name)) {
        issues.push({
          severity: '中等问题',
          title: `人物“${card.name}”状态需要复核`,
          detail: `人物当前状态包含“${card.currentState}”，但本章仍出现该人物名。`,
          source: `character:${card.id}`,
          suggestion: '确认这是回忆、传闻、尸体/遗物描写，还是需要更新人物状态。'
        });
      }
      if (card.kind === 'world-rule' && card.importance === 'absolute' && card.content && isNegatedRuleMentioned(chapterText, card.content)) {
        issues.push({
          severity: '严重问题',
          title: `可能违反绝对世界规则“${card.name}”`,
          detail: `章节中出现疑似突破/违背规则的表达，相关规则：${card.content}`,
          source: `world-rule:${card.id}`,
          suggestion: '检查是否需要补充代价、限制或改写为不违反规则的版本。'
        });
      }
    }

    return issues;
  }

  public async savePendingCodexUpdates(summary: ChapterSummary): Promise<string | undefined> {
    const lines = [
      `# ${summary.chapterTitle} 资料更新建议`,
      '',
      '这些内容来自章节摘要，尚未写入人物卡、地点卡或世界规则。请人工确认后再复制到对应资料卡。',
      '',
      '## 人物状态变化',
      ...formatSuggestionList(summary.characterChanges),
      '',
      '## 地点状态变化',
      ...formatSuggestionList(summary.locationChanges),
      '',
      '## 新增设定',
      ...formatSuggestionList(summary.newSettings),
      '',
      '## 新增伏笔',
      ...formatSuggestionList(summary.newForeshadowing),
      '',
      '## 回收伏笔',
      ...formatSuggestionList(summary.resolvedForeshadowing),
      '',
      '## 未解决问题',
      ...formatSuggestionList(summary.unresolvedQuestions)
    ];
    const hasSuggestions =
      summary.characterChanges.length > 0 ||
      summary.locationChanges.length > 0 ||
      summary.newSettings.length > 0 ||
      summary.newForeshadowing.length > 0 ||
      summary.resolvedForeshadowing.length > 0 ||
      summary.unresolvedQuestions.length > 0;
    if (!hasSuggestions) {
      return undefined;
    }
    const relativePath = posixPath(PENDING_UPDATES_DIR, `${summary.id}.md`);
    await fs.mkdir(this.resolve(PENDING_UPDATES_DIR), { recursive: true });
    await fs.writeFile(this.resolve(relativePath), `${lines.join('\n')}\n`, 'utf8');
    return relativePath;
  }

  public async ensureProjectDirectories(): Promise<void> {
    await Promise.all(
      [
        '.loredock',
        SUMMARY_DIR,
        OUTLINES_DIR,
        BLUEPRINTS_DIR,
        TIMELINE_WORKSPACE_DIR,
        PENDING_UPDATES_DIR,
        MANUSCRIPT_DIR,
        CODEX_DIR,
        CHARACTERS_DIR,
        LOCATIONS_DIR,
        WORLD_RULES_DIR,
        FORESHADOWING_DIR,
        SCENES_DIR,
        BEATS_DIR
      ].map((relative) => fs.mkdir(this.resolve(relative), { recursive: true }))
    );
  }

  private async blueprintRelativePath(document: BlueprintDocument): Promise<string> {
    const existing = await this.findJsonDocumentPathById(BLUEPRINTS_DIR, document.id);
    return existing ?? posixPath(BLUEPRINTS_DIR, `${document.id}-${slugify(document.title)}.json`);
  }

  private async outlineRelativePath(document: OutlineDocument): Promise<string> {
    const existing = await this.findJsonDocumentPathById(OUTLINES_DIR, document.id);
    return existing ?? posixPath(OUTLINES_DIR, `${document.id}-${slugify(document.title)}.json`);
  }

  private async createEmptyOutlineForBlueprint(title: string): Promise<OutlineDocument> {
    await fs.mkdir(this.resolve(OUTLINES_DIR), { recursive: true });
    const timestamp = nowIso();
    const outlineTitle = title.trim() || '未命名蓝图';
    const outline: OutlineDocument = {
      schemaVersion: 1,
      id: makeId('outline'),
      title: outlineTitle,
      rawText: `# ${outlineTitle}\n`,
      nodes: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeJson(await this.outlineRelativePath(outline), outline);
    return outline;
  }

  private async resolveBlueprintOutlinePath(outlineId?: string): Promise<string | undefined> {
    if (!outlineId) {
      return undefined;
    }
    const outline = (await this.listOutlines()).find((candidate) => candidate.id === outlineId);
    return outline ? this.outlineRelativePath(outline) : undefined;
  }

  private async syncBlueprintToOutlineIfNeeded(blueprint: BlueprintDocument): Promise<void> {
    if (!blueprint.outlineId) {
      return;
    }
    const outline = (await this.listOutlines()).find((candidate) => candidate.id === blueprint.outlineId);
    if (!outline) {
      return;
    }
    const nodes = projectBlueprintNodesToOutlineNodes(blueprint);
    if (outlineNodesEqual(outline.nodes, nodes) && outline.rawText === renderOutlineRawText(nodes)) {
      return;
    }
    await this.writeOutlineDocument({
      ...outline,
      title: outline.title || blueprint.title,
      nodes
    });
  }

  private async writeOutlineDocument(document: OutlineDocument): Promise<OutlineDocument> {
    const normalized: OutlineDocument = {
      ...document,
      schemaVersion: 1,
      title: document.title.trim() || '未命名大纲',
      nodes: document.nodes.map((node, index) => ({
        ...node,
        title: node.title.trim() || '未命名节点',
        content: node.content || '',
        order: index + 1,
        sourceLine: index + 1
      })),
      rawText: renderOutlineRawText(document.nodes),
      createdAt: document.createdAt || nowIso(),
      updatedAt: nowIso()
    };
    await this.writeJson(await this.outlineRelativePath(normalized), normalized);
    return normalized;
  }

  private async readBlueprintSyncSource(node: BlueprintNode): Promise<BlueprintSyncSource | undefined> {
    if (node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId) {
      const entry = await this.findCodexEntryById(node.refId);
      if (!entry) {
        return undefined;
      }
      return {
        title: entry.card.name,
        note: entry.card.summary || '',
        refPath: entry.relativePath,
        updatedAt: entry.card.updatedAt
      };
    }
    if (node.refKind === 'outline-node' && node.refId) {
      const ref = parseOutlineNodeRef(node.refId);
      if (!ref) {
        return undefined;
      }
      const outline = (await this.listOutlines()).find((candidate) => candidate.id === ref.outlineId);
      const outlineNode = outline?.nodes.find((candidate) => candidate.id === ref.nodeId);
      if (!outline || !outlineNode) {
        return undefined;
      }
      return {
        title: outlineNode.title,
        note: outlineNode.content || '',
        refPath: await this.outlineRelativePath(outline),
        updatedAt: outline.updatedAt
      };
    }
    if (node.refKind === 'outline' && node.refId) {
      const outline = (await this.listOutlines()).find((candidate) => candidate.id === node.refId);
      if (!outline) {
        return undefined;
      }
      return {
        title: outline.title,
        note: '',
        refPath: await this.outlineRelativePath(outline),
        updatedAt: outline.updatedAt
      };
    }
    return undefined;
  }

  private async writeBlueprintSyncSource(node: BlueprintNode, value: { title: string; note: string }): Promise<string | undefined> {
    if (node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId) {
      const entry = await this.findCodexEntryById(node.refId);
      if (!entry) {
        throw new Error(`找不到资料卡：${node.refId}`);
      }
      const written = await this.writeCodexEntry(entry.relativePath, {
        ...entry.card,
        name: value.title.trim() || entry.card.name,
        summary: value.note
      });
      return written.card.updatedAt;
    }
    if (node.refKind === 'outline-node' && node.refId) {
      const ref = parseOutlineNodeRef(node.refId);
      if (!ref) {
        throw new Error(`蓝图节点大纲引用格式无效：${node.refId}`);
      }
      const outline = (await this.listOutlines()).find((candidate) => candidate.id === ref.outlineId);
      if (!outline) {
        throw new Error(`找不到大纲：${ref.outlineId}`);
      }
      const index = outline.nodes.findIndex((candidate) => candidate.id === ref.nodeId);
      if (index < 0) {
        throw new Error(`找不到大纲节点：${node.refId}`);
      }
      outline.nodes[index] = {
        ...outline.nodes[index],
        title: value.title.trim() || outline.nodes[index].title,
        content: value.note
      };
      const written = await this.writeOutlineDocument(outline);
      return written.updatedAt;
    }
    if (node.refKind === 'outline' && node.refId) {
      const outline = (await this.listOutlines()).find((candidate) => candidate.id === node.refId);
      if (!outline) {
        throw new Error(`找不到大纲：${node.refId}`);
      }
      const written = await this.writeOutlineDocument({
        ...outline,
        title: value.title.trim() || outline.title
      });
      return written.updatedAt;
    }
    return undefined;
  }

  private async findJsonDocumentPathById(relativeDirectory: string, id: string): Promise<string | undefined> {
    try {
      const entries = await fs.readdir(this.resolve(relativeDirectory), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const relativePath = posixPath(relativeDirectory, entry.name);
        try {
          const value = await this.readJson<{ id?: string }>(relativePath);
          if (value.id === id) {
            return relativePath;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return undefined;
  }

  private async createSampleCodexIfMissing(timestamp: string): Promise<void> {
    const sampleCharacterPath = posixPath(CHARACTERS_DIR, 'character-sample.json');
    if (!(await this.exists(sampleCharacterPath))) {
      const card: CharacterCard = {
        schemaVersion: 1,
        id: 'character-sample',
        kind: 'character',
        name: '示例人物',
        aliases: [],
        tags: ['示例'],
        allowInContext: true,
        alwaysIncludeInContext: false,
        doNotTrack: false,
        nestedRefs: [],
        memoryStatus: 'draft',
        summary: '',
        sourceRefs: [],
        inferences: [],
        progressions: [],
        identity: '主角或重要角色',
        fixedSetting: '在这里记录不可随意改变的固定设定。',
        personality: '在这里记录性格基调。',
        speechStyle: '在这里记录说话习惯。',
        goals: '在这里记录当前目标。',
        abilities: '',
        weaknesses: '',
        relationships: [],
        knows: [],
        doesNotKnow: [],
        relationshipNotes: '',
        currentState: '在这里记录最新状态。',
        secrets: '默认不纳入结构上下文。',
        hiddenSecrets: '默认不纳入结构上下文。',
        forbiddenActions: ['不要提前说出隐藏秘密。'],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await this.writeJson(sampleCharacterPath, card);
    }
  }

  private async writeCodexCard(directory: string, card: CodexCard): Promise<void> {
    const fileName = `${card.id}-${slugify(card.name)}.json`;
    await this.writeJson(posixPath(directory, fileName), card);
  }

  private async buildReferenceOccurrences(
    manifest: ProjectManifest,
    entries: CodexEntry[],
    summaries: ChapterSummary[]
  ): Promise<CodexReferenceOccurrence[]> {
    const trackable = entries
      .filter((entry) => entry.card.allowInContext !== false && !entry.card.doNotTrack)
      .map((entry) => ({
        entry,
        names: [entry.card.name, ...(entry.card.aliases ?? [])]
          .map((name) => name.trim())
          .filter((name) => isTrackableReferenceName(name, entry.card))
      }))
      .filter((item) => item.names.length > 0);

    const sources: Array<{
      kind: CodexReferenceOccurrence['sourceKind'];
      id: string;
      title: string;
      relativePath?: string;
      text: string;
    }> = [];

    for (const volume of manifest.volumes) {
      for (const chapter of volume.chapters) {
        if (await this.exists(chapter.filePath)) {
          sources.push({
            kind: 'chapter',
            id: chapter.id,
            title: `${volume.title} / ${chapter.title}`,
            relativePath: chapter.filePath,
            text: await fs.readFile(this.resolve(chapter.filePath), 'utf8')
          });
        }
      }
    }
    for (const summary of summaries) {
      sources.push({
        kind: 'summary',
        id: summary.id,
        title: summary.chapterTitle,
        relativePath: posixPath(SUMMARY_DIR, `${summary.id}.json`),
        text: [
          summary.oneLineSummary,
          ...summary.majorEvents,
          ...summary.characterChanges,
          ...summary.locationChanges,
          ...summary.newSettings,
          ...summary.facts,
          ...summary.inferences
        ].join('\n')
      });
    }
    for (const scene of entries.filter((entry) => entry.card.kind === 'scene')) {
      const card = scene.card as ScenePlan;
      sources.push({
        kind: 'scene',
        id: card.id,
        title: card.name,
        relativePath: scene.relativePath,
        text: [card.name, card.summary, card.viewpointCharacter, card.location, card.conflict, card.turn, card.outcome].filter(Boolean).join('\n')
      });
    }
    for (const beat of entries.filter((entry) => entry.card.kind === 'beat')) {
      const card = beat.card as BeatPlan;
      sources.push({
        kind: 'beat',
        id: card.id,
        title: card.name,
        relativePath: beat.relativePath,
        text: [card.name, card.summary, card.content, card.purpose].filter(Boolean).join('\n')
      });
    }

    const occurrences: CodexReferenceOccurrence[] = [];
    for (const source of sources) {
      for (const { entry, names } of trackable) {
        for (const name of names) {
          for (const index of findAllOccurrences(source.text, name)) {
            occurrences.push({
              cardId: entry.card.id,
              cardName: entry.card.name,
              cardKind: entry.card.kind,
              matchedText: name,
              sourceKind: source.kind,
              sourceId: source.id,
              sourceTitle: source.title,
              relativePath: source.relativePath,
              excerpt: excerptAround(source.text, index, name.length)
            });
          }
        }
      }
    }
    return occurrences;
  }

  private async listCodexEntriesForHealth(): Promise<{ entries: CodexEntry[]; issues: ProjectHealthIssue[] }> {
    const entries: CodexEntry[] = [];
    const issues: ProjectHealthIssue[] = [];
    for (const { kind, directory } of CODEX_DIRECTORIES) {
      try {
        const directoryEntries = await fs.readdir(this.resolve(directory), { withFileTypes: true });
        for (const entry of directoryEntries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
          }
          const relativePath = posixPath(directory, entry.name);
          try {
            const card = await this.readJson<CodexCard>(relativePath);
            entries.push({ card, relativePath });
            if (card.kind !== kind) {
              issues.push({
                severity: 'warning',
                category: 'codex',
                title: '资料卡目录与类型不一致',
                detail: `文件位于 ${directory}，但卡片 kind 是 ${card.kind}。`,
                source: relativePath,
                suggestion: '把资料卡移动到对应目录，或修正 kind 字段。'
              });
            }
          } catch (error) {
            issues.push({
              severity: 'error',
              category: 'codex',
              title: '资料卡 JSON 无法读取',
              detail: error instanceof Error ? error.message : String(error),
              source: relativePath,
              suggestion: '修正 JSON 格式，或从备份恢复这张资料卡。'
            });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return { entries, issues };
  }

  private async listFilesRecursive(relativeDirectory: string, extensions: Set<string>): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await fs.readdir(this.resolve(relativeDirectory), { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = posixPath(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          files.push(...await this.listFilesRecursive(relativePath, extensions));
        } else if (entry.isFile() && extensions.has(path.posix.extname(entry.name).toLowerCase())) {
          files.push(relativePath);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return files;
  }

  private async listEntriesInDirectory<T extends CodexCard>(relativeDirectory: string): Promise<CodexEntry[]> {
    const absolute = this.resolve(relativeDirectory);
    try {
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      const cards = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => ({
            card: await this.readJson<T>(posixPath(relativeDirectory, entry.name)),
            relativePath: posixPath(relativeDirectory, entry.name)
          }))
      );
      return cards.sort((a, b) => a.card.name.localeCompare(b.card.name, 'zh-Hans-CN'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async listTimelineEntriesInDirectory(relativeDirectory: string): Promise<Array<{ card: LegacyTimelineCard; relativePath: string }>> {
    const absolute = this.resolve(relativeDirectory);
    try {
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      const cards = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => ({
            card: await this.readJson<LegacyTimelineCard>(posixPath(relativeDirectory, entry.name)),
            relativePath: posixPath(relativeDirectory, entry.name)
          }))
      );
      return cards.sort((a, b) => (a.card.sequence ?? 0) - (b.card.sequence ?? 0) || a.card.name.localeCompare(b.card.name, 'zh-Hans-CN'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async listJsonDirectory<T extends { updatedAt?: string }>(
    relativeDirectory: string,
    sorter: (left: T, right: T) => number
  ): Promise<T[]> {
    const absolute = this.resolve(relativeDirectory);
    try {
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      const values = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => this.readJson<T>(posixPath(relativeDirectory, entry.name)))
      );
      return values.sort(sorter);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readJson<T>(relativePath: string): Promise<T> {
    const raw = await fs.readFile(this.resolve(relativePath), 'utf8');
    return JSON.parse(stripUtf8Bom(raw)) as T;
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    const absolute = this.resolve(relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  private async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  private async renderManuscriptExport(manifest: ProjectManifest): Promise<ManuscriptExport> {
    const volumes: ExportVolume[] = [];
    for (const volume of [...manifest.volumes].sort((a, b) => a.order - b.order)) {
      const chapters: ExportChapter[] = [];
      for (const chapter of [...volume.chapters].sort((a, b) => a.order - b.order)) {
        const raw = (await fs.readFile(this.resolve(chapter.filePath), 'utf8')).trim();
        chapters.push({
          title: chapter.title,
          body: stripLeadingHeading(raw, chapter.title).trim()
        });
      }
      volumes.push({ title: volume.title, chapters });
    }
    return {
      title: manifest.title,
      author: manifest.author,
      volumes
    };
  }
}

function toWorkspaceRelativePath(relativePath: string): string {
  const forwardPath = relativePath.replace(/\\/g, '/');
  const rawSegments = forwardPath.split('/');
  if (path.isAbsolute(relativePath) || path.posix.isAbsolute(forwardPath) || /^[A-Za-z]:/.test(forwardPath) || rawSegments.includes('..')) {
    throw new Error(`Invalid LoreDock workspace path: ${relativePath}`);
  }
  const normalized = path.posix.normalize(forwardPath);
  if (normalized === '.') {
    return '';
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error(`Invalid LoreDock workspace path: ${relativePath}`);
  }
  return normalized;
}

function normalizePathForCompare(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function findChapterRef(manifest: ProjectManifest, chapterId: string): ChapterRef | undefined {
  for (const volume of manifest.volumes) {
    const chapter = volume.chapters.find((candidate) => candidate.id === chapterId);
    if (chapter) {
      return { volume, chapter };
    }
  }
  return undefined;
}

export function flattenChapterRefs(manifest: ProjectManifest): ChapterRef[] {
  return [...manifest.volumes]
    .sort((a, b) => a.order - b.order)
    .flatMap((volume) =>
      [...volume.chapters]
        .sort((a, b) => a.order - b.order)
        .map((chapter) => ({ volume, chapter }))
    );
}

function addManifestStructureIssues(manifest: ProjectManifest, addIssue: (issue: ProjectHealthIssue) => void): void {
  addDuplicateTokenIssues(
    manifest.volumes.map((volume) => ({ token: volume.id, label: volume.title, source: PROJECT_FILE })),
    {
      severity: 'error',
      category: 'manuscript',
      title: '卷 ID 重复',
      detailPrefix: '多个卷使用同一个 id',
      suggestion: '为重复卷分配唯一 id，避免章节解析和树视图定位混乱。'
    },
    addIssue
  );
  addDuplicateTokenIssues(
    manifest.volumes.map((volume) => ({ token: String(volume.order), label: volume.title, source: PROJECT_FILE })),
    {
      severity: 'warning',
      category: 'manuscript',
      title: '卷顺序重复',
      detailPrefix: '多个卷使用同一个 order',
      suggestion: '调整卷 order，确保全书顺序稳定。'
    },
    addIssue
  );

  const allChapters = manifest.volumes.flatMap((volume) =>
    volume.chapters.map((chapter) => ({ volume, chapter }))
  );
  addDuplicateTokenIssues(
    allChapters.map(({ volume, chapter }) => ({ token: chapter.id, label: `${volume.title} / ${chapter.title}`, source: chapter.filePath })),
    {
      severity: 'error',
      category: 'manuscript',
      title: '章节 ID 重复',
      detailPrefix: '多个章节使用同一个 id',
      suggestion: '为重复章节分配唯一 id，并同步相关场景、Beat、摘要、伏笔和时间线引用。'
    },
    addIssue
  );

  for (const volume of manifest.volumes) {
    addDuplicateTokenIssues(
      volume.chapters.map((chapter) => ({ token: String(chapter.order), label: chapter.title, source: chapter.filePath })),
      {
        severity: 'warning',
        category: 'manuscript',
        title: '章节顺序重复',
        detailPrefix: `${volume.title} 中多个章节使用同一个 order`,
        suggestion: '调整章节 order，确保卷内阅读顺序稳定。'
      },
      addIssue
    );
  }
}

function addSummaryStructureIssues(
  summaries: ChapterSummary[],
  chapterIds: Set<string>,
  addIssue: (issue: ProjectHealthIssue) => void
): void {
  addDuplicateTokenIssues(
    summaries.map((summary) => ({
      token: summary.id,
      label: summary.chapterTitle || summary.chapterId,
      source: posixPath(SUMMARY_DIR, `${summary.id}.json`)
    })),
    {
      severity: 'warning',
      category: 'manuscript',
      title: '摘要 ID 重复',
      detailPrefix: '多个摘要使用同一个 id',
      suggestion: '保留正确摘要，重命名或删除重复摘要文件。'
    },
    addIssue
  );
  for (const summary of summaries) {
    if (!summary.chapterId || chapterIds.has(summary.chapterId)) {
      continue;
    }
    addIssue({
      severity: 'warning',
      category: 'manuscript',
      title: '摘要关联章节不存在',
      detail: `摘要「${summary.id}」指向不存在的章节 ${summary.chapterId}。`,
      source: posixPath(SUMMARY_DIR, `${summary.id}.json`),
      suggestion: '修改摘要的 chapterId，或清理这份孤立摘要。'
    });
  }
}

function addProjectSchemaIssues(manifest: ProjectManifest, addIssue: (issue: ProjectHealthIssue) => void): void {
  if (manifest.schemaVersion !== 1) {
    addIssue({
      severity: 'error',
      category: 'manuscript',
      title: '项目 schemaVersion 不受支持',
      detail: `当前 project.json schemaVersion=${String(manifest.schemaVersion)}，LoreDock 当前只支持 1。`,
      source: PROJECT_FILE,
      suggestion: '先备份项目，再按当前 schemaVersion 迁移 project.json。'
    });
  }
  if (!Array.isArray(manifest.volumes)) {
    addIssue({
      severity: 'error',
      category: 'manuscript',
      title: '项目卷结构异常',
      detail: 'project.json 的 volumes 不是数组。',
      source: PROJECT_FILE,
      suggestion: '从备份恢复 project.json，或按 LoreDock project schema 修复 volumes。'
    });
  }
}

function addSummarySchemaIssues(summaries: ChapterSummary[], addIssue: (issue: ProjectHealthIssue) => void): void {
  for (const summary of summaries) {
    const source = posixPath(SUMMARY_DIR, `${summary.id || 'unknown'}.json`);
    if (summary.schemaVersion !== 1) {
      addIssue({
        severity: 'warning',
        category: 'manuscript',
        title: '摘要 schemaVersion 不受支持',
        detail: `摘要「${summary.id || '未命名'}」schemaVersion=${String(summary.schemaVersion)}。`,
        source,
        suggestion: '备份后按当前摘要结构补齐字段，或重新生成摘要。'
      });
    }
    for (const [field, label] of [
      ['id', 'id'],
      ['chapterId', 'chapterId'],
      ['chapterTitle', '章节标题'],
      ['oneLineSummary', '一句话摘要']
    ] as const) {
      if (typeof summary[field] !== 'string' || !summary[field].trim()) {
        addIssue({
          severity: 'warning',
          category: 'manuscript',
          title: '摘要基础字段缺失',
          detail: `摘要「${summary.id || '未命名'}」缺少 ${label}。`,
          source,
          suggestion: '补齐摘要基础字段，保证引用索引和报告能定位它。'
        });
      }
    }
  }
}

function addCodexSchemaIssues(entries: CodexEntry[], addIssue: (issue: ProjectHealthIssue) => void): void {
  for (const entry of entries) {
    const card = entry.card as CodexCard & Record<string, unknown>;
    if (card.schemaVersion !== 1) {
      addIssue({
        severity: 'warning',
        category: 'codex',
        title: '资料卡 schemaVersion 不受支持',
        detail: `资料卡「${card.name || card.id || entry.relativePath}」schemaVersion=${String(card.schemaVersion)}。`,
        source: entry.relativePath,
        suggestion: '备份后迁移到 schemaVersion 1，或用表单重新保存一次资料卡。'
      });
    }
    for (const [field, label] of [
      ['id', 'id'],
      ['kind', 'kind'],
      ['name', '名称'],
      ['createdAt', 'createdAt'],
      ['updatedAt', 'updatedAt']
    ] as const) {
      if (typeof card[field] !== 'string' || !(card[field] as string).trim()) {
        addIssue({
          severity: field === 'id' || field === 'kind' ? 'error' : 'warning',
          category: 'codex',
          title: '资料卡基础字段缺失',
          detail: `资料卡「${String(card.name || card.id || entry.relativePath)}」缺少 ${label}。`,
          source: entry.relativePath,
          suggestion: '补齐基础字段，避免资料树、引用索引和导入导出异常。'
        });
      }
    }
    for (const [field, label] of [
      ['aliases', '别名'],
      ['tags', '标签']
    ] as const) {
      if (!Array.isArray(card[field])) {
        addIssue({
          severity: 'warning',
          category: 'codex',
          title: '资料卡数组字段异常',
          detail: `资料卡「${String(card.name || card.id || entry.relativePath)}」的 ${label} 字段不是数组。`,
          source: entry.relativePath,
          suggestion: '把该字段修复为空数组或字符串数组。'
        });
      }
    }
    const unknownKeys = Object.keys(card).filter((key) => !allowedCodexKeys(card.kind).has(key));
    if (unknownKeys.length > 0) {
      addIssue({
        severity: 'info',
        category: 'codex',
        title: '资料卡存在未知字段',
        detail: `资料卡「${String(card.name || card.id || entry.relativePath)}」包含当前 schema 未声明字段：${unknownKeys.slice(0, 12).join('、')}`,
        source: entry.relativePath,
        suggestion: '如果这些字段是手动扩展，可以保留；如果来自旧版本，建议迁移到当前字段。'
      });
    }
  }
}

function addStructureQualityIssues(
  entries: CodexEntry[],
  addIssue: (issue: ProjectHealthIssue) => void,
  lastActiveOrder: number | undefined,
  chapterOrder: Map<string, number>
): void {
  for (const entry of entries) {
    const card = entry.card;
    if (card.kind === 'scene') {
      const missing = [
        !card.conflict?.trim() ? '冲突' : '',
        !card.turn?.trim() ? '转折' : '',
        !card.outcome?.trim() ? '结果' : ''
      ].filter(Boolean);
      if (missing.length > 0) {
        addIssue({
          severity: 'info',
          category: 'plan',
          title: '场景规划偏弱',
          detail: `场景「${card.name}」缺少：${missing.join('、')}。`,
          source: entry.relativePath,
          suggestion: '补齐冲突、转折和结果，方便从规划推进到正文。'
        });
      }
    } else if (card.kind === 'beat') {
      const missing = [
        !card.content?.trim() ? '内容' : '',
        !card.purpose?.trim() ? '目的' : ''
      ].filter(Boolean);
      if (missing.length > 0) {
        addIssue({
          severity: 'info',
          category: 'plan',
          title: 'Beat 规划偏弱',
          detail: `Beat「${card.name}」缺少：${missing.join('、')}。`,
          source: entry.relativePath,
          suggestion: '补齐内容和目的，让 Beat 更容易展开为正文。'
        });
      }
    } else if (card.kind === 'character') {
      const missing = [
        !card.currentState?.trim() ? '当前状态' : '',
        !card.goals?.trim() ? '目标' : '',
        !Array.isArray(card.relationships) || card.relationships.length === 0 ? '关系' : ''
      ].filter(Boolean);
      if (missing.length > 0) {
        addIssue({
          severity: 'info',
          category: 'codex',
          title: '人物卡信息偏弱',
          detail: `人物「${card.name}」缺少：${missing.join('、')}。`,
          source: entry.relativePath,
          suggestion: '补齐当前状态、目标和核心关系，减少后续连续性遗漏。'
        });
      }
    } else if (card.kind === 'foreshadowing') {
      const seedOrder = card.firstSeedChapterId ? chapterOrder.get(card.firstSeedChapterId) : undefined;
      if (card.status === 'planned' && seedOrder !== undefined && lastActiveOrder !== undefined && seedOrder < lastActiveOrder) {
        addIssue({
          severity: 'warning',
          category: 'foreshadowing',
          title: '伏笔计划点已过但未埋设',
          detail: `伏笔「${card.name}」计划在 ${card.firstSeedChapterId} 埋设，但状态仍是 planned。`,
          source: entry.relativePath,
          suggestion: '确认是否已经埋设并改为 seeded，或调整首次埋设章节。'
        });
      }
    }
  }
}

function addBlueprintHealthIssues(
  blueprints: BlueprintDocument[],
  context: {
    entries: CodexEntry[];
    timelineEvents: TimelineEvent[];
    outlines: OutlineDocument[];
    blueprintPaths: Map<string, string>;
    addIssue: (issue: ProjectHealthIssue) => void;
  }
): void {
  const cardIds = new Set(context.entries.map((entry) => entry.card.id));
  const timelineEventIds = new Set(context.timelineEvents.map((event) => event.id));
  const entriesById = new Map(context.entries.map((entry) => [entry.card.id, entry]));
  const outlineIds = new Set(context.outlines.map((outline) => outline.id));
  const outlinesById = new Map(context.outlines.map((outline) => [outline.id, outline]));
  const outlineNodeIds = new Set(context.outlines.flatMap((outline) => outline.nodes.map((node) => `${outline.id}:${node.id}`)));
  for (const blueprint of blueprints) {
    const source = context.blueprintPaths.get(blueprint.id) || BLUEPRINTS_DIR;
    const nodeIds = new Set(blueprint.nodes.map((node) => node.id));
    const connectedNodeIds = new Set<string>();
    for (const edge of blueprint.edges) {
      if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
        context.addIssue({
          severity: 'warning',
          category: 'plan',
          title: '蓝图连线指向不存在节点',
          detail: `蓝图「${blueprint.title}」的连线 ${edge.id} 指向不存在节点：${edge.fromNodeId} -> ${edge.toNodeId}。`,
          source,
          suggestion: '删除坏连线，或重新连接到存在的蓝图节点。'
        });
      } else {
        connectedNodeIds.add(edge.fromNodeId);
        connectedNodeIds.add(edge.toNodeId);
      }
    }
    for (const issue of analyzeBlueprintEdgeSemanticIssues(blueprint)) {
      context.addIssue({
        severity: issue.severity,
        category: 'plan',
        title: issue.title,
        detail: issue.detail,
        source,
        suggestion: issue.suggestion
      });
    }

    for (const node of blueprint.nodes) {
      if (node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId && !cardIds.has(node.refId)) {
        context.addIssue({
          severity: 'warning',
          category: 'references',
          title: '蓝图节点资料卡引用不存在',
          detail: `蓝图「${blueprint.title}」中的节点「${node.title}」指向不存在的资料卡 ${node.refId}。`,
          source,
          suggestion: '重新拖入有效资料卡，或删除这个失效蓝图节点。'
        });
      }
      if (node.refKind === 'timeline-event' && node.refId && !timelineEventIds.has(node.refId)) {
        context.addIssue({
          severity: 'warning',
          category: 'references',
          title: '蓝图节点时间线引用不存在',
          detail: `蓝图「${blueprint.title}」中的节点「${node.title}」指向不存在的时间线事件 ${node.refId}。`,
          source,
          suggestion: '在时间线工作台中补回事件，或删除这个失效蓝图节点。'
        });
      }
      if (node.refKind === 'outline' && node.refId && !outlineIds.has(node.refId)) {
        context.addIssue({
          severity: 'warning',
          category: 'references',
          title: '蓝图节点大纲引用不存在',
          detail: `蓝图「${blueprint.title}」中的节点「${node.title}」指向不存在的大纲 ${node.refId}。`,
          source,
          suggestion: '重新从独立大纲生成节点，或删除这个失效蓝图节点。'
        });
      }
      if (node.refKind === 'outline-node' && node.refId && !outlineNodeIds.has(node.refId)) {
        context.addIssue({
          severity: 'warning',
          category: 'references',
          title: '蓝图节点大纲节点引用不存在',
          detail: `蓝图「${blueprint.title}」中的节点「${node.title}」指向不存在的大纲节点 ${node.refId}。`,
          source,
          suggestion: '重新从独立大纲生成蓝图，或删除这个失效节点。'
        });
      }
      if (isSyncableBlueprintNode(node)) {
        const syncSource = getBlueprintSyncSourceForHealth(node, entriesById, outlinesById);
        if (!syncSource) {
          context.addIssue({
            severity: 'warning',
            category: 'references',
            title: '蓝图同步来源缺失',
            detail: `蓝图「${blueprint.title}」中的节点「${node.title}」无法找到可同步的来源。`,
            source,
            suggestion: '重新拖入有效来源，或删除这个失效节点。'
          });
        } else {
          const syncStatus = getBlueprintSyncStatus(node, syncSource);
          if (syncStatus === 'conflict') {
            context.addIssue({
              severity: 'warning',
              category: 'plan',
              title: '蓝图同步存在未处理冲突',
              detail: `蓝图「${blueprint.title}」中的节点「${node.title}」和来源文件都可能有改动。`,
              source,
              suggestion: '打开大纲蓝图的同步预览，选择拉取、推送或跳过。'
            });
          } else if (syncStatus === 'pull' || syncStatus === 'push') {
            context.addIssue({
              severity: 'info',
              category: 'plan',
              title: '蓝图同步快照过期',
              detail: `蓝图「${blueprint.title}」中的节点「${node.title}」有 ${syncStatus === 'pull' ? '来源文件' : '蓝图'} 侧更新尚未同步。`,
              source,
              suggestion: '打开同步预览，确认是否拉取或推送这项更新。'
            });
          }
        }
      }
      if (node.kind !== 'note' && !connectedNodeIds.has(node.id)) {
        context.addIssue({
          severity: 'info',
          category: 'plan',
          title: '蓝图关键节点未连接',
          detail: `蓝图「${blueprint.title}」中的节点「${node.title}」没有任何连线。`,
          source,
          suggestion: '给它接入剧情流或资料关系，或确认它只是暂存节点。'
        });
      }
    }
  }
}

function isCodexBlueprintRefKind(value: string): value is CodexCard['kind'] {
  return ['character', 'location', 'world-rule', 'foreshadowing', 'scene', 'beat'].includes(value);
}

function getBlueprintSyncSourceForHealth(
  node: BlueprintNode,
  entriesById: Map<string, CodexEntry>,
  outlinesById: Map<string, OutlineDocument>
): BlueprintSyncSource | undefined {
  if (node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId) {
    const entry = entriesById.get(node.refId);
    return entry
      ? {
        title: entry.card.name,
        note: entry.card.summary || '',
        refPath: entry.relativePath,
        updatedAt: entry.card.updatedAt
      }
      : undefined;
  }
  if (node.refKind === 'outline-node' && node.refId) {
    const ref = parseOutlineNodeRef(node.refId);
    const outline = ref ? outlinesById.get(ref.outlineId) : undefined;
    const outlineNode = outline && ref ? outline.nodes.find((candidate) => candidate.id === ref.nodeId) : undefined;
    return outline && outlineNode
      ? {
        title: outlineNode.title,
        note: outlineNode.content || '',
        updatedAt: outline.updatedAt
      }
      : undefined;
  }
  if (node.refKind === 'outline' && node.refId) {
    const outline = outlinesById.get(node.refId);
    return outline
      ? {
        title: outline.title,
        note: '',
        updatedAt: outline.updatedAt
      }
      : undefined;
  }
  return undefined;
}

function buildBlueprintNodeSemanticSummary(
  node: BlueprintNode,
  entriesById: Map<string, CodexEntry>,
  outlinesById: Map<string, OutlineDocument>
): BlueprintNodeSemanticSummary {
  if (!node.refKind) {
    return {
      nodeId: node.id,
      label: '本地备注',
      badge: '备注',
      status: 'local',
      lines: compactLines([node.note || ''])
    };
  }
  const source = getBlueprintSyncSourceForHealth(node, entriesById, outlinesById);
  const syncStatus = source ? getBlueprintSyncStatus(node, source) : undefined;
  const status = !source
    ? 'missing'
    : syncStatus === 'conflict'
      ? 'conflict'
      : syncStatus === 'pull' || syncStatus === 'push'
        ? 'stale'
        : 'linked';

  if (node.refKind && isCodexBlueprintRefKind(node.refKind) && node.refId) {
    const entry = entriesById.get(node.refId);
    if (!entry) {
      return missingBlueprintSemantic(node, kindLabelForBlueprint(node.refKind), status);
    }
    return {
      nodeId: node.id,
      label: kindLabelForBlueprint(entry.card.kind),
      badge: kindLabelForBlueprint(entry.card.kind),
      status,
      sourcePath: entry.relativePath,
      lines: semanticLinesForCodexCard(entry.card)
    };
  }
  if (node.refKind === 'outline-node' && node.refId) {
    const ref = parseOutlineNodeRef(node.refId);
    const outline = ref ? outlinesById.get(ref.outlineId) : undefined;
    const outlineNode = outline && ref ? outline.nodes.find((candidate) => candidate.id === ref.nodeId) : undefined;
    if (!outline || !outlineNode) {
      return missingBlueprintSemantic(node, '大纲节点', status);
    }
    return {
      nodeId: node.id,
      label: `大纲节点 / ${outlineNode.type}`,
      badge: outlineNode.type,
      status,
      lines: compactLines([outline.title, outlineNode.content])
    };
  }
  if (node.refKind === 'outline' && node.refId) {
    const outline = outlinesById.get(node.refId);
    if (!outline) {
      return missingBlueprintSemantic(node, '大纲', status);
    }
    return {
      nodeId: node.id,
      label: '独立大纲',
      badge: '大纲',
      status,
      lines: [`${outline.nodes.length} 个节点`]
    };
  }
  return missingBlueprintSemantic(node, node.refKind, status);
}

function missingBlueprintSemantic(
  node: BlueprintNode,
  label: string,
  status: BlueprintNodeSemanticSummary['status']
): BlueprintNodeSemanticSummary {
  return {
    nodeId: node.id,
    label,
    badge: label,
    status,
    lines: ['来源缺失']
  };
}

function semanticLinesForCodexCard(card: CodexCard): string[] {
  if (card.kind === 'character') {
    return compactLines([
      card.identity && `身份：${card.identity}`,
      card.currentState && `状态：${card.currentState}`,
      card.goals && `目标：${card.goals}`,
      (card.secrets || card.hiddenSecrets) && '秘密：已记录'
    ]);
  }
  if (card.kind === 'location') {
    return compactLines([
      card.type && `类型：${card.type}`,
      card.region && `区域：${card.region}`,
      card.currentState && `状态：${card.currentState}`
    ]);
  }
  if (card.kind === 'world-rule') {
    return compactLines([
      card.category && `分类：${card.category}`,
      `重要性：${card.importance}`,
      card.hidden ? '隐藏规则' : '公开规则',
      card.content
    ]);
  }
  if (card.kind === 'foreshadowing') {
    return compactLines([
      `状态：${card.status}`,
      `重要性：${card.importance}`,
      card.expectedResolveChapterId && `预计回收：${card.expectedResolveChapterId}`,
      card.publicHint && `表层提示：${card.publicHint}`
    ]);
  }
  if (card.kind === 'scene') {
    return compactLines([
      card.location && `地点：${card.location}`,
      card.conflict && `冲突：${card.conflict}`,
      card.turn && `转折：${card.turn}`,
      card.outcome && `结果：${card.outcome}`
    ]);
  }
  return compactLines([
    `状态：${card.status}`,
    card.purpose && `目的：${card.purpose}`,
    card.content && `内容：${card.content}`
  ]);
}

function analyzeBlueprintEdgeSemanticIssues(blueprint: BlueprintDocument): BlueprintEdgeSemanticIssue[] {
  const issues: BlueprintEdgeSemanticIssue[] = [];
  const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const seen = new Map<string, string>();
  for (const edge of blueprint.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }
    const duplicateKey = `${edge.fromNodeId}|${edge.toNodeId}|${edge.type}`;
    if (seen.has(duplicateKey)) {
      issues.push({
        edgeId: edge.id,
        severity: 'warning',
        title: '蓝图存在重复语义连线',
        detail: `连线 ${edge.id} 与 ${seen.get(duplicateKey)} 指向同一对节点且类型相同。`,
        suggestion: '删除重复连线，或改成不同关系类型/标签。'
      });
    } else {
      seen.set(duplicateKey, edge.id);
    }
    if ((edge.type === 'conflicts' || edge.type === 'blocks') && edge.fromNodeId === edge.toNodeId) {
      issues.push({
        edgeId: edge.id,
        severity: 'warning',
        title: '蓝图冲突/阻碍连线自环',
        detail: `连线 ${edge.id} 从节点自身连回自身。`,
        suggestion: '连接到真正产生冲突或阻碍的另一节点，或删除自环。'
      });
    }
    if ((edge.type === 'foreshadows' || edge.type === 'resolves') && !isForeshadowingBlueprintNode(from) && !isForeshadowingBlueprintNode(to)) {
      issues.push({
        edgeId: edge.id,
        severity: 'info',
        title: '蓝图伏笔关系未连接伏笔节点',
        detail: `连线 ${edge.id} 的类型是 ${edge.type}，但两端都不是伏笔节点。`,
        suggestion: '把其中一端连接到伏笔资料卡，或改成更合适的关系类型。'
      });
    }
    if (edge.type === 'flow' && (!isFlowBlueprintNode(from) || !isFlowBlueprintNode(to))) {
      issues.push({
        edgeId: edge.id,
        severity: 'info',
        title: '蓝图剧情流连接了非剧情节点',
        detail: `连线 ${edge.id} 使用剧情流，但连接到了非大纲/场景/Beat/时间线节点。`,
        suggestion: '如果这是依赖或支撑关系，改用 uses/supports；如果是剧情顺序，连接到规划节点。'
      });
    }
  }
  return issues;
}

function isForeshadowingBlueprintNode(node: BlueprintNode): boolean {
  return node.refKind === 'foreshadowing';
}

function isFlowBlueprintNode(node: BlueprintNode): boolean {
  return node.kind === 'outline' ||
    node.kind === 'scene' ||
    node.kind === 'beat' ||
    node.refKind === 'outline' ||
    node.refKind === 'outline-node' ||
    node.refKind === 'scene' ||
    node.refKind === 'beat' ||
    node.refKind === 'timeline-event';
}

function compactLines(values: Array<string | undefined | false>): string[] {
  return values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .slice(0, 4);
}

function addCodexReferenceIssues(
  entries: CodexEntry[],
  context: {
    chapterRefs: ChapterRef[];
    summaries: ChapterSummary[];
    timelineEvents: TimelineEvent[];
    addIssue: (issue: ProjectHealthIssue) => void;
  }
): void {
  const chapterIds = new Set(context.chapterRefs.map((ref) => ref.chapter.id));
  const chapterNames = new Set(context.chapterRefs.map((ref) => normalizeHealthToken(ref.chapter.title)).filter(Boolean));
  const summaryIds = new Set(context.summaries.map((summary) => summary.id));
  const summaryNames = new Set(context.summaries.map((summary) => normalizeHealthToken(summary.chapterTitle)).filter(Boolean));
  const cardExists = (value: string, kind?: CodexCard['kind']) => codexReferenceExists(entries, value, kind);
  const timelineEventExists = (value: string) => timelineReferenceExists(context.timelineEvents, value);

  const addMissing = (
    entry: CodexEntry,
    title: string,
    fieldLabel: string,
    target: string,
    expected: string,
    suggestion: string
  ) => {
    context.addIssue({
      severity: 'warning',
      category: 'references',
      title,
      detail: `资料卡「${entry.card.name}」的 ${fieldLabel} 指向不存在的${expected}：${target}。`,
      source: entry.relativePath,
      suggestion
    });
  };

  for (const entry of entries) {
    for (const nestedRef of asStringArray(entry.card.nestedRefs)) {
      if (!cardExists(nestedRef)) {
        addMissing(entry, '嵌套引用不存在', 'nestedRefs', nestedRef, '资料卡', '改为已有资料卡 ID/名称，或删除失效嵌套引用。');
      }
    }

    for (const sourceRef of asSourceRefs(entry.card.sourceRefs)) {
      const target = (sourceRef.id || sourceRef.name || '').trim();
      const exists = sourceRef.kind === 'timeline-event'
        ? timelineEventExists(target)
        : sourceReferenceExists(sourceRef.kind, target, { cardExists, chapterIds, chapterNames, summaryIds, summaryNames });
      if (!target || exists) {
        continue;
      }
      addMissing(entry, '来源引用不存在', `sourceRefs.${sourceRef.kind}`, target, sourceKindLabel(sourceRef.kind), '修正 sourceRefs，或移除已经失效的来源引用。');
    }

    if (entry.card.kind === 'character') {
      for (const relationship of Array.isArray(entry.card.relationships) ? entry.card.relationships : []) {
        if (relationship.target && !cardExists(relationship.target, 'character')) {
          addMissing(entry, '人物关系目标不存在', 'relationships.target', relationship.target, '人物卡', '改为已有人物卡 ID/名称，或补建对应人物。');
        }
      }
    } else if (entry.card.kind === 'location') {
      for (const character of asStringArray(entry.card.relatedCharacters)) {
        if (!cardExists(character, 'character')) {
          addMissing(entry, '关联人物不存在', 'relatedCharacters', character, '人物卡', '改为已有人物卡 ID/名称，或移除失效关联。');
        }
      }
      for (const event of asStringArray(entry.card.relatedEvents)) {
        if (!timelineEventExists(event)) {
          addMissing(entry, '关联事件不存在', 'relatedEvents', event, '时间线事件', '改为已有时间线事件 ID/名称，或移除失效关联。');
        }
      }
    } else if (entry.card.kind === 'world-rule') {
      for (const character of asStringArray(entry.card.relatedCharacters)) {
        if (!cardExists(character, 'character')) {
          addMissing(entry, '关联人物不存在', 'relatedCharacters', character, '人物卡', '改为已有人物卡 ID/名称，或移除失效关联。');
        }
      }
      for (const location of asStringArray(entry.card.relatedLocations)) {
        if (!cardExists(location, 'location')) {
          addMissing(entry, '关联地点不存在', 'relatedLocations', location, '地点卡', '改为已有地点卡 ID/名称，或移除失效关联。');
        }
      }
    } else if (entry.card.kind === 'foreshadowing') {
      for (const character of asStringArray(entry.card.relatedCharacters)) {
        if (!cardExists(character, 'character')) {
          addMissing(entry, '伏笔关联人物不存在', 'relatedCharacters', character, '人物卡', '改为已有人物卡 ID/名称，或移除失效关联。');
        }
      }
    }
  }
}

function addDuplicateTokenIssues(
  items: Array<{ token: string; label: string; source: string }>,
  issue: {
    severity: ProjectHealthIssue['severity'];
    category: ProjectHealthIssue['category'];
    title: string;
    detailPrefix: string;
    suggestion: string;
  },
  addIssue: (issue: ProjectHealthIssue) => void
): void {
  const groups = new Map<string, Array<{ token: string; label: string; source: string }>>();
  for (const item of items) {
    const token = item.token.trim();
    if (!token) {
      continue;
    }
    groups.set(token, [...(groups.get(token) ?? []), item]);
  }
  for (const [token, duplicates] of groups) {
    if (duplicates.length <= 1) {
      continue;
    }
    addIssue({
      severity: issue.severity,
      category: issue.category,
      title: issue.title,
      detail: `${issue.detailPrefix}「${token}」：${duplicates.map((item) => item.label).join('、')}`,
      source: duplicates.map((item) => item.source).join(', '),
      suggestion: issue.suggestion
    });
  }
}

function addDuplicateOrderIssues<T extends ScenePlan | BeatPlan>(
  entries: Array<CodexEntry & { card: T }>,
  label: '场景' | 'Beat',
  addIssue: (issue: ProjectHealthIssue) => void
): void {
  const byChapterAndOrder = new Map<string, Array<CodexEntry & { card: T }>>();
  for (const entry of entries) {
    if (!entry.card.chapterId || !Number.isFinite(entry.card.order)) {
      continue;
    }
    const key = `${entry.card.chapterId}|${entry.card.order}`;
    byChapterAndOrder.set(key, [...(byChapterAndOrder.get(key) ?? []), entry]);
  }
  for (const [key, duplicates] of byChapterAndOrder) {
    if (duplicates.length <= 1) {
      continue;
    }
    const [chapterId, order] = key.split('|');
    addIssue({
      severity: 'warning',
      category: 'plan',
      title: `${label}顺序重复`,
      detail: `${duplicates.length} 个${label}在章节 ${chapterId} 中使用了相同顺序 ${order}：${duplicates.map((entry) => entry.card.name).join('、')}`,
      source: duplicates.map((entry) => entry.relativePath).join(', '),
      suggestion: `运行${label}顺序归一化，或手动调整 order。`
    });
  }
}

function addCodexCollisionIssues(entries: CodexEntry[], addIssue: (issue: ProjectHealthIssue) => void): void {
  for (const { kind } of CODEX_DIRECTORIES) {
    const sameKind = entries.filter((entry) => entry.card.kind === kind);
    const names = new Map<string, CodexEntry[]>();
    for (const entry of sameKind) {
      const key = normalizeHealthToken(entry.card.name);
      if (key) {
        names.set(key, [...(names.get(key) ?? []), entry]);
      }
    }
    const duplicateNameKeys = new Set<string>();
    for (const [key, duplicates] of names) {
      if (duplicates.length <= 1) {
        continue;
      }
      duplicateNameKeys.add(key);
      addIssue({
        severity: 'warning',
        category: 'codex',
        title: '同类型资料卡名称重复',
        detail: `${kind} 中有多张资料卡使用名称「${duplicates[0].card.name}」：${duplicates.map((entry) => entry.relativePath).join('、')}`,
        source: kind,
        suggestion: '重命名重复资料卡，或合并为同一张资料卡并把旧名称放入别名。'
      });
    }

    const tokens = new Map<string, CodexEntry[]>();
    for (const entry of sameKind) {
      const entryTokens = new Set([entry.card.name, ...(entry.card.aliases ?? [])].map(normalizeHealthToken).filter(Boolean));
      for (const token of entryTokens) {
        tokens.set(token, [...(tokens.get(token) ?? []), entry]);
      }
    }
    for (const [token, duplicates] of tokens) {
      const uniqueEntries = [...new Map(duplicates.map((entry) => [entry.card.id, entry])).values()];
      if (uniqueEntries.length <= 1 || duplicateNameKeys.has(token)) {
        continue;
      }
      addIssue({
        severity: 'warning',
        category: 'codex',
        title: '资料卡名称/别名冲突',
        detail: `${kind} 中名称或别名「${token}」同时出现在：${uniqueEntries.map((entry) => entry.card.name).join('、')}`,
        source: uniqueEntries.map((entry) => entry.relativePath).join(', '),
        suggestion: '调整别名或名称，避免引用索引把不同资料卡混在一起。'
      });
    }
  }
}

function addTimelineLocationIssues(
  entries: Array<{ card: TimelineEvent; relativePath: string }>,
  addIssue: (issue: ProjectHealthIssue) => void
): void {
  const byParticipantAndTime = new Map<string, Array<{ card: TimelineEvent; relativePath: string }>>();
  for (const entry of entries) {
    const storyTime = entry.card.start.label.trim() || String(entry.card.start.sortValue);
    const location = typeof entry.card.location === 'string' ? entry.card.location.trim() : '';
    if (!storyTime || !location) {
      continue;
    }
    for (const rawParticipant of asStringArray(entry.card.participants)) {
      const participant = rawParticipant.trim();
      if (!participant) {
        continue;
      }
      const key = `${participant}|${storyTime}`;
      byParticipantAndTime.set(key, [...(byParticipantAndTime.get(key) ?? []), entry]);
    }
  }
  for (const [key, duplicates] of byParticipantAndTime) {
    const locations = [...new Set(duplicates.map((entry) => entry.card.location.trim()).filter(Boolean))];
    if (locations.length <= 1) {
      continue;
    }
    const [participant, storyTime] = key.split('|');
    addIssue({
      severity: 'warning',
      category: 'timeline',
      title: '同一人物同一时间多地点',
      detail: `${participant} 在 ${storyTime} 同时出现在：${locations.join('、')}`,
      source: duplicates.map((entry) => entry.relativePath).join(', '),
      suggestion: '调整地点、故事时间，或在事件说明中补充分身/误认/回忆等原因。'
    });
  }
}

function duplicateOrderChapterIds<T extends ScenePlan | BeatPlan>(entries: Array<CodexEntry & { card: T }>): string[] {
  const byChapterAndOrder = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (!entry.card.chapterId || !Number.isFinite(entry.card.order)) {
      continue;
    }
    const key = `${entry.card.chapterId}|${entry.card.order}`;
    const count = byChapterAndOrder.get(key) ?? 0;
    byChapterAndOrder.set(key, count + 1);
    if (count >= 1) {
      duplicates.add(entry.card.chapterId);
    }
  }
  return [...duplicates].sort();
}

function codexReferenceExists(entries: CodexEntry[], value: string, kind?: CodexCard['kind']): boolean {
  const raw = value.trim();
  const normalized = normalizeHealthToken(raw);
  if (!normalized) {
    return true;
  }
  return entries
    .filter((entry) => !kind || entry.card.kind === kind)
    .some((entry) => (
      entry.card.id === raw ||
      normalizeHealthToken(entry.card.name) === normalized ||
      asStringArray(entry.card.aliases).some((alias) => normalizeHealthToken(alias) === normalized)
    ));
}

function timelineReferenceExists(events: TimelineEvent[], value: string): boolean {
  const raw = value.trim();
  const normalized = normalizeHealthToken(raw);
  if (!normalized) {
    return true;
  }
  return events.some((event) => event.id === raw || normalizeHealthToken(event.title) === normalized);
}

function legacyCodexTimelineToEvent(card: LegacyTimelineCard): TimelineEvent {
  const timestamp = card.updatedAt || card.createdAt || nowIso();
  const storyTime = card.storyTime?.trim() ?? '';
  return normalizeTimelineEvent({
    schemaVersion: 1,
    id: card.id,
    kind: 'timeline-event',
    title: card.name || '未命名事件',
    summary: card.summary ?? '',
    type: 'plot',
    laneType: 'plot',
    importance: 'normal',
    status: 'planned',
    start: {
      label: storyTime,
      sortValue: Number.isFinite(card.sequence) ? Number(card.sequence) : 0
    },
    chapterId: card.chapterId,
    location: card.location ?? '',
    participants: asStringArray(card.participants),
    participantIds: [],
    causes: asStringArray(card.causes),
    consequences: asStringArray(card.consequences),
    knownBy: asStringArray(card.knownBy),
    unknownBy: asStringArray(card.unknownBy),
    relationshipEffects: Array.isArray(card.relationshipEffects) ? card.relationshipEffects : [],
    result: card.result ?? '',
    visibility: card.visibility ?? 'public',
    tags: asStringArray(card.tags),
    notes: '',
    createdAt: card.createdAt ?? timestamp,
    updatedAt: timestamp
  });
}

function normalizeTimelineEvent(event: TimelineEvent): TimelineEvent {
  const timestamp = event.updatedAt || nowIso();
  const start = normalizeTimelinePoint(event.start, 0);
  const end = event.end ? normalizeTimelinePoint(event.end, start.sortValue) : undefined;
  return {
    ...event,
    schemaVersion: 1,
    kind: 'timeline-event',
    title: event.title || '未命名事件',
    summary: event.summary ?? '',
    type: event.type || 'plot',
    laneType: event.laneType || defaultTimelineLaneType(event),
    importance: event.importance || 'normal',
    status: event.status || (event.locked ? 'locked' : 'planned'),
    locked: Boolean(event.locked || event.status === 'locked'),
    color: event.color ?? '',
    notes: event.notes ?? '',
    start,
    ...(end ? { end } : {}),
    location: event.location ?? '',
    participants: asStringArray(event.participants),
    participantIds: asStringArray(event.participantIds),
    causes: asStringArray(event.causes),
    consequences: asStringArray(event.consequences),
    knownBy: asStringArray(event.knownBy),
    unknownBy: asStringArray(event.unknownBy),
    relationshipEffects: Array.isArray(event.relationshipEffects) ? event.relationshipEffects : [],
    result: event.result ?? '',
    visibility: event.visibility || 'public',
    tags: asStringArray(event.tags),
    createdAt: event.createdAt || timestamp,
    updatedAt: timestamp
  };
}

function normalizeTimelinePoint(point: TimelinePoint | undefined, fallbackSortValue: number): TimelinePoint {
  return {
    label: point?.label ?? '',
    sortValue: Number.isFinite(point?.sortValue) ? Number(point?.sortValue) : fallbackSortValue,
    era: point?.era ?? '',
    year: point?.year ?? '',
    month: point?.month ?? '',
    day: point?.day ?? '',
    timeOfDay: point?.timeOfDay ?? ''
  };
}

function defaultTimelineLaneType(event: TimelineEvent): TimelineLane['type'] {
  if (event.type === 'world') {
    return 'world';
  }
  if (event.type === 'character' || asStringArray(event.participantIds).length > 0) {
    return 'character';
  }
  if (event.type === 'location' || event.locationId) {
    return 'location';
  }
  if (event.chapterId) {
    return 'chapter';
  }
  return 'plot';
}

function nextTimelineSortValue(events: TimelineEvent[]): number {
  const values = events.map((event) => Math.max(event.start.sortValue, event.end?.sortValue ?? event.start.sortValue)).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) + 10 : 10;
}

function buildTimelineLanes(events: TimelineEvent[], entries: CodexEntry[], chapterRefs: ChapterRef[]): TimelineLane[] {
  const lanes: TimelineLane[] = [
    { id: 'world', type: 'world', title: '世界线' },
    { id: 'plot', type: 'plot', title: '剧情线' }
  ];
  const characterIds = new Set(events.flatMap((event) => asStringArray(event.participantIds)));
  for (const id of characterIds) {
    lanes.push({ id: `character:${id}`, type: 'character', refId: id, title: resolveCodexName(id, 'character', entries) ?? `缺失人物 ${id}` });
  }
  const locationIds = new Set(events.map((event) => event.locationId).filter((id): id is string => !!id));
  for (const id of locationIds) {
    lanes.push({ id: `location:${id}`, type: 'location', refId: id, title: resolveCodexName(id, 'location', entries) ?? `缺失地点 ${id}` });
  }
  const chapterIds = new Set(events.map((event) => event.chapterId).filter((id): id is string => !!id));
  for (const id of chapterIds) {
    const ref = chapterRefs.find((candidate) => candidate.chapter.id === id);
    lanes.push({ id: `chapter:${id}`, type: 'chapter', refId: id, title: ref ? chapterRefTitle(ref) : `缺失章节 ${id}` });
  }
  return lanes;
}

function analyzeTimelineConflicts(events: TimelineEvent[], entries: CodexEntry[], chapterRefs: ChapterRef[]): TimelineConflict[] {
  const conflicts: TimelineConflict[] = [];
  const chapterIds = new Set(chapterRefs.map((ref) => ref.chapter.id));
  const sceneIds = new Set(entries.filter((entry) => entry.card.kind === 'scene').map((entry) => entry.card.id));
  const beatIds = new Set(entries.filter((entry) => entry.card.kind === 'beat').map((entry) => entry.card.id));
  const locationIds = new Set(entries.filter((entry) => entry.card.kind === 'location').map((entry) => entry.card.id));
  const characterIds = new Set(entries.filter((entry) => entry.card.kind === 'character').map((entry) => entry.card.id));

  for (const event of events) {
    if (event.end && event.start.sortValue > event.end.sortValue) {
      conflicts.push(timelineConflict('bad-range', [event.id], 'warning', '时间线事件开始晚于结束', `时间线事件「${event.title}」的开始排序值大于结束排序值。`));
    }
    for (const [id, exists, label] of [
      [event.chapterId, event.chapterId ? chapterIds.has(event.chapterId) : true, '章节'],
      [event.sceneId, event.sceneId ? sceneIds.has(event.sceneId) : true, '场景'],
      [event.beatId, event.beatId ? beatIds.has(event.beatId) : true, 'Beat'],
      [event.locationId, event.locationId ? locationIds.has(event.locationId) : true, '地点']
    ] as const) {
      if (id && !exists) {
        const titleLabel = label === 'Beat' ? ' Beat ' : label;
        conflicts.push(timelineConflict('missing-reference', [event.id], 'warning', `时间线事件关联${titleLabel}不存在`, `时间线事件「${event.title}」指向不存在的${label} ${id}。`));
      }
    }
    for (const participantId of asStringArray(event.participantIds)) {
      if (participantId && !characterIds.has(participantId)) {
        conflicts.push(timelineConflict('missing-reference', [event.id], 'warning', '时间线事件关联人物不存在', `时间线事件「${event.title}」指向不存在的人物 ${participantId}。`));
      }
    }
    if ((event.type === 'character' || event.laneType === 'character') && asStringArray(event.participantIds).length === 0) {
      conflicts.push(timelineConflict('weak-binding', [event.id], 'info', '人物事件未绑定人物', `时间线事件「${event.title}」是人物事件，但没有绑定资料库人物。`));
    }
    if ((event.type === 'location' || event.laneType === 'location') && !event.locationId) {
      conflicts.push(timelineConflict('weak-binding', [event.id], 'info', '地点事件未绑定地点', `时间线事件「${event.title}」是地点事件，但没有绑定资料库地点。`));
    }
  }

  const byParticipantAndTime = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const time = event.start.label.trim() || String(event.start.sortValue);
    const participants = asStringArray(event.participantIds).length > 0 ? asStringArray(event.participantIds) : asStringArray(event.participants);
    for (const participant of participants) {
      const key = `${participant}|${time}`;
      byParticipantAndTime.set(key, [...(byParticipantAndTime.get(key) ?? []), event]);
    }
  }
  for (const [key, grouped] of byParticipantAndTime) {
    const locations = [...new Set(grouped.map((event) => event.locationId || event.location).filter(Boolean))];
    if (locations.length > 1) {
      const [participant, time] = key.split('|');
      const participantName = resolveCodexName(participant, 'character', entries) ?? participant;
      const locationNames = locations.map((location) => resolveCodexName(location, 'location', entries) ?? location);
      conflicts.push(timelineConflict('multi-location', grouped.map((event) => event.id), 'warning', '同一人物同一时间多地点', `${participantName} 在 ${time} 同时出现在：${locationNames.join('、')}`));
    }
  }
  return conflicts;
}

function timelineConflict(kind: TimelineConflict['kind'], eventIds: string[], severity: TimelineConflict['severity'], title: string, detail: string): TimelineConflict {
  return {
    id: `${kind}:${eventIds.join('|')}:${normalizeHealthToken(title).slice(0, 24)}`,
    eventIds,
    severity,
    kind,
    title,
    detail
  };
}

function timelineSuggestionForConflict(conflict: TimelineConflict): string {
  if (conflict.kind === 'bad-range') {
    return '拖动事件边缘或修改右侧属性栏，让结束时间不早于开始时间。';
  }
  if (conflict.kind === 'missing-reference') {
    return '重新绑定有效来源，或清空已经失效的 ID。';
  }
  if (conflict.kind === 'multi-location') {
    return '调整事件时间/地点，或在说明中补充分身、误认、回忆等原因。';
  }
  return '补充资料库强绑定，减少重名和失效引用。';
}

function resolveTimelineLocation(event: TimelineEvent, entries: CodexEntry[]): string | undefined {
  return event.locationId ? resolveCodexName(event.locationId, 'location', entries) ?? event.location : event.location || undefined;
}

function resolveTimelineParticipants(event: TimelineEvent, entries: CodexEntry[]): string[] {
  const ids = asStringArray(event.participantIds);
  if (ids.length > 0) {
    return ids.map((id) => resolveCodexName(id, 'character', entries) ?? id);
  }
  return asStringArray(event.participants);
}

function resolveCodexName(id: string | undefined, kind: CodexCard['kind'], entries: CodexEntry[]): string | undefined {
  if (!id) {
    return undefined;
  }
  return entries.find((entry) => entry.card.kind === kind && entry.card.id === id)?.card.name;
}

function chapterRefTitle(ref: ChapterRef): string {
  return `${ref.volume.title} / ${ref.chapter.title}`;
}

function sourceReferenceExists(
  kind: CodexSourceKind,
  value: string,
  context: {
    cardExists: (value: string, kind?: CodexCard['kind']) => boolean;
    chapterIds: Set<string>;
    chapterNames: Set<string>;
    summaryIds: Set<string>;
    summaryNames: Set<string>;
  }
): boolean {
  const raw = value.trim();
  const normalized = normalizeHealthToken(raw);
  if (!raw) {
    return true;
  }
  if (kind === 'chapter') {
    return context.chapterIds.has(raw) || context.chapterNames.has(normalized);
  }
  if (kind === 'chapter-summary') {
    return context.summaryIds.has(raw) || context.summaryNames.has(normalized);
  }
  const cardKind = SOURCE_KIND_TO_CARD_KIND[kind];
  if (cardKind) {
    return context.cardExists(raw, cardKind);
  }
  return true;
}

function sourceKindLabel(kind: CodexSourceKind): string {
  const labels: Record<CodexSourceKind, string> = {
    character: '人物卡',
    location: '地点卡',
    'world-rule': '世界规则',
    foreshadowing: '伏笔',
    'timeline-event': '时间线事件',
    scene: '场景',
    beat: 'Beat',
    project: '项目',
    'style-guide': '文风指南',
    chapter: '章节',
    'chapter-summary': '章节摘要',
    conversation: '对话记录',
    manual: '手动来源'
  };
  return labels[kind];
}

function allowedCodexKeys(kind: CodexCard['kind'] | unknown): Set<string> {
  const base = [
    'schemaVersion',
    'id',
    'kind',
    'name',
    'aliases',
    'tags',
    'allowInContext',
    'alwaysIncludeInContext',
    'doNotTrack',
    'nestedRefs',
    'memoryStatus',
    'summary',
    'sourceRefs',
    'ignoredReferenceTerms',
    'inferences',
    'progressions',
    'createdAt',
    'updatedAt'
  ];
  const byKind: Record<CodexCard['kind'], string[]> = {
    character: ['identity', 'fixedSetting', 'personality', 'speechStyle', 'goals', 'abilities', 'weaknesses', 'relationships', 'knows', 'doesNotKnow', 'relationshipNotes', 'currentState', 'firstAppearanceChapterId', 'secrets', 'hiddenSecrets', 'forbiddenActions'],
    location: ['type', 'region', 'visualFeatures', 'atmosphere', 'history', 'rules', 'relatedCharacters', 'currentState', 'secrets', 'hiddenSecrets', 'relatedEvents'],
    'world-rule': ['importance', 'category', 'content', 'rules', 'scope', 'relatedCharacters', 'relatedLocations', 'relatedFactions', 'knownExceptions', 'hidden'],
    foreshadowing: ['status', 'description', 'firstSeedChapterId', 'expectedResolveChapterId', 'relatedCharacters', 'importance', 'allowRevealInContext', 'publicHint', 'hiddenTruth'],
    scene: ['chapterId', 'outlineId', 'outlineNodeId', 'outlineVolumeTitle', 'outlineChapterTitle', 'viewpointCharacter', 'location', 'conflict', 'turn', 'outcome', 'order'],
    beat: ['chapterId', 'sceneId', 'outlineId', 'outlineNodeId', 'outlineVolumeTitle', 'outlineChapterTitle', 'content', 'purpose', 'order', 'status']
  };
  if (typeof kind === 'string' && kind in byKind) {
    return new Set([...base, ...byKind[kind as CodexCard['kind']]]);
  }
  return new Set(base);
}

function summarizeProjectHealthIssues(issues: ProjectHealthIssue[]): Record<ProjectHealthSeverity, number> {
  return {
    error: issues.filter((issue) => issue.severity === 'error').length,
    warning: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length
  };
}

function projectHealthFingerprint(issue: ProjectHealthIssue): string {
  return crypto
    .createHash('sha1')
    .update([issue.severity, issue.category, issue.title, issue.source || '', issue.detail].join('\u001f'))
    .digest('hex');
}

function isSafelyFixableProjectHealthIssue(issue: { title: string }): boolean {
  return ['章节摘要引用缺失', '场景顺序重复', 'Beat顺序重复'].includes(issue.title);
}

function healthSeverityRank(severity: ProjectHealthSeverity): number {
  const ranks: Record<ProjectHealthSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2
  };
  return ranks[severity];
}

function isTrackableReferenceName(name: string, card: CodexCard): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const normalized = normalizeHealthToken(trimmed);
  if (REFERENCE_STOP_WORDS.has(normalized)) {
    return false;
  }
  const ignoredTerms = asStringArray((card as CodexCard & { ignoredReferenceTerms?: unknown }).ignoredReferenceTerms)
    .map(normalizeHealthToken);
  return !ignoredTerms.includes(normalized);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asSourceRefs(value: unknown): Array<{ kind: CodexSourceKind; id?: string; name?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { kind: CodexSourceKind; id?: string; name?: string } => (
      !!item &&
      typeof item === 'object' &&
      'kind' in item &&
      typeof (item as { kind?: unknown }).kind === 'string'
    ))
    .filter((item) => isCodexSourceKind(item.kind));
}

function isCodexSourceKind(value: string): value is CodexSourceKind {
  return [
    'character',
    'location',
    'world-rule',
    'foreshadowing',
    'scene',
    'beat',
    'project',
    'style-guide',
    'chapter',
    'chapter-summary',
    'conversation',
    'manual'
  ].includes(value);
}

function normalizeHealthToken(value: string): string {
  return value.trim().toLocaleLowerCase('zh-Hans-CN');
}

function formatSuggestionList(values: string[]): string[] {
  if (values.length === 0) {
    return ['- 无'];
  }
  return values.map((value) => `- ${value}`);
}

function defaultExportStyle(): ExportStyle {
  return {
    schemaVersion: 1,
    titlePage: true,
    includeAuthor: true,
    includeVolumeTitles: true,
    fontFamily: 'Noto Sans CJK SC',
    fontSize: 12,
    lineHeight: 1.7,
    paragraphSpacing: 8
  };
}

function defaultExportStyleJsonc(): string {
  return `{
  // LoreDock 导出样式。适用于 DOCX / EPUB / PDF，Markdown 和 TXT 会使用 includeAuthor / includeVolumeTitles。
  "schemaVersion": 1,
  "titlePage": true,
  "includeAuthor": true,
  "includeVolumeTitles": true,
  "fontFamily": "Noto Sans CJK SC",
  "fontSize": 12,
  "lineHeight": 1.7,
  "paragraphSpacing": 8
}
`;
}

function stripJsonComments(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripLeadingHeading(input: string, title: string): string {
  const lines = input.split(/\r?\n/);
  if (lines[0]?.trim().replace(/^#+\s*/, '') === title) {
    return lines.slice(1).join('\n').trimStart();
  }
  return input;
}

function markdownToPlainText(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').trimEnd())
    .join('\n');
}

function parseOutlineNodes(outline: string): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let order = 1;
  let currentVolumeId: string | undefined;
  let currentChapterId: string | undefined;
  let currentSceneId: string | undefined;
  for (const [index, rawLine] of outline.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const sceneLine = line.match(/^场景[:：]\s*(.+)$/);
    let type: OutlineNode['type'] = 'note';
    let title = line;
    let parentId: string | undefined = currentSceneId || currentChapterId || currentVolumeId;
    if (heading?.[1] === '#') {
      type = 'volume';
      title = heading[2].trim();
      parentId = undefined;
    } else if (heading?.[1] === '##') {
      type = 'chapter';
      title = heading[2].trim();
      parentId = currentVolumeId;
    } else if (heading?.[1] === '###' || heading?.[1] === '####' || sceneLine) {
      type = 'scene';
      title = heading?.[2]?.trim() || sceneLine?.[1]?.trim() || line;
      parentId = currentChapterId || currentVolumeId;
    } else if (bullet) {
      type = 'beat';
      title = bullet[1].trim();
      parentId = currentSceneId || currentChapterId || currentVolumeId;
    }
    const node: OutlineNode = {
      id: `outline-node-${String(order).padStart(3, '0')}`,
      type,
      title,
      content: type === 'beat' || type === 'note' ? title : '',
      order,
      parentId,
      sourceLine: index + 1
    };
    nodes.push(node);
    order += 1;
    if (type === 'volume') {
      currentVolumeId = node.id;
      currentChapterId = undefined;
      currentSceneId = undefined;
    } else if (type === 'chapter') {
      currentChapterId = node.id;
      currentSceneId = undefined;
    } else if (type === 'scene') {
      currentSceneId = node.id;
    }
  }
  return nodes;
}

function renderOutlineRawText(nodes: OutlineNode[]): string {
  return [...nodes]
    .sort((left, right) => left.order - right.order)
    .map((node) => {
      if (node.type === 'volume') {
        return `# ${node.title}`;
      }
      if (node.type === 'chapter') {
        return `## ${node.title}`;
      }
      if (node.type === 'scene') {
        return node.content && node.content !== node.title
          ? `### ${node.title}\n${node.content}`
          : `### ${node.title}`;
      }
      if (node.type === 'beat') {
        return node.content && node.content !== node.title
          ? `- ${node.title}\n  ${node.content}`
          : `- ${node.title}`;
      }
      return node.content && node.content !== node.title
        ? `${node.title}\n${node.content}`
        : node.title;
    })
    .join('\n');
}

function projectBlueprintNodesToOutlineNodes(blueprint: BlueprintDocument): OutlineNode[] {
  const orderedNodes = [...blueprint.nodes]
    .sort((left, right) => left.y - right.y || left.x - right.x || left.title.localeCompare(right.title, 'zh-Hans-CN'));
  const idByBlueprintNodeId = new Map<string, string>();
  for (const node of orderedNodes) {
    idByBlueprintNodeId.set(node.id, outlineNodeIdForBlueprintNode(blueprint, node));
  }
  const flowParentByNodeId = new Map<string, string>();
  for (const edge of blueprint.edges) {
    if (edge.type !== 'flow') {
      continue;
    }
    const fromOutlineId = idByBlueprintNodeId.get(edge.fromNodeId);
    if (fromOutlineId && idByBlueprintNodeId.has(edge.toNodeId) && !flowParentByNodeId.has(edge.toNodeId)) {
      flowParentByNodeId.set(edge.toNodeId, fromOutlineId);
    }
  }
  return orderedNodes.map((node, index) => ({
    id: idByBlueprintNodeId.get(node.id) || node.id,
    type: outlineTypeForBlueprintNode(node),
    title: node.title,
    content: node.note || '',
    order: index + 1,
    parentId: flowParentByNodeId.get(node.id),
    sourceLine: index + 1
  }));
}

function outlineNodeIdForBlueprintNode(blueprint: BlueprintDocument, node: BlueprintNode): string {
  if (node.refKind === 'outline-node' && node.refId) {
    const parsed = parseOutlineNodeRef(node.refId);
    if (parsed && parsed.outlineId === blueprint.outlineId) {
      return parsed.nodeId;
    }
  }
  return node.id;
}

function outlineTypeForBlueprintNode(node: BlueprintNode): OutlineNode['type'] {
  if (node.kind === 'scene' || node.refKind === 'scene') {
    return 'scene';
  }
  if (node.kind === 'beat' || node.refKind === 'beat') {
    return 'beat';
  }
  return 'note';
}

function outlineNodesEqual(left: OutlineNode[], right: OutlineNode[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((node, index) => {
    const other = right[index];
    return node.id === other.id &&
      node.type === other.type &&
      node.title === other.title &&
      node.content === other.content &&
      node.order === other.order &&
      node.parentId === other.parentId &&
      node.sourceLine === other.sourceLine;
  });
}

function compareBlueprintNodesForLayout(left: BlueprintNode, right: BlueprintNode): number {
  return left.y - right.y || left.x - right.x || left.title.localeCompare(right.title, 'zh-Hans-CN') || left.id.localeCompare(right.id);
}

function createBlueprintSyncSnapshot(title: string, note: string, sourceUpdatedAt?: string): BlueprintSyncSnapshot {
  return {
    title,
    note,
    syncedAt: nowIso(),
    sourceUpdatedAt
  };
}

function isSyncableBlueprintNode(node: BlueprintNode): node is BlueprintNode & { refKind: BlueprintRefKind } {
  return !!node.refKind && (node.refKind === 'outline' || node.refKind === 'outline-node' || isCodexBlueprintRefKind(node.refKind));
}

function parseOutlineNodeRef(refId: string): { outlineId: string; nodeId: string } | undefined {
  const [outlineId, ...nodeParts] = refId.split(':');
  const nodeId = nodeParts.join(':');
  if (!outlineId || !nodeId) {
    return undefined;
  }
  return { outlineId, nodeId };
}

function getBlueprintSyncStatus(node: BlueprintNode, source: BlueprintSyncSource): BlueprintSyncStatus {
  const nodeTitle = node.title;
  const nodeNote = node.note || '';
  if (!node.lastSynced) {
    return nodeTitle === source.title && nodeNote === source.note ? 'unchanged' : 'conflict';
  }
  const sourceChanged = source.title !== node.lastSynced.title || source.note !== node.lastSynced.note;
  const nodeChanged = nodeTitle !== node.lastSynced.title || nodeNote !== node.lastSynced.note;
  if (nodeTitle === source.title && nodeNote === source.note) {
    return 'unchanged';
  }
  if (sourceChanged && nodeChanged) {
    return 'conflict';
  }
  if (sourceChanged) {
    return 'pull';
  }
  if (nodeChanged) {
    return 'push';
  }
  return 'unchanged';
}

function blueprintSyncDetail(status: BlueprintSyncStatus): string {
  const details: Record<BlueprintSyncStatus, string> = {
    pull: '来源文件已更新，蓝图节点尚未同步。',
    push: '蓝图节点已更新，来源文件尚未同步。',
    conflict: '蓝图和来源文件都可能有改动，需要手动选择。',
    missing: '来源文件不存在或无法读取。',
    unchanged: '蓝图和来源文件一致。'
  };
  return details[status];
}

function blueprintSyncFieldDiffs(node: BlueprintNode, source: BlueprintSyncSource): BlueprintSyncFieldDiff[] {
  const nodeNote = node.note || '';
  return [
    {
      field: 'title',
      label: '标题 / name',
      nodeValue: node.title,
      sourceValue: source.title,
      changed: node.title !== source.title
    },
    {
      field: 'note',
      label: '备注 / summary',
      nodeValue: nodeNote,
      sourceValue: source.note,
      changed: nodeNote !== source.note
    }
  ];
}

function summarizeBlueprintSyncItems(items: BlueprintSyncItem[]): Record<BlueprintSyncStatus, number> {
  return items.reduce<Record<BlueprintSyncStatus, number>>(
    (summary, item) => {
      summary[item.status] += 1;
      return summary;
    },
    { pull: 0, push: 0, conflict: 0, missing: 0, unchanged: 0 }
  );
}

function normalizeBlueprintNode(node: BlueprintNode): BlueprintNode {
  return {
    ...node,
    id: node.id || makeId('bp-node'),
    kind: node.kind || 'note',
    title: node.title?.trim() || '未命名节点',
    x: Number.isFinite(node.x) ? node.x : 80,
    y: Number.isFinite(node.y) ? node.y : 80,
    width: Number.isFinite(node.width) && node.width > 80 ? node.width : 220,
    height: Number.isFinite(node.height) && node.height > 60 ? node.height : 104
  };
}

function normalizeBlueprintEdge(edge: BlueprintDocument['edges'][number]): BlueprintDocument['edges'][number] {
  return {
    ...edge,
    id: edge.id || makeId('bp-edge'),
    type: isBlueprintEdgeType(edge.type) ? edge.type : 'custom'
  };
}

function isBlueprintEdgeType(value: string): value is BlueprintDocument['edges'][number]['type'] {
  return ['flow', 'uses', 'foreshadows', 'resolves', 'conflicts', 'supports', 'blocks', 'custom'].includes(value);
}

function blueprintColorForOutlineNode(type: OutlineNode['type']): string {
  const colors: Record<OutlineNode['type'], string> = {
    volume: '#6a9955',
    chapter: '#4e9aef',
    scene: '#c586c0',
    beat: '#dcdcaa',
    note: '#808080'
  };
  return colors[type];
}

function blueprintColorForCard(kind: CodexCard['kind']): string {
  const colors: Record<CodexCard['kind'], string> = {
    character: '#4fc1ff',
    location: '#6a9955',
    'world-rule': '#dcdcaa',
    foreshadowing: '#c586c0',
    scene: '#b5cea8',
    beat: '#9cdcfe'
  };
  return colors[kind];
}

function kindLabelForBlueprint(kind: BlueprintRefKind): string {
  const labels: Record<BlueprintRefKind, string> = {
    character: '人物',
    location: '地点',
    'world-rule': '世界规则',
    foreshadowing: '伏笔',
    'timeline-event': '时间线',
    scene: '场景',
    beat: 'Beat',
    outline: '大纲',
    'outline-node': '大纲节点'
  };
  return labels[kind];
}

function shortTitle(value: string, fallback: string): string {
  const clean = value.replace(/[#*\[\]`"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(clean || fallback).slice(0, 24).join('');
}

function extensionForExport(format: ExportFormat): string {
  if (format === 'markdown') {
    return 'md';
  }
  return format;
}

function renderMarkdownExport(book: ManuscriptExport, style = defaultExportStyle()): string {
  const lines: string[] = [`# ${book.title}`, ''];
  if (style.includeAuthor && book.author) {
    lines.push(`作者：${book.author}`, '');
  }
  for (const volume of book.volumes) {
    if (style.includeVolumeTitles) {
      lines.push(`# ${volume.title}`, '');
    }
    for (const chapter of volume.chapters) {
      lines.push(`## ${chapter.title}`, '', chapter.body, '');
    }
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
}

function renderTextExport(book: ManuscriptExport, style = defaultExportStyle()): string {
  const lines: string[] = [book.title];
  if (style.includeAuthor && book.author) {
    lines.push(`作者：${book.author}`);
  }
  lines.push('');
  for (const volume of book.volumes) {
    if (style.includeVolumeTitles) {
      lines.push(volume.title, '');
    }
    for (const chapter of volume.chapters) {
      lines.push(chapter.title, '', markdownToPlainText(chapter.body), '');
    }
  }
  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
}

function splitImportedChapters(input: string): ExportChapter[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) {
    return [{ title: '导入章节', body: '' }];
  }

  const markdownPattern = /^##\s+/m.test(normalized) ? /^(##)\s+(.+?)\s*$/ : /^(#)\s+(.+?)\s*$/;
  const markdown = splitByHeading(normalized, markdownPattern);
  if (markdown.length > 1) {
    return markdown;
  }

  const text = splitByHeading(normalized, /^\s*((?:第[\d零〇一二三四五六七八九十百千万两]+[章节回卷部].*)|(?:Chapter\s+\d+.*))\s*$/i);
  if (text.length > 1) {
    return text;
  }

  return markdown.length === 1 ? markdown : [{ title: '导入章节', body: normalized }];
}

function splitByHeading(input: string, pattern: RegExp): ExportChapter[] {
  const chapters: ExportChapter[] = [];
  let currentTitle = '';
  let currentBody: string[] = [];
  for (const line of input.split('\n')) {
    const match = line.match(pattern);
    if (match) {
      if (currentTitle || currentBody.join('\n').trim()) {
        chapters.push({
          title: currentTitle || `导入章节 ${chapters.length + 1}`,
          body: currentBody.join('\n').trim()
        });
      }
      currentTitle = (match[2] || match[1] || '').replace(/^#+\s*/, '').trim() || `导入章节 ${chapters.length + 1}`;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentTitle || currentBody.join('\n').trim()) {
    chapters.push({
      title: currentTitle || `导入章节 ${chapters.length + 1}`,
      body: currentBody.join('\n').trim()
    });
  }
  return chapters;
}

function renderDocxExport(book: ManuscriptExport, style = defaultExportStyle()): Buffer {
  const paragraphs: string[] = [
    paragraphXml(book.title, 'Title'),
    ...(style.includeAuthor && book.author ? [paragraphXml(`作者：${book.author}`, 'Subtitle')] : [])
  ];
  for (const volume of book.volumes) {
    if (style.includeVolumeTitles) {
      paragraphs.push(paragraphXml(volume.title, 'Heading1'));
    }
    for (const chapter of volume.chapters) {
      paragraphs.push(paragraphXml(chapter.title, 'Heading2'));
      for (const line of markdownToPlainText(chapter.body).split(/\n{2,}/)) {
        paragraphs.push(paragraphXml(line.trim(), 'Normal'));
      }
    }
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="${escapeXml(style.fontFamily)}" w:hAnsi="${escapeXml(style.fontFamily)}" w:eastAsia="${escapeXml(style.fontFamily)}"/><w:sz w:val="${style.fontSize * 2}"/></w:rPr><w:pPr><w:spacing w:line="${Math.round(style.fontSize * style.lineHeight * 20)}" w:lineRule="auto" w:after="${style.paragraphSpacing * 20}"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>` }
  ]);
}

function paragraphXml(text: string, style: string): string {
  const runs = text
    .split(/\n+/)
    .map((line) => `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`)
    .join('<w:r><w:br/></w:r>');
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`;
}

function renderEpubExport(book: ManuscriptExport, style = defaultExportStyle()): Buffer {
  const body = [
    `<h1>${escapeXml(book.title)}</h1>`,
    style.includeAuthor && book.author ? `<p>作者：${escapeXml(book.author)}</p>` : ''
  ];
  for (const volume of book.volumes) {
    if (style.includeVolumeTitles) {
      body.push(`<h1>${escapeXml(volume.title)}</h1>`);
    }
    for (const chapter of volume.chapters) {
      body.push(`<h2>${escapeXml(chapter.title)}</h2>`);
      for (const paragraph of markdownToPlainText(chapter.body).split(/\n{2,}/)) {
        body.push(`<p>${escapeXml(paragraph.trim()).replace(/\n/g, '<br/>')}</p>`);
      }
    }
  }
  const chapterXhtml = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${escapeXml(book.title)}</title><style>body{font-family:${escapeXml(style.fontFamily)};font-size:${style.fontSize}px;line-height:${style.lineHeight};}p{margin:0 0 ${style.paragraphSpacing}px;}</style></head><body>${body.join('\n')}</body></html>`;
  return zipFiles([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: 'OEBPS/content.opf', data: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:loredock:${escapeXml(slugify(book.title) || 'novel')}</dc:identifier><dc:title>${escapeXml(book.title)}</dc:title><dc:language>zh-CN</dc:language>${book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapters" href="chapters.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapters"/></spine></package>` },
    { name: 'OEBPS/nav.xhtml', data: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>目录</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>目录</h1><ol><li><a href="chapters.xhtml">${escapeXml(book.title)}</a></li></ol></nav></body></html>` },
    { name: 'OEBPS/chapters.xhtml', data: chapterXhtml }
  ]);
}

function renderPdfExport(book: ManuscriptExport, style = defaultExportStyle()): Buffer {
  const lines = renderTextExport(book, style)
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, 32));
  const pages: string[] = [];
  for (let index = 0; index < lines.length; index += 32) {
    pages.push(lines.slice(index, index + 32).join('\n'));
  }
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>'
  ];
  pages.forEach((page, index) => {
    const contentObject = 6 + index * 2;
    const stream = renderPdfTextStream(page, style);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  return buildPdf(objects);
}

function wrapLine(line: string, width: number): string[] {
  if (!line) {
    return [''];
  }
  const wrapped: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    wrapped.push(line.slice(index, index + width));
  }
  return wrapped;
}

function renderPdfTextStream(page: string, style = defaultExportStyle()): string {
  const fontSize = Math.max(8, Math.min(24, style.fontSize));
  const lineHeight = Math.round(fontSize * style.lineHeight);
  const commands = ['BT', `/F1 ${fontSize} Tf`, '72 780 Td', `${lineHeight} TL`];
  for (const line of page.split('\n')) {
    commands.push(`<${utf16Hex(line)}> Tj`, 'T*');
  }
  commands.push('ET');
  return commands.join('\n');
}

function utf16Hex(value: string): string {
  return Buffer.from(`\uFEFF${value}`, 'utf16le').swap16().toString('hex').toUpperCase();
}

function buildPdf(objects: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'utf8'));
  });
  const xrefOffset = Buffer.concat(chunks).length;
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (let index = 1; index < offsets.length; index += 1) {
    xref.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
  }
  chunks.push(Buffer.from(`${xref.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function zipFiles(files: Array<{ name: string; data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unzipFiles(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  const files: Array<{ name: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      break;
    }
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : Buffer.alloc(0);
    if (data.length > 0 || method === 0) {
      files.push({ name, data });
    }
    offset = dataEnd;
  }
  return files;
}

function extractDocxText(buffer: Buffer): string {
  const document = unzipFiles(buffer).find((file) => file.name === 'word/document.xml');
  if (!document) {
    throw new Error('DOCX 中没有找到 word/document.xml。');
  }
  const xml = document.data.toString('utf8');
  const paragraphs = [...xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)].map((match) => match[0]);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const style = paragraph.match(/<w:pStyle[^>]+w:val="([^"]+)"/)?.[1] ?? '';
    const text = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => unescapeXml(match[1]))
      .join('');
    if (!text.trim()) {
      continue;
    }
    if (/heading1|title/i.test(style)) {
      lines.push(`# ${text.trim()}`);
    } else if (/heading2/i.test(style)) {
      lines.push(`## ${text.trim()}`);
    } else {
      lines.push(text.trim());
    }
  }
  return `${lines.join('\n\n').trim()}\n`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function findAllOccurrences(text: string, needle: string): number[] {
  const indexes: number[] = [];
  if (!needle.trim()) {
    return indexes;
  }
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 42);
  const end = Math.min(text.length, index + length + 42);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function isNegatedRuleMentioned(chapterText: string, ruleContent: string): boolean {
  const ruleKeywords = ruleContent
    .split(/[，。；、\s,.!?;:]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 6);
  if (ruleKeywords.length === 0) {
    return false;
  }
  const hasRuleSignal = ruleKeywords.some((keyword) => chapterText.includes(keyword));
  const hasNegation = /突破|违背|无视|不受限制|毫无代价|直接复活|凭空|瞬间跨越/.test(chapterText);
  return hasRuleSignal && hasNegation;
}
