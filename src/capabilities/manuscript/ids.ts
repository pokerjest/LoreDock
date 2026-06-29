import { randomUUID } from "crypto";
import type { BookId, ChapterId, TrashItemId, VolumeId } from "./types";

export function createBookId(): BookId {
  return `book_${randomUUID()}` as BookId;
}

export function createVolumeId(): VolumeId {
  return `volume_${randomUUID()}` as VolumeId;
}

export function createChapterId(): ChapterId {
  return `chapter_${randomUUID()}` as ChapterId;
}

export function createTrashItemId(): TrashItemId {
  return `trash_${randomUUID()}` as TrashItemId;
}

export function formatNumberedName(prefix: string, value: number): string {
  return `${prefix}-${value.toString().padStart(3, "0")}`;
}
