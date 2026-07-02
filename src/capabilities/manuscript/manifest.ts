import * as fs from "fs/promises";
import * as path from "path";
import { LOREDOCK_DIR, type DiagnosticItem } from "../../kernel/types";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { bookAgentPath, bookAgentPaths, bookSystemAgentPath, inspectBookSystemAgentText } from "./bookAgent";
import { createBookId, createChapterId, createVolumeId } from "./ids";
import {
  MANUSCRIPT_DIR,
  MANUSCRIPT_MANIFEST_PATH,
  MANUSCRIPT_NOTES_PATH,
  MANUSCRIPT_SCHEMA_VERSION,
  MANUSCRIPT_STATUSES,
  type BookId,
  type ChapterId,
  type ManuscriptBook,
  type ManuscriptChapter,
  type ManuscriptManifest,
  type ManuscriptStatus,
  type ManuscriptTrash,
  type ManuscriptTrashItem,
  type ManuscriptTrashKind,
  type ManuscriptVolume,
  type TrashItemId,
  type VolumeId
} from "./types";

export type ManuscriptManifestReadResult =
  | { status: "missing"; diagnostics: DiagnosticItem[] }
  | { status: "invalidJson"; diagnostics: DiagnosticItem[] }
  | { status: "degraded"; diagnostics: DiagnosticItem[] }
  | { status: "valid"; diagnostics: DiagnosticItem[]; manifest: ManuscriptManifest };

export function createInitialManuscriptManifest(now = new Date(), bookTitle = "第一本书"): ManuscriptManifest {
  const timestamp = now.toISOString();
  const bookId = createBookId();
  const volumeId = createVolumeId();
  const chapterId = createChapterId();
  const volumePath = `${MANUSCRIPT_DIR}/volume-001`;

  return {
    schemaVersion: MANUSCRIPT_SCHEMA_VERSION,
    book: {
      id: bookId,
      title: bookTitle.trim() || "第一本书"
    },
    volumeIds: [volumeId],
    volumes: {
      [volumeId]: {
        id: volumeId,
        title: "第一卷",
        path: volumePath,
        chapterIds: [chapterId],
        nextChapterNumber: 2
      }
    },
    chapters: {
      [chapterId]: {
        id: chapterId,
        volumeId,
        title: "第一章",
        status: "draft",
        path: `${volumePath}/chapter-001.md`,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    trash: {
      itemIds: [],
      items: {}
    }
  };
}

export async function readManuscriptManifestStructure(workspaceRoot: string): Promise<ManuscriptManifestReadResult> {
  const manifestPath = await inspectExistingManuscriptPath(workspaceRoot, MANUSCRIPT_MANIFEST_PATH);

  if (manifestPath.status === "unsafe") {
    return {
      status: "degraded",
      diagnostics: [
        diagnostic(
          workspaceRoot,
          "error",
          "manuscript.manifest.path.unsafe",
          "手稿清单解析到了工作区之外，或经过了不安全的符号链接。"
        )
      ]
    };
  }

  try {
    const text = await fs.readFile(manifestPath.absolutePath, "utf8");
    let value: unknown;

    try {
      value = JSON.parse(text);
    } catch {
      return {
        status: "invalidJson",
        diagnostics: [
          diagnostic(workspaceRoot, "error", "manuscript.manifest.json.invalid", "手稿清单不是有效 JSON。")
        ]
      };
    }

    const validation = validateManuscriptManifest(value, workspaceRoot);
    if (!validation.manifest) {
      return { status: "degraded", diagnostics: validation.diagnostics };
    }

    return { status: "valid", diagnostics: validation.diagnostics, manifest: validation.manifest };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        status: "missing",
        diagnostics: [
          diagnostic(workspaceRoot, "error", "manuscript.manifest.missing", "缺少手稿清单。")
        ]
      };
    }

    throw error;
  }
}

