import * as fs from "fs/promises";
import { validateProjectManifest } from "../../kernel/manifest";
import { normalizeRelativePath } from "../../kernel/operationPlan";
import { inspectExistingWorkspacePath } from "../../kernel/safeWorkspacePath";
import { MANIFEST_RELATIVE_PATH, type DiagnosticItem } from "../../kernel/types";
import { MANUSCRIPT_CAPABILITY_ID } from "../manuscript/types";
import { OUTLINE_SCENES_CAPABILITY_ID } from "../outlineScenes/types";
import { STORY_BIBLE_CAPABILITY_ID } from "../storyBible/types";
import { isValidKeywordSlug, keywordLabelFromSlug, normalizeKeywordSlugInput } from "../storyBible/ids";
import {
  BOARDS_DIR,
  PLOT_GRID_CAPABILITY_ID,
  PLOT_GRID_CONFIG_PATH,
  PLOT_GRID_CONFIG_SCHEMA_VERSION,
  PLOT_GRID_ROW_MODES,
  PLOT_GRID_VISIBLE_COLUMNS,
  type PlotGridConfigDto,
  type PlotGridConfiguredTrackDto,
  type PlotGridViewPreferencesDto,
  type PlotGridVisibleColumn
} from "./types";

export interface PlotGridConfigReadResult {
  status: "missing" | "valid" | "degraded";
  diagnostics: DiagnosticItem[];
  config: PlotGridConfigDto;
  raw?: Record<string, unknown>;
}

export function createDefaultPlotGridConfig(now = new Date("1970-01-01T00:00:00.000Z")): PlotGridConfigDto {
  return {
    schemaVersion: PLOT_GRID_CONFIG_SCHEMA_VERSION,
    tracks: [],
    view: createDefaultPlotGridView(),
    updatedAt: now.toISOString()
  };
}

export function createDefaultPlotGridView(): PlotGridViewPreferencesDto {
  return {
    rowMode: "scene",
    visibleColumns: ["status", "pov", "characters", "locations", "wordCount"],
    showEmptyTracks: true,
    compact: true
  };
}

