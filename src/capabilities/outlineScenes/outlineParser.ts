import * as fs from "fs/promises";
import * as path from "path";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import type { DiagnosticItem } from "../../kernel/types";
import { createStableOutlineNodeId } from "./ids";
import {
  OUTLINES_DIR,
  type OutlineBeatDto,
  type OutlineChapterDraftDto,
  type OutlineDocumentDto,
  type OutlineDraftScope,
  type OutlineIncludeDto,
  type OutlineSceneDraftDto,
  type OutlineVolumeDraftDto
} from "./types";

export interface OutlineParseResult {
  outline: OutlineDocumentDto;
  diagnostics: DiagnosticItem[];
}

interface ParseState {
  currentVolume?: OutlineVolumeDraftDto;
  currentChapter?: OutlineChapterDraftDto;
  currentScene?: OutlineSceneDraftDto;
  seenContent: boolean;
  explicitScope: boolean;
}

const SCOPE_ALIASES: Record<string, OutlineDraftScope> = {
  book: "book",
  volume: "volume",
  chapter: "chapter",
  scene: "scene",
  "书": "book",
  "卷": "volume",
  "章": "chapter",
  "场景": "scene"
};

export function parseOutlineMarkdown(
  workspaceRoot: string,
  relativePath: string,
  text: string
): OutlineParseResult {
  const normalizedPath = normalizeOutlinePath(relativePath);
  const diagnostics: DiagnosticItem[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const outline: OutlineDocumentDto = {
    path: normalizedPath,
    title: titleFromPath(normalizedPath),
    scope: "book",
    includes: [],
    volumes: []
  };
  const state: ParseState = {
    seenContent: false,
    explicitScope: false
  };
  let inFrontmatter = lines[0] === "---";
  let inFence = false;
  let inHtmlBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();

    if (inFrontmatter) {
      if (lineNumber > 1 && trimmed === "---") {
        inFrontmatter = false;
      }
      continue;
    }

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (trimmed.startsWith("<!--")) {
      inHtmlBlock = !trimmed.includes("-->");
      continue;
    }
    if (inHtmlBlock) {
      if (trimmed.includes("-->")) {
        inHtmlBlock = false;
      }
      continue;
    }

    if (trimmed === "") {
      continue;
    }

    const directive = /^@(scope|include)\s+(.+?)\s*$/.exec(trimmed);
    if (directive) {
      readDirective(workspaceRoot, normalizedPath, outline, state, directive[1], directive[2], diagnostics);
      continue;
    }
    if (trimmed.startsWith("@scope") || trimmed.startsWith("@include")) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.directive.invalid", "大纲指令格式无效。", normalizedPath));
      continue;
    }

    const heading = /^(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(line);
    if (heading) {
      state.seenContent = true;
      const level = heading[1].length;
      const title = cleanTitle(heading[2] ?? "");
      if (title === "") {
        diagnostics.push(diagnostic(workspaceRoot, "warning", "outline.heading.empty", "大纲标题为空。", normalizedPath));
      }
      readHeading(workspaceRoot, normalizedPath, outline, state, level, title, lineNumber, diagnostics);
      continue;
    }

    const listItem = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (listItem) {
      state.seenContent = true;
      addBeat(
        workspaceRoot,
        normalizedPath,
        createBeat(normalizedPath, listItem[1].trim(), lineNumber),
        diagnostics,
        outline,
        state
      );
      continue;
    }

    state.seenContent = true;
  }

  return { outline, diagnostics };
}

export async function resolveOutlineMarkdown(
  workspaceRoot: string,
  relativePath: string
): Promise<OutlineParseResult> {
  const diagnostics: DiagnosticItem[] = [];
  const outline = await resolveOutline(workspaceRoot, normalizeOutlinePath(relativePath), [], diagnostics);
  return { outline, diagnostics };
}