export async function readManuscriptManifest(workspaceRoot: string): Promise<ManuscriptManifestReadResult> {
  const structure = await readManuscriptManifestStructure(workspaceRoot);
  if (structure.status !== "valid") {
    return structure;
  }

  const fileDiagnostics = await validateManuscriptFiles(structure.manifest, workspaceRoot);
  const diagnostics = [...structure.diagnostics, ...fileDiagnostics];
  const hasErrors = diagnostics.some((item) => item.severity === "error");

  return hasErrors
    ? { status: "degraded", diagnostics }
    : { status: "valid", diagnostics, manifest: structure.manifest };
}

export function validateManuscriptManifest(
  value: unknown,
  workspaceRoot: string
): { diagnostics: DiagnosticItem[]; manifest?: ManuscriptManifest } {
  const diagnostics: DiagnosticItem[] = [];
  const add = (severity: DiagnosticItem["severity"], code: string, message: string, relativePath = MANUSCRIPT_MANIFEST_PATH): void => {
    diagnostics.push(diagnostic(workspaceRoot, severity, code, message, relativePath));
  };

  if (!isRecord(value)) {
    add("error", "manuscript.manifest.notObject", "手稿清单必须是 JSON 对象。");
    return { diagnostics };
  }

  if ("bookIds" in value || "books" in value || "nextBookNumber" in value) {
    add(
      "error",
      "manuscript.manifest.legacyMultiBook.unsupported",
      "检测到 pre-1.0 多书手稿结构。当前版本采用“一个工作区文件夹 = 一本书 = 一套故事圣经”，请为每本书创建独立文件夹并重新初始化 LoreDock。"
    );
    return { diagnostics };
  }

  if (value.schemaVersion !== MANUSCRIPT_SCHEMA_VERSION) {
    add(
      "error",
      "manuscript.manifest.schemaVersion.unsupported",
      `不支持手稿 schemaVersion "${String(value.schemaVersion)}"。`
    );
  }

  if (!isIsoTimestamp(value.createdAt)) {
    add("error", "manuscript.manifest.createdAt.invalid", "createdAt 必须是 ISO 时间戳字符串。");
  }

  if (!isIsoTimestamp(value.updatedAt)) {
    add("error", "manuscript.manifest.updatedAt.invalid", "updatedAt 必须是 ISO 时间戳字符串。");
  }

  const book = parseBook(value.book, "book", add);
  const volumeIds = parseIdArray<VolumeId>(value.volumeIds, "volumeIds", add);
  const volumes = parseRecord<ManuscriptVolume>(value.volumes, "volumes", parseVolume, add);
  const chapters = parseRecord<ManuscriptChapter>(value.chapters, "chapters", parseChapter, add);
  const trash = parseTrash(value.trash, add);

  validateIdUniqueness(volumeIds, "volume list", add);
  validateIdUniqueness(Object.values(volumes).map((item) => item.id), "volume", add);
  validateIdUniqueness(Object.values(chapters).map((item) => item.id), "chapter", add);

  for (const id of volumeIds) {
    if (!volumes[id]) {
      add("error", "manuscript.volume.reference.missing", `volumeIds 引用了缺失的卷 "${id}"。`);
    }
  }

  for (const [key, volume] of Object.entries(volumes)) {
    if (key !== volume.id) {
      add("error", "manuscript.volume.keyMismatch", `卷键 "${key}" 与 id "${volume.id}" 不一致。`);
    }

    if (!volumeIds.includes(volume.id)) {
      add("warning", "manuscript.volume.unlisted", `卷 "${volume.id}" 未出现在 volumeIds 中。`);
    }

    validateManuscriptRelativePath(volume.path, `卷“${volume.title}”路径`, add);
    for (const chapterId of volume.chapterIds) {
      const chapter = chapters[chapterId];
      if (!chapter) {
        add("error", "manuscript.chapter.reference.missing", `卷 "${volume.id}" 引用了缺失的章节 "${chapterId}"。`);
      } else if (chapter.volumeId !== volume.id) {
        add("error", "manuscript.chapter.volumeId.mismatch", `章节 "${chapterId}" 的 volumeId 不匹配。`);
      }
    }
  }

  const seenChapterPaths = new Set<string>();
  for (const [key, chapter] of Object.entries(chapters)) {
    if (key !== chapter.id) {
      add("error", "manuscript.chapter.keyMismatch", `章节键 "${key}" 与 id "${chapter.id}" 不一致。`);
    }

    if (!volumes[chapter.volumeId]) {
      add("error", "manuscript.chapter.volumeId.missing", `章节 "${chapter.id}" 引用了缺失的卷 "${chapter.volumeId}"。`);
    }

    validateManuscriptRelativePath(chapter.path, `章节“${chapter.title}”路径`, add);
    if (seenChapterPaths.has(chapter.path)) {
      add("error", "manuscript.chapter.path.duplicate", `章节路径 "${chapter.path}" 重复。`, chapter.path);
    }
    seenChapterPaths.add(chapter.path);
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return { diagnostics };
  }

  return {
    diagnostics,
    manifest: {
      schemaVersion: MANUSCRIPT_SCHEMA_VERSION,
      book: book as ManuscriptBook,
      volumeIds,
      volumes,
      chapters,
      createdAt: value.createdAt as string,
      updatedAt: value.updatedAt as string,
      trash
    }
  };
}

