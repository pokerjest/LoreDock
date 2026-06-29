import type * as vscode from "vscode";
import type { OperationPlan } from "../../kernel/types";

export const STORY_BIBLE_CAPABILITY_ID = "story-bible.core";
export const STORY_BIBLE_CARD_SCHEMA_ID = "story-bible.element";
export const STORY_BIBLE_TAG_SCHEMA_ID = "story-bible.tag";
export const STORY_BIBLE_SCHEMA_VERSION = "0.2.0";

export const LORE_DIR = "lore";
export const STORY_BIBLE_CHARACTER_DIR = "lore/characters";
export const STORY_BIBLE_LOCATION_DIR = "lore/locations";
export const STORY_BIBLE_RULE_DIR = "lore/rules";
export const STORY_BIBLE_TAG_DIR = "lore/tags";

export const STORY_BIBLE_TRASH_DIR = ".loredock/trash/resources/story-bible";
export const STORY_BIBLE_TRASH_METADATA = "trash-item.json";

export type StoryBibleCardId = string & { readonly __brand: "StoryBibleCardId" };
export type StoryBibleTrashItemId = string & { readonly __brand: "StoryBibleTrashItemId" };
export type KeywordSlug = string & { readonly __brand: "KeywordSlug" };

export type StoryBibleCardType = "character" | "location" | "rule";
export type StoryBibleVisibility = "public" | "spoiler" | "private";
export type StoryBibleStatus = "draft" | "canon" | "archived";
export type KeywordSourceStatus = "system-object" | "user-defined" | "inferred";
export type StoryBibleChangeType = "structure" | "metadata" | "content";
export type StoryBibleTrashResourceType = "card" | "keyword-definition";

export const STORY_BIBLE_CARD_TYPES: StoryBibleCardType[] = ["character", "location", "rule"];
export const STORY_BIBLE_VISIBILITIES: StoryBibleVisibility[] = ["public", "spoiler", "private"];
export const STORY_BIBLE_STATUSES: StoryBibleStatus[] = ["draft", "canon", "archived"];
export const STORY_BIBLE_RESERVED_KEYWORD_PREFIXES = ["character/", "location/", "rule/"] as const;

export interface StoryBibleCardDto {
  id: StoryBibleCardId;
  type: StoryBibleCardType;
  name: string;
  aliases: string[];
  tags: KeywordSlug[];
  primaryKeyword: KeywordSlug;
  keywordLabels: Record<string, string>;
  summary: string;
  visibility: StoryBibleVisibility;
  status: StoryBibleStatus;
  createdAt: string;
  updatedAt: string;
  path: string;
  title?: string;
  chapterRefs?: string[];
}

export interface KeywordDefinitionDto {
  slug: KeywordSlug;
  label: string;
  description: string;
  category: string;
  appliesTo: string[];
  createdAt: string;
  updatedAt: string;
  path: string;
}

export interface KeywordCatalogEntryDto {
  slug: KeywordSlug;
  label: string;
  description: string;
  category: string;
  appliesTo: string[];
  usageCount: number;
  definitionPath?: string;
  source: KeywordSourceStatus;
}

export interface StoryBibleTrashItemDto {
  id: StoryBibleTrashItemId;
  resourceType: StoryBibleTrashResourceType;
  cardType?: StoryBibleCardType;
  title: string;
  deletedAt: string;
  originalPath: string;
  trashPath: string;
  originalFileName: string;
  cardId?: StoryBibleCardId;
  keywordSlug?: KeywordSlug;
}

export interface StoryBibleSearchQuery {
  text?: string;
  type?: StoryBibleCardType;
  visibility?: StoryBibleVisibility;
  status?: StoryBibleStatus;
  keyword?: KeywordSlug | string;
}

export interface StoryBibleKeywordSearchQuery {
  text?: string;
  appliesTo?: StoryBibleCardType | "any";
  category?: string;
}

export interface StoryBibleReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface StoryBibleActionResult {
  applied: boolean;
  plan: OperationPlan;
}

export interface StoryBibleCardMetadataPatch {
  name?: string;
  aliases?: string[];
  tags?: string[];
  summary?: string;
  visibility?: StoryBibleVisibility;
  status?: StoryBibleStatus;
  chapterRefs?: string[];
}

export interface StoryBibleKeywordInput {
  slug: string;
  label: string;
  description?: string;
  category?: string;
  appliesTo?: string[];
  body?: string;
}

export interface StoryBibleChangeEvent {
  type: StoryBibleChangeType;
  workspaceFolder: vscode.WorkspaceFolder;
  cardId?: StoryBibleCardId;
  keywordSlug?: KeywordSlug;
  trashItemId?: StoryBibleTrashItemId;
  path?: string;
}

export interface StoryBibleReader {
  listCards(query?: StoryBibleSearchQuery): Promise<StoryBibleCardDto[]>;
  getCard(cardId: StoryBibleCardId): Promise<StoryBibleCardDto | undefined>;
  resolveCardPath(cardId: StoryBibleCardId): Promise<string | undefined>;
  readCardText(cardId: StoryBibleCardId): Promise<StoryBibleReadResult>;
  listKeywords(query?: StoryBibleKeywordSearchQuery): Promise<KeywordCatalogEntryDto[]>;
  searchCards(query: StoryBibleSearchQuery): Promise<StoryBibleCardDto[]>;
  searchKeywords(query: StoryBibleKeywordSearchQuery): Promise<KeywordCatalogEntryDto[]>;
  readKeywordDefinitionText(slug: KeywordSlug | string): Promise<StoryBibleReadResult>;
  listTrashItems(): Promise<StoryBibleTrashItemDto[]>;
}

export interface StoryBibleActions {
  createCard(
    type: StoryBibleCardType,
    name: string,
    options?: Partial<Pick<StoryBibleCardDto, "aliases" | "summary" | "visibility" | "status" | "chapterRefs">>
  ): Promise<StoryBibleActionResult>;
  renameCard(cardId: StoryBibleCardId, name: string): Promise<StoryBibleActionResult>;
  updateCardMetadata(cardId: StoryBibleCardId, patch: StoryBibleCardMetadataPatch): Promise<StoryBibleActionResult>;
  deleteCard(cardId: StoryBibleCardId): Promise<StoryBibleActionResult>;
  defineKeyword(input: StoryBibleKeywordInput): Promise<StoryBibleActionResult>;
  updateKeywordDefinition(slug: KeywordSlug | string, patch: Partial<StoryBibleKeywordInput>): Promise<StoryBibleActionResult>;
  deleteKeywordDefinition(slug: KeywordSlug | string): Promise<StoryBibleActionResult>;
  restoreTrashItem(trashItemId: StoryBibleTrashItemId): Promise<StoryBibleActionResult>;
  permanentlyDeleteTrashItem(trashItemId: StoryBibleTrashItemId): Promise<StoryBibleActionResult>;
}

export interface StoryBibleService {
  reader: StoryBibleReader;
  actions: StoryBibleActions;
  onDidChange(listener: (event: StoryBibleChangeEvent) => unknown): vscode.Disposable;
}
