import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AI_CONFIG_FILE,
  AI_ENV_FILE,
  BEATS_DIR,
  CHARACTERS_DIR,
  CODEX_DIR,
  EXPORTS_DIR,
  EXPORT_STYLE_FILE,
  FORESHADOWING_DIR,
  HISTORY_DIR,
  LORE_DIR,
  LOREDOCK_LOCAL_GITIGNORE,
  LOCATIONS_DIR,
  MANUSCRIPT_DIR,
  PENDING_UPDATES_DIR,
  PROJECT_FILE,
  SCENES_DIR,
  STYLE_GUIDE_FILE,
  SUMMARY_DIR,
  TIMELINE_DIR,
  WORLD_RULES_DIR,
  WRITING_GOALS_FILE
} from './constants';
import { countWords } from './wordCount';
import {
  AIJobRecord,
  AIConfigFile,
  ChapterMeta,
  ChapterRef,
  ChapterStatus,
  ChapterSummary,
  CharacterCard,
  CodexCard,
  CodexEntry,
  ConsistencyIssue,
  CreateCodexInput,
  BeatPlan,
  ExportStyle,
  ForeshadowingCard,
  LocationCard,
  ProjectInitOptions,
  ProjectManifest,
  ScenePlan,
  TimelineEvent,
  VolumeMeta,
  WorldRule,
  WritingGoals,
  WritingStats
} from '../types';
import { makeId, nextNumberedId, nowIso, posixPath, slugify } from './utils';

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

export class LoreDockStorage {
  public constructor(public readonly workspaceRoot: string) {}

