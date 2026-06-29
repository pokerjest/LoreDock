import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { OperationPlan } from "./types";
import {
  isDeclaredBackup,
  isDeclaredDelete,
  isDeclaredDirectory,
  isDeclaredDirectoryDelete,
  isDeclaredDirectoryMove,
  isDeclaredFile,
  isDeclaredFileCreate,
  isDeclaredFileModify,
  isDeclaredMove,
  normalizeRelativePath
} from "./operationPlan";

export class SafeFileWriter {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly plan: OperationPlan
  ) {}

  public async ensureDirectory(relativePath: string): Promise<void> {
    if (!isDeclaredDirectory(this.plan, relativePath)) {
      throw new Error(`目录 "${relativePath}" 未在操作计划中声明。`);
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
        throw new Error(`路径 "${relativePath}" 已存在，但不是目录。`);
      }
    }
  }

  public async writeFile(relativePath: string, content: string): Promise<void> {
    if (!isDeclaredFile(this.plan, relativePath)) {
      throw new Error(`文件 "${relativePath}" 未在操作计划中声明。`);
    }

    const isCreate = isDeclaredFileCreate(this.plan, relativePath);
    const isModify = isDeclaredFileModify(this.plan, relativePath);
    const targetPath = await this.resolveWithinWorkspace(relativePath, true);
    const parentPath = path.dirname(targetPath);

    await this.ensureParentExists(parentPath, relativePath);

    const tempPath = path.join(parentPath, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);

    try {
      await fs.writeFile(tempPath, content, "utf8");
      await fs.stat(tempPath);
      if (isCreate && !isModify) {
        try {
          await fs.link(tempPath, targetPath);
          await fs.rm(tempPath, { force: true }).catch(() => undefined);
        } catch (error) {
          if (isAlreadyExists(error)) {
            throw new Error(`文件 "${relativePath}" 已存在。`);
          }
          throw error;
        }
      } else {
        await fs.rename(tempPath, targetPath);
      }
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async moveFile(from: string, to: string): Promise<void> {
    if (!isDeclaredMove(this.plan, from, to)) {
      throw new Error(`移动 "${from}" -> "${to}" 未在操作计划中声明。`);
    }

    const sourcePath = await this.resolveWithinWorkspace(from, true);
    const targetPath = await this.resolveWithinWorkspace(to, true);
    await this.ensureParentExists(path.dirname(targetPath), to);

    if (await pathExists(targetPath)) {
      throw new Error(`目标路径 "${to}" 已存在。`);
    }

    await fs.rename(sourcePath, targetPath);
  }

  public async moveDirectory(from: string, to: string): Promise<void> {
    if (!isDeclaredDirectoryMove(this.plan, from, to)) {
      throw new Error(`移动目录 "${from}" -> "${to}" 未在操作计划中声明。`);
    }

    const sourcePath = await this.resolveWithinWorkspace(from, true);
    const targetPath = await this.resolveWithinWorkspace(to, true);
    await this.ensureParentExists(path.dirname(targetPath), to);

    const sourceStats = await fs.stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new Error(`源路径 "${from}" 不是目录。`);
    }

    if (await pathExists(targetPath)) {
      throw new Error(`目标目录 "${to}" 已存在。`);
    }

    await fs.rename(sourcePath, targetPath);
  }

  public async deleteFile(relativePath: string): Promise<void> {
    if (!isDeclaredDelete(this.plan, relativePath)) {
      throw new Error(`删除 "${relativePath}" 未在操作计划中声明。`);
    }

    const targetPath = await this.resolveWithinWorkspace(relativePath, true);
    await fs.rm(targetPath);
  }

  public async deleteDirectoryRecursive(relativePath: string): Promise<void> {
    if (!isDeclaredDirectoryDelete(this.plan, relativePath)) {
      throw new Error(`递归删除目录 "${relativePath}" 未在操作计划中声明。`);
    }

    const targetPath = await this.resolveWithinWorkspace(relativePath, true);
    const stats = await fs.stat(targetPath);
    if (!stats.isDirectory()) {
      throw new Error(`路径 "${relativePath}" 不是目录。`);
    }

    await fs.rm(targetPath, { recursive: true });
  }

  public async backupFile(source: string, backup: string): Promise<void> {
    if (!isDeclaredBackup(this.plan, source, backup)) {
      throw new Error(`备份 "${source}" -> "${backup}" 未在操作计划中声明。`);
    }

    const sourcePath = await this.resolveWithinWorkspace(source, true);
    const backupPath = await this.resolveWithinWorkspace(backup, true);
    await this.ensureParentExists(path.dirname(backupPath), backup);

    if (await pathExists(backupPath)) {
      throw new Error(`备份路径 "${backup}" 已存在。`);
    }

    await fs.copyFile(sourcePath, backupPath);
  }

  private async resolveWithinWorkspace(relativePath: string, allowExistingTarget = false): Promise<string> {
    const normalized = normalizeRelativePath(relativePath);

    if (path.isAbsolute(relativePath) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`路径 "${relativePath}" 不是工作区相对路径。`);
    }

    const workspaceAbsolutePath = path.resolve(this.workspaceRoot);
    const workspaceRealPath = await fs.realpath(this.workspaceRoot);
    const absolutePath = path.resolve(this.workspaceRoot, normalized);

    if (!isInside(workspaceAbsolutePath, absolutePath)) {
      throw new Error(`路径 "${relativePath}" 越出了工作区。`);
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
          throw new Error(`父路径 "${current}" 不是目录。`);
        }

        const real = await fs.realpath(current);
        if (!isInside(workspaceRealPath, real)) {
          throw new Error(`父路径 "${current}" 越出了工作区。`);
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
          throw new Error(`目标路径 "${targetPath}" 越出了工作区。`);
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
        throw new Error(`"${relativePath}" 的父路径不是目录。`);
      }
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`"${relativePath}" 的父路径不存在，或未在操作计划中声明。`);
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}