export function stringifyManuscriptManifest(manifest: ManuscriptManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function cloneManifest(manifest: ManuscriptManifest): ManuscriptManifest {
  return JSON.parse(JSON.stringify(manifest)) as ManuscriptManifest;
}

export function assertNonEmptyTitle(title: string): string {
  if (title.trim() === "") {
    throw new Error("标题不能为空。");
  }
  return title.trim();
}

export function assertTargetWordCount(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("targetWordCount 必须是正整数。");
  }

  return value;
}

export function isManuscriptPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === MANUSCRIPT_DIR || normalized.startsWith(`${MANUSCRIPT_DIR}/`);
}

export async function resolveExistingSafeManuscriptPath(
  workspaceRoot: string,
  relativePath: string
): Promise<string | undefined> {
  const result = await inspectExistingManuscriptPath(workspaceRoot, relativePath);
  return result.status === "safe" ? result.absolutePath : undefined;
}

async function validateManuscriptFiles(
  manifest: ManuscriptManifest,
  workspaceRoot: string
): Promise<DiagnosticItem[]> {
  const diagnostics: DiagnosticItem[] = [];
  const manifestPaths = new Set(Object.values(manifest.chapters).map((chapter) => normalizeRelativePath(chapter.path)));
  const notesPath = normalizeRelativePath(MANUSCRIPT_NOTES_PATH);
  const agentPaths = bookAgentPaths();

  const notesInspection = await inspectExistingManuscriptPath(workspaceRoot, notesPath);
  if (notesInspection.status === "missing") {
    diagnostics.push(
      diagnostic(workspaceRoot, "warning", "manuscript.notes.missing", `全局手稿笔记 "${notesPath}" 缺失。`, notesPath)
    );
  } else if (notesInspection.status === "unsafe") {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "error",
        "manuscript.notes.unsafePath",
        `全局手稿笔记 "${notesPath}" 解析到了工作区之外，或经过了不安全的符号链接。`,
        notesPath
      )
    );
  } else {
    try {
      const stats = await fs.stat(notesInspection.absolutePath);
      if (!stats.isFile()) {
        diagnostics.push(
          diagnostic(workspaceRoot, "error", "manuscript.notes.notFile", `全局手稿笔记 "${notesPath}" 不是文件。`, notesPath)
        );
      }
    } catch (error) {
      if (isNotFound(error)) {
        diagnostics.push(
          diagnostic(workspaceRoot, "warning", "manuscript.notes.missing", `全局手稿笔记 "${notesPath}" 缺失。`, notesPath)
        );
      } else {
        throw error;
      }
    }
  }

  await validateBookSystemAgentFile(manifest.book, workspaceRoot, diagnostics);
  await validateBookUserAgentFile(workspaceRoot, diagnostics);

  for (const chapter of Object.values(manifest.chapters)) {
    const inspection = await inspectExistingManuscriptPath(workspaceRoot, chapter.path);
    if (inspection.status === "missing") {
      diagnostics.push(
        diagnostic(workspaceRoot, "warning", "manuscript.chapter.file.missing", `章节文件 "${chapter.path}" 缺失。`, chapter.path)
      );
      continue;
    }

    if (inspection.status === "unsafe") {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "error",
          "manuscript.chapter.file.unsafePath",
          `章节文件 "${chapter.path}" 解析到了工作区之外，或经过了不安全的符号链接。`,
          chapter.path
        )
      );
      continue;
    }

    try {
      const stats = await fs.stat(inspection.absolutePath);
      if (!stats.isFile()) {
        diagnostics.push(
          diagnostic(workspaceRoot, "error", "manuscript.chapter.file.notFile", `章节路径 "${chapter.path}" 不是文件。`, chapter.path)
        );
      }
    } catch (error) {
      if (isNotFound(error)) {
        diagnostics.push(
          diagnostic(workspaceRoot, "warning", "manuscript.chapter.file.missing", `章节文件 "${chapter.path}" 缺失。`, chapter.path)
        );
      } else {
        throw error;
      }
    }
  }

  const manuscriptRoot = await resolveExistingSafeManuscriptPath(workspaceRoot, MANUSCRIPT_DIR);
  const markdownFiles = manuscriptRoot ? await listMarkdownFiles(manuscriptRoot, workspaceRoot) : [];
  for (const relativePath of markdownFiles) {
    if (relativePath === notesPath || manifestPaths.has(relativePath) || agentPaths.has(relativePath)) {
      continue;
    }

    diagnostics.push(
      diagnostic(workspaceRoot, "warning", "manuscript.orphanMarkdown", `游离的手稿 Markdown 文件 "${relativePath}"。`, relativePath)
    );
  }

  return diagnostics;
}