async function resolveOutline(
  workspaceRoot: string,
  relativePath: string,
  stack: string[],
  diagnostics: DiagnosticItem[]
): Promise<OutlineDocumentDto> {
  const normalizedPath = normalizeOutlinePath(relativePath);
  if (!isOutlineMarkdownPath(normalizedPath)) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.unsafe", "规划草稿路径必须位于 outlines/ 内。", normalizedPath));
    return emptyOutline(normalizedPath);
  }
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, normalizedPath);
  if (inspection.status === "unsafe") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.unsafe", "规划草稿路径不安全。", normalizedPath));
    return emptyOutline(normalizedPath);
  }
  if (inspection.status === "missing") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.missing", "规划草稿 include 文件不存在。", normalizedPath));
    return emptyOutline(normalizedPath);
  }
  if (!(await isRealPathInsideOutlines(workspaceRoot, inspection.absolutePath))) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.unsafe", "规划草稿真实路径必须位于 outlines/ 内。", normalizedPath));
    return emptyOutline(normalizedPath);
  }

  let text: string;
  try {
    text = await fs.readFile(inspection.absolutePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.missing", "规划草稿 include 文件不存在。", normalizedPath));
      return emptyOutline(normalizedPath);
    }
    throw error;
  }

  const parsed = parseOutlineMarkdown(workspaceRoot, normalizedPath, text);
  diagnostics.push(...parsed.diagnostics);
  const outline = parsed.outline;

  for (const include of outline.includes) {
    if (include.status !== "pending") {
      continue;
    }
    if (stack.includes(include.resolvedPath) || include.resolvedPath === normalizedPath) {
      include.status = "cycle";
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.cycle", `规划草稿 include 存在循环引用：${include.rawPath}`, normalizedPath));
      continue;
    }
    const includeInspection = await inspectExistingWorkspacePath(workspaceRoot, include.resolvedPath);
    if (includeInspection.status === "unsafe") {
      include.status = "unsafe";
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.unsafe", `规划草稿 include 路径不安全：${include.rawPath}`, normalizedPath));
      continue;
    }
    if (includeInspection.status === "missing") {
      include.status = "missing";
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.missing", `规划草稿 include 文件不存在：${include.rawPath}`, normalizedPath));
      continue;
    }
    if (!(await isRealPathInsideOutlines(workspaceRoot, includeInspection.absolutePath))) {
      include.status = "unsafe";
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.unsafe", `规划草稿 include 真实路径不在 ${OUTLINES_DIR}/ 内：${include.rawPath}`, normalizedPath));
      continue;
    }

    const child = await resolveOutline(workspaceRoot, include.resolvedPath, [...stack, normalizedPath], diagnostics);
    include.scope = child.scope;
    if (!canInclude(outline.scope, child.scope)) {
      include.status = "invalid";
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.containment", `「${scopeLabel(outline.scope)}」不能包含「${scopeLabel(child.scope)}」。`, normalizedPath));
      continue;
    }
    include.status = "resolved";
    mergeIncludedOutline(outline, child);
  }

  return outline;
}

function readDirective(
  workspaceRoot: string,
  relativePath: string,
  outline: OutlineDocumentDto,
  state: ParseState,
  directive: string,
  value: string,
  diagnostics: DiagnosticItem[]
): void {
  if (state.seenContent) {
    diagnostics.push(diagnostic(workspaceRoot, "warning", "outline.directive.misplaced", "大纲指令必须位于首个标题前。", relativePath));
    return;
  }

  if (directive === "scope") {
    const normalized = SCOPE_ALIASES[value.trim().toLowerCase()];
    if (!normalized) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "outline.scope.invalid", `未知大纲粒度 "${value.trim()}"。`, relativePath));
      return;
    }
    if (state.explicitScope) {
      diagnostics.push(diagnostic(workspaceRoot, "warning", "outline.scope.duplicate", "大纲只能声明一个 @scope，后续声明已忽略。", relativePath));
      return;
    }
    outline.scope = normalized;
    state.explicitScope = true;
    return;
  }

  const rawPath = unquote(value.trim());
  const resolved = resolveIncludePath(relativePath, rawPath);
  outline.includes.push(resolved);
  if (resolved.status === "unsafe") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.unsafe", `include 路径必须留在 ${OUTLINES_DIR}/ 内。`, relativePath));
  } else if (resolved.status === "invalid") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "outline.include.invalid", "include 只支持 Markdown 文件。", relativePath));
  }
}

