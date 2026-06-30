import * as fs from "fs/promises";
import * as path from "path";
import { validateProjectManifest } from "../../kernel/manifest";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { MANIFEST_RELATIVE_PATH, type DiagnosticItem } from "../../kernel/types";
import { MANUSCRIPT_CAPABILITY_ID, type ChapterId, type ManuscriptReader } from "../manuscript/types";
import {
  isReservedObjectKeywordSlug,
  isValidKeywordSlug,
  keywordLabelFromSlug,
  normalizeKeywordSlugInput,
  objectKeywordPrefixFor
} from "./ids";
import {
  markdownH1,
  parseMarkdownFrontmatter,
  stringifyMarkdownFrontmatter,
  type FrontmatterDocument
} from "./frontmatter";
import {
  LORE_DIR,
  STORY_BIBLE_CAPABILITY_ID,
  STORY_BIBLE_CARD_TYPES,
  STORY_BIBLE_CHARACTER_DIR,
  STORY_BIBLE_LOCATION_DIR,
  STORY_BIBLE_RULE_DIR,
  STORY_BIBLE_SCHEMA_VERSION,
  STORY_BIBLE_STATUSES,
  STORY_BIBLE_TAG_DIR,
  STORY_BIBLE_TAG_SCHEMA_ID,
  STORY_BIBLE_TRASH_DIR,
  STORY_BIBLE_TRASH_METADATA,
  STORY_BIBLE_VISIBILITIES,
  type KeywordCatalogEntryDto,
  type KeywordDefinitionDto,
  type KeywordSlug,
  type StoryBibleCardDto,
  type StoryBibleCardId,
  type StoryBibleCardType,
  type StoryBibleStatus,
  type StoryBibleTrashItemDto,
  type StoryBibleTrashItemId,
  type StoryBibleVisibility
} from "./types";

export const CARD_FRONTMATTER_KEYS = [
  "schemaVersion",
  "id",
  "type",
  "name",
  "aliases",
  "tags",
  "summary",
  "visibility",
  "status",
  "createdAt",
  "updatedAt",
  "chapterRefs"
];

export const KEYWORD_FRONTMATTER_KEYS = [
  "schemaVersion",
  "schema",
  "slug",
  "label",
  "description",
  "category",
  "appliesTo",
  "createdAt",
  "updatedAt"
];

export const CARD_FRONTMATTER_KEY_SET = new Set(CARD_FRONTMATTER_KEYS);
export const KEYWORD_FRONTMATTER_KEY_SET = new Set(KEYWORD_FRONTMATTER_KEYS);

const CARD_TYPE_DIRS: Record<StoryBibleCardType, string> = {
  character: STORY_BIBLE_CHARACTER_DIR,
  location: STORY_BIBLE_LOCATION_DIR,
  rule: STORY_BIBLE_RULE_DIR
};

export interface ParsedStoryBibleCard {
  dto: StoryBibleCardDto;
  frontmatter: FrontmatterDocument;
  body: string;
}

export interface ParsedKeywordDefinition {
  dto: KeywordDefinitionDto;
  frontmatter: FrontmatterDocument;
  body: string;
}

export type StoryBibleReadResult =
  | {
      status: "missing";
      diagnostics: DiagnosticItem[];
      cards: ParsedStoryBibleCard[];
      keywordDefinitions: ParsedKeywordDefinition[];
      keywords: KeywordCatalogEntryDto[];
      trashItems: StoryBibleTrashItemDto[];
    }
  | {
      status: "degraded" | "valid";
      diagnostics: DiagnosticItem[];
      cards: ParsedStoryBibleCard[];
      keywordDefinitions: ParsedKeywordDefinition[];
      keywords: KeywordCatalogEntryDto[];
      trashItems: StoryBibleTrashItemDto[];
    };

