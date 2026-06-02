export type ChapterStatus =
  | 'planned'
  | 'drafting'
  | 'draft-complete'
  | 'needs-polish'
  | 'needs-check'
  | 'complete'
  | 'abandoned';

export type AIProvider =
  | 'gpt'
  | 'claude'
  | 'anthropic'
  | 'gemini'
  | 'openai-compatible'
  | 'openrouter'
  | 'lm-studio'
  | 'ollama'
  | 'deepseek'
  | 'custom';

export type AITaskType = 'continue' | 'polish' | 'summary' | 'consistency' | 'test';

export interface ProjectManifest {
  schemaVersion: 1;
  title: string;
  author: string;
  genre: string;
  language: string;
  defaultStyle: string;
  createdAt: string;
  updatedAt: string;
  volumes: VolumeMeta[];
}

export interface VolumeMeta {
  id: string;
  title: string;
  order: number;
  chapters: ChapterMeta[];
}

export interface ChapterMeta {
  id: string;
  title: string;
  status: ChapterStatus;
  filePath: string;
  order: number;
  wordCount: number;
  lastModifiedAt?: string;
  summaryId?: string;
}

export interface ProjectInitOptions {
  title: string;
  author: string;
  genre: string;
  language: string;
  defaultStyle: string;
  createSamples: boolean;
  force?: boolean;
}

export interface CharacterRelationship {
  target: string;
  description: string;
}

export interface BaseCodexCard {
  schemaVersion: 1;
  id: string;
  kind: 'character' | 'location' | 'world-rule' | 'foreshadowing' | 'timeline-event' | 'scene' | 'beat';
  name: string;
  aliases: string[];
  tags: string[];
  allowInContext: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterCard extends BaseCodexCard {
  kind: 'character';
  identity: string;
  fixedSetting: string;
  personality: string;
  speechStyle: string;
  goals: string;
  abilities: string;
  weaknesses: string;
  relationships: CharacterRelationship[];
  currentState: string;
  firstAppearanceChapterId?: string;
  secrets: string;
  hiddenSecrets: string;
  forbiddenActions: string[];
}

export interface LocationCard extends BaseCodexCard {
  kind: 'location';
  type: string;
  region: string;
  visualFeatures: string;
  atmosphere: string;
  history: string;
  rules: string;
  relatedCharacters: string[];
  currentState: string;
  secrets: string;
  hiddenSecrets: string;
}

export type WorldRuleImportance = 'normal' | 'important' | 'absolute';

export interface WorldRule extends BaseCodexCard {
  kind: 'world-rule';
  importance: WorldRuleImportance;
  content: string;
  hidden: boolean;
}

export type ForeshadowingStatus = 'planned' | 'seeded' | 'developing' | 'resolved' | 'abandoned';

export interface ForeshadowingCard extends BaseCodexCard {
  kind: 'foreshadowing';
  status: ForeshadowingStatus;
  description: string;
  firstSeedChapterId?: string;
  expectedResolveChapterId?: string;
  relatedCharacters: string[];
  importance: WorldRuleImportance;
  allowRevealToAI: boolean;
  publicHint: string;
  hiddenTruth: string;
}

export interface TimelineEvent extends BaseCodexCard {
  kind: 'timeline-event';
  storyTime: string;
  chapterId?: string;
  location: string;
  participants: string[];
  result: string;
  visibility: 'reader-unknown' | 'character-unknown' | 'public';
}

export interface ScenePlan extends BaseCodexCard {
  kind: 'scene';
  chapterId?: string;
  viewpointCharacter: string;
  location: string;
  conflict: string;
  turn: string;
  outcome: string;
  order: number;
}

export interface BeatPlan extends BaseCodexCard {
  kind: 'beat';
  chapterId?: string;
  sceneId?: string;
  content: string;
  purpose: string;
  order: number;
  status: 'planned' | 'expanded' | 'discarded';
}

export type CodexCard = CharacterCard | LocationCard | WorldRule | ForeshadowingCard | TimelineEvent | ScenePlan | BeatPlan;

export interface ChapterSummary {
  schemaVersion: 1;
  id: string;
  chapterId: string;
  chapterTitle: string;
  oneLineSummary: string;
  majorEvents: string[];
  characterChanges: string[];
  locationChanges: string[];
  newSettings: string[];
  newForeshadowing: string[];
  resolvedForeshadowing: string[];
  unresolvedQuestions: string[];
  nextChapterHooks: string[];
  facts: string[];
  inferences: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AISettings {
  provider: AIProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  defaultLanguage: string;
}

export interface AIProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface AIConfigFile {
  schemaVersion: 1;
  activeProvider: AIProvider;
  defaultLanguage: string;
  providers: Partial<Record<AIProvider, AIProviderConfig>>;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIRequest {
  taskType: AITaskType;
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface AIResponse {
  content: string;
  model?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface ContextSection {
  id: string;
  title: string;
  body: string;
  priority: number;
  alwaysInclude?: boolean;
}

export interface ContextPackage {
  taskType: AITaskType;
  chapterId?: string;
  title: string;
  userInstruction: string;
  sections: ContextSection[];
  omitted: string[];
  assembledText: string;
}

export interface ExportStyle {
  schemaVersion: 1;
  titlePage: boolean;
  includeAuthor: boolean;
  includeVolumeTitles: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
}

export interface WritingGoals {
  schemaVersion: 1;
  dailyWordTarget: number;
  totalWordTarget: number;
  updatedAt: string;
}

export interface ConsistencyIssue {
  severity: '严重问题' | '中等问题' | '轻微问题' | '建议优化';
  title: string;
  detail: string;
  source: string;
  suggestion: string;
}

export interface AIJobRecord {
  schemaVersion: 1;
  id: string;
  taskType: AITaskType;
  chapterId?: string;
  chapterTitle?: string;
  model: string;
  provider: AIProvider;
  userInstruction: string;
  contextPreview: string;
  output: string;
  action: 'append' | 'insert' | 'replace' | 'copy' | 'save-summary' | 'discard' | 'test' | 'none';
  createdAt: string;
  latencyMs: number;
}

export interface WritingStats {
  projectTitle: string;
  volumeCount: number;
  chapterCount: number;
  totalWordCount: number;
  modifiedTodayWordCount: number;
  goals?: WritingGoals;
  dailyGoalProgress?: number;
  totalGoalProgress?: number;
  statusCounts: Record<ChapterStatus, number>;
  volumes: Array<{
    id: string;
    title: string;
    chapterCount: number;
    wordCount: number;
  }>;
}

export interface ChapterRef {
  volume: VolumeMeta;
  chapter: ChapterMeta;
}

export interface CreateCodexInput {
  name: string;
  detail?: string;
  chapterId?: string;
}

export interface CodexEntry {
  card: CodexCard;
  relativePath: string;
}
