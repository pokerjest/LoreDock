import * as fs from "fs/promises";
import * as path from "path";
import { validateProjectManifest } from "../../kernel/manifest";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { MANIFEST_RELATIVE_PATH, type DiagnosticItem } from "../../kernel/types";
import { MANUSCRIPT_CAPABILITY_ID, type ChapterId, type ManuscriptReader } from "../manuscript/types";
import { STORY_BIBLE_CAPABILITY_ID, type StoryBibleCardDto, type StoryBibleReader } from "../storyBible/types";
import {
  parseMarkdownFrontmatter,
  type FrontmatterDocument
} from "../storyBible/frontmatter";
import { resolveOutlineMarkdown } from "./outlineParser";
import {
  OUTLINE_SCENES_CAPABILITY_ID,
  OUTLINE_SCENES_SCHEMA_VERSION,
  OUTLINE_SCENES_TRASH_DIR,
  OUTLINE_SCENES_TRASH_METADATA,
  OUTLINES_DIR,
  SCENE_STATUSES,
  SCENES_DIR,
  type OutlineDocumentDto,
  type OutlineListItemDto,
  type OutlineScenesTrashItemDto,
  type SceneCardDto,
  type SceneId,
  type SceneStatus
} from "./types";

export const SCENE_FRONTMATTER_KEYS = [
  "schemaVersion",
  "id",
  "title",
  "chapterRefs",
  "chapterId",
  "order",
  "pov",
  "locationRefs",
  "characterRefs",
  "plotlineRefs",
  "conflict",
  "turn",
  "outcome",
  "status",
  "createdAt",
  "updatedAt",
  "sourceOutline",
  "sourceLine"
];

const SCENE_FRONTMATTER_KEY_SET = new Set(SCENE_FRONTMATTER_KEYS);

export interface ParsedSceneCard {
  dto: SceneCardDto;
  frontmatter: FrontmatterDocument;
  body: string;
}

export interface OutlineScenesReadResult {
  status: "missing" | "valid" | "degraded";
  diagnostics: DiagnosticItem[];
  scenes: ParsedSceneCard[];
  outlines: OutlineDocumentDto[];
  outlineItems: OutlineListItemDto[];
  trashItems: OutlineScenesTrashItemDto[];
}

interface StoryReferenceContext {
  characterIds: Set<string>;
  locationIds: Set<string>;
  characterKeywords: Set<string>;
  locationKeywords: Set<string>;
  ordinaryKeywords: Set<string>;
}

export async function readOutlineScenes(
  workspaceRoot: string,
  manuscriptReader?: ManuscriptReader,
  storyBibleReader?: StoryBibleReader
): Promise<OutlineScenesReadResult> {
  const diagnostics: DiagnosticItem[] = [];
  const dirs = await inspectOutlineSceneDirectories(workspaceRoot, diagnostics);
  const anyDirectoryExists = [dirs[OUTLINES_DIR], dirs[SCENES_DIR]].some((inspection) => inspection.status === "safe");
  const storyContext = storyBibleReader ? await createStoryReferenceContext(storyBibleReader) : undefined;
  const outlines: OutlineDocumentDto[] = [];
  const outlineItems: OutlineListItemDto[] = [];
  const scenes: ParsedSceneCard[] = [];

  if (dirs[OUTLINES_DIR].status === "safe") {
    for (const relativePath of await listMarkdownFiles(dirs[OUTLINES_DIR].absolutePath, workspaceRoot)) {
      const parsed = await resolveOutlineMarkdown(workspaceRoot, relativePath);
      diagnostics.push(...parsed.diagnostics);
      outlines.push(parsed.outline);
      outlineItems.push({
        path: relativePath,
        title: parsed.outline.title,
        status: parsed.diagnostics.some((item) => item.severity === "error") ? "degraded" : "valid"
      });
    }
  }

  if (dirs[SCENES_DIR].status === "safe") {
    for (const relativePath of await listMarkdownFiles(dirs[SCENES_DIR].absolutePath, workspaceRoot)) {
      const parsed = await readSceneFile(workspaceRoot, relativePath, manuscriptReader, storyContext, diagnostics);
      if (parsed) {
        scenes.push(parsed);
      }
    }
  }

  addCrossSceneDiagnostics(workspaceRoot, scenes, diagnostics);
  const trashItems = await listOutlineScenesTrashItems(workspaceRoot, diagnostics);
  if (!anyDirectoryExists) {
    return { status: "missing", diagnostics, scenes, outlines, outlineItems, trashItems };
  }

  return {
    status: diagnostics.some((item) => item.severity === "error") ? "degraded" : "valid",
    diagnostics,
    scenes,
    outlines,
    outlineItems,
    trashItems
  };
}