export async function readStoryBible(
  workspaceRoot: string,
  manuscriptReader?: ManuscriptReader
): Promise<StoryBibleReadResult> {
  const diagnostics: DiagnosticItem[] = [];
  const dirs = await inspectStoryBibleDirectories(workspaceRoot, diagnostics);
  const anyDirectoryExists = Object.values(dirs).some((inspection) => inspection.status === "safe");

  if (!anyDirectoryExists) {
    return {
      status: "missing",
      diagnostics,
      cards: [],
      keywordDefinitions: [],
      keywords: [],
      trashItems: await listStoryBibleTrashItems(workspaceRoot, diagnostics)
    };
  }

  const cards: ParsedStoryBibleCard[] = [];
  const keywordDefinitions: ParsedKeywordDefinition[] = [];

  for (const type of STORY_BIBLE_CARD_TYPES) {
    const directoryInspection = dirs[CARD_TYPE_DIRS[type]];
    if (directoryInspection.status !== "safe") {
      continue;
    }

    for (const relativePath of await listMarkdownFiles(directoryInspection.absolutePath, workspaceRoot)) {
      const parsed = await readCardFile(workspaceRoot, relativePath, type, manuscriptReader, diagnostics);
      if (parsed) {
        cards.push(parsed);
      }
    }
  }

  if (dirs[STORY_BIBLE_TAG_DIR].status === "safe") {
    for (const relativePath of await listMarkdownFiles(dirs[STORY_BIBLE_TAG_DIR].absolutePath, workspaceRoot)) {
      const parsed = await readKeywordFile(workspaceRoot, relativePath, diagnostics);
      if (parsed) {
        keywordDefinitions.push(parsed);
      }
    }
  }

  await addOrphanMarkdownDiagnostics(workspaceRoot, dirs[LORE_DIR], diagnostics);
  addCrossFileDiagnostics(workspaceRoot, cards, keywordDefinitions, diagnostics);
  const keywords = buildKeywordCatalog(cards.map((item) => item.dto), keywordDefinitions.map((item) => item.dto));
  const keywordLabels = Object.fromEntries(keywords.map((keyword) => [keyword.slug, keyword.label]));
  for (const card of cards) {
    card.dto.keywordLabels = Object.fromEntries(card.dto.tags.map((tag) => [tag, keywordLabels[tag] ?? keywordLabelFromSlug(tag)]));
  }
  const trashItems = await listStoryBibleTrashItems(workspaceRoot, diagnostics);
  const hasErrors = diagnostics.some((item) => item.severity === "error");

  return {
    status: hasErrors ? "degraded" : "valid",
    diagnostics,
    cards,
    keywordDefinitions,
    keywords,
    trashItems
  };
}

export async function isStoryBibleCapabilityEnabled(workspaceRoot: string): Promise<boolean> {
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, MANIFEST_RELATIVE_PATH);
  if (inspection.status !== "safe") {
    return false;
  }

  try {
    const value = JSON.parse(await fs.readFile(inspection.absolutePath, "utf8")) as unknown;
    const validation = validateProjectManifest(
      value,
      workspaceRoot,
      new Set([STORY_BIBLE_CAPABILITY_ID, MANUSCRIPT_CAPABILITY_ID])
    );
    return validation.isValid && Boolean(validation.manifest?.capabilities.includes(STORY_BIBLE_CAPABILITY_ID));
  } catch {
    return false;
  }
}

export async function parseCardText(
  workspaceRoot: string,
  relativePath: string,
  text: string,
  expectedType: StoryBibleCardType,
  manuscriptReader?: ManuscriptReader
): Promise<{ card?: ParsedStoryBibleCard; diagnostics: DiagnosticItem[] }> {
  const diagnostics: DiagnosticItem[] = [];
  const frontmatter = parseMarkdownFrontmatter(text, CARD_FRONTMATTER_KEY_SET);
  for (const error of frontmatter.errors) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "storyBible.card.frontmatter.invalid", error, relativePath));
  }

  const card = await parseCardFrontmatter(
    workspaceRoot,
    relativePath,
    frontmatter,
    expectedType,
    manuscriptReader,
    diagnostics
  );
  return { card, diagnostics };
}

export function parseKeywordDefinitionText(
  workspaceRoot: string,
  relativePath: string,
  text: string
): { definition?: ParsedKeywordDefinition; diagnostics: DiagnosticItem[] } {
  const diagnostics: DiagnosticItem[] = [];
  const frontmatter = parseMarkdownFrontmatter(text, KEYWORD_FRONTMATTER_KEY_SET);
  for (const error of frontmatter.errors) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "storyBible.keyword.frontmatter.invalid", error, relativePath));
  }

  const definition = parseKeywordFrontmatter(workspaceRoot, relativePath, frontmatter, diagnostics);
  return { definition, diagnostics };
}

export function stringifyCardMarkdown(
  card: Omit<StoryBibleCardDto, "keywordLabels" | "title" | "primaryKeyword" | "path"> & { path?: string },
  body: string,
  existing?: Pick<FrontmatterDocument, "unknownChunks">
): string {
  return stringifyMarkdownFrontmatter(
    {
      schemaVersion: STORY_BIBLE_SCHEMA_VERSION,
      id: card.id,
      type: card.type,
      name: card.name,
      aliases: card.aliases,
      tags: card.tags,
      summary: card.summary,
      visibility: card.visibility,
      status: card.status,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      ...(card.chapterRefs === undefined ? {} : { chapterRefs: card.chapterRefs })
    },
    CARD_FRONTMATTER_KEYS,
    body,
    existing
  );
}