export async function readPlotGridConfig(workspaceRoot: string): Promise<PlotGridConfigReadResult> {
  const diagnostics: DiagnosticItem[] = [];
  const boardsInspection = await inspectExistingWorkspacePath(workspaceRoot, BOARDS_DIR);
  const configInspection = await inspectExistingWorkspacePath(workspaceRoot, PLOT_GRID_CONFIG_PATH);

  if (boardsInspection.status === "unsafe") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.path.unsafe", `路径 "${BOARDS_DIR}" 不安全。`, BOARDS_DIR));
  }
  if (configInspection.status === "unsafe") {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.config.path.unsafe", `路径 "${PLOT_GRID_CONFIG_PATH}" 不安全。`, PLOT_GRID_CONFIG_PATH));
  }
  if (configInspection.status !== "safe") {
    return {
      status: diagnostics.some((item) => item.severity === "error") ? "degraded" : "missing",
      diagnostics,
      config: createDefaultPlotGridConfig()
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(configInspection.absolutePath, "utf8"));
  } catch (error) {
    diagnostics.push(diagnostic(
      workspaceRoot,
      "error",
      "plotGrid.config.json.invalid",
      `Plot Grid 配置不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      PLOT_GRID_CONFIG_PATH
    ));
    return { status: "degraded", diagnostics, config: createDefaultPlotGridConfig() };
  }

  if (!isRecord(raw)) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.config.notObject", "Plot Grid 配置必须是 JSON 对象。", PLOT_GRID_CONFIG_PATH));
    return { status: "degraded", diagnostics, config: createDefaultPlotGridConfig() };
  }

  const config = parsePlotGridConfig(workspaceRoot, raw, diagnostics);
  return {
    status: diagnostics.some((item) => item.severity === "error") ? "degraded" : "valid",
    diagnostics,
    config,
    raw
  };
}

export async function isPlotGridCapabilityEnabled(workspaceRoot: string): Promise<boolean> {
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, MANIFEST_RELATIVE_PATH);
  if (inspection.status !== "safe") {
    return false;
  }

  try {
    const value = JSON.parse(await fs.readFile(inspection.absolutePath, "utf8")) as unknown;
    const validation = validateProjectManifest(
      value,
      workspaceRoot,
      new Set([PLOT_GRID_CAPABILITY_ID, MANUSCRIPT_CAPABILITY_ID, OUTLINE_SCENES_CAPABILITY_ID, STORY_BIBLE_CAPABILITY_ID])
    );
    return validation.isValid && Boolean(validation.manifest?.capabilities.includes(PLOT_GRID_CAPABILITY_ID));
  } catch {
    return false;
  }
}

export function stringifyPlotGridConfig(config: PlotGridConfigDto, raw?: Record<string, unknown>): string {
  const value: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const rawTracks = Array.isArray(raw?.tracks) ? raw.tracks.filter(isRecord) : [];
  const rawTracksById = new Map(rawTracks.map((track) => [typeof track.id === "string" ? normalizeKeywordSlugInput(track.id) : "", track]));

  value.schemaVersion = PLOT_GRID_CONFIG_SCHEMA_VERSION;
  value.tracks = config.tracks.map((track) => {
    const rawTrack = rawTracksById.get(track.id);
    return {
      ...(rawTrack ? { ...rawTrack } : {}),
      id: track.id,
      label: track.label,
      ...(track.color ? { color: track.color } : {}),
      order: track.order,
      visible: track.visible
    };
  });

  const rawView = isRecord(raw?.view) ? { ...raw.view } : {};
  value.view = {
    ...rawView,
    rowMode: config.view.rowMode,
    visibleColumns: config.view.visibleColumns,
    showEmptyTracks: config.view.showEmptyTracks,
    compact: config.view.compact
  };
  value.updatedAt = config.updatedAt;

  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeTrackId(value: string): string {
  return normalizeKeywordSlugInput(value);
}

export function createInferredTrack(id: string, order: number): PlotGridConfiguredTrackDto {
  return {
    id,
    label: keywordLabelFromSlug(id),
    order,
    visible: true
  };
}

export function isPlotGridContentPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === BOARDS_DIR || normalized === PLOT_GRID_CONFIG_PATH;
}

export function diagnostic(
  workspaceRoot: string,
  severity: DiagnosticItem["severity"],
  code: string,
  message: string,
  relativePath = PLOT_GRID_CONFIG_PATH
): DiagnosticItem {
  return {
    severity,
    code,
    message,
    workspaceFolder: workspaceRoot,
    relativePath: normalizeRelativePath(relativePath)
  };
}

function parsePlotGridConfig(
  workspaceRoot: string,
  raw: Record<string, unknown>,
  diagnostics: DiagnosticItem[]
): PlotGridConfigDto {
  if (raw.schemaVersion !== PLOT_GRID_CONFIG_SCHEMA_VERSION) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.config.schemaVersion.unsupported", `Plot Grid config schemaVersion 必须是 "${PLOT_GRID_CONFIG_SCHEMA_VERSION}"。`));
  }

  const tracks = parseTracks(workspaceRoot, raw.tracks, diagnostics);
  const view = parseView(workspaceRoot, raw.view, diagnostics);
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim() !== ""
    ? raw.updatedAt
    : createDefaultPlotGridConfig().updatedAt;

  return {
    schemaVersion: PLOT_GRID_CONFIG_SCHEMA_VERSION,
    tracks,
    view,
    updatedAt
  };
}

function parseTracks(
  workspaceRoot: string,
  value: unknown,
  diagnostics: DiagnosticItem[]
): PlotGridConfiguredTrackDto[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.config.tracks.invalid", "tracks 必须是数组。"));
    return [];
  }

  const result: PlotGridConfiguredTrackDto[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.track.invalid", `tracks[${index}] 必须是对象。`));
      continue;
    }
    const id = typeof item.id === "string" ? normalizeTrackId(item.id) : "";
    if (!id || !isValidKeywordSlug(id)) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.track.id.invalid", `tracks[${index}].id 必须是合法 keyword slug。`));
      continue;
    }
    if (seen.has(id)) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.track.id.duplicate", `轨道 "${id}" 重复。`));
      continue;
    }
    seen.add(id);

    const label = typeof item.label === "string" && item.label.trim() !== "" ? item.label.trim() : keywordLabelFromSlug(id);
    if (typeof item.label !== "string" || item.label.trim() === "") {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.track.label.invalid", `轨道 "${id}" 的 label 不能为空。`));
    }

    const order = typeof item.order === "number" && Number.isInteger(item.order) && item.order > 0 ? item.order : result.length + 1;
    if (item.order !== undefined && order !== item.order) {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.track.order.invalid", `轨道 "${id}" 的 order 必须是正整数。`));
    }

    const visible = item.visible === undefined ? true : item.visible === true;
    if (item.visible !== undefined && typeof item.visible !== "boolean") {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.track.visible.invalid", `轨道 "${id}" 的 visible 必须是布尔值。`));
    }

    const color = typeof item.color === "string" && isHexColor(item.color) ? item.color : undefined;
    if (item.color !== undefined && (typeof item.color !== "string" || !isHexColor(item.color))) {
      diagnostics.push(diagnostic(workspaceRoot, "warning", "plotGrid.track.color.invalid", `轨道 "${id}" 的 color 不是合法十六进制颜色。`));
    }

    result.push({
      id,
      label,
      ...(color ? { color } : {}),
      order,
      visible
    });
  }

  const orderSeen = new Set<number>();
  for (const track of result) {
    if (orderSeen.has(track.order)) {
      diagnostics.push(diagnostic(workspaceRoot, "warning", "plotGrid.track.order.duplicate", `多个轨道使用 order ${track.order}。`));
    }
    orderSeen.add(track.order);
  }

  return sortConfiguredTracks(result);
}

function parseView(
  workspaceRoot: string,
  value: unknown,
  diagnostics: DiagnosticItem[]
): PlotGridViewPreferencesDto {
  const defaults = createDefaultPlotGridView();
  if (value === undefined) {
    return defaults;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.view.invalid", "view 必须是对象。"));
    return defaults;
  }

  const rowMode = PLOT_GRID_ROW_MODES.includes(value.rowMode as PlotGridViewPreferencesDto["rowMode"])
    ? value.rowMode as PlotGridViewPreferencesDto["rowMode"]
    : defaults.rowMode;
  if (value.rowMode !== undefined && rowMode !== value.rowMode) {
    diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.view.rowMode.invalid", "view.rowMode 必须是 scene 或 chapter。"));
  }

  let visibleColumns = defaults.visibleColumns;
  if (value.visibleColumns !== undefined) {
    if (Array.isArray(value.visibleColumns)) {
      visibleColumns = value.visibleColumns.filter((column): column is PlotGridVisibleColumn =>
        PLOT_GRID_VISIBLE_COLUMNS.includes(column as PlotGridVisibleColumn)
      );
      if (visibleColumns.length !== value.visibleColumns.length) {
        diagnostics.push(diagnostic(workspaceRoot, "warning", "plotGrid.view.visibleColumns.unknown", "view.visibleColumns 包含 v0.4 不支持的列名。"));
      }
    } else {
      diagnostics.push(diagnostic(workspaceRoot, "error", "plotGrid.view.visibleColumns.invalid", "view.visibleColumns 必须是数组。"));
    }
  }

  return {
    rowMode,
    visibleColumns,
    showEmptyTracks: typeof value.showEmptyTracks === "boolean" ? value.showEmptyTracks : defaults.showEmptyTracks,
    compact: typeof value.compact === "boolean" ? value.compact : defaults.compact
  };
}

function sortConfiguredTracks(tracks: PlotGridConfiguredTrackDto[]): PlotGridConfiguredTrackDto[] {
  return [...tracks].sort((left, right) =>
    left.order - right.order || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
