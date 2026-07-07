export const BOOK_AGENT_FILENAME = "agent.md";
export const BOOK_AGENT_SYSTEM_FILENAME = "agent.system.md";
export const BOOK_AGENT_SYSTEM_RULES_START = "<!-- LOREDOCK_AGENT_SYSTEM_RULES_START -->";
export const BOOK_AGENT_SYSTEM_RULES_END = "<!-- LOREDOCK_AGENT_SYSTEM_RULES_END -->";
export const BOOK_AGENT_USER_RULES_START = "<!-- LOREDOCK_AGENT_USER_RULES_START -->";
export const BOOK_AGENT_USER_RULES_END = "<!-- LOREDOCK_AGENT_USER_RULES_END -->";

export function bookAgentPath(): string {
  return BOOK_AGENT_FILENAME;
}

export function bookSystemAgentPath(): string {
  return BOOK_AGENT_SYSTEM_FILENAME;
}

export function bookAgentPaths(): Set<string> {
  return new Set([bookAgentPath(), bookSystemAgentPath()]);
}

export function createBookAgentText(bookTitle: string, existingText?: string): string {
  return [
    `# ${bookTitle} 用户 Agent 规则（可编辑）`,
    "",
    "这个文件由用户维护，LoreDock 不会在常规启动同步中覆盖它。",
    "",
    `AI 使用本书前必须先读取工作区根目录的 \`${BOOK_AGENT_SYSTEM_FILENAME}\`，再读取本文件。`,
    "如果本文件规则与系统 agent 冲突，AI 必须先向用户说明冲突并询问确认；用户确认后，本次协作按用户规则执行，但仍不能修改系统 agent。",
    "",
    extractBookAgentUserRulesText(existingText) ?? createBookAgentUserRulesText(),
    ""
  ].join("\n");
}

export function createBookSystemAgentText(bookTitle: string): string {
  return [
    `# ${bookTitle} 系统 Agent 规则（只读）`,
    "",
    "这个文件由 LoreDock 自动生成，用于告诉外置 AI 如何安全使用本书和插件结构。",
    "LoreDock 启动后会把本文件同步到当前插件版本；用户自定义规则请写在工作区根目录 `agent.md`。",
    "",
    createBookAgentSystemRulesText(),
    ""
  ].join("\n");
}

export function refreshBookAgentText(bookTitle: string, existingText?: string): string {
  return createBookAgentText(bookTitle, existingText);
}

export function isCombinedBookAgentText(text: string): boolean {
  const normalizedText = normalizeLineEndings(text);
  return (
    normalizedText.includes(BOOK_AGENT_SYSTEM_RULES_START) ||
    normalizedText.includes(BOOK_AGENT_SYSTEM_RULES_END)
  );
}

