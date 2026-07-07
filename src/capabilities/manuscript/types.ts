import type * as vscode from "vscode";
import type { SafeFileWriter } from "../../kernel/safeFileWriter";
import type { OperationPlan } from "../../kernel/types";

export const MANUSCRIPT_CAPABILITY_ID = "manuscript.core";
export const MANUSCRIPT_SCHEMA_ID = "manuscript.manifest";
export const MANUSCRIPT_SCHEMA_VERSION = "0.2.0";
export const MANUSCRIPT_DIR = "manuscript";
export const MANUSCRIPT_MANIFEST_PATH = "manuscript/manifest.json";
export const MANUSCRIPT_NOTES_PATH = "manuscript/notes.md";

export type BookId = string & { readonly __brand: "BookId" };
export type VolumeId = string & { readonly __brand: "VolumeId" };
export type ChapterId = string & { readonly __brand: "ChapterId" };
export type TrashItemId = string & { readonly __brand: "TrashItemId" };

export type ManuscriptStatus = "idea" | "outline" | "draft" | "revise" | "done" | "archived";
export type ManuscriptChangeType = "structure" | "status" | "metadata" | "content";
export type ManuscriptTrashKind = "volume" | "chapter";

export const MANUSCRIPT_STATUSES: ManuscriptStatus[] = [
  "idea",
  "outline",
  "draft",
  "revise",
  "done",
  "archived"
];

export interface ManuscriptManifest {
  schemaVersion: string;
  book: ManuscriptBook;
  volumeIds: VolumeId[];
  volumes: Record<string, ManuscriptVolume>;
  chapters: Record<string, ManuscriptChapter>;
  createdAt: string;
  updatedAt: string;
  trash: ManuscriptTrash;
}

export interface ManuscriptBook {
  id: BookId;
  title: string;
}

export interface ManuscriptVolume {
  id: VolumeId;
  title: string;
  path: string;
  chapterIds: ChapterId[];
  nextChapterNumber: number;
}

export interface ManuscriptChapter {
  id: ChapterId;
  volumeId: VolumeId;
  title: string;
  status: ManuscriptStatus;
  path: string;
  createdAt: string;
  updatedAt: string;
  targetWordCount?: number;
}

export interface ManuscriptTrash {
  itemIds: TrashItemId[];
  items: Record<string, ManuscriptTrashItem>;
}

export interface ManuscriptTrashItem {
  id: TrashItemId;
  kind: ManuscriptTrashKind;
  title: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
  volumes: Record<string, ManuscriptVolume>;
  chapters: Record<string, ManuscriptChapter>;
}

export interface ManuscriptBookDto {
  id: BookId;
  title: string;
}

export interface ManuscriptVolumeDto {
  id: VolumeId;
  title: string;
  path: string;
  chapterIds: ChapterId[];
  index: number;
}

export interface ManuscriptChapterDto {
  id: ChapterId;
  volumeId: VolumeId;
  title: string;
  status: ManuscriptStatus;
  path: string;
  index: number;
  targetWordCount?: number;
}

export interface ManuscriptTrashItemDto {
  id: TrashItemId;
  kind: ManuscriptTrashKind;
  title: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
}

export interface ManuscriptChangeEvent {
  type: ManuscriptChangeType;
  workspaceFolder: vscode.WorkspaceFolder;
  bookId?: BookId;
  volumeId?: VolumeId;
  chapterId?: ChapterId;
  trashItemId?: TrashItemId;
  path?: string;
}

export interface ManuscriptReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface ManuscriptActionResult {
  applied: boolean;
  plan: OperationPlan;
}

export interface ManuscriptOutlineChapterInput {
  clientId: string;
  title: string;
  existingChapterId?: ChapterId;
}

export interface ManuscriptOutlineVolumeInput {
  title: string;
  existingVolumeId?: VolumeId;
  chapters: ManuscriptOutlineChapterInput[];
}

export interface ManuscriptPreparedStructure {
  plan: OperationPlan;
  chapterIdsByClientId: Record<string, ChapterId>;
  apply(writer: SafeFileWriter): Promise<void>;
}

export interface ManuscriptPreparedChapter {
  plan: OperationPlan;
  chapterId: ChapterId;
  apply(writer: SafeFileWriter): Promise<void>;
}

export interface ManuscriptReader {
  getBook(): Promise<ManuscriptBookDto>;
  listVolumes(): Promise<ManuscriptVolumeDto[]>;
  listChapters(volumeId?: VolumeId): Promise<ManuscriptChapterDto[]>;
  listTrashItems(): Promise<ManuscriptTrashItemDto[]>;
  getChapter(chapterId: ChapterId): Promise<ManuscriptChapterDto | undefined>;
  resolveChapterPath(chapterId: ChapterId): Promise<string | undefined>;
  readChapterText(chapterId: ChapterId): Promise<ManuscriptReadResult>;
}

export interface ManuscriptActions {
  refreshBookAgentGuide(): Promise<ManuscriptActionResult>;
  createVolume(title: string): Promise<ManuscriptActionResult>;
  createChapter(volumeId: VolumeId, title: string): Promise<ManuscriptActionResult>;
  renameBook(title: string): Promise<ManuscriptActionResult>;
  renameVolume(volumeId: VolumeId, title: string): Promise<ManuscriptActionResult>;
  renameChapter(chapterId: ChapterId, title: string): Promise<ManuscriptActionResult>;
  moveChapter(chapterId: ChapterId, targetVolumeId: VolumeId, targetIndex?: number): Promise<ManuscriptActionResult>;
  deleteVolume(volumeId: VolumeId): Promise<ManuscriptActionResult>;
  deleteChapter(chapterId: ChapterId): Promise<ManuscriptActionResult>;
  restoreTrashItem(trashItemId: TrashItemId): Promise<ManuscriptActionResult>;
  permanentlyDeleteTrashItem(trashItemId: TrashItemId): Promise<ManuscriptActionResult>;
  setChapterStatus(chapterId: ChapterId, status: ManuscriptStatus): Promise<ManuscriptActionResult>;
  setChapterTargetWordCount(chapterId: ChapterId, targetWordCount?: number): Promise<ManuscriptActionResult>;
  prepareStructureFromOutline(volumes: ManuscriptOutlineVolumeInput[]): Promise<ManuscriptPreparedStructure>;
  prepareChapterInVolume(volumeId: VolumeId, title: string): Promise<ManuscriptPreparedChapter>;
}

export interface ManuscriptService {
  reader: ManuscriptReader;
  actions: ManuscriptActions;
  onDidChange(listener: (event: ManuscriptChangeEvent) => unknown): vscode.Disposable;
}
