export type ChapterStatus =
  | 'planned'
  | 'drafting'
  | 'draft-complete'
  | 'needs-polish'
  | 'needs-check'
  | 'complete'
  | 'abandoned';

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

export type OutlineNodeType = 'volume' | 'chapter' | 'scene' | 'beat' | 'note';

export interface OutlineNode {
  id: string;
  type: OutlineNodeType;
  title: string;
  content: string;
  order: number;
  parentId?: string;
  sourceLine: number;
}

export interface OutlineDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  rawText: string;
  nodes: OutlineNode[];
  createdAt: string;
  updatedAt: string;
}

export interface OutlineImportResult {
  document: OutlineDocument;
  volumes: number;
  outlineChapters: number;
  scenes: number;
  beats: number;
}

export type BlueprintNodeKind = 'outline' | 'codex' | 'scene' | 'beat' | 'note';
export type BlueprintRefKind = CodexCard['kind'] | 'timeline-event' | 'outline' | 'outline-node';
export type BlueprintEdgeType = 'flow' | 'uses' | 'foreshadows' | 'resolves' | 'conflicts' | 'supports' | 'blocks' | 'custom';
export type BlueprintSyncStatus = 'pull' | 'push' | 'conflict' | 'missing' | 'unchanged';
export type BlueprintSyncAction = 'pull' | 'push' | 'delete-source' | 'skip';
export type BlueprintNodeSourceStatus = 'local' | 'linked' | 'missing' | 'stale' | 'conflict';

export interface BlueprintSyncSnapshot {
  title: string;
  note: string;
  syncedAt: string;
  sourceUpdatedAt?: string;
}

export interface BlueprintNode {
  id: string;
  kind: BlueprintNodeKind;
  title: string;
  refKind?: BlueprintRefKind;
  refId?: string;
  refPath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  note?: string;
  color?: string;
  lastSynced?: BlueprintSyncSnapshot;
}

export interface BlueprintEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: BlueprintEdgeType;
  label?: string;
}

export interface BlueprintDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  outlineId?: string;
  outlinePath?: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintResource {
  id: string;
  title: string;
  kind: BlueprintRefKind;
  relativePath: string;
  detail?: string;
}

export interface BlueprintPanelState {
  blueprints: BlueprintDocument[];
  current: BlueprintDocument;
  resources: BlueprintResource[];
  nodeSemantics: Record<string, BlueprintNodeSemanticSummary>;
  edgeSemanticIssues: BlueprintEdgeSemanticIssue[];
  syncPreview?: BlueprintSyncPreview;
  syncResult?: BlueprintSyncResult;
}

export interface BlueprintNodeSemanticSummary {
  nodeId: string;
  label: string;
  badge: string;
  status: BlueprintNodeSourceStatus;
  lines: string[];
  sourcePath?: string;
}

export interface BlueprintEdgeSemanticIssue {
  edgeId: string;
  severity: 'warning' | 'info';
  title: string;
  detail: string;
  suggestion: string;
}

export interface BlueprintSyncFieldDiff {
  field: 'title' | 'note';
  label: string;
  nodeValue: string;
  sourceValue: string;
  changed: boolean;
}

export interface BlueprintSyncItem {
  id: string;
  nodeId: string;
  nodeTitle: string;
  nodeNote: string;
  refKind: BlueprintRefKind;
  refId?: string;
  refPath?: string;
  sourceTitle?: string;
  sourceNote?: string;
  sourceUpdatedAt?: string;
  status: BlueprintSyncStatus;
  detail: string;
  defaultAction: BlueprintSyncAction;
  fieldDiffs: BlueprintSyncFieldDiff[];
}

export interface BlueprintSyncDecision {
  itemId: string;
  action: BlueprintSyncAction;
}

export interface BlueprintSyncPreview {
  schemaVersion: 1;
  blueprintId: string;
  generatedAt: string;
  items: BlueprintSyncItem[];
  summary: Record<BlueprintSyncStatus, number>;
}

