import { createHash, randomUUID } from "crypto";
import type { OutlineScenesTrashItemId, SceneId } from "./types";

export function createSceneId(): SceneId {
  return `scene_${randomUUID()}` as SceneId;
}

export function createOutlineScenesTrashItemId(): OutlineScenesTrashItemId {
  return `trash_${randomUUID()}` as OutlineScenesTrashItemId;
}

export function slugSegmentFromTitle(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (ascii !== "") {
    return ascii;
  }

  return `u-${createStableShortHash(title)}`;
}

export function createStableOutlineNodeId(relativePath: string, kind: string, line: number): string {
  return `${relativePath}:${kind}:${line}`;
}

function createStableShortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}