export async function isOutlineScenesCapabilityEnabled(workspaceRoot: string): Promise<boolean> {
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, MANIFEST_RELATIVE_PATH);
  if (inspection.status !== "safe") {
    return false;
  }

  try {
    const value = JSON.parse(await fs.readFile(inspection.absolutePath, "utf8")) as unknown;
    const validation = validateProjectManifest(
      value,
      workspaceRoot,
      new Set([OUTLINE_SCENES_CAPABILITY_ID, MANUSCRIPT_CAPABILITY_ID, STORY_BIBLE_CAPABILITY_ID])
    );
    return validation.isValid && Boolean(validation.manifest?.capabilities.includes(OUTLINE_SCENES_CAPABILITY_ID));
  } catch {
    return false;
  }
}

export async function parseSceneText(
  workspaceRoot: string,
  relativePath: string,
  text: string,
  manuscriptReader?: ManuscriptReader,
  storyContext?: StoryReferenceContext
): Promise<{ scene?: ParsedSceneCard; diagnostics: DiagnosticItem[] }> {
  const diagnostics: DiagnosticItem[] = [];
  const frontmatter = parseMarkdownFrontmatter(text, SCENE_FRONTMATTER_KEY_SET);
  for (const error of frontmatter.errors) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.frontmatter.invalid", error, relativePath));
  }

  const scene = await parseSceneFrontmatter(
    workspaceRoot,
    relativePath,
    frontmatter,
    manuscriptReader,
    storyContext,
    diagnostics
  );
  return { scene, diagnostics };
}

export function stringifySceneMarkdown(
  scene: Omit<SceneCardDto, "path"> & { path?: string },
  body: string,
  existing?: Pick<FrontmatterDocument, "unknownChunks">
): string {
  const lines = ["---"];
  appendStringField(lines, "schemaVersion", OUTLINE_SCENES_SCHEMA_VERSION);
  appendStringField(lines, "id", scene.id);
  appendStringField(lines, "title", scene.title);
  appendArrayField(lines, "chapterRefs", scene.chapterRefs);
  lines.push(`order: ${scene.order}`);
  appendStringField(lines, "pov", scene.pov);
  appendArrayField(lines, "locationRefs", scene.locationRefs);
  appendArrayField(lines, "characterRefs", scene.characterRefs);
  appendArrayField(lines, "plotlineRefs", scene.plotlineRefs);
  appendStringField(lines, "conflict", scene.conflict);
  appendStringField(lines, "turn", scene.turn);
  appendStringField(lines, "outcome", scene.outcome);
  appendStringField(lines, "status", scene.status);
  appendStringField(lines, "createdAt", scene.createdAt);
  appendStringField(lines, "updatedAt", scene.updatedAt);
  if (scene.sourceOutline !== undefined) {
    appendStringField(lines, "sourceOutline", scene.sourceOutline);
  }
  if (scene.sourceLine !== undefined) {
    lines.push(`sourceLine: ${scene.sourceLine}`);
  }
  for (const chunk of existing?.unknownChunks ?? []) {
    if (chunk.trim() !== "") {
      lines.push(...chunk.split("\n"));
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${body.replace(/\r\n/g, "\n")}`;
}

export function createSceneTemplateBody(title: string, beats: string[] = []): string {
  const beatLines = beats.length === 0 ? ["- "] : beats.map((beat) => `- ${beat}`);
  return [
    `# ${title}`,
    "",
    "## 场景目的",
    "",
    "## Beats",
    "",
    ...beatLines,
    "",
    "## 备注",
    ""
  ].join("\n");
}

export function isOutlineSceneContentPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    normalized === OUTLINES_DIR ||
    normalized.startsWith(`${OUTLINES_DIR}/`) ||
    normalized === SCENES_DIR ||
    normalized.startsWith(`${SCENES_DIR}/`)
  );
}

export function isOutlineSceneTrashPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === OUTLINE_SCENES_TRASH_DIR || normalized.startsWith(`${OUTLINE_SCENES_TRASH_DIR}/`);
}

