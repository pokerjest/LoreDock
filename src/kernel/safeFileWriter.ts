import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { OperationPlan } from "./types";
import { isDeclaredDirectory, isDeclaredFile, normalizeRelativePath } from "./operationPlan";

export class SafeFileWriter {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly plan: OperationPlan
  ) {}

  public async ensureDirectory(relativePath: string): Promise<void> {
    if (!isDeclaredDirectory(this.plan, relativePath)) {
      throw new Error(`Directory "${relativePath}" was not declared in the operation plan.`);
    }

    const absolutePath = await this.resolveWithinWorkspace(relativePath, true);
    await this.ensureParentExists(path.dirname(absolutePath), relativePath);

    try {
      await fs.mkdir(absolutePath);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }

      const stats = await fs.stat(absolutePath);
      if (!stats.isDirectory()) {
        throw new Error(`Path "${relativePath}" exists but is not a directory.`);
      }
    }
  }

  public async writeFile(relativePath: string, content: string): Promise<void> {
    if (!isDeclaredFile(this.plan, relativePath)) {
      throw new Error(`File "${relativePath}" was not declared in the operation plan.`);
    }

    const targetPath = await this.resolveWithinWorkspace(relativePath, true);
    const parentPath = path.dirname(targetPath);

    await this.ensureParentExists(parentPath, relativePath);

    const tempPath = path.join(parentPath, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);

    try {
      await fs.writeFile(tempPath, content, "utf8");
      await fs.stat(tempPath);
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async resolveWithinWorkspace(relativePath: string, allowExistingTarget = false): Promise<string> {
    const normalized = normalizeRelativePath(relativePath);

    if (path.isAbsolute(relativePath) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Path "${relativePath}" is not workspace-relative.`);
    }

    const workspaceAbsolutePath = path.resolve(this.workspaceRoot);
    const workspaceRealPath = await fs.realpath(this.workspaceRoot);
    const absolutePath = path.resolve(this.workspaceRoot, normalized);

    if (!isInside(workspaceAbsolutePath, absolutePath)) {
      throw new Error(`Path "${relativePath}" escapes the workspace.`);
    }

    await this.validateExistingParents(workspaceRealPath, absolutePath);

    if (allowExistingTarget) {
      await this.validateExistingTarget(workspaceRealPath, absolutePath);
    }

    return absolutePath;
  }

  private async validateExistingParents(workspaceRealPath: string, targetPath: string): Promise<void> {
    const relativeToWorkspace = path.relative(this.workspaceRoot, path.dirname(targetPath));
    const segments = relativeToWorkspace === "" ? [] : relativeToWorkspace.split(path.sep);
    let current = this.workspaceRoot;

    for (const segment of segments) {
      current = path.join(current, segment);

      try {
        const stats = await fs.lstat(current);
        if (!stats.isDirectory() && !stats.isSymbolicLink()) {
          throw new Error(`Parent path "${current}" is not a directory.`);
        }

        const real = await fs.realpath(current);
        if (!isInside(workspaceRealPath, real)) {
          throw new Error(`Parent path "${current}" escapes the workspace.`);
        }
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }
    }
  }

  private async validateExistingTarget(workspaceRealPath: string, targetPath: string): Promise<void> {
    try {
      const stats = await fs.lstat(targetPath);

      if (stats.isSymbolicLink()) {
        const real = await fs.realpath(targetPath);
        if (!isInside(workspaceRealPath, real)) {
          throw new Error(`Target path "${targetPath}" escapes the workspace.`);
        }
      }
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  private async ensureParentExists(parentPath: string, relativePath: string): Promise<void> {
    try {
      const stats = await fs.stat(parentPath);
      if (!stats.isDirectory()) {
        throw new Error(`Parent path for "${relativePath}" is not a directory.`);
      }
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`Parent path for "${relativePath}" does not exist or was not declared.`);
      }
      throw error;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
