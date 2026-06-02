import { LoreDockStorage } from './storage';
import { chapterTail } from './wordCount';
import { truncateMiddle } from './utils';
import {
  AIMessage,
  AITaskType,
  BeatPlan,
  CharacterCard,
  ChapterSummary,
  ContextPackage,
  ContextSection,
  ForeshadowingCard,
  LocationCard,
  ProjectManifest,
  ScenePlan,
  TimelineEvent,
  WorldRule
} from '../types';

const CONTEXT_BUDGET = 14000;

export interface BuildContextOptions {
  storage: LoreDockStorage;
  chapterId: string;
  taskType: AITaskType;
  userInstruction: string;
  selectedText?: string;
}

export async function buildContextPackage(options: BuildContextOptions): Promise<ContextPackage> {
  const manifest = await options.storage.requireManifest();
  const ref = await options.storage.getChapterRef(options.chapterId);
  const chapterText = await options.storage.readChapterText(options.chapterId);
  const previousSummary = await options.storage.readPreviousSummary(options.chapterId);
  const styleGuide = await options.storage.readStyleGuide();
  const codexCards = await options.storage.listCodexCards();

  const signalText = [
    chapterText,
    options.selectedText,
    options.userInstruction,
    previousSummary ? formatSummary(previousSummary) : ''
  ]
    .filter(Boolean)
    .join('\n');

  const relatedCharacters = codexCards
    .filter((card): card is CharacterCard => card.kind === 'character')
    .filter((card) => isCardRelevant(card.name, card.aliases, signalText))
    .filter((card) => card.allowInContext !== false)
    .slice(0, 8);

  const relatedLocations = codexCards
    .filter((card): card is LocationCard => card.kind === 'location')
    .filter((card) => isCardRelevant(card.name, card.aliases, signalText))
    .filter((card) => card.allowInContext !== false)
    .slice(0, 6);

  const worldRules = codexCards
    .filter((card): card is WorldRule => card.kind === 'world-rule')
    .filter((card) => card.allowInContext !== false && !card.hidden)
    .sort((a, b) => ruleWeight(b) - ruleWeight(a))
    .slice(0, 8);

  const foreshadowing = codexCards
    .filter((card): card is ForeshadowingCard => card.kind === 'foreshadowing')
    .filter((card) => card.allowInContext !== false)
    .filter((card) => options.taskType === 'consistency' || card.status !== 'resolved')
    .filter((card) => isCardRelevant(card.name, card.aliases, signalText) || card.status === 'developing' || card.status === 'seeded')
    .sort((a, b) => ruleWeight(b) - ruleWeight(a))
    .slice(0, 8);

  const timelineEvents = codexCards
    .filter((card): card is TimelineEvent => card.kind === 'timeline-event')
    .filter((card) => card.allowInContext !== false)
    .filter((card) => options.taskType === 'consistency' || card.chapterId === options.chapterId || isCardRelevant(card.name, card.aliases, signalText))
    .slice(0, 10);

  const scenes = codexCards
    .filter((card): card is ScenePlan => card.kind === 'scene')
    .filter((card) => card.allowInContext !== false)
    .filter((card) => card.chapterId === options.chapterId || isCardRelevant(card.name, card.aliases, signalText))
    .sort((a, b) => a.order - b.order)
    .slice(0, 8);

  const beats = codexCards
    .filter((card): card is BeatPlan => card.kind === 'beat')
    .filter((card) => card.allowInContext !== false && card.status !== 'discarded')
    .filter((card) => card.chapterId === options.chapterId || isCardRelevant(card.name, card.aliases, signalText))
    .sort((a, b) => a.order - b.order)
    .slice(0, 12);

  const sections: ContextSection[] = [
    {
      id: 'task',
      title: '任务',
      body: taskDescription(options.taskType, options.userInstruction),
      priority: 100,
      alwaysInclude: true
    },
    {
      id: 'project',
      title: '小说信息',
      body: formatProject(manifest),
      priority: 95,
      alwaysInclude: true
    },
    {
      id: 'style',
      title: '文风指南',
      body: styleGuide.trim() || manifest.defaultStyle || '保持长篇小说风格，尊重既有设定。',
      priority: 90,
      alwaysInclude: true
    },
    {
      id: 'chapter-tail',
      title: '当前章节末尾',
      body: chapterTail(chapterText, options.taskType === 'summary' ? 12000 : 5000),
      priority: 85,
      alwaysInclude: true
    }
  ];

  if (options.selectedText) {
    sections.push({
      id: 'selection',
      title: '选中文本',
      body: options.selectedText,
      priority: 88,
      alwaysInclude: true
    });
  }

  if (previousSummary) {
    sections.push({
      id: 'previous-summary',
      title: '上一章已确认摘要',
      body: formatSummary(previousSummary),
      priority: 80
    });
  }

  if (relatedCharacters.length > 0) {
    sections.push({
      id: 'characters',
      title: '相关人物卡（已排除 secrets / hiddenSecrets）',
      body: relatedCharacters.map(formatCharacter).join('\n\n'),
      priority: 70
    });
  }

  if (relatedLocations.length > 0) {
    sections.push({
      id: 'locations',
      title: '相关地点卡（已排除 secrets / hiddenSecrets）',
      body: relatedLocations.map(formatLocation).join('\n\n'),
      priority: 65
    });
  }

  if (worldRules.length > 0) {
    sections.push({
      id: 'world-rules',
      title: '世界规则',
      body: worldRules.map(formatWorldRule).join('\n\n'),
      priority: 60
    });
  }

  if (foreshadowing.length > 0) {
    sections.push({
      id: 'foreshadowing',
      title: '相关伏笔（隐藏真相默认不发送）',
      body: foreshadowing.map(formatForeshadowing).join('\n\n'),
      priority: 58
    });
  }

  if (timelineEvents.length > 0) {
    sections.push({
      id: 'timeline',
      title: '相关时间线事件',
      body: timelineEvents.map(formatTimelineEvent).join('\n\n'),
      priority: 56
    });
  }

  if (scenes.length > 0) {
    sections.push({
      id: 'scenes',
      title: '当前章节场景计划',
      body: scenes.map(formatScene).join('\n\n'),
      priority: 75
    });
  }

  if (beats.length > 0) {
    sections.push({
      id: 'beats',
      title: '当前章节 Beat',
      body: beats.map(formatBeat).join('\n\n'),
      priority: 74
    });
  }

  const { assembledText, omitted } = assembleContextSections(sections);
  return {
    taskType: options.taskType,
    chapterId: options.chapterId,
    title: `${ref.volume.title} / ${ref.chapter.title}`,
    userInstruction: options.userInstruction,
    sections,
    omitted,
    assembledText
  };
}