async function validateBookSystemAgentFile(
  book: ManuscriptBook,
  workspaceRoot: string,
  diagnostics: DiagnosticItem[]
): Promise<void> {
  const agentPath = bookSystemAgentPath();
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, agentPath);
  if (inspection.status === "missing") {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "warning",
        "manuscript.book.agent.system.missing",
        `书籍系统 AI 指南 "${agentPath}" 缺失。`,
        agentPath
      )
    );
    return;
  }

  if (inspection.status === "unsafe") {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "warning",
        "manuscript.book.agent.system.unsafePath",
        `书籍系统 AI 指南 "${agentPath}" 解析到了工作区之外，或经过了不安全的符号链接。`,
        agentPath
      )
    );
    return;
  }

  try {
    const stats = await fs.stat(inspection.absolutePath);
    if (!stats.isFile()) {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "warning",
          "manuscript.book.agent.system.notFile",
          `书籍系统 AI 指南 "${agentPath}" 不是文件。`,
          agentPath
        )
      );
      return;
    }

    const systemRulesIssue = inspectBookSystemAgentText(await fs.readFile(inspection.absolutePath, "utf8"), book.title);
    if (systemRulesIssue === "modified") {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "warning",
          "manuscript.book.agent.system.modified",
          `书籍系统 AI 指南 "${agentPath}" 不是当前插件版本。`,
          agentPath
        )
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "warning",
          "manuscript.book.agent.system.missing",
          `书籍系统 AI 指南 "${agentPath}" 缺失。`,
          agentPath
        )
      );
      return;
    }
    throw error;
  }
}

async function validateBookUserAgentFile(
  workspaceRoot: string,
  diagnostics: DiagnosticItem[]
): Promise<void> {
  const agentPath = bookAgentPath();
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, agentPath);
  if (inspection.status === "missing") {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "warning",
        "manuscript.book.agent.user.missing",
        `书籍用户 AI 指南 "${agentPath}" 缺失。`,
        agentPath
      )
    );
    return;
  }

  if (inspection.status === "unsafe") {
    diagnostics.push(
      diagnostic(
        workspaceRoot,
        "warning",
        "manuscript.book.agent.user.unsafePath",
        `书籍用户 AI 指南 "${agentPath}" 解析到了工作区之外，或经过了不安全的符号链接。`,
        agentPath
      )
    );
    return;
  }

  try {
    const stats = await fs.stat(inspection.absolutePath);
    if (!stats.isFile()) {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "warning",
          "manuscript.book.agent.user.notFile",
          `书籍用户 AI 指南 "${agentPath}" 不是文件。`,
          agentPath
        )
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      diagnostics.push(
        diagnostic(
          workspaceRoot,
          "warning",
          "manuscript.book.agent.user.missing",
          `书籍用户 AI 指南 "${agentPath}" 缺失。`,
          agentPath
        )
      );
      return;
    }
    throw error;
  }
}