function readHeading(
  workspaceRoot: string,
  relativePath: string,
  outline: OutlineDocumentDto,
  state: ParseState,
  level: number,
  title: string,
  line: number,
  diagnostics: DiagnosticItem[]
): void {
  if (outline.scope === "book" || outline.scope === "volume") {
    readBookLikeHeading(workspaceRoot, relativePath, outline, state, level, title, line, diagnostics);
    return;
  }
  if (outline.scope === "chapter") {
    readChapterHeading(workspaceRoot, relativePath, outline, state, level, title, line, diagnostics);
    return;
  }
  readSceneHeading(relativePath, outline, state, level, title, line);
}

function readBookLikeHeading(
  workspaceRoot: string,
  relativePath: string,
  outline: OutlineDocumentDto,
  state: ParseState,
  level: number,
  title: string,
  line: number,
  diagnostics: DiagnosticItem[]
): void {
  if (level === 1) {
    state.currentVolume = createVolume(relativePath, title || "未命名卷", line);
    outline.volumes.push(state.currentVolume);
    state.currentChapter = undefined;
    state.currentScene = undefined;
  } else if (level === 2) {
    state.currentVolume = state.currentVolume ?? createDefaultVolume(outline, workspaceRoot, relativePath, line, diagnostics);
    state.currentChapter = createChapter(relativePath, title || "未命名章节", line);
    state.currentVolume.chapters.push(state.currentChapter);
    state.currentScene = undefined;
  } else if (level === 3) {
    state.currentVolume = state.currentVolume ?? createDefaultVolume(outline, workspaceRoot, relativePath, line, diagnostics);
    state.currentChapter =
      state.currentChapter ?? createDefaultChapter(state.currentVolume, workspaceRoot, relativePath, line, diagnostics);
    state.currentScene = createScene(relativePath, title || "未命名场景", line);
    state.currentChapter.scenes.push(state.currentScene);
  } else {
    addBeat(workspaceRoot, relativePath, createBeat(relativePath, title || "未命名备注", line), diagnostics, outline, state);
  }
}

function readChapterHeading(
  workspaceRoot: string,
  relativePath: string,
  outline: OutlineDocumentDto,
  state: ParseState,
  level: number,
  title: string,
  line: number,
  diagnostics: DiagnosticItem[]
): void {
  if (level === 1) {
    const volume = ensureVirtualVolume(outline, relativePath, line);
    state.currentVolume = volume;
    state.currentChapter = createChapter(relativePath, title || "未命名章节", line);
    volume.chapters.push(state.currentChapter);
    state.currentScene = undefined;
  } else if (level === 2) {
    state.currentChapter = state.currentChapter ?? ensureDefaultChapterForScope(outline, relativePath, line);
    state.currentScene = createScene(relativePath, title || "未命名场景", line);
    state.currentChapter.scenes.push(state.currentScene);
  } else {
    addBeat(workspaceRoot, relativePath, createBeat(relativePath, title || "未命名备注", line), diagnostics, outline, state);
  }
}

function readSceneHeading(
  relativePath: string,
  outline: OutlineDocumentDto,
  state: ParseState,
  level: number,
  title: string,
  line: number
): void {
  if (level !== 1) {
    return;
  }
  const chapter = ensureDefaultChapterForScope(outline, relativePath, line);
  state.currentChapter = chapter;
  state.currentScene = createScene(relativePath, title || "未命名场景", line);
  chapter.scenes.push(state.currentScene);
}

function addBeat(
  workspaceRoot: string,
  relativePath: string,
  beat: OutlineBeatDto,
  diagnostics: DiagnosticItem[],
  outline: OutlineDocumentDto,
  state: ParseState
): void {
  if (outline.scope === "scene") {
    state.currentScene = state.currentScene ?? ensureDefaultSceneForScope(outline, relativePath, beat.line);
  } else if (outline.scope === "chapter") {
    state.currentChapter = state.currentChapter ?? ensureDefaultChapterForScope(outline, relativePath, beat.line);
  } else if (outline.scope === "volume") {
    state.currentVolume = state.currentVolume ?? createDefaultVolume(outline, workspaceRoot, relativePath, beat.line, diagnostics);
  }

  if (state.currentScene) {
    state.currentScene.beats.push(beat);
  } else if (state.currentChapter) {
    state.currentChapter.beats.push(beat);
  } else if (state.currentVolume) {
    state.currentVolume.beats.push(beat);
  } else {
    diagnostics.push(diagnostic(workspaceRoot, "warning", "outline.beat.orphan", "Beat 没有可归属的卷、章或场景。", relativePath));
  }
}

