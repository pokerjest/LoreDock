import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import type { DiagnosticItem, OperationPlan } from "../../kernel/types";
import type { ManuscriptReader } from "../manuscript/types";
import {
  createObjectKeywordSlug,
  createStoryBibleCardId,
  createStoryBibleTrashItemId,
  createUniqueFileBasename,
  isReservedObjectKeywordSlug,
  isValidKeywordSlug,
  normalizeKeywordSlugInput,
  slugSegmentFromName
} from "./ids";
import {
  cardTypeDirectory,
  isStoryBibleContentPath,
  isStoryBibleTrashItemPath,
  isStoryBibleTrashPath,
  keywordDefinitionPath,
  parseKeywordDefinitionText,
  readStoryBible,
  resolveExistingSafeStoryBiblePath,
  stringifyCardMarkdown,
  stringifyKeywordDefinitionMarkdown,
  type ParsedKeywordDefinition,
  type ParsedStoryBibleCard
} from "./files";
import {
  LORE_DIR,
  STORY_BIBLE_CARD_TYPES,
  STORY_BIBLE_TRASH_DIR,
  STORY_BIBLE_TRASH_METADATA,
  STORY_BIBLE_VISIBILITIES,
  STORY_BIBLE_STATUSES,
  type KeywordCatalogEntryDto,
  type KeywordDefinitionDto,
  type KeywordSlug,
  type StoryBibleActionResult,
  type StoryBibleActions,
  type StoryBibleCardDto,
  type StoryBibleCardId,
  type StoryBibleCardMetadataPatch,
  type StoryBibleCardType,
  type StoryBibleChangeEvent,
  type StoryBibleChangeType,
  type StoryBibleKeywordInput,
  type StoryBibleKeywordSearchQuery,
  type StoryBibleReadResult,
  type StoryBibleReader,
  type StoryBibleSearchQuery,
  type StoryBibleService,
  type StoryBibleStatus,
  type StoryBibleTrashItemDto,
  type StoryBibleTrashItemId,
  type StoryBibleVisibility
} from "./types";

interface StoryBibleControllerOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  output: vscode.OutputChannel;
  diagnostics: {
    add(item: DiagnosticItem): void;
    clearMatching(workspaceFolderPath: string, predicate: (item: DiagnosticItem) => boolean): void;
  };
  confirmOperationPlan(plan: OperationPlan): Promise<boolean>;
  confirmDestructiveDelete(message: string): Promise<boolean>;
  getManuscriptReader?(): ManuscriptReader | undefined;
  now(): Date;
}

interface TrashMetadata extends Omit<StoryBibleTrashItemDto, "id"> {
  id: StoryBibleTrashItemId;
}

export class StoryBibleController implements StoryBibleReader, StoryBibleActions, StoryBibleService {
  public readonly reader: StoryBibleReader = this;
  public readonly actions: StoryBibleActions = this;

  private readonly emitter = new vscode.EventEmitter<StoryBibleChangeEvent>();

  public constructor(private readonly options: StoryBibleControllerOptions) {}

