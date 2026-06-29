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

export function isDeclaredFileCreate(plan: OperationPlan, relativePath: string): boolean {
  return createPlanSet(plan.filesToCreate).has(normalizeRelativePath(relativePath));
}

export function isDeclaredFileModify(plan: OperationPlan, relativePath: string): boolean {
  return createPlanSet(plan.filesToModify).has(normalizeRelativePath(relativePath));
}

export function isDeclaredDirectory(plan: OperationPlan, relativePath: string): boolean {
  return createPlanSet(plan.directoriesToCreate).has(normalizeRelativePath(relativePath));
}

export function isDeclaredMove(plan: OperationPlan, from: string, to: string): boolean {
  const normalizedFrom = normalizeRelativePath(from);
  const normalizedTo = normalizeRelativePath(to);

  return (plan.filesToMove ?? []).some(
    (operation) =>
      normalizeRelativePath(operation.from) === normalizedFrom &&
      normalizeRelativePath(operation.to) === normalizedTo
  );
}

export function isDeclaredDirectoryMove(plan: OperationPlan, from: string, to: string): boolean {
  const normalizedFrom = normalizeRelativePath(from);
  const normalizedTo = normalizeRelativePath(to);

  return (plan.directoriesToMove ?? []).some(
    (operation) =>
      normalizeRelativePath(operation.from) === normalizedFrom &&
      normalizeRelativePath(operation.to) === normalizedTo
  );
}

export function isDeclaredDelete(plan: OperationPlan, relativePath: string): boolean {
  return createPlanSet(plan.filesToDelete ?? []).has(normalizeRelativePath(relativePath));
}

export function isDeclaredDirectoryDelete(plan: OperationPlan, relativePath: string): boolean {
  return createPlanSet(plan.directoriesToDelete ?? []).has(normalizeRelativePath(relativePath));
}

export function isDeclaredBackup(plan: OperationPlan, source: string, backup: string): boolean {
  const normalizedSource = normalizeRelativePath(source);
  const normalizedBackup = normalizeRelativePath(backup);

  return (plan.filesToBackup ?? []).some(
    (operation) =>
      normalizeRelativePath(operation.source) === normalizedSource &&
      normalizeRelativePath(operation.backup) === normalizedBackup
  );
}