export function buildContinuationMessages(context: ContextPackage): AIMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是 LoreDock 的长篇小说续写引擎。只输出正文，不输出解释、标题、总结或列表。保持既有视角、文风、人物状态和世界规则。不要擅自新增核心世界观，不要提前揭露隐藏秘密。'
    },
    {
      role: 'user',
      content: `${context.assembledText}\n\n请从“当前章节末尾”自然续写。额外要求：${context.userInstruction || '无'}`
    }
  ];
}

export function buildPolishMessages(context: ContextPackage): AIMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是 LoreDock 的局部润色引擎。只输出改写后的正文，不输出解释。保留原意、剧情事实、人物行动结果和已确认设定。除非用户明确要求，不新增重大事件。'
    },
    {
      role: 'user',
      content: `${context.assembledText}\n\n请润色“选中文本”。润色要求：${context.userInstruction || '轻度润色，提升表达质量'}`
    }
  ];
}

export function buildSummaryMessages(context: ContextPackage): AIMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是 LoreDock 的章节摘要引擎。只提取文本中已经发生的事实，不发挥，不替作者确认新设定。必须输出合法 JSON，不要使用 Markdown 代码块。'
    },
    {
      role: 'user',
      content: `${context.assembledText}

请为当前章节生成结构化摘要，JSON 字段必须包含：
{
  "oneLineSummary": "",
  "majorEvents": [],
  "characterChanges": [],
  "locationChanges": [],
  "newSettings": [],
  "newForeshadowing": [],
  "resolvedForeshadowing": [],
  "unresolvedQuestions": [],
  "nextChapterHooks": [],
  "facts": [],
  "inferences": []
}

要求：facts 只写已发生事实；inferences 只能写明确标注为推测的内容。`
    }
  ];
}