  public onDidChange(listener: (event: StoryBibleChangeEvent) => unknown): vscode.Disposable {
    return this.emitter.event(listener);
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  public async refreshDiagnostics(): Promise<DiagnosticItem[]> {
    this.options.diagnostics.clearMatching(this.workspaceRoot, isStoryBibleDiagnostic);
    const result = await readStoryBible(this.workspaceRoot, this.options.getManuscriptReader?.());
    for (const item of result.diagnostics) {
      this.options.diagnostics.add(item);
    }
    return result.diagnostics;
  }

  public notifyFileChanged(relativePath: string, type?: StoryBibleChangeType): void {
    const normalized = normalizeRelativePath(relativePath);
    this.emit(type ?? (normalized.includes("/trash/") ? "structure" : "content"), { path: normalized });
  }

  public async listCards(query: StoryBibleSearchQuery = {}): Promise<StoryBibleCardDto[]> {
    const catalog = await this.readCatalog();
    return filterCards(catalog.cards.map((item) => item.dto), query);
  }

  public async getCard(cardId: StoryBibleCardId): Promise<StoryBibleCardDto | undefined> {
    const catalog = await this.readCatalog();
    return catalog.cards.find((item) => item.dto.id === cardId)?.dto;
  }

  public async resolveCardPath(cardId: StoryBibleCardId): Promise<string | undefined> {
    return (await this.getCard(cardId))?.path;
  }

  public async readCardText(cardId: StoryBibleCardId): Promise<StoryBibleReadResult> {
    const catalog = await this.readCatalog();
    const card = catalog.cards.find((item) => item.dto.id === cardId);
    if (!card) {
      return { ok: false, error: `未找到故事圣经条目 "${cardId}"。` };
    }

    return { ok: true, text: card.body };
  }

  public async listKeywords(query: StoryBibleKeywordSearchQuery = {}): Promise<KeywordCatalogEntryDto[]> {
    const catalog = await this.readCatalog();
    return filterKeywords(catalog.keywords, query);
  }

  public async searchCards(query: StoryBibleSearchQuery): Promise<StoryBibleCardDto[]> {
    const catalog = await this.readCatalog();
    let cards = filterCards(catalog.cards.map((item) => item.dto), query);
    const text = query.text?.trim().toLowerCase();

    if (!text) {
      return cards;
    }

    const keywordBySlug = new Map(catalog.keywords.map((keyword) => [keyword.slug as string, keyword]));
    cards = cards.filter((card) => {
      const fields = [
        card.name,
        ...card.aliases,
        card.summary,
        card.title ?? "",
        ...card.tags.flatMap((tag) => {
          const keyword = keywordBySlug.get(tag);
          return [tag, keyword?.label ?? "", keyword?.description ?? ""];
        })
      ];

      return fields.some((field) => field.toLowerCase().includes(text));
    });

    return cards;
  }

  public async searchKeywords(query: StoryBibleKeywordSearchQuery): Promise<KeywordCatalogEntryDto[]> {
    return this.listKeywords(query);
  }

  public async readKeywordDefinitionText(slug: KeywordSlug | string): Promise<StoryBibleReadResult> {
    const normalized = normalizeKeywordSlugInput(slug);
    const catalog = await this.readCatalog();
    const keyword = catalog.keywordDefinitions.find((item) => item.dto.slug === normalized);
    if (!keyword) {
      return { ok: false, error: `未找到关键词定义 "${slug}"。` };
    }

    return { ok: true, text: keyword.body };
  }

  public async listTrashItems(): Promise<StoryBibleTrashItemDto[]> {
    return (await this.readCatalog()).trashItems;
  }

  public async createCard(
    type: StoryBibleCardType,
    name: string,
    options: Partial<Pick<StoryBibleCardDto, "aliases" | "summary" | "visibility" | "status" | "chapterRefs">> = {}
  ): Promise<StoryBibleActionResult> {
    assertCardType(type);
    const cleanName = assertNonEmpty(name, "条目名称");
    const catalog = await this.readCatalog();
    const directory = cardTypeDirectory(type);
    const fileName = await allocateCardFilename(this.workspaceRoot, directory, cleanName);
    const cardPath = normalizeRelativePath(`${directory}/${fileName}`);
    const timestamp = this.timestamp();
    const takenKeywordSlugs = new Set(catalog.keywords.map((keyword) => keyword.slug as string));
    const primaryKeyword = createObjectKeywordSlug(type, cleanName, takenKeywordSlugs);
    const card: Omit<StoryBibleCardDto, "keywordLabels" | "title" | "path" | "primaryKeyword"> & { path?: string } = {
      id: createStoryBibleCardId(),
      type,
      name: cleanName,
      aliases: normalizeStringArray(options.aliases ?? []),
      tags: [primaryKeyword],
      summary: options.summary ?? "",
      visibility: options.visibility ?? "public",
      status: options.status ?? "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(options.chapterRefs ? { chapterRefs: normalizeStringArray(options.chapterRefs) } : {})
    };
    validateVisibility(card.visibility);
    validateStatus(card.status);

    const body = createCardTemplateBody(type, cleanName);
    const content = stringifyCardMarkdown(card, body);
    const plan = storyBiblePlan(`新建${formatCardType(type)}“${cleanName}”。`, contentDirectoriesFor(directory), [cardPath]);
    plan.fileContentPreviews = [{
      relativePath: cardPath,
      title: "初始 frontmatter",
      content: extractFrontmatterPreview(content)
    }];
    return this.applyPlan(plan, async (writer) => {
      for (const dir of contentDirectoriesFor(directory)) {
        await writer.ensureDirectory(dir);
      }
      await writer.writeFile(cardPath, content);
    }, [{ type: "structure", cardId: card.id, path: cardPath }]);
  }

  public async renameCard(cardId: StoryBibleCardId, name: string): Promise<StoryBibleActionResult> {
    const cleanName = assertNonEmpty(name, "条目名称");
    const catalog = await this.readCatalog();
    const card = requireParsedCard(catalog.cards, cardId);
    const primaryKeyword = resolvePrimaryKeywordForName(catalog.keywords.map((keyword) => keyword.slug as string), card.dto, cleanName);
    const nextTags = dedupeKeywords([primaryKeyword, ...card.dto.tags]);
    const next = {
      ...card.dto,
      name: cleanName,
      tags: nextTags,
      updatedAt: this.timestamp()
    };

    const plan = storyBiblePlan(`重命名条目为“${cleanName}”。`, [], [], [card.dto.path]);
    return this.applyPlan(plan, async (writer) => {
      await writer.writeFile(card.dto.path, stringifyCardMarkdown(next, card.body, card.frontmatter));
    }, [{ type: "metadata", cardId, path: card.dto.path }]);
  }

  public async updateCardMetadata(
    cardId: StoryBibleCardId,
    patch: StoryBibleCardMetadataPatch
  ): Promise<StoryBibleActionResult> {
    const catalog = await this.readCatalog();
    const card = requireParsedCard(catalog.cards, cardId);
    const nextName = patch.name === undefined ? card.dto.name : assertNonEmpty(patch.name, "条目名称");
    const nameChanged = nextName !== card.dto.name;
    const primaryKeyword = nameChanged
      ? resolvePrimaryKeywordForName(catalog.keywords.map((keyword) => keyword.slug as string), card.dto, nextName)
      : card.dto.primaryKeyword;
    let tags = card.dto.tags;

    if (patch.tags !== undefined) {
      const normalizedTags = dedupeKeywords(patch.tags.map((tag) => normalizeKeywordSlugInput(tag) as KeywordSlug));
      if (!nameChanged && normalizedTags[0] !== card.dto.primaryKeyword) {
        throw new Error("不能删除或移动当前对象主关键词 tags[0]。");
      }
      for (const tag of normalizedTags) {
        if (!isValidKeywordSlug(tag)) {
          throw new Error(`keyword slug "${tag}" 不合法。`);
        }
      }
      tags = nameChanged
        ? dedupeKeywords([primaryKeyword, ...normalizedTags.filter((tag) => tag !== primaryKeyword)])
        : normalizedTags;
    } else if (nameChanged) {
      tags = dedupeKeywords([primaryKeyword, ...card.dto.tags]);
    }

    const next = {
      ...card.dto,
      name: nextName,
      aliases: patch.aliases === undefined ? card.dto.aliases : normalizeStringArray(patch.aliases),
      tags,
      summary: patch.summary === undefined ? card.dto.summary : patch.summary,
      visibility: patch.visibility ?? card.dto.visibility,
      status: patch.status ?? card.dto.status,
      updatedAt: this.timestamp(),
      ...(patch.chapterRefs === undefined ? {} : { chapterRefs: normalizeStringArray(patch.chapterRefs) })
    };
    validateVisibility(next.visibility);
    validateStatus(next.status);

    const plan = storyBiblePlan(`更新条目“${card.dto.name}”元数据。`, [], [], [card.dto.path]);
    return this.applyPlan(plan, async (writer) => {
      await writer.writeFile(card.dto.path, stringifyCardMarkdown(next, card.body, card.frontmatter));
    }, [{ type: "metadata", cardId, path: card.dto.path }]);
  }

  public async deleteCard(cardId: StoryBibleCardId): Promise<StoryBibleActionResult> {
    const catalog = await this.readCatalog();
    const card = requireParsedCard(catalog.cards, cardId);
    const trashItemId = createStoryBibleTrashItemId();
    const trashPath = storyBibleTrashItemPath(trashItemId);
    const metadataPath = normalizeRelativePath(`${trashPath}/${STORY_BIBLE_TRASH_METADATA}`);
    const fileMove = await createExistingStoryBibleTrashMove(this.workspaceRoot, card.dto.path, trashPath);
    const metadata: TrashMetadata = {
      id: trashItemId,
      resourceType: "card",
      cardType: card.dto.type,
      title: card.dto.name,
      deletedAt: this.timestamp(),
      originalPath: card.dto.path,
      trashPath,
      originalFileName: path.basename(card.dto.path),
      cardId: card.dto.id
    };

    if (!fileMove) {
      throw new Error(`无法删除条目：文件 "${card.dto.path}" 缺失或路径不安全。`);
    }

    const plan = storyBiblePlan(
      `将条目“${card.dto.name}”移入故事圣经资源垃圾桶。`,
      trashDirectoriesFor(trashPath),
      [metadataPath]
    );
    plan.filesToMove = [fileMove];

    return this.applyPlan(plan, async (writer) => {
      for (const dir of trashDirectoriesFor(trashPath)) {
        await writer.ensureDirectory(dir);
      }
      await writer.writeFile(metadataPath, stringifyTrashMetadata(metadata));
      await writer.moveFile(fileMove.from, fileMove.to);
    }, [{ type: "structure", cardId, trashItemId, path: card.dto.path }]);
  }

  public async defineKeyword(input: StoryBibleKeywordInput): Promise<StoryBibleActionResult> {
    const slug = validateOrdinaryKeywordSlug(input.slug);
    const keywordPath = keywordDefinitionPath(slug);
    const existing = await readExistingKeywordDefinition(this.workspaceRoot, keywordPath);
    const timestamp = this.timestamp();
    const keyword: Omit<KeywordDefinitionDto, "path"> = {
      slug,
      label: assertNonEmpty(input.label, "Keyword label"),
      description: input.description ?? "",
      category: normalizeCategory(input.category ?? "custom"),
      appliesTo: normalizeStringArray(input.appliesTo ?? ["any"]),
      createdAt: existing?.dto.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    const body = input.body ?? existing?.body ?? `# ${keyword.label}\n\n`;
    const directories = contentDirectoriesFor(path.dirname(keywordPath));
    const fileExists = existing !== undefined || (await pathExists(path.join(this.workspaceRoot, keywordPath)));
    const plan = storyBiblePlan(
      `${fileExists ? "更新" : "定义"}关键词“${keyword.label}”。`,
      directories,
      fileExists ? [] : [keywordPath],
      fileExists ? [keywordPath] : []
    );

    return this.applyPlan(plan, async (writer) => {
      for (const dir of directories) {
        await writer.ensureDirectory(dir);
      }
      await writer.writeFile(keywordPath, stringifyKeywordDefinitionMarkdown(keyword, body, existing?.frontmatter));
    }, [{ type: fileExists ? "metadata" : "structure", keywordSlug: slug, path: keywordPath }]);
  }

  public async updateKeywordDefinition(
    slug: KeywordSlug | string,
    patch: Partial<StoryBibleKeywordInput>
  ): Promise<StoryBibleActionResult> {
    const normalized = validateOrdinaryKeywordSlug(slug);
    if (patch.slug !== undefined && normalizeKeywordSlugInput(patch.slug) !== normalized) {
      throw new Error("v0.2 不支持通过更新操作修改关键词 slug；请创建新关键词定义。");
    }

    const keywordPath = keywordDefinitionPath(normalized);
    const existing = await readExistingKeywordDefinition(this.workspaceRoot, keywordPath);
    if (!existing) {
      throw new Error(`未找到关键词定义 "${slug}"。`);
    }

    const next: Omit<KeywordDefinitionDto, "path"> = {
      slug: normalized,
      label: patch.label === undefined ? existing.dto.label : assertNonEmpty(patch.label, "Keyword label"),
      description: patch.description ?? existing.dto.description,
      category: normalizeCategory(patch.category ?? existing.dto.category),
      appliesTo: patch.appliesTo === undefined ? existing.dto.appliesTo : normalizeStringArray(patch.appliesTo),
      createdAt: existing.dto.createdAt,
      updatedAt: this.timestamp()
    };
    const body = patch.body ?? existing.body;
    const plan = storyBiblePlan(`更新关键词“${next.label}”。`, [], [], [keywordPath]);

    return this.applyPlan(plan, async (writer) => {
      await writer.writeFile(keywordPath, stringifyKeywordDefinitionMarkdown(next, body, existing.frontmatter));
    }, [{ type: "metadata", keywordSlug: normalized, path: keywordPath }]);
  }

  public async deleteKeywordDefinition(slug: KeywordSlug | string): Promise<StoryBibleActionResult> {
    const normalized = validateOrdinaryKeywordSlug(slug);
    const keywordPath = keywordDefinitionPath(normalized);
    const existing = await readExistingKeywordDefinition(this.workspaceRoot, keywordPath);
    if (!existing) {
      throw new Error(`未找到关键词定义 "${slug}"。`);
    }

    const trashItemId = createStoryBibleTrashItemId();
    const trashPath = storyBibleTrashItemPath(trashItemId);
    const metadataPath = normalizeRelativePath(`${trashPath}/${STORY_BIBLE_TRASH_METADATA}`);
    const fileMove = await createExistingStoryBibleTrashMove(this.workspaceRoot, keywordPath, trashPath);
    const metadata: TrashMetadata = {
      id: trashItemId,
      resourceType: "keyword-definition",
      title: existing.dto.label,
      deletedAt: this.timestamp(),
      originalPath: keywordPath,
      trashPath,
      originalFileName: path.basename(keywordPath),
      keywordSlug: existing.dto.slug
    };

    if (!fileMove) {
      throw new Error(`无法删除 Keyword 定义：文件 "${keywordPath}" 缺失或路径不安全。`);
    }

    const plan = storyBiblePlan(
      `将关键词定义“${existing.dto.label}”移入故事圣经资源垃圾桶。`,
      trashDirectoriesFor(trashPath),
      [metadataPath]
    );
    plan.filesToMove = [fileMove];

    return this.applyPlan(plan, async (writer) => {
      for (const dir of trashDirectoriesFor(trashPath)) {
        await writer.ensureDirectory(dir);
      }
      await writer.writeFile(metadataPath, stringifyTrashMetadata(metadata));
      await writer.moveFile(fileMove.from, fileMove.to);
    }, [{ type: "structure", keywordSlug: normalized, trashItemId, path: keywordPath }]);
  }

  public async restoreTrashItem(trashItemId: StoryBibleTrashItemId): Promise<StoryBibleActionResult> {
    const item = await this.requireTrashItem(trashItemId);
    const source = normalizeRelativePath(`${item.trashPath}/${item.originalFileName}`);
    const absoluteSource = await resolveExistingSafeStoryBiblePath(this.workspaceRoot, source);
    if (!absoluteSource) {
      throw new Error(`无法还原：回收站内容 "${source}" 缺失或路径不安全。`);
    }
    if (await pathExists(path.join(this.workspaceRoot, item.originalPath))) {
      throw new Error(`无法还原：目标路径 "${item.originalPath}" 已存在。`);
    }

    const plan = storyBiblePlan(`还原资源垃圾桶项目“${item.title}”。`, contentDirectoriesFor(path.dirname(item.originalPath)));
    plan.filesToMove = [{ from: source, to: item.originalPath }];
    plan.directoriesToDelete = [item.trashPath];

    return this.applyPlan(plan, async (writer) => {
      for (const dir of contentDirectoriesFor(path.dirname(item.originalPath))) {
        await writer.ensureDirectory(dir);
      }
      await writer.moveFile(source, item.originalPath);
      await writer.deleteDirectoryRecursive(item.trashPath);
    }, [{ type: "structure", trashItemId, path: item.originalPath }]);
  }

  public async permanentlyDeleteTrashItem(trashItemId: StoryBibleTrashItemId): Promise<StoryBibleActionResult> {
    const item = await this.requireTrashItem(trashItemId);
    const plan = storyBiblePlan(`永久删除资源垃圾桶项目“${item.title}”。`);
    plan.directoriesToDelete = [item.trashPath];

    return this.applyPlan(
      plan,
      async (writer) => {
        await writer.deleteDirectoryRecursive(item.trashPath);
      },
      [{ type: "structure", trashItemId }],
      `将永久删除故事圣经资源垃圾桶项目“${item.title}”。此操作不能撤销。确认删除？`
    );
  }

  private async readCatalog() {
    return readStoryBible(this.workspaceRoot, this.options.getManuscriptReader?.());
  }

  private async requireTrashItem(trashItemId: StoryBibleTrashItemId): Promise<StoryBibleTrashItemDto> {
    const item = (await this.listTrashItems()).find((candidate) => candidate.id === trashItemId);
    if (!item) {
      throw new Error(`未找到资源垃圾桶项目 "${trashItemId}"。`);
    }
    return item;
  }

  private async applyPlan(
    plan: OperationPlan,
    apply: (writer: SafeFileWriter) => Promise<void>,
    events: Partial<StoryBibleChangeEvent>[],
    destructiveDeleteMessage?: string
  ): Promise<StoryBibleActionResult> {
    assertSafeStoryBibleOperations(plan);
    const confirmed = await this.options.confirmOperationPlan(plan);
    if (!confirmed) {
      this.options.output.appendLine(`已取消故事圣经操作：${plan.summary}`);
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

  private emit(type: StoryBibleChangeType, event: Partial<StoryBibleChangeEvent>): void {
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

function storyBiblePlan(
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

function filterCards(cards: StoryBibleCardDto[], query: StoryBibleSearchQuery): StoryBibleCardDto[] {
  return cards.filter((card) => {
    if (query.type && card.type !== query.type) {
      return false;
    }
    if (query.visibility && card.visibility !== query.visibility) {
      return false;
    }
    if (query.status && card.status !== query.status) {
      return false;
    }
    if (query.keyword && !card.tags.includes(normalizeKeywordSlugInput(query.keyword) as KeywordSlug)) {
      return false;
    }
    return true;
  });
}

function filterKeywords(keywords: KeywordCatalogEntryDto[], query: StoryBibleKeywordSearchQuery): KeywordCatalogEntryDto[] {
  const text = query.text?.trim().toLowerCase();
  return keywords.filter((keyword) => {
    if (query.category && keyword.category !== query.category) {
      return false;
    }
    if (query.appliesTo && !keyword.appliesTo.includes("any") && !keyword.appliesTo.includes(query.appliesTo)) {
      return false;
    }
    if (!text) {
      return true;
    }

    return [keyword.slug, keyword.label, keyword.description, keyword.category]
      .some((field) => field.toLowerCase().includes(text));
  });
}

function requireParsedCard(cards: ParsedStoryBibleCard[], cardId: StoryBibleCardId): ParsedStoryBibleCard {
  const card = cards.find((candidate) => candidate.dto.id === cardId);
  if (!card) {
    throw new Error(`未找到故事圣经条目 "${cardId}"。`);
  }
  return card;
}

function resolvePrimaryKeywordForName(
  catalogSlugs: string[],
  card: Pick<StoryBibleCardDto, "type" | "tags">,
  name: string
): KeywordSlug {
  const baseSlug = `${card.type}/${slugSegmentFromName(name)}`;
  const existingHistoricalKeyword = card.tags.find((tag) => tag === baseSlug);
  if (existingHistoricalKeyword) {
    return existingHistoricalKeyword as KeywordSlug;
  }

  const takenKeywordSlugs = new Set(catalogSlugs.filter((slug) => !card.tags.includes(slug as KeywordSlug)));
  return createObjectKeywordSlug(card.type, name, takenKeywordSlugs);
}

async function readExistingKeywordDefinition(
  workspaceRoot: string,
  keywordPath: string
): Promise<ParsedKeywordDefinition | undefined> {
  const absolutePath = await resolveExistingSafeStoryBiblePath(workspaceRoot, keywordPath);
  if (!absolutePath) {
    return undefined;
  }

  const text = await fs.readFile(absolutePath, "utf8");
  return parseKeywordDefinitionText(workspaceRoot, keywordPath, text).definition;
}

async function allocateCardFilename(workspaceRoot: string, directory: string, name: string): Promise<string> {
  const absoluteDirectory = path.join(workspaceRoot, directory);
  const taken = new Set<string>();
  try {
    for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        taken.add(entry.name.toLowerCase());
      }
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  let candidate = createUniqueFileBasename(name, ".md", taken);
  while (await pathExists(path.join(workspaceRoot, directory, candidate))) {
    taken.add(candidate.toLowerCase());
    candidate = createUniqueFileBasename(name, ".md", taken);
  }
  return candidate;
}

async function createExistingStoryBibleTrashMove(
  workspaceRoot: string,
  source: string,
  trashPath: string
): Promise<NonNullable<OperationPlan["filesToMove"]>[number] | undefined> {
  const normalizedSource = normalizeRelativePath(source);
  const absoluteSource = await resolveExistingSafeStoryBiblePath(workspaceRoot, normalizedSource);
  if (!absoluteSource) {
    return undefined;
  }

  const stats = await fs.stat(absoluteSource);
  if (!stats.isFile()) {
    return undefined;
  }

  return {
    from: normalizedSource,
    to: normalizeRelativePath(`${trashPath}/${path.basename(normalizedSource)}`)
  };
}

function contentDirectoriesFor(targetDirectory: string): string[] {
  const normalized = normalizeRelativePath(targetDirectory);
  const parts = normalized.split("/").filter(Boolean);
  const dirs: string[] = [];
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (current === LORE_DIR || current.startsWith(`${LORE_DIR}/`)) {
      dirs.push(current);
    }
  }

  return dirs;
}

function trashDirectoriesFor(trashPath: string): string[] {
  const normalized = normalizeRelativePath(trashPath);
  const parts = normalized.split("/").filter(Boolean);
  const dirs: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    dirs.push(current);
  }
  return dirs;
}

function storyBibleTrashItemPath(trashItemId: StoryBibleTrashItemId): string {
  return normalizeRelativePath(`${STORY_BIBLE_TRASH_DIR}/${trashItemId}`);
}

function stringifyTrashMetadata(metadata: TrashMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function extractFrontmatterPreview(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (!normalized.startsWith("---\n") || endIndex < 0) {
    return normalized;
  }

  return normalized.slice(0, endIndex + "\n---".length);
}

function createCardTemplateBody(type: StoryBibleCardType, name: string): string {
  const sections: Record<StoryBibleCardType, string[]> = {
    character: [
      "## 角色定位",
      "",
      "- 在故事中的功能：",
      "",
      "## 目标",
      "",
      "- 当前想要得到什么：",
      "",
      "## 冲突",
      "",
      "- 阻碍、矛盾或代价：",
      "",
      "## 说话方式",
      "",
      "- 语气、口头禅或表达习惯：",
      "",
      "## 当前状态",
      "",
      "- 剧情推进到这里时的状态："
    ],
    location: [
      "## 区域",
      "",
      "- 所属地域或空间范围：",
      "",
      "## 氛围",
      "",
      "- 作者希望读者感到：",
      "",
      "## 重要规则",
      "",
      "- 在这里必须遵守或容易出事的规则：",
      "",
      "## 当前状态",
      "",
      "- 剧情推进到这里时的状态："
    ],
    rule: [
      "## 分类",
      "",
      "- 魔法、社会、组织、技术或叙事规则：",
      "",
      "## 重要性",
      "",
      "- 为什么它会影响故事：",
      "",
      "## 规则陈述",
      "",
      "- 这条规则具体是什么：",
      "",
      "## 例外",
      "",
      "- 谁能例外，代价是什么："
    ]
  };

  return [`# ${name}`, "", ...sections[type], ""].join("\n");
}

function validateOrdinaryKeywordSlug(value: string): KeywordSlug {
  const slug = normalizeKeywordSlugInput(value);
  if (!isValidKeywordSlug(slug)) {
    throw new Error(`keyword slug "${value}" 不合法。`);
  }
  if (isReservedObjectKeywordSlug(slug)) {
    throw new Error("普通关键词定义不能使用 character/、location/ 或 rule/ 保留前缀。");
  }
  return slug as KeywordSlug;
}

function normalizeCategory(value: string): string {
  const category = normalizeKeywordSlugInput(value);
  if (!isValidKeywordSlug(category)) {
    throw new Error(`关键词 category "${value}" 不合法。`);
  }
  return category;
}

function dedupeKeywords(tags: KeywordSlug[]): KeywordSlug[] {
  const result: KeywordSlug[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeKeywordSlugInput(tag) as KeywordSlug;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeStringArray(value: string[]): string[] {
  return value.map((item) => item.trim()).filter((item) => item !== "");
}

function validateVisibility(value: StoryBibleVisibility): void {
  if (!STORY_BIBLE_VISIBILITIES.includes(value)) {
    throw new Error(`visibility "${value}" 不受支持。`);
  }
}

function validateStatus(value: StoryBibleStatus): void {
  if (!STORY_BIBLE_STATUSES.includes(value)) {
    throw new Error(`status "${value}" 不受支持。`);
  }
}

function assertCardType(value: StoryBibleCardType): void {
  if (!STORY_BIBLE_CARD_TYPES.includes(value)) {
    throw new Error(`条目类型 "${String(value)}" 不受支持。`);
  }
}

function assertNonEmpty(value: string, label: string): string {
  if (value.trim() === "") {
    throw new Error(`${label} 不能为空。`);
  }
  return value.trim();
}

function assertSafeStoryBibleOperations(plan: OperationPlan): void {
  for (const directory of plan.directoriesToCreate) {
    if (!isAllowedDirectoryCreate(directory)) {
      throw new Error(`故事圣经目录创建操作不安全："${directory}"。`);
    }
  }

  for (const filePath of [...plan.filesToCreate, ...plan.filesToModify]) {
    if (!isStoryBibleContentPath(filePath) && !isStoryBibleTrashPath(filePath)) {
      throw new Error(`故事圣经文件写入操作必须位于 lore/ 或故事圣经资源垃圾桶："${filePath}"。`);
    }
  }

  for (const operation of plan.filesToMove ?? []) {
    const fromContentToTrash = isStoryBibleContentPath(operation.from) && isStoryBibleTrashPath(operation.to);
    const fromTrashToContent = isStoryBibleTrashPath(operation.from) && isStoryBibleContentPath(operation.to);
    if (!fromContentToTrash && !fromTrashToContent) {
      throw new Error("故事圣经文件移动操作必须在 lore/ 和故事圣经资源垃圾桶之间进行。");
    }
  }

  for (const directory of plan.directoriesToDelete ?? []) {
    if (!isStoryBibleTrashItemPath(directory)) {
      throw new Error("故事圣经递归删除操作必须指向单个故事圣经资源垃圾桶项目。");
    }
  }
}

function isAllowedDirectoryCreate(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    normalized === ".loredock" ||
    normalized === ".loredock/trash" ||
    normalized === ".loredock/trash/resources" ||
    isStoryBibleContentPath(normalized) ||
    isStoryBibleTrashPath(normalized)
  );
}

function isStoryBibleDiagnostic(item: DiagnosticItem): boolean {
  return (
    item.code.startsWith("storyBible.") ||
    item.relativePath === LORE_DIR ||
    item.relativePath?.startsWith(`${LORE_DIR}/`) === true ||
    item.relativePath === STORY_BIBLE_TRASH_DIR ||
    item.relativePath?.startsWith(`${STORY_BIBLE_TRASH_DIR}/`) === true
  );
}

function formatCardType(type: StoryBibleCardType): string {
  switch (type) {
    case "character":
      return "人物";
    case "location":
      return "地点";
    case "rule":
      return "规则";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