type ExistingPathInspection =
  | { status: "safe"; absolutePath: string }
  | { status: "missing"; absolutePath: string }
  | { status: "unsafe"; absolutePath: string };

async function inspectExistingManuscriptPath(
  workspaceRoot: string,
  relativePath: string
): Promise<ExistingPathInspection> {
  const normalized = normalizeRelativePath(relativePath);
  const workspaceAbsolutePath = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(workspaceRoot, normalized);

  if (
    path.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !isManuscriptPath(normalized) ||
    !isInside(workspaceAbsolutePath, absolutePath)
  ) {
    return { status: "unsafe", absolutePath };
  }

  try {
    const workspaceRealPath = await fs.realpath(workspaceRoot);
    const realPath = await fs.realpath(absolutePath);
    return isInside(workspaceRealPath, realPath)
      ? { status: "safe", absolutePath }
      : { status: "unsafe", absolutePath };
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }

    return (await pathExistsOrBrokenLink(absolutePath))
      ? { status: "unsafe", absolutePath }
      : { status: "missing", absolutePath };
  }
}

function parseBook(value: unknown, pathLabel: string, add: AddDiagnostic): ManuscriptBook | undefined {
  if (!isRecord(value)) {
    add("error", "manuscript.book.invalid", `${pathLabel} 必须是对象。`);
    return undefined;
  }

  const id = parseNonEmptyString<BookId>(value.id, `${pathLabel}.id`, add);
  const title = parseTitle(value.title, `${pathLabel}.title`, add);

  if (!id || !title) {
    return undefined;
  }

  return { id, title };
}

function parseVolume(value: unknown, pathLabel: string, add: AddDiagnostic): ManuscriptVolume | undefined {
  if (!isRecord(value)) {
    add("error", "manuscript.volume.invalid", `${pathLabel} 必须是对象。`);
    return undefined;
  }

  const id = parseNonEmptyString<VolumeId>(value.id, `${pathLabel}.id`, add);
  const title = parseTitle(value.title, `${pathLabel}.title`, add);
  const pathValue = parseNonEmptyString<string>(value.path, `${pathLabel}.path`, add);
  const chapterIds = parseIdArray<ChapterId>(value.chapterIds, `${pathLabel}.chapterIds`, add);

  if (!isPositiveInteger(value.nextChapterNumber)) {
    add("error", "manuscript.volume.nextChapterNumber.invalid", `${pathLabel}.nextChapterNumber 必须是正整数。`);
  }

  if (!id || !title || !pathValue || !isPositiveInteger(value.nextChapterNumber)) {
    return undefined;
  }

  return {
    id,
    title,
    path: normalizeRelativePath(pathValue),
    chapterIds,
    nextChapterNumber: value.nextChapterNumber
  };
}