function mergeIncludedOutline(parent: OutlineDocumentDto, child: OutlineDocumentDto): void {
  if (parent.scope === "book") {
    parent.volumes.push(...child.volumes);
    parent.includes.push(...child.includes);
    return;
  }
  if (parent.scope === "volume") {
    const targetVolume = ensureMergeVolume(parent);
    targetVolume.chapters.push(...extractChapters(child));
    parent.includes.push(...child.includes);
    return;
  }
  if (parent.scope === "chapter") {
    const targetChapter = ensureMergeChapter(parent);
    targetChapter.scenes.push(...extractScenes(child));
    parent.includes.push(...child.includes);
  }
}

function ensureMergeVolume(outline: OutlineDocumentDto): OutlineVolumeDraftDto {
  const existing = outline.volumes.find((volume) => !volume.isVirtual) ?? outline.volumes[0];
  if (existing) {
    return existing;
  }
  const volume = createVolume(outline.path, titleFromPath(outline.path), 1);
  outline.volumes.push(volume);
  return volume;
}

function ensureMergeChapter(outline: OutlineDocumentDto): OutlineChapterDraftDto {
  const volume = ensureVirtualVolume(outline, outline.path, 1);
  const existing = volume.chapters.find((chapter) => !chapter.isVirtual) ?? volume.chapters[0];
  if (existing) {
    return existing;
  }
  const chapter = createChapter(outline.path, titleFromPath(outline.path), 1);
  volume.chapters.push(chapter);
  return chapter;
}

function extractChapters(outline: OutlineDocumentDto): OutlineChapterDraftDto[] {
  return outline.volumes.flatMap((volume) => volume.chapters);
}

function extractScenes(outline: OutlineDocumentDto): OutlineSceneDraftDto[] {
  return outline.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes));
}

function createVolume(relativePath: string, title: string, line: number, isVirtual = false): OutlineVolumeDraftDto {
  return {
    id: createStableOutlineNodeId(relativePath, "volume", line),
    title,
    line,
    sourcePath: relativePath,
    chapters: [],
    beats: [],
    ...(isVirtual ? { isVirtual } : {})
  };
}

function createChapter(relativePath: string, title: string, line: number, isVirtual = false): OutlineChapterDraftDto {
  return {
    id: createStableOutlineNodeId(relativePath, "chapter", line),
    title,
    line,
    sourcePath: relativePath,
    scenes: [],
    beats: [],
    ...(isVirtual ? { isVirtual } : {})
  };
}

function createScene(relativePath: string, title: string, line: number, isVirtual = false): OutlineSceneDraftDto {
  return {
    id: createStableOutlineNodeId(relativePath, "scene", line),
    title,
    line,
    sourcePath: relativePath,
    beats: [],
    ...(isVirtual ? { isVirtual } : {})
  };
}

function createBeat(relativePath: string, title: string, line: number): OutlineBeatDto {
  return {
    id: createStableOutlineNodeId(relativePath, "beat", line),
    title,
    line,
    sourcePath: relativePath
  };
}

function createDefaultVolume(
  outline: OutlineDocumentDto,
  workspaceRoot: string,
  relativePath: string,
  line: number,
  diagnostics: DiagnosticItem[]
): OutlineVolumeDraftDto {
  const isScopedVolume = outline.scope === "volume";
  if (!isScopedVolume) {
    diagnostics.push(diagnostic(workspaceRoot, "warning", "outline.volume.virtual", "大纲在卷标题前出现了章节或场景。", relativePath));
  }
  const volume = createVolume(relativePath, isScopedVolume ? titleFromPath(relativePath) : "未归类卷", line, !isScopedVolume);
  outline.volumes.push(volume);
  return volume;
}