export function outlineScenesTrashMetadataPath(trashPath: string): string {
  return normalizeRelativePath(`${trashPath}/${OUTLINE_SCENES_TRASH_METADATA}`);
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

async function readSceneFile(
  workspaceRoot: string,
  relativePath: string,
  manuscriptReader: ManuscriptReader | undefined,
  storyContext: StoryReferenceContext | undefined,
  diagnostics: DiagnosticItem[]
): Promise<ParsedSceneCard | undefined> {
  const text = await fs.readFile(path.join(workspaceRoot, relativePath), "utf8");
  const parsed = await parseSceneText(workspaceRoot, relativePath, text, manuscriptReader, storyContext);
  diagnostics.push(...parsed.diagnostics);
  return parsed.scene;
}

async function parseSceneFrontmatter(
  workspaceRoot: string,
  relativePath: string,
  frontmatter: FrontmatterDocument,
  manuscriptReader: ManuscriptReader | undefined,
  storyContext: StoryReferenceContext | undefined,
  diagnostics: DiagnosticItem[]
): Promise<ParsedSceneCard | undefined> {
  const data = frontmatter.data;
  const schemaVersion = requireString(workspaceRoot, data, "schemaVersion", relativePath, diagnostics);
  const id = requireString(workspaceRoot, data, "id", relativePath, diagnostics);
  const title = requireString(workspaceRoot, data, "title", relativePath, diagnostics);
  const chapterRefs = readChapterRefs(workspaceRoot, data, relativePath, diagnostics);
  const order = requirePositiveInteger(workspaceRoot, data, "order", relativePath, diagnostics);
  const status = requireSceneStatus(workspaceRoot, data, "status", relativePath, diagnostics);
  const createdAt = requireIsoTimestamp(workspaceRoot, data, "createdAt", relativePath, diagnostics);
  const updatedAt = requireIsoTimestamp(workspaceRoot, data, "updatedAt", relativePath, diagnostics);
  const locationRefs = requireStringArray(workspaceRoot, data, "locationRefs", relativePath, diagnostics);
  const characterRefs = requireStringArray(workspaceRoot, data, "characterRefs", relativePath, diagnostics);
  const plotlineRefs = requireStringArray(workspaceRoot, data, "plotlineRefs", relativePath, diagnostics);

  if (schemaVersion && schemaVersion !== OUTLINE_SCENES_SCHEMA_VERSION) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.schemaVersion.unsupported", `场景卡 schemaVersion 必须是 "${OUTLINE_SCENES_SCHEMA_VERSION}"。`, relativePath));
  }
  if (manuscriptReader) {
    for (const chapterRef of chapterRefs) {
      if (!(await manuscriptReader.getChapter(chapterRef as ChapterId))) {
        diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.chapterRefs.missing", `场景卡引用了不存在的章节 "${chapterRef}"。`, relativePath));
      }
    }
  }
  validateStoryReferences(workspaceRoot, relativePath, "characterRefs", characterRefs, "character", storyContext, diagnostics);
  validateStoryReferences(workspaceRoot, relativePath, "locationRefs", locationRefs, "location", storyContext, diagnostics);

  if (!id || !title || order === undefined || !status || !createdAt || !updatedAt) {
    return undefined;
  }

  return {
    dto: {
      id: id as SceneId,
      title,
      chapterRefs: chapterRefs as ChapterId[],
      order,
      pov: optionalString(data.pov),
      locationRefs,
      characterRefs,
      plotlineRefs,
      conflict: optionalString(data.conflict),
      turn: optionalString(data.turn),
      outcome: optionalString(data.outcome),
      status,
      createdAt,
      updatedAt,
      path: normalizeRelativePath(relativePath),
      ...(optionalString(data.sourceOutline) ? { sourceOutline: optionalString(data.sourceOutline) } : {}),
      ...(optionalPositiveInteger(data.sourceLine) ? { sourceLine: optionalPositiveInteger(data.sourceLine) } : {})
    },
    frontmatter,
    body: frontmatter.body
  };
}

async function inspectOutlineSceneDirectories(
  workspaceRoot: string,
  diagnostics: DiagnosticItem[]
): Promise<Record<string, { status: "safe" | "missing" | "unsafe"; absolutePath: string }>> {
  const result: Record<string, { status: "safe" | "missing" | "unsafe"; absolutePath: string }> = {};
  for (const directory of [OUTLINES_DIR, SCENES_DIR, OUTLINE_SCENES_TRASH_DIR]) {
    const inspection = await inspectExistingWorkspacePath(workspaceRoot, directory);
    result[directory] = inspection;
    if (inspection.status === "unsafe") {
      diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.path.unsafe", `路径 "${directory}" 不安全。`, directory));
    }
  }
  return result;
}

