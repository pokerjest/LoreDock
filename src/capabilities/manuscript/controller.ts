import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { LOREDOCK_DIR, type DiagnosticItem, type OperationPlan } from "../../kernel/types";
import { SafeFileWriter } from "../../kernel/safeFileWriter";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { bookAgentPath, createBookAgentText } from "./bookAgent";
import { createBookId, createChapterId, createTrashItemId, createVolumeId, formatNumberedName } from "./ids";
import {
  assertNonEmptyTitle,
  assertTargetWordCount,
  cloneManifest,
  isManuscriptPath,
  readManuscriptManifest,
  readManuscriptManifestStructure,
  resolveExistingSafeManuscriptPath,
  stringifyManuscriptManifest
} from "./manifest";
import { countMarkdownWords } from "./wordCount";
import {
  MANUSCRIPT_STATUSES,
  MANUSCRIPT_MANIFEST_PATH,
  type BookId,
  type ChapterId,
  type ManuscriptActionResult,
  type ManuscriptActions,
  type ManuscriptBook,
  type ManuscriptBookDto,
  type ManuscriptChangeEvent,
  type ManuscriptChangeType,
  type ManuscriptChapter,
  type ManuscriptChapterDto,
  type ManuscriptManifest,
  type ManuscriptReader,
  type ManuscriptReadResult,
  type ManuscriptService,
  type ManuscriptStatus,
  type ManuscriptTrashItemDto,
  type ManuscriptVolume,
  type ManuscriptVolumeDto,
  type TrashItemId,
  type VolumeId
} from "./types";

const MANUSCRIPT_TRASH_DIR = `${LOREDOCK_DIR}/trash/manuscript`;

interface ManuscriptControllerOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  output: vscode.OutputChannel;
  diagnostics: {
    add(item: DiagnosticItem): void;
    clearMatching(workspaceFolderPath: string, predicate: (item: DiagnosticItem) => boolean): void;
  };
  confirmOperationPlan(plan: OperationPlan): Promise<boolean>;
  confirmDestructiveDelete(message: string): Promise<boolean>;
  now(): Date;
}

export class ManuscriptController implements ManuscriptReader, ManuscriptActions, ManuscriptService {
  public readonly reader: ManuscriptReader = this;
  public readonly actions: ManuscriptActions = this;

  private readonly emitter = new vscode.EventEmitter<ManuscriptChangeEvent>();

  public constructor(private readonly options: ManuscriptControllerOptions) {}

  public onDidChange(listener: (event: ManuscriptChangeEvent) => unknown): vscode.Disposable {
    return this.emitter.event(listener);
  }

  public dispose(): void {
    this.emitter.dispose();
  }

  public async refreshDiagnostics(): Promise<DiagnosticItem[]> {
    this.options.diagnostics.clearMatching(this.workspaceRoot, isManuscriptDiagnostic);
    const result = await readManuscriptManifest(this.workspaceRoot);
    for (const item of result.diagnostics) {
      this.options.diagnostics.add(item);
    }
    return result.diagnostics;
  }

  public notifyFileChanged(relativePath: string): void {
    this.emit(relativePath === MANUSCRIPT_MANIFEST_PATH ? "metadata" : "content", { path: relativePath });
  }

  public async listBooks(): Promise<ManuscriptBookDto[]> {
    const manifest = await this.loadManifest();
    return manifest.bookIds
      .map((id, index) => ({ book: manifest.books[id], index }))
      .filter((entry): entry is { book: NonNullable<(typeof entry)["book"]>; index: number } => Boolean(entry.book))
      .map(({ book, index }) => ({
        id: book.id,
        title: book.title,
        path: book.path,
        volumeIds: [...book.volumeIds],
        index
      }));
  }

  public async listVolumes(bookId?: BookId): Promise<ManuscriptVolumeDto[]> {
    const manifest = await this.loadManifest();
    const ids = bookId
      ? manifest.books[bookId]?.volumeIds ?? []
      : manifest.bookIds.flatMap((id) => manifest.books[id]?.volumeIds ?? []);

    return ids
      .map((id, index) => ({ volume: manifest.volumes[id], index }))
      .filter((entry): entry is { volume: NonNullable<(typeof entry)["volume"]>; index: number } => Boolean(entry.volume))
      .map(({ volume, index }) => ({
        id: volume.id,
        bookId: volume.bookId,
        title: volume.title,
        path: volume.path,
        chapterIds: [...volume.chapterIds],
        index
      }));
  }

  public async listChapters(volumeId?: VolumeId): Promise<ManuscriptChapterDto[]> {
    const manifest = await this.loadManifest();
    const ids = volumeId
      ? manifest.volumes[volumeId]?.chapterIds ?? []
      : manifest.bookIds.flatMap((bookId) =>
          (manifest.books[bookId]?.volumeIds ?? []).flatMap((id) => manifest.volumes[id]?.chapterIds ?? [])
        );

    return ids
      .map((id, index) => ({ chapter: manifest.chapters[id], index }))
      .filter((entry): entry is { chapter: NonNullable<(typeof entry)["chapter"]>; index: number } => Boolean(entry.chapter))
      .map(({ chapter, index }) => chapterDto(chapter, index));
  }