export function stringifyKeywordDefinitionMarkdown(
  keyword: Omit<KeywordDefinitionDto, "path">,
  body: string,
  existing?: Pick<FrontmatterDocument, "unknownChunks">
): string {
  return stringifyMarkdownFrontmatter(
    {
      schemaVersion: STORY_BIBLE_SCHEMA_VERSION,
      schema: STORY_BIBLE_TAG_SCHEMA_ID,
      slug: keyword.slug,
      label: keyword.label,
      description: keyword.description,
      category: keyword.category,
      appliesTo: keyword.appliesTo,
      createdAt: keyword.createdAt,
      updatedAt: keyword.updatedAt
    },
    KEYWORD_FRONTMATTER_KEYS,
    body,
    existing
  );
}

export function cardTypeDirectory(type: StoryBibleCardType): string {
  return CARD_TYPE_DIRS[type];
}

export function storyBibleCardTypeFromPath(relativePath: string): StoryBibleCardType | undefined {
  const normalized = normalizeRelativePath(relativePath);
  for (const [type, directory] of Object.entries(CARD_TYPE_DIRS)) {
    if (normalized.startsWith(`${directory}/`) && normalized.endsWith(".md")) {
      return type as StoryBibleCardType;
    }
  }
  return undefined;
}

export function keywordDefinitionPath(slug: string): string {
  return normalizeRelativePath(`${STORY_BIBLE_TAG_DIR}/${normalizeKeywordSlugInput(slug)}.md`);
}

export async function resolveExistingSafeStoryBiblePath(
  workspaceRoot: string,
  relativePath: string
): Promise<string | undefined> {
  if (!isStoryBibleContentPath(relativePath) && !isStoryBibleTrashPath(relativePath)) {
    return undefined;
  }

  const inspection = await inspectExistingWorkspacePath(workspaceRoot, normalizeRelativePath(relativePath));
  return inspection.status === "safe" ? inspection.absolutePath : undefined;
}

export function isStoryBibleContentPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === LORE_DIR || normalized.startsWith(`${LORE_DIR}/`);
}

export function isStoryBibleTrashPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === STORY_BIBLE_TRASH_DIR || normalized.startsWith(`${STORY_BIBLE_TRASH_DIR}/`);
}

export function isStoryBibleTrashItemPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized.startsWith(`${STORY_BIBLE_TRASH_DIR}/`)) {
    return false;
  }

  const itemSegment = normalized.slice(STORY_BIBLE_TRASH_DIR.length + 1);
  return itemSegment !== "" && !itemSegment.includes("/");
}

export function diagnostic(
  workspaceRoot: string,
  severity: DiagnosticItem["severity"],
  code: string,
  message: string,
  relativePath?: string
): DiagnosticItem {
  return {
    severity,
    code,
    message,
    workspaceFolder: workspaceRoot,
    relativePath: relativePath ? normalizeRelativePath(relativePath) : undefined
  };
}

async function inspectStoryBibleDirectories(
  workspaceRoot: string,
  diagnostics: DiagnosticItem[]
): Promise<Record<string, { status: "safe" | "missing" | "unsafe"; absolutePath: string }>> {
  const result: Record<string, { status: "safe" | "missing" | "unsafe"; absolutePath: string }> = {};
  for (const directory of [
    LORE_DIR,
    STORY_BIBLE_CHARACTER_DIR,
    STORY_BIBLE_LOCATION_DIR,
    STORY_BIBLE_RULE_DIR,
    STORY_BIBLE_TAG_DIR
  ]) {
    const inspection = await inspectExistingWorkspacePath(workspaceRoot, directory);
    result[directory] = inspection;

    if (inspection.status === "unsafe") {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "error",
          "storyBible.directory.unsafePath",
          `故事圣经目录 "${directory}" 解析到了工作区之外，或经过了不安全的符号链接。`,
          directory
        )
      );
    } else if (inspection.status === "safe") {
      const stats = await fs.stat(inspection.absolutePath);
      if (!stats.isDirectory()) {
        diagnostics.push(
          diagnostic(workspaceRoot, "error", "storyBible.directory.notDirectory", `"${directory}" 不是目录。`, directory)
        );
      }
    } else if (directory !== LORE_DIR) {
      diagnostics.push(
        diagnostic(workspaceRoot, "warning", "storyBible.directory.missing", `故事圣经目录 "${directory}" 缺失。`, directory)
      );
    }
  }

  return result;
}

