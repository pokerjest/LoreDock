import path from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function posixPath(...segments: string[]): string {
  return path.posix.join(...segments);
}

export function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'untitled';
}

export function nextNumberedId(prefix: string, existingIds: string[]): string {
  const used = new Set(existingIds);
  for (let index = 1; index < 10000; index += 1) {
    const id = `${prefix}-${String(index).padStart(3, '0')}`;
    if (!used.has(id)) {
      return id;
    }
  }
  throw new Error(`Unable to allocate id for prefix ${prefix}`);
}

export function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars < 32) {
    return value.slice(0, maxChars);
  }
  const half = Math.floor((maxChars - 20) / 2);
  return `${value.slice(0, half)}\n...[已省略]...\n${value.slice(-half)}`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function makeId(prefix: string): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${time}-${random}`;
}
