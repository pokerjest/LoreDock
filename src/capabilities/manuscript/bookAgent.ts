import { normalizeRelativePath } from "../../kernel/operationPlan";
import type { ManuscriptManifest } from "./types";

export const BOOK_AGENT_FILENAME = "agent.md";
export const BOOK_AGENT_SYSTEM_RULES_START = "<!-- LOREDOCK_AGENT_SYSTEM_RULES_START -->";
export const BOOK_AGENT_SYSTEM_RULES_END = "<!-- LOREDOCK_AGENT_SYSTEM_RULES_END -->";
export const BOOK_AGENT_USER_RULES_START = "<!-- LOREDOCK_AGENT_USER_RULES_START -->";
export const BOOK_AGENT_USER_RULES_END = "<!-- LOREDOCK_AGENT_USER_RULES_END -->";

export function bookAgentPath(bookPath: string): string {
  return normalizeRelativePath(`${bookPath}/${BOOK_AGENT_FILENAME}`);
}

export function bookAgentPaths(manifest: ManuscriptManifest): Set<string> {
  return new Set(Object.values(manifest.books).map((book) => bookAgentPath(book.path)));
}

export function createBookAgentText(bookTitle: string, bookPath: string): string {
  return [
    `# ${bookTitle} AI Agent 使用说明`,
    "",
    "这个文件是给 AI 插件看的操作说明。它帮助 AI 在不破坏 LoreDock 项目结构的前提下理解和协作这本书。",
    "",
    "本文分为两块：系统规则和用户自定义规则。",
    "",
    createBookAgentSystemRulesText(bookPath),
    "",
    createBookAgentUserRulesText(),
    ""
  ].join("\n");
}

export function createBookAgentSystemRulesText(bookPath: string): string {
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
    "- 用户可以在“用户自定义规则（可编辑）”中补充自己的工作偏好。",
    "- 如果用户自定义规则与系统规则冲突，AI 必须先向用户说明冲突并询问确认。",
    "- 用户确认后，AI 在本次协作中按用户自己的规则执行，但仍不得改写本节系统规则。",
    "- 未获得用户确认前，AI 不得自行用用户自定义规则覆盖系统规则。",
    "",
    "## 这本书的位置",
    "",
    `- 书目录：\`${bookPath}\``,
    "- 章节正文是普通 Markdown 文件。",
    "- 章节、卷、书的稳定关系以 `manuscript/manifest.json` 为准。",
    "- 全局手稿笔记在 `manuscript/notes.md`。",
    "",
    "## AI 协作规则",
    "",
    "- 先读取 `manuscript/manifest.json`，再按 manifest 中的路径读取章节正文。",
    "- 不要手动重命名、移动或删除章节文件；需要结构变更时使用 LoreDock 命令或请用户确认。",
    "- 不要直接改写 `manuscript/manifest.json`，除非用户明确要求进行维护修复。",
    "- 不要修改 book、volume、chapter 的稳定 ID。",
    "- 可以编辑章节 Markdown 正文，但应避免写入隐藏插件元数据。",
    "- 新建、移动、删除、改名、设置状态和目标字数等结构操作应走 LoreDock 的 preview/apply 流程。",
    "- 如果发现缺失文件、孤立 Markdown、路径异常或 manifest 损坏，先报告给用户，不要自行猜测修复。",
    "",
    "## 推荐工作流",
    "",
    "1. 读取本文件，理解当前书目录规则。",
    "2. 读取 `manuscript/manifest.json`，拿到书、卷、章顺序和路径。",
    "3. 只读取需要处理的章节 Markdown。",
    "4. 输出建议或编辑正文时，保持 Markdown 简洁透明。",
    "5. 需要结构性写入时，让 LoreDock 执行对应命令。",
    "",
    BOOK_AGENT_SYSTEM_RULES_END
  ].join("\n");
}

export function createBookAgentUserRulesText(): string {
  return [
    BOOK_AGENT_USER_RULES_START,
    "",
    "## 用户自定义规则（可编辑）",
    "",
    "用户可以在本节写入这本书的 AI 协作偏好，例如文风、禁用词、叙事视角、角色称呼、章节处理习惯或特殊工作流。",
    "",
    "- 示例：保持第三人称有限视角。",
    "- 示例：不要自动扩写，只给出修改建议。",
    "- 示例：所有新增设定都先写入笔记，确认后再进正文。",
    "",
    BOOK_AGENT_USER_RULES_END
  ].join("\n");
}

export function inspectBookAgentSystemRules(text: string, bookPath: string): "missing" | "modified" | undefined {
  const normalizedText = normalizeLineEndings(text);
  const startIndex = normalizedText.indexOf(BOOK_AGENT_SYSTEM_RULES_START);
  const endIndex = normalizedText.indexOf(BOOK_AGENT_SYSTEM_RULES_END);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return "missing";
  }

  const endWithMarker = endIndex + BOOK_AGENT_SYSTEM_RULES_END.length;
  const actual = normalizedText.slice(startIndex, endWithMarker);
  return actual === createBookAgentSystemRulesText(bookPath) ? undefined : "modified";
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
