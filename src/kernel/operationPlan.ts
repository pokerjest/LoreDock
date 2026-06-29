import * as path from "path";
import type { OperationPlan } from "./types";

export function normalizeRelativePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/\\/g, "/"));
}

export function createPlanSet(paths: string[]): Set<string> {
  return new Set(paths.map(normalizeRelativePath));
}

export function isDeclaredFile(plan: OperationPlan, relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return createPlanSet([...plan.filesToCreate, ...plan.filesToModify]).has(normalized);
}

export function isDeclaredDirectory(plan: OperationPlan, relativePath: string): boolean {
  return createPlanSet(plan.directoriesToCreate).has(normalizeRelativePath(relativePath));
}