function parseChapter(value: unknown, pathLabel: string, add: AddDiagnostic): ManuscriptChapter | undefined {
  if (!isRecord(value)) {
    add("error", "manuscript.chapter.invalid", `${pathLabel} 必须是对象。`);
    return undefined;
  }

  const id = parseNonEmptyString<ChapterId>(value.id, `${pathLabel}.id`, add);
  const volumeId = parseNonEmptyString<VolumeId>(value.volumeId, `${pathLabel}.volumeId`, add);
  const title = parseTitle(value.title, `${pathLabel}.title`, add);
  const pathValue = parseNonEmptyString<string>(value.path, `${pathLabel}.path`, add);

  if (!MANUSCRIPT_STATUSES.includes(value.status as ManuscriptStatus)) {
    add("error", "manuscript.chapter.status.invalid", `${pathLabel}.status 不是支持的章节状态。`);
  }

  if (!isIsoTimestamp(value.createdAt)) {
    add("error", "manuscript.chapter.createdAt.invalid", `${pathLabel}.createdAt 必须是 ISO 时间戳字符串。`);
  }

  if (!isIsoTimestamp(value.updatedAt)) {
    add("error", "manuscript.chapter.updatedAt.invalid", `${pathLabel}.updatedAt 必须是 ISO 时间戳字符串。`);
  }

  if (value.targetWordCount !== undefined && !isPositiveInteger(value.targetWordCount)) {
    add("error", "manuscript.chapter.targetWordCount.invalid", `${pathLabel}.targetWordCount 必须是正整数。`);
  }

  if (!id || !volumeId || !title || !pathValue || !MANUSCRIPT_STATUSES.includes(value.status as ManuscriptStatus)) {
    return undefined;
  }

  return {
    id,
    volumeId,
    title,
    status: value.status as ManuscriptStatus,
    path: normalizeRelativePath(pathValue),
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    ...(value.targetWordCount === undefined ? {} : { targetWordCount: value.targetWordCount as number })
  };
}

function parseTrash(value: unknown, add: AddDiagnostic): ManuscriptTrash {
  if (value === undefined) {
    return { itemIds: [], items: {} };
  }

  if (!isRecord(value)) {
    add("error", "manuscript.trash.invalid", "trash 必须是对象。");
    return { itemIds: [], items: {} };
  }

  const itemIds = parseIdArray<TrashItemId>(value.itemIds, "trash.itemIds", add);
  const items = parseRecord<ManuscriptTrashItem>(value.items, "trash.items", parseTrashItem, add);

  validateIdUniqueness(itemIds, "trash item list", add);
  validateIdUniqueness(Object.values(items).map((item) => item.id), "trash item", add);

  for (const id of itemIds) {
    if (!items[id]) {
      add("error", "manuscript.trash.item.reference.missing", `trash.itemIds 引用了缺失的回收站条目 "${id}"。`);
    }
  }

  for (const [key, item] of Object.entries(items)) {
    if (key !== item.id) {
      add("error", "manuscript.trash.item.keyMismatch", `回收站条目键 "${key}" 与 id "${item.id}" 不一致。`);
    }
  }

  return { itemIds, items };
}

function parseTrashItem(value: unknown, pathLabel: string, add: AddDiagnostic): ManuscriptTrashItem | undefined {
  if (!isRecord(value)) {
    add("error", "manuscript.trash.item.invalid", `${pathLabel} 必须是对象。`);
    return undefined;
  }

  const id = parseNonEmptyString<TrashItemId>(value.id, `${pathLabel}.id`, add);
  const kind = parseTrashKind(value.kind, `${pathLabel}.kind`, add);
  const title = parseTitle(value.title, `${pathLabel}.title`, add);
  const originalPath = parseNonEmptyString<string>(value.originalPath, `${pathLabel}.originalPath`, add);
  const trashPath = parseNonEmptyString<string>(value.trashPath, `${pathLabel}.trashPath`, add);
  const volumes = parseRecord<ManuscriptVolume>(value.volumes, `${pathLabel}.volumes`, parseVolume, add);
  const chapters = parseRecord<ManuscriptChapter>(value.chapters, `${pathLabel}.chapters`, parseChapter, add);

  if (!isIsoTimestamp(value.deletedAt)) {
    add("error", "manuscript.trash.item.deletedAt.invalid", `${pathLabel}.deletedAt 必须是 ISO 时间戳字符串。`);
  }

  if (originalPath) {
    validateManuscriptRelativePath(originalPath, `${pathLabel}.originalPath`, add);
  }
  if (trashPath) {
    validateTrashRelativePath(trashPath, `${pathLabel}.trashPath`, add);
  }

  if (!id || !kind || !title || !originalPath || !trashPath || !isIsoTimestamp(value.deletedAt)) {
    return undefined;
  }

  return {
    id,
    kind,
    title,
    deletedAt: value.deletedAt as string,
    originalPath: normalizeRelativePath(originalPath),
    trashPath: normalizeRelativePath(trashPath),
    volumes,
    chapters
  };
}