  public async listTrashItems(): Promise<ManuscriptTrashItemDto[]> {
    const manifest = await this.loadManifest();
    return manifest.trash.itemIds
      .map((id) => manifest.trash.items[id])
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        deletedAt: item.deletedAt,
        originalPath: item.originalPath,
        trashPath: item.trashPath
      }));
  }

  public async getChapter(chapterId: ChapterId): Promise<ManuscriptChapterDto | undefined> {
    const manifest = await this.loadManifest();
    const chapter = manifest.chapters[chapterId];
    if (!chapter) {
      return undefined;
    }

    const index = manifest.volumes[chapter.volumeId]?.chapterIds.indexOf(chapterId) ?? -1;
    return chapterDto(chapter, index);
  }

  public async resolveChapterPath(chapterId: ChapterId): Promise<string | undefined> {
    const manifest = await this.loadManifest();
    const chapter = manifest.chapters[chapterId];
    if (!chapter || !isSafeManuscriptRelativePath(chapter.path)) {
      return undefined;
    }
    return chapter.path;
  }

  public async readChapterText(chapterId: ChapterId): Promise<ManuscriptReadResult> {
    let relativePath: string | undefined;
    try {
      relativePath = await this.resolveChapterPath(chapterId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }

    if (!relativePath) {
      return { ok: false, error: `章节 "${chapterId}" 没有安全的手稿路径。` };
    }

    try {
      const absolutePath = await resolveExistingSafeManuscriptPath(this.workspaceRoot, relativePath);
      if (!absolutePath) {
        return { ok: false, error: `章节 "${chapterId}" 的文件缺失或路径不安全。` };
      }

      return {
        ok: true,
        text: await fs.readFile(absolutePath, "utf8")
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  public async createBook(title: string): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const cleanTitle = assertNonEmptyTitle(title);
    const number = next.nextBookNumber;
    const bookId = createBookId();
    const bookPath = `manuscript/${formatNumberedName("book", number)}`;
    const timestamp = this.timestamp();

    next.nextBookNumber = number + 1;
    next.bookIds.push(bookId);
    next.books[bookId] = {
      id: bookId,
      title: cleanTitle,
      path: bookPath,
      volumeIds: [],
      nextVolumeNumber: 1
    };
    next.updatedAt = timestamp;

    const agentPath = bookAgentPath(bookPath);
    const plan = manifestPlan(`新建书籍“${cleanTitle}”。`, [bookPath], [agentPath]);
    return this.applyManifestPlan(plan, next, async (writer) => {
      await writer.ensureDirectory(bookPath);
      await writer.writeFile(agentPath, createBookAgentText(cleanTitle, bookPath));
      await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(next));
    }, [{ type: "structure", bookId }]);
  }

  public async createVolume(bookId: BookId, title: string): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const book = requireBook(next, bookId);
    const cleanTitle = assertNonEmptyTitle(title);
    const number = book.nextVolumeNumber;
    const volumeId = createVolumeId();
    const volumePath = `${book.path}/${formatNumberedName("volume", number)}`;
    const timestamp = this.timestamp();

    book.nextVolumeNumber = number + 1;
    book.volumeIds.push(volumeId);
    next.volumes[volumeId] = {
      id: volumeId,
      bookId,
      title: cleanTitle,
      path: volumePath,
      chapterIds: [],
      nextChapterNumber: 1
    };
    next.updatedAt = timestamp;

    const plan = manifestPlan(`新建卷“${cleanTitle}”。`, [volumePath]);
    return this.applyManifestPlan(plan, next, async (writer) => {
      await writer.ensureDirectory(volumePath);
      await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(next));
    }, [{ type: "structure", bookId, volumeId }]);
  }

  public async createChapter(volumeId: VolumeId, title: string): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const volume = requireVolume(next, volumeId);
    const cleanTitle = assertNonEmptyTitle(title);
    const number = volume.nextChapterNumber;
    const chapterId = createChapterId();
    const chapterPath = `${volume.path}/${formatNumberedName("chapter", number)}.md`;
    const timestamp = this.timestamp();

    volume.nextChapterNumber = number + 1;
    volume.chapterIds.push(chapterId);
    next.chapters[chapterId] = {
      id: chapterId,
      volumeId,
      title: cleanTitle,
      status: "draft",
      path: chapterPath,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    next.updatedAt = timestamp;

    const plan = manifestPlan(`新建章节“${cleanTitle}”。`, [], [chapterPath]);
    return this.applyManifestPlan(plan, next, async (writer) => {
      await writer.writeFile(chapterPath, `# ${cleanTitle}\n\n`);
      try {
        await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(next));
      } catch (error) {
        await fs.rm(path.join(this.workspaceRoot, chapterPath), { force: true }).catch(() => undefined);
        throw error;
      }
    }, [
      { type: "structure", volumeId, chapterId },
      { type: "metadata", volumeId, chapterId }
    ]);
  }

  public async renameBook(bookId: BookId, title: string): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const book = requireBook(next, bookId);
    book.title = assertNonEmptyTitle(title);
    next.updatedAt = this.timestamp();
    return this.writeManifestOnly(`重命名书籍为“${book.title}”。`, next, [{ type: "metadata", bookId }]);
  }

  public async renameVolume(volumeId: VolumeId, title: string): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const volume = requireVolume(next, volumeId);
    volume.title = assertNonEmptyTitle(title);
    next.updatedAt = this.timestamp();
    return this.writeManifestOnly(`重命名卷为“${volume.title}”。`, next, [
      { type: "metadata", bookId: volume.bookId, volumeId }
    ]);
  }

  public async renameChapter(chapterId: ChapterId, title: string): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const chapter = requireChapter(next, chapterId);
    chapter.title = assertNonEmptyTitle(title);
    chapter.updatedAt = this.timestamp();
    next.updatedAt = chapter.updatedAt;
    return this.writeManifestOnly(`重命名章节为“${chapter.title}”。`, next, [
      { type: "metadata", volumeId: chapter.volumeId, chapterId }
    ]);
  }

  public async moveChapter(
    chapterId: ChapterId,
    targetVolumeId: VolumeId,
    targetIndex?: number
  ): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const originalText = stringifyManuscriptManifest(manifest);
    const next = cloneManifest(manifest);
    const chapter = requireChapter(next, chapterId);
    const sourceVolume = requireVolume(next, chapter.volumeId);
    const targetVolume = requireVolume(next, targetVolumeId);
    const originalPath = chapter.path;

    if (sourceVolume.id === targetVolume.id && targetIndex === undefined) {
      return { applied: false, plan: noOpPlan(`章节“${chapter.title}”已在目标卷，无需移动。`) };
    }

    sourceVolume.chapterIds = sourceVolume.chapterIds.filter((id) => id !== chapterId);
    const insertionIndex = clampIndex(targetIndex ?? targetVolume.chapterIds.length, targetVolume.chapterIds.length);
    targetVolume.chapterIds.splice(insertionIndex, 0, chapterId);

    chapter.volumeId = targetVolumeId;
    chapter.updatedAt = this.timestamp();
    next.updatedAt = chapter.updatedAt;

    const moveOperations: { from: string; to: string }[] = [];
    if (sourceVolume.id !== targetVolume.id) {
      chapter.path = await this.allocateMovedChapterPath(next, targetVolume, path.basename(originalPath), originalPath);
      if (chapter.path !== originalPath) {
        moveOperations.push({ from: originalPath, to: chapter.path });
      }
    }

    const plan = manifestPlan(`移动章节“${chapter.title}”。`);
    plan.filesToMove = moveOperations;
    assertSafeManuscriptOperations(plan);

    return this.applyManifestPlan(plan, next, async (writer) => {
      await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(next));
      try {
        for (const operation of moveOperations) {
          await writer.moveFile(operation.from, operation.to);
        }
      } catch (error) {
        await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, originalText);
        throw error;
      }
    }, [
      { type: "structure", volumeId: targetVolumeId, chapterId },
      { type: "metadata", volumeId: targetVolumeId, chapterId }
    ]);
  }

  public async deleteBook(bookId: BookId): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const originalText = stringifyManuscriptManifest(manifest);
    const next = cloneManifest(manifest);
    const book = requireBook(next, bookId);
    const timestamp = this.timestamp();
    const volumes = book.volumeIds.map((volumeId) => requireVolume(next, volumeId));
    const chapters = volumes.flatMap((volume) => volume.chapterIds.map((chapterId) => requireChapter(next, chapterId)));
    const trashItemId = createTrashItemId();
    const trashPath = createTrashItemPath(trashItemId);
    const directoryMove = await createExistingDirectoryTrashMove(this.workspaceRoot, book.path, trashPath);
    const requiresSecondConfirmation = volumes.length > 0 || chapters.length > 0;

    next.trash.itemIds.unshift(trashItemId);
    next.trash.items[trashItemId] = {
      id: trashItemId,
      kind: "book",
      title: book.title,
      deletedAt: timestamp,
      originalPath: book.path,
      trashPath,
      bookIds: [book.id],
      books: recordById<ManuscriptBook>([book]),
      volumes: recordById<ManuscriptVolume>(volumes),
      chapters: recordById<ManuscriptChapter>(chapters)
    };
    next.bookIds = next.bookIds.filter((id) => id !== bookId);
    delete next.books[bookId];
    for (const volume of volumes) {
      delete next.volumes[volume.id];
    }
    for (const chapter of chapters) {
      delete next.chapters[chapter.id];
    }
    next.updatedAt = timestamp;

    const plan = manifestPlan(
      `将书籍“${book.title}”移入回收站${chapters.length > 0 ? `（包含 ${chapters.length} 个章节）` : ""}。`,
      trashDirectoriesFor(trashPath)
    );
    if (directoryMove) {
      plan.directoriesToMove = [directoryMove];
    }
    assertSafeManuscriptOperations(plan);

    return this.applyManifestPlan(
      plan,
      next,
      async (writer) => {
        await this.applyMoveToTrash(writer, originalText, next, {
          directoriesToCreate: trashDirectoriesFor(trashPath),
          directoriesToMove: directoryMove ? [directoryMove] : []
        });
      },
      [{ type: "structure", bookId, trashItemId }],
      requiresSecondConfirmation
        ? `书籍“${book.title}”包含 ${volumes.length} 个卷、${chapters.length} 个章节。删除后会移入回收站；在回收站中永久删除会递归删除对应目录。确认删除？`
        : undefined
    );
  }

  public async deleteVolume(volumeId: VolumeId): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const originalText = stringifyManuscriptManifest(manifest);
    const next = cloneManifest(manifest);
    const volume = requireVolume(next, volumeId);
    const book = requireBook(next, volume.bookId);
    const timestamp = this.timestamp();
    const chapters = volume.chapterIds.map((chapterId) => requireChapter(next, chapterId));
    const trashItemId = createTrashItemId();
    const trashPath = createTrashItemPath(trashItemId);
    const directoryMove = await createExistingDirectoryTrashMove(this.workspaceRoot, volume.path, trashPath);

    next.trash.itemIds.unshift(trashItemId);
    next.trash.items[trashItemId] = {
      id: trashItemId,
      kind: "volume",
      title: volume.title,
      deletedAt: timestamp,
      originalPath: volume.path,
      trashPath,
      bookIds: [],
      books: {},
      volumes: recordById<ManuscriptVolume>([volume]),
      chapters: recordById<ManuscriptChapter>(chapters)
    };
    book.volumeIds = book.volumeIds.filter((id) => id !== volumeId);
    delete next.volumes[volumeId];
    for (const chapter of chapters) {
      delete next.chapters[chapter.id];
    }
    next.updatedAt = timestamp;

    const plan = manifestPlan(
      `将卷“${volume.title}”移入回收站${chapters.length > 0 ? `（包含 ${chapters.length} 个章节）` : ""}。`,
      trashDirectoriesFor(trashPath)
    );
    if (directoryMove) {
      plan.directoriesToMove = [directoryMove];
    }
    assertSafeManuscriptOperations(plan);

    return this.applyManifestPlan(
      plan,
      next,
      async (writer) => {
        await this.applyMoveToTrash(writer, originalText, next, {
          directoriesToCreate: trashDirectoriesFor(trashPath),
          directoriesToMove: directoryMove ? [directoryMove] : []
        });
      },
      [{ type: "structure", bookId: book.id, volumeId, trashItemId }],
      chapters.length > 0
        ? `卷“${volume.title}”包含 ${chapters.length} 个章节。删除后会移入回收站；在回收站中永久删除会递归删除对应目录。确认删除？`
        : undefined
    );
  }

  public async deleteChapter(chapterId: ChapterId): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const originalText = stringifyManuscriptManifest(manifest);
    const next = cloneManifest(manifest);
    const chapter = requireChapter(next, chapterId);
    const volume = requireVolume(next, chapter.volumeId);
    const timestamp = this.timestamp();
    const trashItemId = createTrashItemId();
    const trashPath = createTrashItemPath(trashItemId);
    const fileMove = await createExistingFileTrashMove(this.workspaceRoot, chapter.path, trashPath);

    next.trash.itemIds.unshift(trashItemId);
    next.trash.items[trashItemId] = {
      id: trashItemId,
      kind: "chapter",
      title: chapter.title,
      deletedAt: timestamp,
      originalPath: chapter.path,
      trashPath,
      bookIds: [],
      books: {},
      volumes: {},
      chapters: recordById<ManuscriptChapter>([chapter])
    };
    volume.chapterIds = volume.chapterIds.filter((id) => id !== chapterId);
    delete next.chapters[chapterId];
    next.updatedAt = timestamp;

    const plan = manifestPlan(`将章节“${chapter.title}”移入回收站。`, trashDirectoriesFor(trashPath));
    if (fileMove) {
      plan.filesToMove = [fileMove];
    }
    assertSafeManuscriptOperations(plan);

    return this.applyManifestPlan(plan, next, async (writer) => {
      await this.applyMoveToTrash(writer, originalText, next, {
        directoriesToCreate: trashDirectoriesFor(trashPath),
        filesToMove: fileMove ? [fileMove] : []
      });
    }, [{ type: "structure", volumeId: volume.id, chapterId, trashItemId }]);
  }

  public async restoreTrashItem(trashItemId: TrashItemId): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const originalText = stringifyManuscriptManifest(manifest);
    const next = cloneManifest(manifest);
    const item = requireTrashItem(next, trashItemId);
    const restoreMove = await createExistingRestoreMove(this.workspaceRoot, item.kind, item.originalPath, item.trashPath);

    restoreTrashSnapshot(next, item);
    next.trash.itemIds = next.trash.itemIds.filter((id) => id !== trashItemId);
    delete next.trash.items[trashItemId];
    next.updatedAt = this.timestamp();

    const plan = manifestPlan(`还原回收站项目“${item.title}”。`);
    if (restoreMove.kind === "file") {
      plan.filesToMove = [restoreMove.operation];
    } else {
      plan.directoriesToMove = [restoreMove.operation];
    }
    assertSafeManuscriptOperations(plan);

    return this.applyManifestPlan(plan, next, async (writer) => {
      await this.applyRestoreFromTrash(writer, originalText, next, restoreMove);
    }, [restoreEventFor(item)]);
  }

  public async permanentlyDeleteTrashItem(trashItemId: TrashItemId): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const originalText = stringifyManuscriptManifest(manifest);
    const next = cloneManifest(manifest);
    const item = requireTrashItem(next, trashItemId);
    const shouldDeleteDirectory = await existingSafeTrashDirectory(this.workspaceRoot, item.trashPath);

    next.trash.itemIds = next.trash.itemIds.filter((id) => id !== trashItemId);
    delete next.trash.items[trashItemId];
    next.updatedAt = this.timestamp();

    const plan = manifestPlan(`永久删除回收站项目“${item.title}”。`);
    if (shouldDeleteDirectory) {
      plan.directoriesToDelete = [item.trashPath];
    }
    assertSafeManuscriptOperations(plan);

    return this.applyManifestPlan(plan, next, async (writer) => {
      let manifestWritten = false;
      try {
        await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(next));
        manifestWritten = true;
        if (shouldDeleteDirectory) {
          await writer.deleteDirectoryRecursive(item.trashPath);
        }
      } catch (error) {
        if (manifestWritten) {
          await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, originalText).catch(() => undefined);
        }
        throw error;
      }
    }, [{ type: "structure", trashItemId }]);
  }

  public async setChapterStatus(chapterId: ChapterId, status: ManuscriptStatus): Promise<ManuscriptActionResult> {
    if (!MANUSCRIPT_STATUSES.includes(status)) {
      throw new Error(`章节状态 "${String(status)}" 不受支持。`);
    }

    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const chapter = requireChapter(next, chapterId);
    chapter.status = status;
    chapter.updatedAt = this.timestamp();
    next.updatedAt = chapter.updatedAt;
    return this.writeManifestOnly(`将章节“${chapter.title}”状态设为${formatStatus(status)}。`, next, [
      { type: "status", volumeId: chapter.volumeId, chapterId },
      { type: "metadata", volumeId: chapter.volumeId, chapterId }
    ]);
  }

  public async setChapterTargetWordCount(
    chapterId: ChapterId,
    targetWordCount?: number
  ): Promise<ManuscriptActionResult> {
    const manifest = await this.loadManifest();
    const next = cloneManifest(manifest);
    const chapter = requireChapter(next, chapterId);
    const cleanValue = assertTargetWordCount(targetWordCount);

    if (cleanValue === undefined) {
      delete chapter.targetWordCount;
    } else {
      chapter.targetWordCount = cleanValue;
    }

    chapter.updatedAt = this.timestamp();
    next.updatedAt = chapter.updatedAt;
    return this.writeManifestOnly(`设置章节“${chapter.title}”目标字数。`, next, [
      { type: "metadata", volumeId: chapter.volumeId, chapterId }
    ]);
  }

  public async buildStatisticsReport(): Promise<string> {
    const manifest = await this.loadManifest();
    const chapterStats = await Promise.all(
      Object.values(manifest.chapters).map(async (chapter) => {
        const absolutePath = await resolveExistingSafeManuscriptPath(this.workspaceRoot, chapter.path);
        const text = absolutePath ? await fs.readFile(absolutePath, "utf8").catch(() => "") : "";
        const wordCount = countMarkdownWords(text);
        return { chapter, wordCount: wordCount.count, isEmpty: wordCount.isEmpty };
      })
    );

    const statusCounts = new Map<ManuscriptStatus, number>();
    for (const item of chapterStats) {
      statusCounts.set(item.chapter.status, (statusCounts.get(item.chapter.status) ?? 0) + 1);
    }

    const lines = ["# 手稿统计", ""];
    let grandTotal = 0;

    for (const bookId of manifest.bookIds) {
      const book = manifest.books[bookId];
      if (!book) {
        continue;
      }

      lines.push(`## ${book.title}`, "");
      let bookTotal = 0;
      for (const volumeId of book.volumeIds) {
        const volume = manifest.volumes[volumeId];
        if (!volume) {
          continue;
        }

        let volumeTotal = 0;
        const chapterRows: string[] = [];
        for (const chapterId of volume.chapterIds) {
          const stat = chapterStats.find((item) => item.chapter.id === chapterId);
          if (!stat) {
            continue;
          }

          volumeTotal += stat.wordCount;
          chapterRows.push(formatChapterStat(stat.chapter, stat.wordCount, stat.isEmpty));
        }

        bookTotal += volumeTotal;
        lines.push(`### ${volume.title}（${volumeTotal} 字）`, "");
        lines.push(...(chapterRows.length === 0 ? ["- 暂无章节。"] : chapterRows), "");
      }

      grandTotal += bookTotal;
      lines.push(`本书合计：${bookTotal} 字`, "");
    }

    lines.push("## 状态汇总", "");
    for (const [status, count] of statusCounts.entries()) {
      lines.push(`- ${formatStatus(status)}：${count}`);
    }
    lines.push("", `总计：${grandTotal} 字`, "");
    return `${lines.join("\n")}\n`;
  }

  private async writeManifestOnly(
    summary: string,
    manifest: ManuscriptManifest,
    events: Partial<ManuscriptChangeEvent>[]
  ): Promise<ManuscriptActionResult> {
    const plan = manifestPlan(summary);
    return this.applyManifestPlan(plan, manifest, async (writer) => {
      await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(manifest));
    }, events);
  }

  private async applyManifestPlan(
    plan: OperationPlan,
    manifest: ManuscriptManifest,
    apply: (writer: SafeFileWriter) => Promise<void>,
    events: Partial<ManuscriptChangeEvent>[],
    destructiveDeleteMessage?: string
  ): Promise<ManuscriptActionResult> {
    assertSafeManuscriptOperations(plan);
    const confirmed = await this.options.confirmOperationPlan(plan);
    if (!confirmed) {
      this.options.output.appendLine(`已取消手稿操作：${plan.summary}`);
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

  private async allocateMovedChapterPath(
    manifest: ManuscriptManifest,
    targetVolume: { path: string; nextChapterNumber: number },
    basename: string,
    originalPath: string
  ): Promise<string> {
    const preferred = normalizeRelativePath(`${targetVolume.path}/${basename}`);
    if (!(await this.chapterPathUnavailable(manifest, preferred, originalPath))) {
      return preferred;
    }

    let nextNumber = targetVolume.nextChapterNumber;
    let candidate: string;
    do {
      candidate = normalizeRelativePath(`${targetVolume.path}/${formatNumberedName("chapter", nextNumber)}.md`);
      nextNumber += 1;
    } while (await this.chapterPathUnavailable(manifest, candidate, originalPath));

    targetVolume.nextChapterNumber = nextNumber;
    return candidate;
  }

  private async chapterPathUnavailable(
    manifest: ManuscriptManifest,
    relativePath: string,
    originalPath: string
  ): Promise<boolean> {
    const normalized = normalizeRelativePath(relativePath);
    if (
      normalized !== normalizeRelativePath(originalPath) &&
      Object.values(manifest.chapters).some((chapter) => normalizeRelativePath(chapter.path) === normalized)
    ) {
      return true;
    }

    return pathExists(path.join(this.workspaceRoot, normalized));
  }

  private async applyMoveToTrash(
    writer: SafeFileWriter,
    originalManifestText: string,
    nextManifest: ManuscriptManifest,
    operations: {
      directoriesToCreate: string[];
      filesToMove?: NonNullable<OperationPlan["filesToMove"]>;
      directoriesToMove?: NonNullable<OperationPlan["directoriesToMove"]>;
    }
  ): Promise<void> {
    let manifestWritten = false;
    try {
      for (const directory of operations.directoriesToCreate) {
        await writer.ensureDirectory(directory);
      }
      await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(nextManifest));
      manifestWritten = true;
      for (const operation of operations.filesToMove ?? []) {
        await writer.moveFile(operation.from, operation.to);
      }
      for (const operation of operations.directoriesToMove ?? []) {
        await writer.moveDirectory(operation.from, operation.to);
      }
    } catch (error) {
      if (manifestWritten) {
        await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, originalManifestText).catch(() => undefined);
      }
      throw error;
    }
  }

  private async applyRestoreFromTrash(
    writer: SafeFileWriter,
    originalManifestText: string,
    nextManifest: ManuscriptManifest,
    restoreMove: RestoreMoveOperation
  ): Promise<void> {
    let manifestWritten = false;
    try {
      await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, stringifyManuscriptManifest(nextManifest));
      manifestWritten = true;
      if (restoreMove.kind === "file") {
        await writer.moveFile(restoreMove.operation.from, restoreMove.operation.to);
      } else {
        await writer.moveDirectory(restoreMove.operation.from, restoreMove.operation.to);
      }
    } catch (error) {
      if (manifestWritten) {
        await writer.writeFile(MANUSCRIPT_MANIFEST_PATH, originalManifestText).catch(() => undefined);
      }
      throw error;
    }
  }

  private async loadManifest(): Promise<ManuscriptManifest> {
    const result = await readManuscriptManifestStructure(this.workspaceRoot);
    if (result.status === "valid") {
      return result.manifest;
    }

    for (const item of result.diagnostics) {
      this.options.diagnostics.add(item);
    }
    throw new Error("手稿清单处于异常状态，写入操作已禁用。");
  }

  private emit(type: ManuscriptChangeType, event: Partial<ManuscriptChangeEvent>): void {
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

function manifestPlan(summary: string, directoriesToCreate: string[] = [], filesToCreate: string[] = []): OperationPlan {
  return {
    summary,
    directoriesToCreate,
    filesToCreate,
    filesToModify: [MANUSCRIPT_MANIFEST_PATH]
  };
}

function noOpPlan(summary: string): OperationPlan {
  return {
    summary,
    directoriesToCreate: [],
    filesToCreate: [],
    filesToModify: []
  };
}

type RestoreMoveOperation =
  | { kind: "file"; operation: NonNullable<OperationPlan["filesToMove"]>[number] }
  | { kind: "directory"; operation: NonNullable<OperationPlan["directoriesToMove"]>[number] };

function assertSafeManuscriptOperations(plan: OperationPlan): void {
  for (const operation of plan.filesToMove ?? []) {
    if (
      !(
        isSafeManuscriptRelativePath(operation.from) &&
        isSafeManuscriptOrTrashRelativePath(operation.to)
      ) &&
      !(isSafeTrashRelativePath(operation.from) && isSafeManuscriptRelativePath(operation.to))
    ) {
      throw new Error("手稿文件移动操作必须在 manuscript/ 和手稿回收站之间进行。");
    }
  }

  for (const operation of plan.directoriesToMove ?? []) {
    if (
      !(
        isSafeManuscriptRelativePath(operation.from) &&
        isSafeTrashRelativePath(operation.to)
      ) &&
      !(isSafeTrashRelativePath(operation.from) && isSafeManuscriptRelativePath(operation.to))
    ) {
      throw new Error("手稿目录移动操作必须在 manuscript/ 和手稿回收站之间进行。");
    }
  }

  for (const relativePath of plan.filesToDelete ?? []) {
    if (!isSafeManuscriptRelativePath(relativePath)) {
      throw new Error("手稿删除操作必须位于 manuscript/ 目录下。");
    }
  }

  for (const relativePath of plan.directoriesToDelete ?? []) {
    if (!isSafeTrashRelativePath(relativePath)) {
      throw new Error("手稿递归删除操作必须位于手稿回收站目录下。");
    }
  }

  for (const operation of plan.filesToBackup ?? []) {
    if (!isSafeManuscriptRelativePath(operation.source) || !isSafeBackupRelativePath(operation.backup)) {
      throw new Error("手稿备份操作必须从 manuscript/ 复制到 .loredock/backups/ 目录下。");
    }
  }
}

function requireBook(manifest: ManuscriptManifest, bookId: BookId) {
  const book = manifest.books[bookId];
  if (!book) {
    throw new Error(`未找到书籍 "${bookId}"。`);
  }
  return book;
}

function requireVolume(manifest: ManuscriptManifest, volumeId: VolumeId) {
  const volume = manifest.volumes[volumeId];
  if (!volume) {
    throw new Error(`未找到卷 "${volumeId}"。`);
  }
  return volume;
}

function requireChapter(manifest: ManuscriptManifest, chapterId: ChapterId) {
  const chapter = manifest.chapters[chapterId];
  if (!chapter) {
    throw new Error(`未找到章节 "${chapterId}"。`);
  }
  return chapter;
}

function requireTrashItem(manifest: ManuscriptManifest, trashItemId: TrashItemId) {
  const item = manifest.trash.items[trashItemId];
  if (!item) {
    throw new Error(`未找到回收站项目 "${trashItemId}"。`);
  }
  return item;
}

function restoreTrashSnapshot(manifest: ManuscriptManifest, item: ReturnType<typeof requireTrashItem>): void {
  assertTrashSnapshotHasNoActiveConflicts(manifest, item);

  if (item.kind === "book") {
    for (const bookId of item.bookIds) {
      const book = item.books[bookId];
      if (!book) {
        throw new Error(`回收站项目缺少书籍快照 "${bookId}"。`);
      }
      manifest.bookIds.push(bookId);
    }
    Object.assign(manifest.books, item.books);
    Object.assign(manifest.volumes, item.volumes);
    Object.assign(manifest.chapters, item.chapters);
    return;
  }

  if (item.kind === "volume") {
    const volume = singleSnapshot(item.volumes, "卷");
    const parentBook = manifest.books[volume.bookId];
    if (!parentBook) {
      throw new Error(`无法还原卷“${volume.title}”：父书籍已不存在。`);
    }

    parentBook.volumeIds.push(volume.id);
    Object.assign(manifest.volumes, item.volumes);
    Object.assign(manifest.chapters, item.chapters);
    return;
  }

  const chapter = singleSnapshot(item.chapters, "章节");
  const parentVolume = manifest.volumes[chapter.volumeId];
  if (!parentVolume) {
    throw new Error(`无法还原章节“${chapter.title}”：父卷已不存在。`);
  }

  parentVolume.chapterIds.push(chapter.id);
  Object.assign(manifest.chapters, item.chapters);
}

function assertTrashSnapshotHasNoActiveConflicts(
  manifest: ManuscriptManifest,
  item: ReturnType<typeof requireTrashItem>
): void {
  for (const id of Object.keys(item.books)) {
    if (manifest.books[id]) {
      throw new Error(`无法还原“${item.title}”：书籍 ID "${id}" 已存在。`);
    }
  }
  for (const id of Object.keys(item.volumes)) {
    if (manifest.volumes[id]) {
      throw new Error(`无法还原“${item.title}”：卷 ID "${id}" 已存在。`);
    }
  }
  for (const [id, chapter] of Object.entries(item.chapters)) {
    if (manifest.chapters[id]) {
      throw new Error(`无法还原“${item.title}”：章节 ID "${id}" 已存在。`);
    }
    if (
      Object.values(manifest.chapters).some(
        (activeChapter) => normalizeRelativePath(activeChapter.path) === normalizeRelativePath(chapter.path)
      )
    ) {
      throw new Error(`无法还原“${item.title}”：章节路径 "${chapter.path}" 已被占用。`);
    }
  }
}

function singleSnapshot<T>(items: Record<string, T>, label: string): T {
  const values = Object.values(items);
  if (values.length !== 1) {
    throw new Error(`回收站项目必须包含一个${label}快照。`);
  }
  return values[0];
}

function restoreEventFor(item: ReturnType<typeof requireTrashItem>): Partial<ManuscriptChangeEvent> {
  if (item.kind === "book") {
    return { type: "structure", bookId: item.bookIds[0], trashItemId: item.id };
  }
  if (item.kind === "volume") {
    const volume = singleSnapshot(item.volumes, "卷");
    return { type: "structure", bookId: volume.bookId, volumeId: volume.id, trashItemId: item.id };
  }

  const chapter = singleSnapshot(item.chapters, "章节");
  return { type: "structure", volumeId: chapter.volumeId, chapterId: chapter.id, trashItemId: item.id };
}

function chapterDto(chapter: ManuscriptChapter, index: number): ManuscriptChapterDto {
  return {
    id: chapter.id,
    volumeId: chapter.volumeId,
    title: chapter.title,
    status: chapter.status,
    path: chapter.path,
    index,
    ...(chapter.targetWordCount === undefined ? {} : { targetWordCount: chapter.targetWordCount })
  };
}

function formatChapterStat(chapter: ManuscriptChapter, wordCount: number, isEmpty: boolean): string {
  const target =
    chapter.targetWordCount === undefined
      ? ""
      : `，目标 ${chapter.targetWordCount}，差距 ${chapter.targetWordCount - wordCount}`;
  const empty = isEmpty ? "，空章节" : "";
  return `- ${chapter.title}：${wordCount} 字，${formatStatus(chapter.status)}${target}${empty}`;
}

function formatStatus(status: ManuscriptStatus): string {
  switch (status) {
    case "idea":
      return "构思";
    case "outline":
      return "大纲";
    case "draft":
      return "草稿";
    case "revise":
      return "修订";
    case "done":
      return "完成";
    case "archived":
      return "归档";
  }
}

function clampIndex(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function isSafeManuscriptRelativePath(relativePath: string): boolean {
  return !path.isAbsolute(relativePath) && isManuscriptPath(relativePath);
}

function isSafeManuscriptOrTrashRelativePath(relativePath: string): boolean {
  return isSafeManuscriptRelativePath(relativePath) || isSafeTrashRelativePath(relativePath);
}

function isSafeBackupRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    !path.isAbsolute(relativePath) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized.startsWith(`${LOREDOCK_DIR}/backups/`)
  );
}

function isSafeTrashRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    !path.isAbsolute(relativePath) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized.startsWith(`${MANUSCRIPT_TRASH_DIR}/`)
  );
}

function createTrashItemPath(trashItemId: TrashItemId): string {
  return normalizeRelativePath(`${MANUSCRIPT_TRASH_DIR}/${trashItemId}`);
}

function trashDirectoriesFor(trashPath: string): string[] {
  return [LOREDOCK_DIR, `${LOREDOCK_DIR}/trash`, MANUSCRIPT_TRASH_DIR, trashPath].map(normalizeRelativePath);
}

async function createExistingFileTrashMove(
  workspaceRoot: string,
  source: string,
  trashPath: string
): Promise<NonNullable<OperationPlan["filesToMove"]>[number] | undefined> {
  const normalizedSource = normalizeRelativePath(source);
  const absoluteSource = await resolveExistingSafeManuscriptPath(workspaceRoot, normalizedSource);
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

async function createExistingDirectoryTrashMove(
  workspaceRoot: string,
  source: string,
  trashPath: string
): Promise<NonNullable<OperationPlan["directoriesToMove"]>[number] | undefined> {
  const normalizedSource = normalizeRelativePath(source);
  const absoluteSource = await resolveExistingSafeManuscriptPath(workspaceRoot, normalizedSource);
  if (!absoluteSource) {
    return undefined;
  }

  const stats = await fs.stat(absoluteSource);
  if (!stats.isDirectory()) {
    return undefined;
  }

  return {
    from: normalizedSource,
    to: normalizeRelativePath(`${trashPath}/${path.basename(normalizedSource)}`)
  };
}

async function createExistingRestoreMove(
  workspaceRoot: string,
  kind: "book" | "volume" | "chapter",
  originalPath: string,
  trashPath: string
): Promise<RestoreMoveOperation> {
  const normalizedOriginalPath = normalizeRelativePath(originalPath);
  const source = normalizeRelativePath(`${trashPath}/${path.basename(normalizedOriginalPath)}`);
  const absoluteSource = await resolveExistingSafeTrashPath(workspaceRoot, source);
  if (!absoluteSource) {
    throw new Error(`无法还原：回收站内容 "${source}" 缺失或路径不安全。`);
  }

  const absoluteTarget = path.resolve(workspaceRoot, normalizedOriginalPath);
  if (await pathExists(absoluteTarget)) {
    throw new Error(`无法还原：目标路径 "${normalizedOriginalPath}" 已存在。`);
  }

  const stats = await fs.stat(absoluteSource);
  if (kind === "chapter") {
    if (!stats.isFile()) {
      throw new Error(`无法还原：回收站路径 "${source}" 不是章节文件。`);
    }
    return {
      kind: "file",
      operation: {
        from: source,
        to: normalizedOriginalPath
      }
    };
  }

  if (!stats.isDirectory()) {
    throw new Error(`无法还原：回收站路径 "${source}" 不是目录。`);
  }
  return {
    kind: "directory",
    operation: {
      from: source,
      to: normalizedOriginalPath
    }
  };
}

async function existingSafeTrashDirectory(workspaceRoot: string, relativePath: string): Promise<boolean> {
  if (!isSafeTrashRelativePath(relativePath)) {
    return false;
  }

  const absolutePath = path.resolve(workspaceRoot, normalizeRelativePath(relativePath));
  const workspaceAbsolutePath = path.resolve(workspaceRoot);
  if (!isInside(workspaceAbsolutePath, absolutePath)) {
    return false;
  }

  try {
    const workspaceRealPath = await fs.realpath(workspaceRoot);
    const realPath = await fs.realpath(absolutePath);
    const stats = await fs.stat(absolutePath);
    return stats.isDirectory() && isInside(workspaceRealPath, realPath);
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function resolveExistingSafeTrashPath(workspaceRoot: string, relativePath: string): Promise<string | undefined> {
  if (!isSafeTrashRelativePath(relativePath)) {
    return undefined;
  }

  const normalized = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(workspaceRoot, normalized);
  const workspaceAbsolutePath = path.resolve(workspaceRoot);
  if (!isInside(workspaceAbsolutePath, absolutePath)) {
    return undefined;
  }

  try {
    const workspaceRealPath = await fs.realpath(workspaceRoot);
    const realPath = await fs.realpath(absolutePath);
    return isInside(workspaceRealPath, realPath) ? absolutePath : undefined;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function recordById<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function isManuscriptDiagnostic(item: DiagnosticItem): boolean {
  return (
    item.code.startsWith("manuscript.") ||
    item.relativePath === "manuscript" ||
    item.relativePath?.startsWith("manuscript/") === true
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
