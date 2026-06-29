import { randomUUID } from "crypto";
import * as path from "path";
import type { DiagnosticItem, ManifestValidationResult, ProjectManifest } from "./types";
import {
  MANIFEST_RELATIVE_PATH,
  MANIFEST_SCHEMA_VERSION,
  PROJECT_ID_PREFIX
} from "./types";

type MutableManifest = Partial<ProjectManifest> & Record<string, unknown>;

export function generateProjectId(): string {
  return `${PROJECT_ID_PREFIX}${randomUUID()}`;
}

export function createDefaultManifest(workspaceFolderPath: string, now = new Date()): ProjectManifest {
  const timestamp = now.toISOString();

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: generateProjectId(),
    title: path.basename(workspaceFolderPath),
    createdAt: timestamp,
    updatedAt: timestamp,
    capabilities: []
  };
}

export function repairManifestValue(
  value: unknown,
  workspaceFolderPath: string,
  now = new Date()
): ProjectManifest {
  const fallback = createDefaultManifest(workspaceFolderPath, now);

  if (!isRecord(value)) {
    return fallback;
  }

  const candidate = value as MutableManifest;
  const createdAt = isIsoTimestamp(candidate.createdAt) ? candidate.createdAt : fallback.createdAt;

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: isNonEmptyString(candidate.projectId) ? candidate.projectId : fallback.projectId,
    title: isNonEmptyString(candidate.title) ? candidate.title : fallback.title,
    createdAt,
    updatedAt: now.toISOString(),
    capabilities: collectValidCapabilityIds(candidate.capabilities)
  };
}

export function validateProjectManifest(
  value: unknown,
  workspaceFolderPath: string,
  knownCapabilityIds = new Set<string>()
): ManifestValidationResult {
  const diagnostics: DiagnosticItem[] = [];
  let degraded = false;

  const add = (severity: DiagnosticItem["severity"], code: string, message: string): void => {
    diagnostics.push({
      severity,
      code,
      message,
      workspaceFolder: workspaceFolderPath,
      relativePath: MANIFEST_RELATIVE_PATH
    });
  };

  if (!isRecord(value)) {
    add("error", "manifest.notObject", "Project manifest must be a JSON object.");
    return { diagnostics, isValid: false, degraded: true };
  }

  const candidate = value as MutableManifest;

  if (candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    degraded = true;
    if (typeof candidate.schemaVersion !== "string" || candidate.schemaVersion.trim() === "") {
      add("error", "manifest.schemaVersion.invalid", "schemaVersion must be the string \"0.0.0\".");
    } else {
      add(
        "error",
        "manifest.schemaVersion.unsupported",
        `Unsupported schemaVersion "${candidate.schemaVersion}". v0.0 only supports "0.0.0".`
      );
    }
  }

  if (!isNonEmptyString(candidate.projectId)) {
    degraded = true;
    add("error", "manifest.projectId.invalid", "projectId must be a non-empty string.");
  }

  if (!isNonEmptyString(candidate.title)) {
    degraded = true;
    add("error", "manifest.title.invalid", "title must be a non-empty string.");
  }

  if (!isIsoTimestamp(candidate.createdAt)) {
    degraded = true;
    add("error", "manifest.createdAt.invalid", "createdAt must be an ISO timestamp string.");
  }

  if (!isIsoTimestamp(candidate.updatedAt)) {
    degraded = true;
    add("error", "manifest.updatedAt.invalid", "updatedAt must be an ISO timestamp string.");
  }

  const capabilitiesResult = validateCapabilities(candidate.capabilities);
  diagnostics.push(
    ...capabilitiesResult.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      workspaceFolder: workspaceFolderPath,
      relativePath: MANIFEST_RELATIVE_PATH
    }))
  );

  if (capabilitiesResult.hasErrors) {
    degraded = true;
  }

  for (const capabilityId of capabilitiesResult.validCapabilities) {
    if (!knownCapabilityIds.has(capabilityId)) {
      add("warning", "manifest.capability.unknown", `Unknown capability "${capabilityId}" is enabled.`);
    }
  }

  const isValid = !degraded;

  if (!isValid) {
    return { diagnostics, isValid, degraded };
  }

  const manifest: ProjectManifest = {
    schemaVersion: candidate.schemaVersion as string,
    projectId: candidate.projectId as string,
    title: candidate.title as string,
    createdAt: candidate.createdAt as string,
    updatedAt: candidate.updatedAt as string,
    capabilities: capabilitiesResult.validCapabilities
  };

  return {
    manifest,
    diagnostics,
    isValid,
    degraded
  };
}

export function isKnownFutureOrUnknownVersion(value: unknown): boolean {
  return isRecord(value) && typeof value.schemaVersion === "string" && value.schemaVersion !== MANIFEST_SCHEMA_VERSION;
}

function validateCapabilities(value: unknown): {
  validCapabilities: string[];
  diagnostics: Omit<DiagnosticItem, "workspaceFolder" | "relativePath">[];
  hasErrors: boolean;
} {
  const diagnostics: Omit<DiagnosticItem, "workspaceFolder" | "relativePath">[] = [];
  let hasErrors = false;

  if (!Array.isArray(value)) {
    return {
      validCapabilities: [],
      diagnostics: [
        {
          severity: "error",
          code: "manifest.capabilities.invalid",
          message: "capabilities must be an array of strings."
        }
      ],
      hasErrors: true
    };
  }

  const validCapabilities: string[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      hasErrors = true;
      diagnostics.push({
        severity: "error",
        code: "manifest.capability.invalid",
        message: `capabilities[${index}] must be a non-empty string.`
      });
      return;
    }

    if (seen.has(item)) {
      diagnostics.push({
        severity: "warning",
        code: "manifest.capability.duplicate",
        message: `Duplicate capability "${item}" will be activated only once in memory.`
      });
      return;
    }

    seen.add(item);
    validCapabilities.push(item);
  });

  return { validCapabilities, diagnostics, hasErrors };
}

function collectValidCapabilityIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || seen.has(item)) {
      continue;
    }

    seen.add(item);
    ids.push(item);
  }

  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}
