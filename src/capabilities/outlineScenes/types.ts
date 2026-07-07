import type * as vscode from "vscode";
import type { OperationPlan } from "../../kernel/types";
import type { ChapterId, VolumeId } from "../manuscript/types";

export const OUTLINE_SCENES_CAPABILITY_ID = "structure.outline-scenes";
export const OUTLINE_SCENES_SCHEMA_ID = "outline-scenes.scene";
export const OUTLINE_SCENES_SCHEMA_VERSION = "0.3.0";

export const OUTLINES_DIR = "outlines";
export const SCENES_DIR = "scenes";
export const OUTLINE_SCENES_TRASH_DIR = ".loredock/trash/resources/outline-scenes";
export const OUTLINE_SCENES_TRASH_METADATA = "trash-item.json";

export type SceneId = string & { readonly __brand: "SceneId" };
export type OutlineScenesTrashItemId = string & { readonly __brand: "OutlineScenesTrashItemId" };
export type SceneStatus = "idea" | "outline" | "draft" | "revise" | "done" | "archived";
export type OutlineSceneChangeType = "outline" | "structure" | "metadata" | "content";
export type OutlineDraftNodeStatus = "landed" | "importable" | "skipped" | "conflict";
export type OutlineDraftScope = "book" | "volume" | "chapter" | "scene";
export type OutlineIncludeStatus = "pending" | "resolved" | "missing" | "unsafe" | "cycle" | "invalid";

export const SCENE_STATUSES: SceneStatus[] = ["idea", "outline", "draft", "revise", "done", "archived"];

export interface SceneCardDto {
  id: SceneId;
  title: string;
  chapterRefs: ChapterId[];
  order: number;
  pov: string;
  locationRefs: string[];
  characterRefs: string[];
  plotlineRefs: string[];
  conflict: string;
  turn: string;
  outcome: string;
  status: SceneStatus;
  createdAt: string;
  updatedAt: string;
  path: string;
  sourceOutline?: string;
  sourceLine?: number;
}

export interface SceneCardMetadataPatch {
  title?: string;
  chapterRefs?: string[];
  chapterId?: string;
  order?: number;
  pov?: string;
  locationRefs?: string[];
  characterRefs?: string[];
  plotlineRefs?: string[];
  conflict?: string;
  turn?: string;
  outcome?: string;
  status?: SceneStatus;
}

export interface SceneCardInput extends Partial<Omit<SceneCardDto, "id" | "createdAt" | "updatedAt" | "path" | "chapterRefs" | "title">> {
  title: string;
  chapterRefs?: string[];
  chapterId?: string;
}

export interface OutlineBeatDto {
  id: string;
  title: string;
  line: number;
  sourcePath: string;
}

export interface OutlineSceneDraftDto {
  id: string;
  title: string;
  line: number;
  sourcePath: string;
  beats: OutlineBeatDto[];
  isVirtual?: boolean;
}

export interface OutlineChapterDraftDto {
  id: string;
  title: string;
  line: number;
  sourcePath: string;
  scenes: OutlineSceneDraftDto[];
  beats: OutlineBeatDto[];
  isVirtual?: boolean;
}

export interface OutlineVolumeDraftDto {
  id: string;
  title: string;
  line: number;
  sourcePath: string;
  chapters: OutlineChapterDraftDto[];
  beats: OutlineBeatDto[];
  isVirtual?: boolean;
}

export interface OutlineIncludeDto {
  rawPath: string;
  resolvedPath: string;
  scope?: OutlineDraftScope;
  status: OutlineIncludeStatus;
}

export interface OutlineDocumentDto {
  path: string;
  title: string;
  scope: OutlineDraftScope;
  includes: OutlineIncludeDto[];
  volumes: OutlineVolumeDraftDto[];
}

export interface OutlineListItemDto {
  path: string;
  title: string;
  status: "valid" | "degraded";
}

export interface StructureSkeletonDto {
  volumes: StructureVolumeDto[];
  orphanScenes: SceneCardDto[];
  outlineDrafts: OutlineDocumentDto[];
  diagnostics: string[];
}