function parseTrashKind(value: unknown, label: string, add: AddDiagnostic): ManuscriptTrashKind | undefined {
  if (value === "volume" || value === "chapter") {
    return value;
  }

  add("error", "manuscript.trash.item.kind.invalid", `${label} 必须是 volume 或 chapter。`);
  return undefined;
}

type AddDiagnostic = (
  severity: DiagnosticItem["severity"],
  code: string,
  message: string,
  relativePath?: string
) => void;

function parseRecord<T>(
  value: unknown,
  label: string,
  parse: (value: unknown, pathLabel: string, add: AddDiagnostic) => T | undefined,
  add: AddDiagnostic
): Record<string, T> {
  if (!isRecord(value)) {
    add("error", `manuscript.${label}.invalid`, `${label} 必须是对象。`);
    return {};
  }

  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = parse(item, `${label}.${key}`, add);
    if (parsed) {
      result[key] = parsed;
    }
  }
  return result;
}

function parseIdArray<T extends string>(value: unknown, label: string, add: AddDiagnostic): T[] {
  if (!Array.isArray(value)) {
    add("error", `manuscript.${label}.invalid`, `${label} 必须是数组。`);
    return [];
  }

  const result: T[] = [];
  value.forEach((item, index) => {
    const id = parseNonEmptyString<T>(item, `${label}[${index}]`, add);
    if (id) {
      result.push(id);
    }
  });
  return result;
}

function parseTitle(value: unknown, label: string, add: AddDiagnostic): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    add("error", "manuscript.title.invalid", `${label} 必须是非空字符串。`);
    return undefined;
  }

  return value;
}

function parseNonEmptyString<T extends string>(value: unknown, label: string, add: AddDiagnostic): T | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    add("error", "manuscript.string.invalid", `${label} 必须是非空字符串。`);
    return undefined;
  }

  return value as T;
}

function validateIdUniqueness(ids: string[], label: string, add: AddDiagnostic): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      add("error", `manuscript.${label}.id.duplicate`, `${label} ID "${id}" 重复。`);
    }
    seen.add(id);
  }
}

function validateManuscriptRelativePath(value: string, label: string, add: AddDiagnostic): void {
  const normalized = normalizeRelativePath(value);
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    add("error", "manuscript.path.notRelative", `${label} 必须是工作区相对路径。`, value);
    return;
  }

  if (!isManuscriptPath(normalized)) {
    add("error", "manuscript.path.outsideManuscript", `${label} 必须位于 manuscript/ 目录下。`, value);
  }
}

function validateTrashRelativePath(value: string, label: string, add: AddDiagnostic): void {
  const normalized = normalizeRelativePath(value);
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    add("error", "manuscript.trash.path.notRelative", `${label} 必须是工作区相对路径。`, value);
    return;
  }

  if (!normalized.startsWith(`${LOREDOCK_DIR}/trash/manuscript/`)) {
    add("error", "manuscript.trash.path.outsideTrash", `${label} 必须位于 .loredock/trash/manuscript/ 目录下。`, value);
  }
}

async function listMarkdownFiles(root: string, workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        paths.push(...(await listMarkdownFiles(absolutePath, workspaceRoot)));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        paths.push(normalizeRelativePath(path.relative(workspaceRoot, absolutePath)));
      }
    }

    return paths;
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

function diagnostic(
  workspaceRoot: string,
  severity: DiagnosticItem["severity"],
  code: string,
  message: string,
  relativePath = MANUSCRIPT_MANIFEST_PATH
): DiagnosticItem {
  return {
    severity,
    code,
    message,
    workspaceFolder: workspaceRoot,
    relativePath: normalizeRelativePath(relativePath)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function pathExistsOrBrokenLink(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}