export function buildConsistencyMessages(context: ContextPackage): AIMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是 LoreDock 的长篇小说一致性检查助手。不要重写正文。只输出问题报告，按“严重问题 / 中等问题 / 轻微问题 / 建议优化”分组。每个问题说明位置、冲突原因、相关设定和修改建议。'
    },
    {
      role: 'user',
      content: `${context.assembledText}

请检查当前章节是否违反人物设定、地点设定、世界规则、上一章摘要、伏笔状态、场景/Beat 计划、称呼、道具归属、秘密公开状态或时间顺序。没有明确证据的问题请标记为“建议复核”，不要编造冲突。`
    }
  ];
}

export function filterContextPackage(contextPackage: ContextPackage, includedSectionIds: string[]): ContextPackage {
  const included = new Set(includedSectionIds);
  const sections = contextPackage.sections.filter((section) => section.alwaysInclude || included.has(section.id));
  const { assembledText, omitted } = assembleContextSections(sections);
  return {
    ...contextPackage,
    sections,
    omitted: [...contextPackage.omitted, ...contextPackage.sections.filter((section) => !section.alwaysInclude && !included.has(section.id)).map((section) => `${section.title}（用户排除）`), ...omitted],
    assembledText
  };
}

export function assembleContextSections(sections: ContextSection[], budget = CONTEXT_BUDGET): { assembledText: string; omitted: string[] } {
  const ordered = [...sections].sort((a, b) => {
    if (a.alwaysInclude && !b.alwaysInclude) {
      return -1;
    }
    if (!a.alwaysInclude && b.alwaysInclude) {
      return 1;
    }
    return b.priority - a.priority;
  });

  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const section of ordered) {
    const rendered = renderSection(section);
    const remaining = budget - used;
    if (rendered.length <= remaining) {
      included.push(rendered);
      used += rendered.length;
      continue;
    }
    if (section.alwaysInclude && remaining > 200) {
      const truncated = renderSection({ ...section, body: truncateMiddle(section.body, Math.max(120, remaining - 80)) });
      included.push(truncated);
      used += truncated.length;
      omitted.push(`${section.title}（已截断）`);
      continue;
    }
    omitted.push(section.title);
  }

  return {
    assembledText: included.join('\n\n'),
    omitted
  };
}

function renderSection(section: ContextSection): string {
  return `## ${section.title}\n${section.body.trim()}`;
}

function taskDescription(taskType: AITaskType, userInstruction: string): string {
  if (taskType === 'continue') {
    return `任务类型：续写当前章节\n用户额外要求：${userInstruction || '无'}`;
  }
  if (taskType === 'polish') {
    return `任务类型：润色选中文本\n用户额外要求：${userInstruction || '轻度润色'}`;
  }
  if (taskType === 'summary') {
    return `任务类型：生成章节摘要\n用户额外要求：${userInstruction || '无'}`;
  }
  if (taskType === 'consistency') {
    return `任务类型：一致性检查\n用户额外要求：${userInstruction || '无'}`;
  }
  return `任务类型：连接测试\n用户额外要求：${userInstruction || '无'}`;
}

function formatProject(manifest: ProjectManifest): string {
  return [
    `标题：${manifest.title}`,
    `作者：${manifest.author || '未填写'}`,
    `类型：${manifest.genre || '未填写'}`,
    `语言：${manifest.language || 'zh-CN'}`,
    `默认文风：${manifest.defaultStyle || '未填写'}`
  ].join('\n');
}

function formatSummary(summary: ChapterSummary): string {
  return [
    `章节：${summary.chapterTitle}`,
    `一句话摘要：${summary.oneLineSummary}`,
    `主要事件：${formatList(summary.majorEvents)}`,
    `人物变化：${formatList(summary.characterChanges)}`,
    `地点变化：${formatList(summary.locationChanges)}`,
    `新增设定：${formatList(summary.newSettings)}`,
    `新增伏笔：${formatList(summary.newForeshadowing)}`,
    `回收伏笔：${formatList(summary.resolvedForeshadowing)}`,
    `未解决问题：${formatList(summary.unresolvedQuestions)}`,
    `下一章承接点：${formatList(summary.nextChapterHooks)}`
  ].join('\n');
}

