import * as fs from "fs/promises";
import * as path from "path";
import { normalizeRelativePath } from "./operationPlan";

export type ExistingWorkspacePathInspection =
  | { status: "safe"; absolutePath: string }
  | { status: "missing"; absolutePath: string }
  | { status: "unsafe"; absolutePath: string };

export async function inspectExistingWorkspacePath(
  workspaceRoot: string,
  relativePath: string
): Promise<ExistingWorkspacePathInspection> {
  const normalized = normalizeRelativePath(relativePath);
  const workspaceAbsolutePath = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(workspaceRoot, normalized);

  if (path.isAbsolute(relativePath) || normalized === ".." || normalized.startsWith("../")) {
    return { status: "unsafe", absolutePath };
  }

  if (!isInside(workspaceAbsolutePath, absolutePath)) {
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

export async function resolveExistingSafeWorkspacePath(
  workspaceRoot: string,
  relativePath: string
): Promise<string | undefined> {
  const inspection = await inspectExistingWorkspacePath(workspaceRoot, relativePath);
  return inspection.status === "safe" ? inspection.absolutePath : undefined;
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
