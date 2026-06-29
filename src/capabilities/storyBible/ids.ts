import { createHash, randomUUID } from "crypto";
import type {
  KeywordSlug,
  StoryBibleCardId,
  StoryBibleCardType,
  StoryBibleTrashItemId
} from "./types";

const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createStoryBibleCardId(): StoryBibleCardId {
  return `story_${randomUUID()}` as StoryBibleCardId;
}

export function createStoryBibleTrashItemId(): StoryBibleTrashItemId {
  return `trash_${randomUUID()}` as StoryBibleTrashItemId;
}

export function createObjectKeywordSlug(type: StoryBibleCardType, name: string, taken: Set<string>): KeywordSlug {
  const base = `${type}/${slugSegmentFromName(name)}`;
  return createUniqueKeywordSlug(base, taken);
}

export function createUniqueKeywordSlug(base: string, taken: Set<string>): KeywordSlug {
  const cleanBase = normalizeKeywordSlugInput(base);
  if (!isValidKeywordSlug(cleanBase)) {
    throw new Error(`keyword slug "${base}" 不合法。`);
  }

  if (!taken.has(cleanBase)) {
    return cleanBase as KeywordSlug;
  }

  let suffix = 2;
  let candidate = `${cleanBase}-${suffix}`;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }

  return candidate as KeywordSlug;
}

export function slugSegmentFromName(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (ascii !== "") {
    return ascii;
  }

  return `u-${stableShortHash(name)}`;
}

export function createUniqueFileBasename(name: string, extension: ".md", taken: Set<string>): string {
  const base = slugSegmentFromName(name);
  let candidate = `${base}${extension}`;
  let suffix = 2;

  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}${extension}`;
    suffix += 1;
  }

  return candidate;
}

export function normalizeKeywordSlugInput(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function isValidKeywordSlug(value: string): boolean {
  if (value.trim() !== value || value === "" || value.includes("\\") || value.includes(" ") || value.includes("%")) {
    return false;
  }

  return value.split("/").every((segment) => segment !== "." && segment !== ".." && SEGMENT_PATTERN.test(segment));
}

export function isReservedObjectKeywordSlug(value: string): boolean {
  return value.startsWith("character/") || value.startsWith("location/") || value.startsWith("rule/");
}

export function objectKeywordPrefixFor(type: StoryBibleCardType): `${StoryBibleCardType}/` {
  return `${type}/`;
}

export function keywordLabelFromSlug(slug: string): string {
  const withoutObjectPrefix = slug.replace(/^(character|location|rule)\//, "");
  const last = withoutObjectPrefix.split("/").filter(Boolean).at(-1) ?? withoutObjectPrefix;
  return last.replace(/-/g, " ");
}

function stableShortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