async function readCardFile(
  workspaceRoot: string,
  relativePath: string,
  expectedType: StoryBibleCardType,
  manuscriptReader: ManuscriptReader | undefined,
  diagnostics: DiagnosticItem[]
): Promise<ParsedStoryBibleCard | undefined> {
  const absolutePath = await resolveExistingSafeStoryBiblePath(workspaceRoot, relativePath);
  if (!absolutePath) {
    diagnostics.push(
      diagnostic(workspaceRoot, "error", "storyBible.card.file.unsafePath", `条目文件 "${relativePath}" 路径不安全。`, relativePath)
    );
    return undefined;
  }

  const text = await fs.readFile(absolutePath, "utf8");
  const parsed = await parseCardText(workspaceRoot, relativePath, text, expectedType, manuscriptReader);
  diagnostics.push(...parsed.diagnostics);
  return parsed.card;
}

async function parseCardFrontmatter(
  workspaceRoot: string,
  relativePath: string,
  frontmatter: FrontmatterDocument,
  expectedType: StoryBibleCardType,
  manuscriptReader: ManuscriptReader | undefined,
  diagnostics: DiagnosticItem[]
): Promise<ParsedStoryBibleCard | undefined> {
  const data = frontmatter.data;
  const add = (severity: DiagnosticItem["severity"], code: string, message: string) =>
    diagnostics.push(diagnostic(workspaceRoot, severity, code, message, relativePath));

  if (!frontmatter.hasFrontmatter) {
    return undefined;
  }

  if (data.schemaVersion !== STORY_BIBLE_SCHEMA_VERSION) {
    add("error", "storyBible.card.schemaVersion.unsupported", `条目 schemaVersion 必须是 "${STORY_BIBLE_SCHEMA_VERSION}"。`);
  }

  const id = nonEmptyString<StoryBibleCardId>(data.id);
  const type = parseCardType(data.type);
  const name = nonEmptyString(data.name);
  const aliases = parseStringArray(data.aliases);
  const tags = parseStringArray(data.tags).map((item) => normalizeKeywordSlugInput(item) as KeywordSlug);
  const summary = typeof data.summary === "string" ? data.summary : undefined;
  const visibility = STORY_BIBLE_VISIBILITIES.includes(data.visibility as StoryBibleVisibility)
    ? (data.visibility as StoryBibleVisibility)
    : undefined;
  const status = STORY_BIBLE_STATUSES.includes(data.status as StoryBibleStatus)
    ? (data.status as StoryBibleStatus)
    : undefined;
  const createdAt = nonEmptyString(data.createdAt);
  const updatedAt = nonEmptyString(data.updatedAt);
  const chapterRefs = data.chapterRefs === undefined ? undefined : parseStringArray(data.chapterRefs);

  if (!id) {
    add("error", "storyBible.card.id.invalid", "条目 id 必须是非空字符串。");
  }
  if (!type) {
    add("error", "storyBible.card.type.invalid", "条目 type 必须是 character、location 或 rule。");
  } else if (type !== expectedType) {
    add("error", "storyBible.card.type.dirMismatch", `条目 type "${type}" 与目录类型 "${expectedType}" 不一致。`);
  }
  if (!name) {
    add("error", "storyBible.card.name.invalid", "条目 name 必须是非空字符串。");
  }
  if (!Array.isArray(data.aliases)) {
    add("error", "storyBible.card.aliases.invalid", "aliases 必须是字符串数组。");
  }
  if (!Array.isArray(data.tags)) {
    add("error", "storyBible.card.tags.invalid", "tags 必须是字符串数组。");
  }
  if (summary === undefined) {
    add("error", "storyBible.card.summary.invalid", "summary 必须是字符串。");
  }
  if (!visibility) {
    add("error", "storyBible.card.visibility.invalid", "visibility 必须是 public、spoiler 或 private。");
  }
  if (!status) {
    add("error", "storyBible.card.status.invalid", "status 必须是 draft、canon 或 archived。");
  }
  if (!isIsoTimestamp(createdAt)) {
    add("error", "storyBible.card.createdAt.invalid", "createdAt 必须是 ISO 时间戳字符串。");
  }
  if (!isIsoTimestamp(updatedAt)) {
    add("error", "storyBible.card.updatedAt.invalid", "updatedAt 必须是 ISO 时间戳字符串。");
  }
  if (data.chapterRefs !== undefined && !Array.isArray(data.chapterRefs)) {
    add("error", "storyBible.card.chapterRefs.invalid", "chapterRefs 必须是字符串数组。");
  }

  addArrayDiagnostics("aliases", aliases, add);
  addArrayDiagnostics("tags", tags, add);

  for (const tag of tags) {
    if (!isValidKeywordSlug(tag)) {
      add("warning", "storyBible.card.tagSlug.invalid", `keyword slug "${tag}" 不合法。`);
    }
    if (isReservedObjectKeywordSlug(tag) && type && !tag.startsWith(objectKeywordPrefixFor(type))) {
      add("warning", "storyBible.card.tag.reservedPrefixMismatch", `对象关键词 "${tag}" 与条目 type "${type}" 不匹配。`);
    }
  }

  if (tags.length === 0 || !type || !tags[0].startsWith(objectKeywordPrefixFor(type))) {
    add("warning", "storyBible.card.primaryKeyword.missing", "tags[0] 必须是当前条目 type 的对象主关键词。");
  }

  if (chapterRefs && manuscriptReader) {
    for (const chapterRef of chapterRefs) {
      if (!(await manuscriptReader.getChapter(chapterRef as ChapterId))) {
        add("warning", "storyBible.card.chapterRefs.missing", `chapterRefs 引用了不存在的章节 "${chapterRef}"。`);
      }
    }
  }

  if (
    diagnostics.some((item) => item.relativePath === normalizeRelativePath(relativePath) && item.severity === "error") ||
    !id ||
    !type ||
    !name ||
    summary === undefined ||
    !visibility ||
    !status ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  return {
    frontmatter,
    body: frontmatter.body,
    dto: {
      id,
      type,
      name,
      aliases,
      tags,
      primaryKeyword: (tags[0] ?? "") as KeywordSlug,
      keywordLabels: {},
      summary,
      visibility,
      status,
      createdAt,
      updatedAt,
      path: normalizeRelativePath(relativePath),
      title: markdownH1(frontmatter.body),
      ...(chapterRefs === undefined ? {} : { chapterRefs })
    }
  };
}

async function readKeywordFile(
  workspaceRoot: string,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): Promise<ParsedKeywordDefinition | undefined> {
  const absolutePath = await resolveExistingSafeStoryBiblePath(workspaceRoot, relativePath);
  if (!absolutePath) {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "error",
        "storyBible.keyword.file.unsafePath",
        `Keyword 定义文件 "${relativePath}" 路径不安全。`,
        relativePath
      )
    );
    return undefined;
  }

  const text = await fs.readFile(absolutePath, "utf8");
  const parsed = parseKeywordDefinitionText(workspaceRoot, relativePath, text);
  diagnostics.push(...parsed.diagnostics);
  return parsed.definition;
}

