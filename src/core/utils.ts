import path from 'node:path';

const WINDOWS_RESERVED_BASENAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

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
  const slug = normalized || 'untitled';
  return WINDOWS_RESERVED_BASENAMES.has(slug) ? `${slug}-file` : slug;
}

export function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function decodeTextBuffer(input: Uint8Array): string {
  const buffer = Buffer.from(input);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(Math.max(0, buffer.length - 2));
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8');
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