  public resolve(relativePath: string): string {
    return path.join(this.workspaceRoot, relativePath);
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
    await this.ensureLocalIgnore();

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

  public async ensureAIConfigFile(): Promise<string> {
    await this.requireManifest();
    await this.ensureLocalIgnore();
    if (!(await this.exists(AI_CONFIG_FILE))) {
      await fs.writeFile(this.resolve(AI_CONFIG_FILE), defaultAIConfigJsonc(), 'utf8');
    }
    await this.ensureAIEnvFile();
    return AI_CONFIG_FILE;
  }

  public async ensureAIEnvFile(): Promise<string> {
    await this.requireManifest();
    await this.ensureLocalIgnore();
    if (!(await this.exists(AI_ENV_FILE))) {
      await fs.writeFile(this.resolve(AI_ENV_FILE), defaultAIEnv(), 'utf8');
    }
    return AI_ENV_FILE;
  }

  public async readAIEnv(): Promise<Record<string, string>> {
    await this.ensureAIEnvFile();
    const raw = await fs.readFile(this.resolve(AI_ENV_FILE), 'utf8');
    return parseEnvFile(raw);
  }

  public async readAIConfig(): Promise<AIConfigFile> {
    await this.ensureAIConfigFile();
    const raw = await fs.readFile(this.resolve(AI_CONFIG_FILE), 'utf8');
    return JSON.parse(stripJsonComments(raw)) as AIConfigFile;
  }

  public async writeAIConfig(config: AIConfigFile): Promise<void> {
    await this.ensureLocalIgnore();
    await fs.writeFile(this.resolve(AI_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  public async updateActiveAIModel(model: string): Promise<AIConfigFile> {
    const config = await this.readAIConfig();
    const provider = config.activeProvider;
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      throw new Error(`AI 配置中找不到 activeProvider：${provider}`);
    }
    providerConfig.model = model;
    await this.writeAIConfig(config);
    return config;
  }

  public async configureOpenRouterProfile(): Promise<AIConfigFile> {
    const config = await this.readAIConfig();
    const existingKey =
      config.providers.openrouter?.apiKey ||
      config.providers['openai-compatible']?.apiKey ||
      config.providers.custom?.apiKey ||
      config.providers.gpt?.apiKey ||
      '';
    config.activeProvider = 'openrouter';
    config.providers.openrouter = {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: config.providers.openrouter?.model ?? '',
      apiKey: existingKey,
      apiKeyEnv: config.providers.openrouter?.apiKeyEnv ?? 'OPENROUTER_API_KEY',
      temperature: config.providers.openrouter?.temperature ?? 0.7,
      maxOutputTokens: config.providers.openrouter?.maxOutputTokens ?? 1200,
      timeoutMs: config.providers.openrouter?.timeoutMs ?? 60000
    };
    await this.writeAIConfig(config);
    return config;
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
    const normalized = path.normalize(absolutePath);
    for (const volume of manifest.volumes) {
      for (const chapter of volume.chapters) {
        if (path.normalize(this.resolve(chapter.filePath)) === normalized) {
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
    return { ...defaultExportStyle(), ...(JSON.parse(stripJsonComments(raw)) as Partial<ExportStyle>), schemaVersion: 1 };
  }

  public async importManuscript(sourceName: string, content: string): Promise<ChapterMeta[]> {
    await this.requireManifest();
    const baseName = path.basename(sourceName).replace(/\.[^.]+$/, '') || '导入手稿';
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
      identity: input.detail ?? '',
      fixedSetting: '',
      personality: '',
      speechStyle: '',
      goals: '',
      abilities: '',
      weaknesses: '',
      relationships: [],
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
      importance: 'important',
      content: input.detail ?? '',
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
      status: 'planned',
      description: input.detail ?? '',
      firstSeedChapterId: input.chapterId,
      expectedResolveChapterId: '',
      relatedCharacters: [],
      importance: 'important',
      allowRevealToAI: false,
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
    const card: TimelineEvent = {
      schemaVersion: 1,
      id: makeId('timeline'),
      kind: 'timeline-event',
      name: input.name,
      aliases: [],
      tags: [],
      allowInContext: true,
      storyTime: '',
      chapterId: input.chapterId,
      location: '',
      participants: [],
      result: input.detail ?? '',
      visibility: 'public',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeCodexCard(TIMELINE_DIR, card);
    return card;
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
    const [characters, locations, worldRules, foreshadowing, timeline, scenes, beats] = await Promise.all([
      this.listEntriesInDirectory<CharacterCard>(CHARACTERS_DIR),
      this.listEntriesInDirectory<LocationCard>(LOCATIONS_DIR),
      this.listEntriesInDirectory<WorldRule>(WORLD_RULES_DIR),
      this.listEntriesInDirectory<ForeshadowingCard>(FORESHADOWING_DIR),
      this.listEntriesInDirectory<TimelineEvent>(TIMELINE_DIR),
      this.listEntriesInDirectory<ScenePlan>(SCENES_DIR),
      this.listEntriesInDirectory<BeatPlan>(BEATS_DIR)
    ]);
    return [...characters, ...locations, ...worldRules, ...foreshadowing, ...timeline, ...scenes, ...beats].map((entry) => entry.card);
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
    if (kind === 'timeline-event') {
      return (await this.listEntriesInDirectory<TimelineEvent>(TIMELINE_DIR)).map((entry) => entry.card);
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
    if (kind === 'timeline-event') {
      return this.listEntriesInDirectory<TimelineEvent>(TIMELINE_DIR);
    }
    if (kind === 'scene') {
      return this.listEntriesInDirectory<ScenePlan>(SCENES_DIR);
    }
    if (kind === 'beat') {
      return this.listEntriesInDirectory<BeatPlan>(BEATS_DIR);
    }
    const [characters, locations, worldRules, foreshadowing, timeline, scenes, beats] = await Promise.all([
      this.listEntriesInDirectory<CharacterCard>(CHARACTERS_DIR),
      this.listEntriesInDirectory<LocationCard>(LOCATIONS_DIR),
      this.listEntriesInDirectory<WorldRule>(WORLD_RULES_DIR),
      this.listEntriesInDirectory<ForeshadowingCard>(FORESHADOWING_DIR),
      this.listEntriesInDirectory<TimelineEvent>(TIMELINE_DIR),
      this.listEntriesInDirectory<ScenePlan>(SCENES_DIR),
      this.listEntriesInDirectory<BeatPlan>(BEATS_DIR)
    ]);
    return [...characters, ...locations, ...worldRules, ...foreshadowing, ...timeline, ...scenes, ...beats];
  }

  public async deleteCodexEntry(relativePath: string): Promise<void> {
    const normalized = relativePath.replace(/\\/g, '/');
    const allowed =
      normalized.startsWith(`${CHARACTERS_DIR}/`) ||
      normalized.startsWith(`${LOCATIONS_DIR}/`) ||
      normalized.startsWith(`${WORLD_RULES_DIR}/`) ||
      normalized.startsWith(`${FORESHADOWING_DIR}/`) ||
      normalized.startsWith(`${TIMELINE_DIR}/`) ||
      normalized.startsWith(`${SCENES_DIR}/`) ||
      normalized.startsWith(`${BEATS_DIR}/`);
    if (!allowed || !normalized.endsWith('.json')) {
      throw new Error('只能删除 LoreDock 资料库里的 JSON 卡片。');
    }
    await fs.rm(this.resolve(normalized), { force: true });
  }

  public async readCodexEntry(relativePath: string): Promise<CodexEntry> {
    const normalized = relativePath.replace(/\\/g, '/');
    const card = await this.readJson<CodexCard>(normalized);
    return { card, relativePath: normalized };
  }

  public async writeCodexEntry(relativePath: string, card: CodexCard): Promise<CodexEntry> {
    const normalized = relativePath.replace(/\\/g, '/');
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

  public async runDeterministicConsistencyCheck(chapterId: string): Promise<ConsistencyIssue[]> {
    const chapterText = await this.readChapterText(chapterId);
    const cards = await this.listCodexCards();
    const issues: ConsistencyIssue[] = [];

    for (const card of cards) {
      if (card.kind === 'foreshadowing' && card.hiddenTruth && !card.allowRevealToAI && chapterText.includes(card.hiddenTruth)) {
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

    const timeline = cards.filter((card): card is TimelineEvent => card.kind === 'timeline-event');
    const byParticipantAndTime = new Map<string, TimelineEvent[]>();
    for (const event of timeline) {
      if (!event.storyTime || !event.location) {
        continue;
      }
      for (const participant of event.participants) {
        const key = `${participant}|${event.storyTime}`;
        byParticipantAndTime.set(key, [...(byParticipantAndTime.get(key) ?? []), event]);
      }
    }
    for (const [key, events] of byParticipantAndTime) {
      const locations = [...new Set(events.map((event) => event.location).filter(Boolean))];
      if (locations.length > 1) {
        const [participant, storyTime] = key.split('|');
        issues.push({
          severity: '严重问题',
          title: `${participant} 在同一时间出现在多个地点`,
          detail: `${storyTime}：${locations.join('、')}`,
          source: 'timeline',
          suggestion: '调整时间线事件、地点，或说明分身/误认/回忆等特殊原因。'
        });
      }
    }

    return issues;
  }

  public async appendHistory(record: AIJobRecord): Promise<void> {
    await this.writeJson(posixPath(HISTORY_DIR, `${record.id}.json`), record);
  }

  public async listHistory(limit = 50): Promise<AIJobRecord[]> {
    const absolute = this.resolve(HISTORY_DIR);
    try {
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      const records = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => this.readJson<AIJobRecord>(posixPath(HISTORY_DIR, entry.name)))
      );
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  public async clearHistory(): Promise<void> {
    await fs.rm(this.resolve(HISTORY_DIR), { recursive: true, force: true });
    await fs.mkdir(this.resolve(HISTORY_DIR), { recursive: true });
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
        HISTORY_DIR,
        PENDING_UPDATES_DIR,
        MANUSCRIPT_DIR,
        CODEX_DIR,
        CHARACTERS_DIR,
        LOCATIONS_DIR,
        WORLD_RULES_DIR,
        FORESHADOWING_DIR,
        TIMELINE_DIR,
        SCENES_DIR,
        BEATS_DIR
      ].map((relative) => fs.mkdir(this.resolve(relative), { recursive: true }))
    );
    await this.ensureLocalIgnore();
  }

  private async ensureLocalIgnore(): Promise<void> {
    await fs.mkdir(this.resolve(LORE_DIR), { recursive: true });
    const ignorePath = this.resolve(LOREDOCK_LOCAL_GITIGNORE);
    const ignored = ['ai.local.jsonc', 'ai.env'];
    let current = '';
    try {
      current = await fs.readFile(ignorePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const existingLines = current.split(/\r?\n/);
    const missing = ignored.filter((line) => !existingLines.includes(line));
    if (missing.length > 0) {
      const next = current.trim() ? `${current.trimEnd()}\n${missing.join('\n')}\n` : `${missing.join('\n')}\n`;
      await fs.writeFile(ignorePath, next, 'utf8');
    }
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
        identity: '主角或重要角色',
        fixedSetting: '在这里记录不可随意改变的固定设定。',
        personality: '在这里记录性格基调。',
        speechStyle: '在这里记录说话习惯。',
        goals: '在这里记录当前目标。',
        abilities: '',
        weaknesses: '',
        relationships: [],
        currentState: '在这里记录最新状态。',
        secrets: '普通续写默认不会发送此字段。',
        hiddenSecrets: '普通续写默认不会发送此字段。',
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

  private async readJson<T>(relativePath: string): Promise<T> {
    const raw = await fs.readFile(this.resolve(relativePath), 'utf8');
    return JSON.parse(raw) as T;
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

function formatSuggestionList(values: string[]): string[] {
  if (values.length === 0) {
    return ['- 无'];
  }
  return values.map((value) => `- ${value}`);
}

function defaultAIConfigJsonc(): string {
  return `{
  // 当前使用的供应商：gpt / claude / gemini / openai-compatible / openrouter / lm-studio / ollama / deepseek / custom
  // 如果你的一个 sk 开头 key 可以选择 GPT、Claude、DeepSeek 等很多模型，它通常是模型路由平台 key。
  // 这种情况请使用 "openrouter" 或 "openai-compatible"，不要使用原生 "claude"。
  // API key 可以直接写在 provider.apiKey，也可以写在 .loredock/ai.env。
  "schemaVersion": 1,
  "activeProvider": "openai-compatible",
  "defaultLanguage": "zh-CN",
  "providers": {
    "gpt": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "OPENAI_API_KEY",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "claude": {
      // 可以写 "https://api.anthropic.com"，也可以写 "https://api.anthropic.com/v1"
      // Anthropic 控制台 API key 通常以 "sk-ant-" 开头。
      "baseUrl": "https://api.anthropic.com",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "anthropic": {
      // "anthropic" 是 "claude" 的别名；如果你更习惯 Anthropic 这个名字，可以把 activeProvider 写成 "anthropic"。
      "baseUrl": "https://api.anthropic.com",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "gemini": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "GEMINI_API_KEY",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "openai-compatible": {
      "baseUrl": "http://localhost:1234/v1",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "openrouter": {
      // OpenRouter 这类模型路由平台可以用一个 key 访问 GPT、Claude、DeepSeek 等模型。
      // 模型名通常类似 "openai/gpt-4.1"、"anthropic/claude-sonnet-4"、"deepseek/deepseek-chat"。
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    },
    "custom": {
      "baseUrl": "",
      "model": "",
      "apiKey": "",
      "apiKeyEnv": "",
      "temperature": 0.7,
      "maxOutputTokens": 1200,
      "timeoutMs": 60000
    }
  }
}
`;
}

function defaultAIEnv(): string {
  return `# LoreDock 本地 AI key。这个文件会被 .loredock/.gitignore 忽略。
# 在等号后填写 key，通常不需要加引号。

# Anthropic 原生 Claude key，通常以 sk-ant- 开头。
ANTHROPIC_API_KEY=

# OpenRouter 或其他多模型路由 key。
# 如果你的 sk key 可以同时选择 GPT、Claude、DeepSeek，请优先填这里。
# OpenRouter 官方 key 常见形态：sk-or-v1-...
OPENROUTER_API_KEY=

# OpenAI 原生 key。
OPENAI_API_KEY=

# Google Gemini key。
GEMINI_API_KEY=

# DeepSeek key。
DEEPSEEK_API_KEY=
`;
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

function parseEnvFile(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = stripInlineEnvComment(value).trim();
    }
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

function stripInlineEnvComment(value: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === '#' && !inSingleQuote && !inDoubleQuote && (!previous || /\s/.test(previous))) {
      return value.slice(0, index);
    }
  }
  return value;
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