function createDefaultChapter(
  volume: OutlineVolumeDraftDto,
  workspaceRoot: string,
  relativePath: string,
  line: number,
  diagnostics: DiagnosticItem[]
): OutlineChapterDraftDto {
  diagnostics.push(diagnostic(workspaceRoot, "warning", "outline.chapter.virtual", "大纲在章节标题前出现了场景。", relativePath));
  const chapter = createChapter(relativePath, "未归类章节", line, true);
  volume.chapters.push(chapter);
  return chapter;
}

function ensureVirtualVolume(outline: OutlineDocumentDto, relativePath: string, line: number): OutlineVolumeDraftDto {
  let volume = outline.volumes[0];
  if (!volume) {
    volume = createVolume(relativePath, "导入目标卷", line, true);
    outline.volumes.push(volume);
  }
  return volume;
}

function ensureDefaultChapterForScope(
  outline: OutlineDocumentDto,
  relativePath: string,
  line: number
): OutlineChapterDraftDto {
  const volume = ensureVirtualVolume(outline, relativePath, line);
  let chapter = volume.chapters[0];
  if (!chapter) {
    chapter = createChapter(relativePath, titleFromPath(relativePath), line, outline.scope === "scene");
    volume.chapters.push(chapter);
  }
  return chapter;
}

function ensureDefaultSceneForScope(
  outline: OutlineDocumentDto,
  relativePath: string,
  line: number
): OutlineSceneDraftDto {
  const chapter = ensureDefaultChapterForScope(outline, relativePath, line);
  let scene = chapter.scenes[0];
  if (!scene) {
    scene = createScene(relativePath, titleFromPath(relativePath), line);
    chapter.scenes.push(scene);
  }
  return scene;
}

function emptyOutline(relativePath: string): OutlineDocumentDto {
  return {
    path: relativePath,
    title: titleFromPath(relativePath),
    scope: "book",
    includes: [],
    volumes: []
  };
}

function resolveIncludePath(relativePath: string, rawPath: string): OutlineIncludeDto {
  if (path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
    return { rawPath, resolvedPath: rawPath, status: "unsafe" };
  }
  const normalizedRawPath = rawPath.replace(/\\/g, "/");
  const fromDirectory = path.posix.dirname(normalizeOutlinePath(relativePath));
  const resolvedPath = path.posix.normalize(path.posix.join(fromDirectory, normalizedRawPath));
  if (!isOutlineMarkdownPath(resolvedPath) || resolvedPath.includes("/../") || resolvedPath.startsWith("../")) {
    return { rawPath, resolvedPath, status: "unsafe" };
  }
  if (!resolvedPath.toLowerCase().endsWith(".md")) {
    return { rawPath, resolvedPath, status: "invalid" };
  }
  return { rawPath, resolvedPath, status: "pending" };
}

function canInclude(parent: OutlineDraftScope, child: OutlineDraftScope): boolean {
  const rank: Record<OutlineDraftScope, number> = {
    book: 0,
    volume: 1,
    chapter: 2,
    scene: 3
  };
  return rank[child] > rank[parent];
}

function cleanTitle(value: string): string {
  return value.trim().replace(/\s+#+$/, "").trim();
}

function titleFromPath(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  return name.replace(/\.md$/i, "");
}

function normalizeOutlinePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isOutlineMarkdownPath(relativePath: string): boolean {
  return relativePath.startsWith(`${OUTLINES_DIR}/`);
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function scopeLabel(scope: OutlineDraftScope): string {
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

function diagnostic(
  workspaceRoot: string,
  severity: DiagnosticItem["severity"],
  code: string,
  message: string,
  relativePath: string
): DiagnosticItem {
  return {
    severity,
    code,
    message,
    workspaceFolder: workspaceRoot,
    relativePath
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function isRealPathInsideOutlines(workspaceRoot: string, absolutePath: string): Promise<boolean> {
  try {
    const [outlineRoot, realPath] = await Promise.all([
      fs.realpath(path.join(workspaceRoot, OUTLINES_DIR)),
      fs.realpath(absolutePath)
    ]);
    const relative = path.relative(outlineRoot, realPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}