export interface BlueprintSyncResult {
  applied: number;
  skipped: number;
  pulled: number;
  pushed: number;
  deletedSources?: number;
}

export interface CharacterRelationship {
  target: string;
  type?: string;
  status?: string;
  description: string;
  reason?: string;
  knownBy?: string[];
  sourceRefs?: CodexSourceRef[];
  hidden?: boolean;
}

export type CodexMemoryStatus = 'draft' | 'pending' | 'confirmed' | 'deprecated';
export type InferenceStatus = 'pending' | 'accepted' | 'rejected';
export type InferenceConfidence = 'low' | 'medium' | 'high';
export type CodexSourceKind =
  | 'character'
  | 'location'
  | 'world-rule'
  | 'foreshadowing'
  | 'timeline-event'
  | 'scene'
  | 'beat'
  | 'project'
  | 'style-guide'
  | 'chapter'
  | 'chapter-summary'
  | 'conversation'
  | 'manual';

export interface CodexSourceRef {
  kind: CodexSourceKind;
  id?: string;
  name?: string;
  reason?: string;
}

export interface CodexInference {
  subject: string;
  field: string;
  value: string;
  basis: string[];
  confidence: InferenceConfidence;
  status: InferenceStatus;
  sourceRefs: CodexSourceRef[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CodexProgression {
  id: string;
  title: string;
  content: string;
  effectiveFromChapterId?: string;
  effectiveFromSceneId?: string;
  sourceRefs: CodexSourceRef[];
  status: 'pending' | 'confirmed' | 'deprecated';
  createdAt: string;
  updatedAt: string;
}

export interface BaseCodexCard {
  schemaVersion: 1;
  id: string;
  kind: 'character' | 'location' | 'world-rule' | 'foreshadowing' | 'scene' | 'beat';
  name: string;
  aliases: string[];
  tags: string[];
  allowInContext: boolean;
  alwaysIncludeInContext?: boolean;
  doNotTrack?: boolean;
  nestedRefs?: string[];
  memoryStatus?: CodexMemoryStatus;
  summary?: string;
  sourceRefs?: CodexSourceRef[];
  ignoredReferenceTerms?: string[];
  inferences?: CodexInference[];
  progressions?: CodexProgression[];
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
  knows?: string[];
  doesNotKnow?: string[];
  relationshipNotes?: string;
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
  relatedEvents?: string[];
}

export type WorldRuleImportance = 'normal' | 'important' | 'absolute';

export interface WorldRule extends BaseCodexCard {
  kind: 'world-rule';
  importance: WorldRuleImportance;
  category?: string;
  content: string;
  rules?: string[];
  scope?: string[];
  relatedCharacters?: string[];
  relatedLocations?: string[];
  relatedFactions?: string[];
  knownExceptions?: string[];
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
  allowRevealInContext: boolean;
  publicHint: string;
  hiddenTruth: string;
}

export interface TimelineCalendar {
  worldCreatedAt: string;
  calendarName: string;
  eraLabel: string;
  note: string;
}

export interface TimelinePoint {
  label: string;
  sortValue: number;
  era?: string;
  year?: string;
  month?: string;
  day?: string;
  timeOfDay?: string;
}

export type TimelineEventVisibility = 'reader-unknown' | 'character-unknown' | 'public';
export type TimelineEventType = 'world' | 'plot' | 'character' | 'location' | 'relationship' | 'custom';
export type TimelineLaneType = 'world' | 'plot' | 'character' | 'location' | 'chapter';
export type TimelineEventImportance = 'minor' | 'normal' | 'major' | 'turning-point';
export type TimelineEventStatus = 'planned' | 'drafted' | 'locked';

export interface TimelineEvent {
  schemaVersion: 1;
  id: string;
  kind: 'timeline-event';
  title: string;
  summary: string;
  type: TimelineEventType;
  laneType: TimelineLaneType;
  importance: TimelineEventImportance;
  status: TimelineEventStatus;
  locked?: boolean;
  color?: string;
  notes?: string;
  start: TimelinePoint;
  end?: TimelinePoint;
  chapterId?: string;
  sceneId?: string;
  beatId?: string;
  location: string;
  locationId?: string;
  participants: string[];
  participantIds?: string[];
  causes?: string[];
  consequences?: string[];
  knownBy?: string[];
  unknownBy?: string[];
  relationshipEffects?: CharacterRelationship[];
  result: string;
  visibility: TimelineEventVisibility;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TimelineLane {
  id: string;
  type: TimelineLaneType;
  title: string;
  refId?: string;
}

export type TimelineConflictSeverity = 'warning' | 'info';
export type TimelineConflictKind = 'bad-range' | 'missing-reference' | 'multi-location' | 'weak-binding';

export interface TimelineConflict {
  id: string;
  eventIds: string[];
  severity: TimelineConflictSeverity;
  kind: TimelineConflictKind;
  title: string;
  detail: string;
}

export interface TimelineResolvedEvent extends TimelineEvent {
  resolvedLocation?: string;
  resolvedParticipants: string[];
  resolvedChapter?: string;
  resolvedScene?: string;
  resolvedBeat?: string;
  conflictIds: string[];
}

export interface TimelineResolvedView {
  document: TimelineDocument;
  lanes: TimelineLane[];
  events: TimelineResolvedEvent[];
  conflicts: TimelineConflict[];
}

export interface TimelineDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  calendar: TimelineCalendar;
  events: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface ScenePlan extends BaseCodexCard {
  kind: 'scene';
  chapterId?: string;
  outlineId?: string;
  outlineNodeId?: string;
  outlineVolumeTitle?: string;
  outlineChapterTitle?: string;
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
  outlineId?: string;
  outlineNodeId?: string;
  outlineVolumeTitle?: string;
  outlineChapterTitle?: string;
  content: string;
  purpose: string;
  order: number;
  status: 'planned' | 'expanded' | 'discarded';
}

export type CodexCard = CharacterCard | LocationCard | WorldRule | ForeshadowingCard | ScenePlan | BeatPlan;

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

export interface CodexReferenceOccurrence {
  cardId: string;
  cardName: string;
  cardKind: CodexCard['kind'];
  matchedText: string;
  sourceKind: 'chapter' | 'summary' | 'scene' | 'beat';
  sourceId: string;
  sourceTitle: string;
  relativePath?: string;
  excerpt: string;
}

export interface CodexReferenceIndex {
  schemaVersion: 1;
  generatedAt: string;
  occurrences: CodexReferenceOccurrence[];
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

export type ProjectHealthSeverity = 'error' | 'warning' | 'info';
export type ProjectHealthCategory = 'manuscript' | 'codex' | 'plan' | 'timeline' | 'foreshadowing' | 'references';

export interface ProjectHealthIssue {
  fingerprint?: string;
  severity: ProjectHealthSeverity;
  category: ProjectHealthCategory;
  title: string;
  detail: string;
  source?: string;
  suggestion: string;
  ignored?: boolean;
  fixable?: boolean;
}

export interface ProjectHealthReport {
  schemaVersion: 1;
  generatedAt: string;
  projectTitle: string;
  summary: Record<ProjectHealthSeverity, number>;
  totalSummary: Record<ProjectHealthSeverity, number>;
  ignoredCount: number;
  newCount: number;
  issues: ProjectHealthIssue[];
}

export interface ProjectHealthFixAction {
  title: string;
  detail: string;
  changed: boolean;
  willChange?: boolean;
  affectedSources?: string[];
}

export interface ProjectHealthFixReport {
  schemaVersion: 1;
  fixedAt: string;
  actions: ProjectHealthFixAction[];
}

export interface ProjectHealthBaseline {
  schemaVersion: 1;
  updatedAt: string;
  fingerprints: string[];
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

export interface ProjectDashboard {
  projectTitle: string;
  generatedAt: string;
  stats: WritingStats;
  health: ProjectHealthReport;
  topIssues: ProjectHealthIssue[];
  overdueForeshadowing: ForeshadowingCard[];
  recentChapters: ChapterRef[];
  unreferencedImportantCards: CodexEntry[];
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
