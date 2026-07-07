import type * as vscode from "vscode";
import type { OperationPlan } from "../../kernel/types";
import type { ChapterId } from "../manuscript/types";
import type { SceneCardMetadataPatch, SceneId, SceneStatus } from "../outlineScenes/types";

export const PLOT_GRID_CAPABILITY_ID = "structure.plot-grid";
export const PLOT_GRID_SCHEMA_ID = "plot-grid.config";
export const PLOT_GRID_CONFIG_SCHEMA_VERSION = "0.4.0";
export const BOARDS_DIR = "boards";
export const PLOT_GRID_CONFIG_PATH = "boards/plot-grid.json";

export type PlotGridTrackSource = "configured" | "inferred";
export type PlotGridRowMode = "scene" | "chapter";
export type PlotGridVisibleColumn =
  | "status"
  | "pov"
  | "characters"
  | "locations"
  | "rules"
  | "wordCount"
  | "targetWordCount";
export type PlotGridRowType = "chapter" | "scene";
export type PlotGridSourceType = "chapter" | "scene" | "storyBibleCard" | "keyword";
export type PlotGridChangeType = "config" | "projection";

export const PLOT_GRID_ROW_MODES: PlotGridRowMode[] = ["scene", "chapter"];
export const PLOT_GRID_VISIBLE_COLUMNS: PlotGridVisibleColumn[] = [
  "status",
  "pov",
  "characters",
  "locations",
  "rules",
  "wordCount",
  "targetWordCount"
];

export interface PlotGridTrackDto {
  id: string;
  label: string;
  color?: string;
  order: number;
  visible: boolean;
  source: PlotGridTrackSource;
}

export interface PlotGridConfiguredTrackDto extends Omit<PlotGridTrackDto, "source"> {}

export interface PlotGridViewPreferencesDto {
  rowMode: PlotGridRowMode;
  visibleColumns: PlotGridVisibleColumn[];
  showEmptyTracks: boolean;
  compact: boolean;
}

export interface PlotGridConfigDto {
  schemaVersion: string;
  tracks: PlotGridConfiguredTrackDto[];
  view: PlotGridViewPreferencesDto;
  updatedAt: string;
}

export interface PlotGridTrackInput {
  id: string;
  label?: string;
  color?: string;
  visible?: boolean;
}

export interface PlotGridViewPreferencesPatch {
  rowMode?: PlotGridRowMode;
  visibleColumns?: PlotGridVisibleColumn[];
  showEmptyTracks?: boolean;
  compact?: boolean;
}

export interface PlotGridFilters {
  text?: string;
  status?: SceneStatus | string;
  characterRef?: string;
  locationRef?: string;
  plotlineRef?: string;
}

export interface PlotGridEntityDto {
  ref: string;
  label: string;
  type: "character" | "location" | "rule" | "keyword" | "unknown";
  path?: string;
  intro?: string;
  summary?: string;
  description?: string;
  aliases?: string[];
  status?: string;
  visibility?: string;
  category?: string;
}

export interface PlotGridRowDto {
  id: string;
  type: PlotGridRowType;
  title: string;
  chapterId?: ChapterId;
  sceneId?: SceneId;
  volumeId?: string;
  path?: string;
  status?: SceneStatus | string;
  pov?: string;
  characterRefs: string[];
  locationRefs: string[];
  ruleRefs: string[];
  plotlineRefs: string[];
  wordCount?: number;
  targetWordCount?: number;
  isEmpty?: boolean;
  conflict?: string;
  turn?: string;
  outcome?: string;
  diagnostics: string[];
  sourceType: PlotGridSourceType;
}

export interface PlotGridFilterOptionsDto {
  statuses: string[];
  characters: PlotGridEntityDto[];
  locations: PlotGridEntityDto[];
  plotlines: Array<{ id: string; label: string }>;
}

export interface PlotGridProjectionDto {
  rowMode: PlotGridRowMode;
  visibleColumns: PlotGridVisibleColumn[];
  tracks: PlotGridTrackDto[];
  rows: PlotGridRowDto[];
  filters: PlotGridFilterOptionsDto;
  entities: Record<string, PlotGridEntityDto>;
  diagnostics: string[];
}

export interface PlotGridActionResult {
  applied: boolean;
  plan: OperationPlan;
}

export interface PlotGridReader {
  getConfig(): Promise<PlotGridConfigDto>;
  getProjection(filters?: PlotGridFilters): Promise<PlotGridProjectionDto>;
  listTracks(): Promise<PlotGridTrackDto[]>;
  validateConfig(): Promise<import("../../kernel/types").DiagnosticItem[]>;
}

export interface PlotGridActions {
  enablePlotGrid(): Promise<PlotGridActionResult>;
  upsertTrack(input: PlotGridTrackInput): Promise<PlotGridActionResult>;
  deleteTrack(trackId: string): Promise<PlotGridActionResult>;
  reorderTracks(trackIds: string[]): Promise<PlotGridActionResult>;
  updateViewPreferences(patch: PlotGridViewPreferencesPatch): Promise<PlotGridActionResult>;
  updateSceneMetadata(sceneId: SceneId, patch: SceneCardMetadataPatch): Promise<PlotGridActionResult>;
  assignSceneTrack(sceneId: SceneId, trackId: string, assigned: boolean): Promise<PlotGridActionResult>;
  reorderChapterScenes(chapterId: string, sceneIds: SceneId[]): Promise<PlotGridActionResult>;
}

export interface PlotGridChangeEvent {
  type: PlotGridChangeType;
  workspaceFolder: vscode.WorkspaceFolder;
  path?: string;
}

export interface PlotGridService {
  reader: PlotGridReader;
  actions: PlotGridActions;
  onDidChange(listener: (event: PlotGridChangeEvent) => unknown): vscode.Disposable;
}