async function addOrphanMarkdownDiagnostics(
  workspaceRoot: string,
  loreInspection: { status: "safe" | "missing" | "unsafe"; absolutePath: string },
  diagnostics: DiagnosticItem[]
): Promise<void> {
  if (loreInspection.status !== "safe") {
    return;
  }

  for (const relativePath of await listMarkdownFiles(loreInspection.absolutePath, workspaceRoot)) {
    const normalized = normalizeRelativePath(relativePath);
    const inCardDirectory = storyBibleCardTypeFromPath(normalized) !== undefined;
    const inKeywordDirectory = normalized.startsWith(`${STORY_BIBLE_TAG_DIR}/`);
    if (!inCardDirectory && !inKeywordDirectory) {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "warning",
          "storyBible.orphanMarkdown",
          `Markdown 文件 "${normalized}" 不在故事圣经 v0.2 支持的目录中。`,
          normalized
        )
      );
    }
  }
}

function parseKeywordFrontmatter(
  workspaceRoot: string,
  relativePath: string,
  frontmatter: FrontmatterDocument,
  diagnostics: DiagnosticItem[]
): ParsedKeywordDefinition | undefined {
  const data = frontmatter.data;
  const add = (severity: DiagnosticItem["severity"], code: string, message: string) =>
    diagnostics.push(diagnostic(workspaceRoot, severity, code, message, relativePath));

  if (!frontmatter.hasFrontmatter) {
    return undefined;
  }

  if (data.schemaVersion !== STORY_BIBLE_SCHEMA_VERSION) {
    add("error", "storyBible.keyword.schemaVersion.unsupported", `Keyword schemaVersion 必须是 "${STORY_BIBLE_SCHEMA_VERSION}"。`);
  }
  if (data.schema !== STORY_BIBLE_TAG_SCHEMA_ID) {
    add("error", "storyBible.keyword.schema.invalid", `Keyword 定义 schema 必须是 "${STORY_BIBLE_TAG_SCHEMA_ID}"。`);
  }

  const slug = nonEmptyString(data.slug);
  const label = nonEmptyString(data.label);
  const description = typeof data.description === "string" ? data.description : undefined;
  const category = nonEmptyString(data.category);
  const appliesTo = parseStringArray(data.appliesTo);
  const createdAt = nonEmptyString(data.createdAt);
  const updatedAt = nonEmptyString(data.updatedAt);

  if (!slug || !isValidKeywordSlug(slug)) {
    add("error", "storyBible.keyword.slug.invalid", "Keyword slug 必须是合法的小写 ASCII slug。");
  }
  if (slug && isReservedObjectKeywordSlug(slug)) {
    add("error", "storyBible.keyword.slug.reservedPrefix", "普通关键词定义不能使用 character/、location/ 或 rule/ 保留前缀。");
  }
  if (slug && normalizeRelativePath(relativePath) !== keywordDefinitionPath(slug)) {
    add("warning", "storyBible.keyword.path.slugMismatch", `Keyword 定义路径应为 "${keywordDefinitionPath(slug)}"。`);
  }
  if (!label) {
    add("error", "storyBible.keyword.label.invalid", "Keyword label 必须是非空字符串。");
  }
  if (description === undefined) {
    add("error", "storyBible.keyword.description.invalid", "Keyword description 必须是字符串。");
  }
  if (!category || !isValidKeywordSlug(category)) {
    add("error", "storyBible.keyword.category.invalid", "Keyword category 必须是合法 slug。");
  }
  if (!Array.isArray(data.appliesTo)) {
    add("error", "storyBible.keyword.appliesTo.invalid", "appliesTo 必须是字符串数组。");
  }
  for (const target of appliesTo) {
    if (target !== "any" && !STORY_BIBLE_CARD_TYPES.includes(target as StoryBibleCardType)) {
      add("warning", "storyBible.keyword.appliesTo.unknown", `appliesTo 包含 v0.2 未知条目类型 "${target}"。`);
    }
  }
  if (!isIsoTimestamp(createdAt)) {
    add("error", "storyBible.keyword.createdAt.invalid", "createdAt 必须是 ISO 时间戳字符串。");
  }
  if (!isIsoTimestamp(updatedAt)) {
    add("error", "storyBible.keyword.updatedAt.invalid", "updatedAt 必须是 ISO 时间戳字符串。");
  }

  if (
    diagnostics.some((item) => item.relativePath === normalizeRelativePath(relativePath) && item.severity === "error") ||
    !slug ||
    !label ||
    description === undefined ||
    !category ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  return {
    frontmatter,
    body: frontmatter.body,
    dto: {
      slug: normalizeKeywordSlugInput(slug) as KeywordSlug,
      label,
      description,
      category,
      appliesTo,
      createdAt,
      updatedAt,
      path: normalizeRelativePath(relativePath)
    }
  };
}

function buildKeywordCatalog(
  cards: StoryBibleCardDto[],
  definitions: KeywordDefinitionDto[]
): KeywordCatalogEntryDto[] {
  const usage = new Map<string, Set<StoryBibleCardId>>();
  const objectLabels = new Map<string, string>();
  const systemKeywords = new Set<string>();

  for (const card of cards) {
    for (const tag of new Set(card.tags)) {
      const set = usage.get(tag) ?? new Set<StoryBibleCardId>();
      set.add(card.id);
      usage.set(tag, set);

      if (isReservedObjectKeywordSlug(tag)) {
        systemKeywords.add(tag);
        if (tag === card.primaryKeyword || !objectLabels.has(tag)) {
          objectLabels.set(tag, card.name);
        }
      }
    }
  }

  const definitionBySlug = new Map(definitions.map((definition) => [definition.slug as string, definition]));
  const slugs = new Set<string>([...usage.keys(), ...definitionBySlug.keys()]);
  const entries = [...slugs].map((slug): KeywordCatalogEntryDto => {
    const definition = definitionBySlug.get(slug);
    const source = systemKeywords.has(slug) ? "system-object" : definition ? "user-defined" : "inferred";
    const label = objectLabels.get(slug) ?? definition?.label ?? keywordLabelFromSlug(slug);

    return {
      slug: slug as KeywordSlug,
      label,
      description: definition?.description ?? "",
      category: definition?.category ?? (source === "system-object" ? "object" : "custom"),
      appliesTo: definition?.appliesTo ?? ["any"],
      usageCount: usage.get(slug)?.size ?? 0,
      ...(definition ? { definitionPath: definition.path } : {}),
      source
    };
  });

  return entries.sort((left, right) => left.slug.localeCompare(right.slug));
}

function addCrossFileDiagnostics(
  workspaceRoot: string,
  cards: ParsedStoryBibleCard[],
  definitions: ParsedKeywordDefinition[],
  diagnostics: DiagnosticItem[]
): void {
  const ids = new Map<string, string[]>();
  const primaryKeywords = new Map<string, string[]>();
  const definitionSlugs = new Map<string, string[]>();
  const namesByType = new Map<string, { label: string; paths: string[] }>();
  const aliasesByType = new Map<string, { label: string; paths: string[] }>();

  for (const card of cards) {
    pushMap(ids, card.dto.id, card.dto.path);
    pushMap(primaryKeywords, card.dto.primaryKeyword, card.dto.path);
    pushLabelMap(namesByType, `${card.dto.type}:${normalizeComparableText(card.dto.name)}`, card.dto.name, card.dto.path);
    for (const alias of card.dto.aliases) {
      if (alias.trim() === "") {
        continue;
      }
      pushLabelMap(aliasesByType, `${card.dto.type}:${normalizeComparableText(alias)}`, alias, card.dto.path);
    }
  }

  for (const definition of definitions) {
    pushMap(definitionSlugs, definition.dto.slug, definition.dto.path);
  }

  for (const [id, paths] of ids.entries()) {
    if (paths.length > 1) {
      for (const relativePath of paths) {
        diagnostics.push(diagnostic(workspaceRoot, "error", "storyBible.card.id.duplicate", `条目 id "${id}" 重复。`, relativePath));
      }
    }
  }

  for (const [slug, paths] of primaryKeywords.entries()) {
    if (paths.length > 1) {
      for (const relativePath of paths) {
        diagnostics.push(
          diagnostic(
            workspaceRoot,
            "warning",
            "storyBible.card.primaryKeyword.duplicate",
            `对象主关键词 "${slug}" 被多个条目使用。`,
            relativePath
          )
        );
      }
    }
  }

  for (const [slug, paths] of definitionSlugs.entries()) {
    if (paths.length > 1) {
      for (const relativePath of paths) {
        diagnostics.push(
          diagnostic(workspaceRoot, "warning", "storyBible.keyword.slug.duplicate", `Keyword 定义 slug "${slug}" 重复。`, relativePath)
        );
      }
    }
  }

  for (const duplicate of namesByType.values()) {
    const uniquePaths = [...new Set(duplicate.paths)];
    if (uniquePaths.length > 1) {
      for (const relativePath of uniquePaths) {
        diagnostics.push(
          diagnostic(workspaceRoot, "warning", "storyBible.card.name.duplicate", `同类型下条目 name "${duplicate.label}" 重复。`, relativePath)
        );
      }
    }
  }

  for (const duplicate of aliasesByType.values()) {
    const uniquePaths = [...new Set(duplicate.paths)];
    if (uniquePaths.length > 1) {
      for (const relativePath of uniquePaths) {
        diagnostics.push(
          diagnostic(workspaceRoot, "warning", "storyBible.card.alias.duplicate", `同类型下条目 alias "${duplicate.label}" 重复。`, relativePath)
        );
      }
    }
  }
}

async function listStoryBibleTrashItems(
  workspaceRoot: string,
  diagnostics: DiagnosticItem[]
): Promise<StoryBibleTrashItemDto[]> {
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, STORY_BIBLE_TRASH_DIR);
  if (inspection.status === "missing") {
    return [];
  }
  if (inspection.status === "unsafe") {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "error",
        "storyBible.trash.unsafePath",
        "故事圣经资源垃圾桶路径不安全。",
        STORY_BIBLE_TRASH_DIR
      )
    );
    return [];
  }

  const entries = await fs.readdir(inspection.absolutePath, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFound(error) || isNotDirectory(error)) {
      return [];
    }
    throw error;
  });
  const items: StoryBibleTrashItemDto[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const trashPath = normalizeRelativePath(`${STORY_BIBLE_TRASH_DIR}/${entry.name}`);
    const metadataPath = normalizeRelativePath(`${trashPath}/${STORY_BIBLE_TRASH_METADATA}`);
    const metadataInspection = await inspectExistingWorkspacePath(workspaceRoot, metadataPath);
    if (metadataInspection.status !== "safe") {
      diagnostics.push(
        diagnostic(workspaceRoot, "warning", "storyBible.trash.metadata.missing", `资源垃圾桶元数据 "${metadataPath}" 缺失或不安全。`, metadataPath)
      );
      continue;
    }

    try {
      const metadata = JSON.parse(await fs.readFile(metadataInspection.absolutePath, "utf8")) as Record<string, unknown>;
      const item = parseTrashItemMetadata(workspaceRoot, metadata, metadataPath);
      if (item) {
        items.push(item);
      } else {
        diagnostics.push(
          diagnostic(workspaceRoot, "warning", "storyBible.trash.metadata.invalid", `资源垃圾桶元数据 "${metadataPath}" 字段不完整或不安全。`, metadataPath)
        );
      }
    } catch {
      diagnostics.push(
        diagnostic(workspaceRoot, "warning", "storyBible.trash.metadata.invalid", `资源垃圾桶元数据 "${metadataPath}" 损坏。`, metadataPath)
      );
    }
  }

  return items.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