export function createBookAgentSystemRulesText(): string {
  return [
    BOOK_AGENT_SYSTEM_RULES_START,
    "",
    "## 系统规则（只读）",
    "",
    "本节由 LoreDock 开发者维护。除开发者更新插件或迁移模板外，任何 AI、自动化脚本和普通用户流程都不能修改本节内容。",
    "",
    "### 规则优先级",
    "",
    "- AI 必须读取并遵守本节系统规则。",
    "- 用户可以在 `agent.md` 中补充自己的工作偏好。",
    "- 如果用户 agent 与系统 agent 冲突，AI 必须先向用户说明冲突并询问确认。",
    "- 用户确认后，AI 在本次协作中按用户自己的规则执行，但仍不得改写系统 agent。",
    "- 未获得用户确认前，AI 不得自行用用户 agent 覆盖系统 agent。",
    "",
    "## 这本书的位置",
    "",
    "- 当前 VS Code 工作区文件夹就是这本书的根目录；一个工作区文件夹只对应一本书。",
    "- 不要在同一个工作区里创建第二本书；切换书籍等于打开另一个书文件夹。",
    "- 章节正文是普通 Markdown 文件。",
    "- 章节、卷、书名的稳定关系以 `manuscript/manifest.json` 为准。",
    "- 全局手稿笔记在 `manuscript/notes.md`。",
    "- 卷目录位于 `manuscript/volume-###/`，章节文件位于对应卷目录下。",
    "- 系统 agent 在工作区根目录 `agent.system.md`，用户可编辑 agent 在工作区根目录 `agent.md`。",
    "",
    "## AI 协作规则",
    "",
    "- 先读取本文件，再读取工作区根目录 `agent.md`，最后读取 `manuscript/manifest.json` 和必要章节正文。",
    "- 不要手动重命名、移动或删除章节文件；需要结构变更时使用 LoreDock 命令或请用户确认。",
    "- 不要直接改写 `manuscript/manifest.json`，除非用户明确要求进行维护修复。",
    "- 不要修改 book、volume、chapter 的稳定 ID。",
    "- 可以编辑章节 Markdown 正文，但应避免写入隐藏插件元数据。",
    "- 新建、移动、删除、改名、设置状态和目标字数等结构操作应走 LoreDock 的 preview/apply 流程。",
    "- 如果发现缺失文件、孤立 Markdown、路径异常或 manifest 损坏，先报告给用户，不要自行猜测修复。",
    "",
    "## 结构规划协作规则",
    "",
    "结构规划用于把大纲草稿、场景卡和手稿卷章合成为可重建的 Structure Skeleton；启用后 capability ID 是 `structure.outline-scenes`，内容位于 `outlines/` 和 `scenes/`。",
    "",
    "- `outlines/` 是规划草稿和导入源，不是 canon；修改草稿不会自动同步已落地的章节或场景卡。",
    "- `scenes/` 是场景卡 canon；场景身份来自 frontmatter 中稳定的 `scene_...` ID，而不是文件名、标题或章节路径。",
    "- 场景卡 schema 当前为 `0.3.0`，必须保留 `schemaVersion`、`id`、`title`、`chapterRefs`、`order`、`pov`、人物/地点/剧情线引用、冲突、转折、结果、状态和时间戳等结构字段。",
    "- 场景卡通过 `chapterRefs` 绑定 0..N 个 Manuscript 稳定章节 ID；不要用章节标题、章节文件路径或正文隐藏标记替代绑定关系。",
    "- 旧场景卡如果只有 `chapterId`，读取时可以兼容；新写入或更新必须使用 `chapterRefs`。",
    "- 大纲草稿支持文件开头、首个标题前的 `@scope book|volume|chapter|scene`，也支持中文别名 `书|卷|章|场景`。",
    "- 大纲草稿支持 `@include ./relative.md` 包含更小粒度草稿；include 路径必须相对当前草稿，并且真实路径仍在 `outlines/` 内。",
    "- 大纲导入必须走 LoreDock 的 preview/apply 流程；导入时可以选择复用已有卷/章或创建缺失父级，但 AI 不要静默创建未归类卷或未归类章节。",
    "- 结构规划 capability 不能直接改写 `manuscript/manifest.json`；卷和章节创建必须交给 Manuscript actions 生成稳定 ID 和文件路径。",
    "- 不要在章节 Markdown 正文写入隐藏插件元数据；章节正文保持人可读，章节和场景的关系只通过 `chapterRefs` 与稳定 ID 表达。",
    "- 删除场景卡或规划草稿必须走 LoreDock 命令和 preview/apply；场景卡删除先进入 `.loredock/trash/resources/outline-scenes/`，不要直接永久删除 `scenes/` 文件。",
    "- v0.3 不包含拖拽剧情矩阵、Plot Grid、Timeline、一致性引擎或 AI 上下文拼装；相关需求不要伪造为当前可用结构。",
    "",
    "## 故事圣经协作规则",
    "",
    "故事圣经是这本书的字典 + 百科全书，用于维护人物、地点、规则和关键词条目；启用后内容位于当前书文件夹的 `lore/characters/`、`lore/locations/`、`lore/rules/` 和 `lore/tags/`。",
    "不要把人物只写进聊天回复、章节正文、`manuscript/notes.md` 或其他临时笔记；新人物要出现在 LoreDock 左侧故事圣经视图中，必须创建合法的 `lore/characters/*.md` 卡片文件。",
    "",
    "### 外置 AI 创建条目的正确流程",
    "",
    "1. 先确认 `.loredock/project.json` 的 `capabilities` 是否包含 `story-bible.core`。",
    "2. 如果尚未启用故事圣经，先请用户运行 `LoreDock：启用故事圣经`；只有在用户明确要求直接写文件时，才创建 `lore/` 目录结构。",
    "3. 如果外置 AI 能调用 VS Code/LoreDock 命令，创建角色或人物条目时优先使用 `LoreDock：新建人物`（命令 ID：`loredock.storyBible.createCharacter`）。",
    "4. 如果外置 AI 只能编辑文件，仍然可以直接创建合法的故事圣经卡片；人物写入 `lore/characters/*.md`，地点写入 `lore/locations/*.md`，规则写入 `lore/rules/*.md`。",
    "5. 直接写文件时必须一次性写完整 frontmatter；保存后请用户运行 `LoreDock：刷新故事圣经`，新卡片会出现在故事圣经树和条目库中。",
    "6. 从正文选中文本生成故事圣经条目时，若能调用命令，使用 `LoreDock：从选中文本创建条目`（`loredock.storyBible.createCardFromSelection`）；若不能调用命令，就按下方模板直接创建卡片文件。",
    "",
    "### 直接创建人物卡片文件",
    "",
    "- 每个角色必须是一个独立文件，路径形如 `lore/characters/<safe-name>.md`；不要只写到 `notes.md` 或章节正文里。",
    "- 文件名只用小写 ASCII、数字和连字符，例如 `shen-zhou.md`、`character-20260701-120000.md` 或 `u-a1b2c3d4.md`；同名文件已存在时追加 `-2`、`-3`。",
    "- `id` 必须全项目唯一，推荐 `story_` 加 UUID，例如 `story_550e8400-e29b-41d4-a716-446655440000`。",
    "- `type` 必须与目录一致：人物是 `character`，地点是 `location`，规则是 `rule`。",
    "- `tags[0]` 必须是对象主关键词。人物用 `character/<slug>`，地点用 `location/<slug>`，规则用 `rule/<slug>`；`<slug>` 只能包含小写 ASCII、数字和连字符。",
    "- `tags[1...]` 是全局关联标签，可以跨类型自由引用；人物可以挂 `location/...`、`rule/...` 或其他 `character/...`，地点和规则也同理。",
    "- 中文名可以用拼音 slug，或用 `u-` 加 8 位小写十六进制短码，例如 `character/shen-zhou` 或 `character/u-a1b2c3d4`。",
    "- `createdAt` 和 `updatedAt` 必须使用 ISO 时间字符串，可以用当前时间的 `new Date().toISOString()`；不要写“今天”“刚才”“2026/7/1”。",
    "- `aliases`、`tags`、`chapterRefs` 必须是字符串数组；没有内容时写 `[]`。",
    "- `visibility` 只能是 `public`、`spoiler` 或 `private`；`status` 只能是 `draft`、`canon` 或 `archived`。",
    "",
    "```md",
    "---",
    "schemaVersion: \"0.2.0\"",
    "id: \"story_550e8400-e29b-41d4-a716-446655440000\"",
    "type: \"character\"",
    "name: \"沈舟\"",
    "aliases: [\"旧书修复师\"]",
    "tags:",
    "  - \"character/shen-zhou\"",
    "  - \"identity/restorer\"",
    "summary: \"项目内可追踪的人物档案摘要。\"",
    "visibility: \"public\"",
    "status: \"draft\"",
    "createdAt: \"2026-07-01T12:00:00.000Z\"",
    "updatedAt: \"2026-07-01T12:00:00.000Z\"",
    "chapterRefs: []",
    "---",
    "# 沈舟",
    "",
    "## 摘要",
    "",
    "这里写人物身份、作用和已确认设定。",
    "",
    "## 线索",
    "",
    "- 这里写与章节相关的证据或片段。",
    "```",
    "",
    "### 修改已有故事圣经卡片",
    "",
    "- 已存在卡片的 `id`、`type`、`createdAt` 不要改。",
    "- 更新内容时可以改 `name`、`aliases`、`summary`、`visibility`、`status`、`chapterRefs`、正文，以及追加普通关键词。",
    "- 改动已有卡片时必须更新 `updatedAt` 为当前 ISO 时间。",
    "- 如果改了 `name`，检查 `tags[0]` 是否仍是合适的对象主关键词；不确定时保持原值，避免制造重复对象关键词。",
    "- 不要因为跨类型就删除 `tags[1...]`；它们用于表达全局关联，例如“这个人物关联某地点/规则/其他人物”。",
    "- 不要把多个角色合并写进同一个人物条目；每个角色应该有一个独立人物卡片。",
    "- 删除、还原、重命名条目或移动资源垃圾桶内容时，必须走 LoreDock 命令和 preview/apply 流程，不要直接移动或删除 `lore/` 与 `.loredock/trash/` 下的文件。",
    "",
    "### 故事圣经诊断修复速查",
    "",
    "- 左侧故事圣经树出现 warning/error 时，先打开诊断指向的相对路径，例如 `lore/characters/example.md`。",
    "- `createdAt 必须是 ISO 时间戳字符串` 或 `updatedAt 必须是 ISO 时间戳字符串`：把对应字段改成 `new Date().toISOString()` 形式的字符串，例如 `2026-07-01T12:00:00.000Z`。",
    "- `type 与目录类型不一致`：`lore/characters/` 只能是 `type: \"character\"`，`lore/locations/` 只能是 `type: \"location\"`，`lore/rules/` 只能是 `type: \"rule\"`。",
    "- `tags[0] 必须是当前条目 type 的对象主关键词`：按 `character/<slug>`、`location/<slug>` 或 `rule/<slug>` 修复，并保证同类型主关键词不与其他卡片重复。",
    "- `条目 id 重复`：给其中一个文件换成新的唯一 `story_<uuid>`。",
    "- `对象主关键词被多个条目使用`：给其中一个文件换一个唯一 `tags[0]`。",
    "- 修复完成后，请用户运行 `LoreDock：刷新故事圣经` 或重新打开故事圣经视图确认诊断消失。",
    "",
    "## 推荐工作流",
    "",
    "1. 读取本文件，理解当前书目录规则。",
    "2. 读取工作区根目录 `agent.md`，理解用户自定义规则。",
    "3. 读取 `manuscript/manifest.json`，拿到书、卷、章顺序和路径。",
    "4. 如果任务涉及结构规划，再读取相关 `outlines/**/*.md` 草稿和 `scenes/**/*.md` 场景卡。",
    "5. 只读取需要处理的章节 Markdown。",
    "6. 需要创建人物、地点或规则时，直接创建合法故事圣经卡片文件，确保保存后能被 LoreDock 扫描。",
    "7. 需要创建或绑定场景时，优先使用 LoreDock 结构规划命令；直接写文件时必须生成合法场景卡 frontmatter。",
    "8. 输出建议或编辑正文时，保持 Markdown 简洁透明。",
    "9. 结构性手稿操作仍让 LoreDock 执行对应命令。",
    "",
    BOOK_AGENT_SYSTEM_RULES_END
  ].join("\n");
}

export function createBookAgentUserRulesText(): string {
  return [
    "## 用户自定义规则（可编辑）",
    "",
    "用户可以在本节写入这本书的 AI 协作偏好，例如文风、禁用词、叙事视角、角色称呼、章节处理习惯或特殊工作流。",
    "",
    "- 示例：保持第三人称有限视角。",
    "- 示例：不要自动扩写，只给出修改建议。",
    "- 示例：所有新增设定都先写入笔记，确认后再进正文。"
  ].join("\n");
}

export function inspectBookSystemAgentText(text: string, bookTitle: string): "modified" | undefined {
  return normalizeLineEndings(text) === createBookSystemAgentText(bookTitle) ? undefined : "modified";
}

function extractBookAgentUserRulesText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalizedText = normalizeLineEndings(text);
  const startIndex = normalizedText.indexOf(BOOK_AGENT_USER_RULES_START);
  const endIndex = normalizedText.indexOf(BOOK_AGENT_USER_RULES_END);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return undefined;
  }

  const contentStart = startIndex + BOOK_AGENT_USER_RULES_START.length;
  const content = normalizedText.slice(contentStart, endIndex).trim();
  return content === "" ? undefined : content;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