async function listMarkdownFiles(directory: string, workspaceRoot: string): Promise<string[]> {
  const result: string[] = [];
  await walk(directory, result);
  return result
    .map((absolutePath) => normalizeRelativePath(path.relative(workspaceRoot, absolutePath)))
    .filter((relativePath) => relativePath.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));
}

async function walk(directory: string, result: string[]): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, result);
    } else if (entry.isFile()) {
      result.push(absolutePath);
    }
  }
}

async function listOutlineScenesTrashItems(
  workspaceRoot: string,
  diagnostics: DiagnosticItem[]
): Promise<OutlineScenesTrashItemDto[]> {
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, OUTLINE_SCENES_TRASH_DIR);
  if (inspection.status !== "safe") {
    return [];
  }

  const result: OutlineScenesTrashItemDto[] = [];
  const entries = await fs.readdir(inspection.absolutePath, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const metadataPath = normalizeRelativePath(`${OUTLINE_SCENES_TRASH_DIR}/${entry.name}/${OUTLINE_SCENES_TRASH_METADATA}`);
    const metadataInspection = await inspectExistingWorkspacePath(workspaceRoot, metadataPath);
    if (metadataInspection.status !== "safe") {
      diagnostics.push(diagnostic(workspaceRoot, "warning", "outlineScenes.trash.metadata.missing", "场景卡垃圾桶元数据缺失或不安全。", metadataPath));
      continue;
    }

    try {
      const value = JSON.parse(await fs.readFile(metadataInspection.absolutePath, "utf8")) as OutlineScenesTrashItemDto;
      result.push({
        ...value,
        trashPath: normalizeRelativePath(value.trashPath),
        originalPath: normalizeRelativePath(value.originalPath)
      });
    } catch {
      diagnostics.push(diagnostic(workspaceRoot, "warning", "outlineScenes.trash.metadata.invalid", "场景卡垃圾桶元数据不是有效 JSON。", metadataPath));
    }
  }
  return result.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

function addCrossSceneDiagnostics(workspaceRoot: string, scenes: ParsedSceneCard[], diagnostics: DiagnosticItem[]): void {
  const seenIds = new Map<string, string>();
  const orderByChapter = new Map<string, Map<number, string>>();
  for (const scene of scenes) {
    const existing = seenIds.get(scene.dto.id);
    if (existing) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.id.duplicate", `场景 ID "${scene.dto.id}" 重复。`, scene.dto.path));
      diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.id.duplicate", `场景 ID "${scene.dto.id}" 重复。`, existing));
    } else {
      seenIds.set(scene.dto.id, scene.dto.path);
    }

    for (const chapterRef of scene.dto.chapterRefs) {
      const chapterOrders = orderByChapter.get(chapterRef) ?? new Map<number, string>();
      const sameOrderPath = chapterOrders.get(scene.dto.order);
      if (sameOrderPath) {
        diagnostics.push(diagnostic(workspaceRoot, "warning", "outlineScenes.scene.order.duplicate", `章节 "${chapterRef}" 下存在重复场景 order ${scene.dto.order}。`, scene.dto.path));
        diagnostics.push(diagnostic(workspaceRoot, "warning", "outlineScenes.scene.order.duplicate", `章节 "${chapterRef}" 下存在重复场景 order ${scene.dto.order}。`, sameOrderPath));
      } else {
        chapterOrders.set(scene.dto.order, scene.dto.path);
        orderByChapter.set(chapterRef, chapterOrders);
      }
    }
  }
}

async function createStoryReferenceContext(reader: StoryBibleReader): Promise<StoryReferenceContext> {
  const [cards, keywords] = await Promise.all([reader.listCards(), reader.listKeywords()]);
  return {
    characterIds: new Set(cards.filter((card) => card.type === "character").map((card) => card.id)),
    locationIds: new Set(cards.filter((card) => card.type === "location").map((card) => card.id)),
    characterKeywords: new Set(objectKeywords(cards, "character")),
    locationKeywords: new Set(objectKeywords(cards, "location")),
    ordinaryKeywords: new Set(keywords.map((keyword) => keyword.slug as string))
  };
}