function parseTrashItemMetadata(
  workspaceRoot: string,
  value: Record<string, unknown>,
  metadataPath: string
): StoryBibleTrashItemDto | undefined {
  const id = nonEmptyString<StoryBibleTrashItemId>(value.id);
  const resourceType = value.resourceType === "card" || value.resourceType === "keyword-definition" ? value.resourceType : undefined;
  const cardType = parseCardType(value.cardType);
  const title = nonEmptyString(value.title);
  const deletedAt = nonEmptyString(value.deletedAt);
  const originalPath = nonEmptyString(value.originalPath);
  const trashPath = nonEmptyString(value.trashPath);
  const originalFileName = nonEmptyString(value.originalFileName);
  const cardId = nonEmptyString<StoryBibleCardId>(value.cardId);
  const keywordSlug = nonEmptyString<KeywordSlug>(value.keywordSlug);

  if (!id || !resourceType || !title || !deletedAt || !originalPath || !trashPath || !originalFileName) {
    return undefined;
  }
  if (resourceType === "card" && !cardType) {
    return undefined;
  }
  const normalizedTrashPath = normalizeRelativePath(trashPath);
  if (
    !isStoryBibleTrashItemPath(normalizedTrashPath) ||
    normalizeRelativePath(metadataPath) !== normalizeRelativePath(`${normalizedTrashPath}/${STORY_BIBLE_TRASH_METADATA}`)
  ) {
    return undefined;
  }
  if (!isStoryBibleContentPath(originalPath)) {
    return undefined;
  }
  if (!isIsoTimestamp(deletedAt)) {
    return undefined;
  }

  return {
    id,
    resourceType,
    ...(cardType ? { cardType } : {}),
    title,
    deletedAt,
    originalPath: normalizeRelativePath(originalPath),
    trashPath: normalizeRelativePath(trashPath),
    originalFileName,
    ...(cardId ? { cardId } : {}),
    ...(keywordSlug ? { keywordSlug } : {})
  };
}