export interface StructureVolumeDto {
  id: VolumeId;
  title: string;
  index: number;
  chapters: StructureChapterDto[];
}

export interface StructureChapterDto {
  id: ChapterId;
  title: string;
  index: number;
  scenes: SceneCardDto[];
}

export interface SceneProjectionDto {
  chapters: Array<{
    chapterId: ChapterId;
    title: string;
    volumeId: VolumeId;
    index: number;
    scenes: SceneCardDto[];
  }>;
  orphanScenes: SceneCardDto[];
}

export interface SceneSearchQuery {
  chapterId?: string;
  status?: SceneStatus;
  characterRef?: string;
  locationRef?: string;
  plotlineRef?: string;
}

export interface OutlineScenesTrashItemDto {
  id: OutlineScenesTrashItemId;
  title: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
  originalFileName: string;
  sceneId?: SceneId;
}

export interface OutlineSceneReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface OutlineSceneActionResult {
  applied: boolean;
  plan: OperationPlan;
}

export interface OutlineImportTarget {
  volumeId?: string;
  chapterId?: string;
  volumeTitle?: string;
  chapterTitle?: string;
}

export interface OutlineImportOptions {
  target?: OutlineImportTarget;
}

export interface OutlineSceneChangeEvent {
  type: OutlineSceneChangeType;
  workspaceFolder: vscode.WorkspaceFolder;
  sceneId?: SceneId;
  trashItemId?: OutlineScenesTrashItemId;
  path?: string;
}

export interface OutlineSceneReader {
  listOutlines(): Promise<OutlineListItemDto[]>;
  parseOutline(relativePath: string): Promise<OutlineDocumentDto>;
  getStructureSkeleton(): Promise<StructureSkeletonDto>;
  listScenes(query?: SceneSearchQuery): Promise<SceneCardDto[]>;
  getScene(sceneId: SceneId): Promise<SceneCardDto | undefined>;
  resolveScenePath(sceneId: SceneId): Promise<string | undefined>;
  readSceneText(sceneId: SceneId): Promise<OutlineSceneReadResult>;
  getSceneProjection(): Promise<SceneProjectionDto>;
  listTrashItems(): Promise<OutlineScenesTrashItemDto[]>;
}

export interface OutlineSceneActions {
  createOutlineTemplate(title?: string, scope?: OutlineDraftScope): Promise<OutlineSceneActionResult>;
  deleteOutline(relativePath: string): Promise<OutlineSceneActionResult>;
  importOutline(relativePath: string, options?: OutlineImportOptions): Promise<OutlineSceneActionResult>;
  createSceneCard(input: SceneCardInput): Promise<OutlineSceneActionResult>;
  createSceneCardFromChapter(chapterId: string, title?: string): Promise<OutlineSceneActionResult>;
  bindSceneToChapters(sceneId: SceneId, chapterRefs: string[]): Promise<OutlineSceneActionResult>;
  bindScenesToChapter(sceneIds: SceneId[], chapterId: string): Promise<OutlineSceneActionResult>;
  createChapterAndBindScene(sceneId: SceneId, volumeId: string, title: string): Promise<OutlineSceneActionResult>;
  updateSceneMetadata(sceneId: SceneId, patch: SceneCardMetadataPatch): Promise<OutlineSceneActionResult>;
  deleteSceneCard(sceneId: SceneId): Promise<OutlineSceneActionResult>;
  restoreTrashItem(trashItemId: OutlineScenesTrashItemId): Promise<OutlineSceneActionResult>;
  permanentlyDeleteTrashItem(trashItemId: OutlineScenesTrashItemId): Promise<OutlineSceneActionResult>;
  reorderChapterScenes(chapterId: string, sceneIds: SceneId[]): Promise<OutlineSceneActionResult>;
}

export interface OutlineSceneService {
  reader: OutlineSceneReader;
  actions: OutlineSceneActions;
  onDidChange(listener: (event: OutlineSceneChangeEvent) => unknown): vscode.Disposable;
}