function formatCharacter(card: CharacterCard): string {
  return [
    `人物：${card.name}`,
    card.aliases.length ? `别名：${card.aliases.join('、')}` : '',
    card.identity ? `身份：${card.identity}` : '',
    card.fixedSetting ? `固定设定：${card.fixedSetting}` : '',
    card.personality ? `性格：${card.personality}` : '',
    card.speechStyle ? `说话习惯：${card.speechStyle}` : '',
    card.goals ? `目标：${card.goals}` : '',
    card.abilities ? `能力：${card.abilities}` : '',
    card.weaknesses ? `弱点：${card.weaknesses}` : '',
    card.currentState ? `当前状态：${card.currentState}` : '',
    card.relationships.length ? `关系：${card.relationships.map((item) => `${item.target}：${item.description}`).join('；')}` : '',
    card.forbiddenActions.length ? `禁止事项：${card.forbiddenActions.join('；')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function formatLocation(card: LocationCard): string {
  return [
    `地点：${card.name}`,
    card.aliases.length ? `别名：${card.aliases.join('、')}` : '',
    card.type ? `类型：${card.type}` : '',
    card.region ? `区域：${card.region}` : '',
    card.visualFeatures ? `视觉特征：${card.visualFeatures}` : '',
    card.atmosphere ? `氛围：${card.atmosphere}` : '',
    card.history ? `历史：${card.history}` : '',
    card.rules ? `地点规则：${card.rules}` : '',
    card.currentState ? `当前状态：${card.currentState}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function formatWorldRule(card: WorldRule): string {
  const label = card.importance === 'absolute' ? '绝对禁止违反' : card.importance === 'important' ? '重要' : '普通';
  return [`规则：${card.name}`, `重要性：${label}`, card.content].filter(Boolean).join('\n');
}

function formatForeshadowing(card: ForeshadowingCard): string {
  const label = card.importance === 'absolute' ? '绝对禁止提前揭露' : card.importance === 'important' ? '重要' : '普通';
  return [
    `伏笔：${card.name}`,
    `状态：${card.status}`,
    `重要性：${label}`,
    card.description ? `描述：${card.description}` : '',
    card.publicHint ? `可公开提示：${card.publicHint}` : '',
    card.allowRevealToAI && card.hiddenTruth ? `隐藏真相（已允许发送）：${card.hiddenTruth}` : '',
    !card.allowRevealToAI && card.hiddenTruth ? '隐藏真相：不发送给普通 AI 写作任务' : '',
    card.expectedResolveChapterId ? `预计回收章节：${card.expectedResolveChapterId}` : '',
    card.relatedCharacters.length ? `相关人物：${card.relatedCharacters.join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTimelineEvent(card: TimelineEvent): string {
  return [
    `事件：${card.name}`,
    card.storyTime ? `故事时间：${card.storyTime}` : '',
    card.chapterId ? `关联章节：${card.chapterId}` : '',
    card.location ? `地点：${card.location}` : '',
    card.participants.length ? `参与人物：${card.participants.join('、')}` : '',
    card.result ? `结果：${card.result}` : '',
    `可见性：${card.visibility}`
  ]
    .filter(Boolean)
    .join('\n');
}

function formatScene(card: ScenePlan): string {
  return [
    `场景：${card.name}`,
    card.chapterId ? `章节：${card.chapterId}` : '',
    `顺序：${card.order}`,
    card.viewpointCharacter ? `视角人物：${card.viewpointCharacter}` : '',
    card.location ? `地点：${card.location}` : '',
    card.conflict ? `冲突：${card.conflict}` : '',
    card.turn ? `转折：${card.turn}` : '',
    card.outcome ? `结果：${card.outcome}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function formatBeat(card: BeatPlan): string {
  return [
    `Beat：${card.name}`,
    card.chapterId ? `章节：${card.chapterId}` : '',
    card.sceneId ? `场景：${card.sceneId}` : '',
    `顺序：${card.order}`,
    `状态：${card.status}`,
    card.content ? `内容：${card.content}` : '',
    card.purpose ? `目的：${card.purpose}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function isCardRelevant(name: string, aliases: string[], text: string): boolean {
  const haystack = text.toLowerCase();
  const names = [name, ...aliases].map((candidate) => candidate.trim()).filter(Boolean);
  return names.some((candidate) => haystack.includes(candidate.toLowerCase()));
}

function ruleWeight(rule: { importance: WorldRule['importance'] }): number {
  if (rule.importance === 'absolute') {
    return 3;
  }
  if (rule.importance === 'important') {
    return 2;
  }
  return 1;
}

function formatList(values: string[]): string {
  return values.length ? values.join('；') : '无';
}