async function listMarkdownFiles(root: string, workspaceRoot: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFound(error) || isNotDirectory(error)) {
      return [];
    }
    throw error;
  });
  const result: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listMarkdownFiles(absolutePath, workspaceRoot)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      result.push(normalizeRelativePath(path.relative(workspaceRoot, absolutePath)));
    }
  }

  return result.sort();
}

function parseCardType(value: unknown): StoryBibleCardType | undefined {
  return STORY_BIBLE_CARD_TYPES.includes(value as StoryBibleCardType) ? (value as StoryBibleCardType) : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

function addArrayDiagnostics(
  label: "aliases" | "tags",
  values: string[],
  add: (severity: DiagnosticItem["severity"], code: string, message: string) => void
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (value === "") {
      add("warning", `storyBible.card.${label}.empty`, `${label} 包含空值。`);
      continue;
    }
    if (seen.has(value)) {
      add("warning", `storyBible.card.${label}.duplicate`, `${label} 包含重复值 "${value}"。`);
    }
    seen.add(value);
  }
}

function nonEmptyString<T extends string = string>(value: unknown): T | undefined {
  return typeof value === "string" && value.trim() !== "" ? (value.trim() as T) : undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const items = map.get(key) ?? [];
  items.push(value);
  map.set(key, items);
}

function pushLabelMap(
  map: Map<string, { label: string; paths: string[] }>,
  key: string,
  label: string,
  pathValue: string
): void {
  const item = map.get(key) ?? { label, paths: [] };
  item.paths.push(pathValue);
  map.set(key, item);
}

function normalizeComparableText(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}