function objectKeywords(cards: StoryBibleCardDto[], type: "character" | "location"): string[] {
  return cards.filter((card) => card.type === type).flatMap((card) => card.tags);
}

function validateStoryReferences(
  workspaceRoot: string,
  relativePath: string,
  field: "characterRefs" | "locationRefs",
  refs: string[],
  type: "character" | "location",
  context: StoryReferenceContext | undefined,
  diagnostics: DiagnosticItem[]
): void {
  if (!context) {
    return;
  }

  for (const ref of refs) {
    const ok =
      type === "character"
        ? context.characterIds.has(ref) || context.characterKeywords.has(ref) || context.ordinaryKeywords.has(ref)
        : context.locationIds.has(ref) || context.locationKeywords.has(ref) || context.ordinaryKeywords.has(ref);
    if (!ok) {
      diagnostics.push(diagnostic(workspaceRoot, "warning", `outlineScenes.scene.${field}.missing`, `${field} 引用了无法解析的 ${type} 引用 "${ref}"。`, relativePath));
    }
  }
}

function requireString(
  workspaceRoot: string,
  data: Record<string, unknown>,
  key: string,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): string | undefined {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    diagnostics.push(diagnostic(workspaceRoot, "error", `outlineScenes.scene.${key}.invalid`, `${key} 必须是非空字符串。`, relativePath));
    return undefined;
  }
  return value.trim();
}

function requireStringArray(
  workspaceRoot: string,
  data: Record<string, unknown>,
  key: string,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): string[] {
  const value = data[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    diagnostics.push(diagnostic(workspaceRoot, "error", `outlineScenes.scene.${key}.invalid`, `${key} 必须是字符串数组。`, relativePath));
    return [];
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function readChapterRefs(
  workspaceRoot: string,
  data: Record<string, unknown>,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): string[] {
  const refs = data.chapterRefs;
  if (refs !== undefined) {
    if (!Array.isArray(refs) || !refs.every((item) => typeof item === "string")) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.chapterRefs.invalid", "chapterRefs 必须是字符串数组。", relativePath));
      return [];
    }
    return uniqueStrings(refs.map((item) => item.trim()).filter(Boolean));
  }

  const legacyRef = data.chapterId;
  if (legacyRef === undefined) {
    return [];
  }
  if (typeof legacyRef !== "string" || legacyRef.trim() === "") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outlineScenes.scene.chapterId.invalid", "chapterId 必须是非空字符串。", relativePath));
    return [];
  }
  return [legacyRef.trim()];
}

function requirePositiveInteger(
  workspaceRoot: string,
  data: Record<string, unknown>,
  key: string,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): number | undefined {
  const value = optionalPositiveInteger(data[key]);
  if (value === undefined) {
    diagnostics.push(diagnostic(workspaceRoot, "error", `outlineScenes.scene.${key}.invalid`, `${key} 必须是正整数。`, relativePath));
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requireSceneStatus(
  workspaceRoot: string,
  data: Record<string, unknown>,
  key: string,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): SceneStatus | undefined {
  const value = data[key];
  if (typeof value === "string" && SCENE_STATUSES.includes(value as SceneStatus)) {
    return value as SceneStatus;
  }
  diagnostics.push(diagnostic(workspaceRoot, "error", `outlineScenes.scene.${key}.invalid`, `${key} 必须是合法场景状态。`, relativePath));
  return undefined;
}

function requireIsoTimestamp(
  workspaceRoot: string,
  data: Record<string, unknown>,
  key: string,
  relativePath: string,
  diagnostics: DiagnosticItem[]
): string | undefined {
  const value = data[key];
  if (typeof value === "string" && isIsoTimestamp(value)) {
    return value;
  }
  diagnostics.push(diagnostic(workspaceRoot, "error", `outlineScenes.scene.${key}.invalid`, `${key} 必须是 ISO 时间戳字符串。`, relativePath));
  return undefined;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function appendStringField(lines: string[], key: string, value: string): void {
  lines.push(`${key}: ${JSON.stringify(value)}`);
}

function appendArrayField(lines: string[], key: string, values: string[]): void {
  if (values.length === 0) {
    lines.push(`${key}: []`);
    return;
  }
  lines.push(`${key}:`);
  for (const value of values) {
    lines.push(`  - ${JSON.stringify(value)}`);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
