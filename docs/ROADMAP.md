# LoreDock 全新重构总计划

这份文档用于保留 LoreDock 的全新重构路线。它不沿用旧项目的功能形状，而是重新把 LoreDock 设计成一个运行在 VS Code 里的、本地优先、文件透明、可扩展的小说工程系统。

## 产品定位

LoreDock 的目标不是做一个普通的 AI 写作工具，也不是做一个云端世界观百科，而是成为 **VS Code 里的故事操作系统**：

- 管理长篇手稿。
- 维护本地故事圣经，包括人物、地点、规则、事件、势力、物品和剧情线。
- 提供大纲、场景卡、剧情矩阵、时间线和故事弧视图。
- 建立引用索引、反向链接、实体图谱、进展记录和一致性检查。
- 提供导出、排版、快照和版本保护。
- 在本地结构稳定后，加入可选 AI 辅助，但 AI 永远不是核心依赖。

核心气质是：本地、透明、可审计、可扩展、适合长期维护长篇小说。

## 市面产品拆解与吸收

LoreDock 要把成熟写作和世界观工具的优势拆成能力积木，再重新组合：

| 产品 | 主要优势 | LoreDock 吸收方向 |
| --- | --- | --- |
| Scrivener | Binder、Corkboard、Outliner、非线性长文组织、Compile 导出 | 手稿树、场景卡板、大纲表、编译导出流水线 |
| Obsidian | 本地 Markdown、双链、反向链接、图谱、可搜索知识库 | 本地故事 wiki、反链、未链接提及、关系图 |
| Campfire | 模块化世界观、人物、地点、时间线、关系和模板 | 可插拔故事模块和模板系统 |
| World Anvil | 世界百科、文章模板、地图、时间线、秘密和剧透管理 | 完整世界观层，区分公开信息和隐藏信息 |
| Plottr | 可视化时间线、场景卡、剧情线、故事圣经 | 剧情矩阵、场景卡、故事线、结构板 |
| Dabble | Plot Grid、Story Notes、写作目标、轻量起草体验 | 写作桌面、旁侧结构格、目标追踪 |
| LivingWriter | Boards、模板、写作规划发布一体化 | 项目仪表盘、模板、项目工作流 |
| Novelcrafter | Codex、AI 上下文、可搜索故事圣经、自定义字段、进展状态 | Story Bible 作为 AI 和一致性检查的地基 |
| Manuskript | 本地/开源精神、雪花法、大纲、专注写作 | 本地透明文件和可选写作方法模板 |
| Aeon Timeline | 人物、地点、故事弧、事件时间、因果关系 | 时间线引擎和故事时间一致性检查 |
| Milanote | 灵感板、研究板、人物 profile、moodboard | 后期加入灵感板和素材板 |
| Atticus | 写作、排版、预览、电子书/纸书导出 | 编译、格式化、预览、发布导出 |

## 架构原则

- **本地优先**：用户内容保存在 workspace 中，而不是远端服务。
- **文件透明**：手稿和资料用 Markdown；索引、manifest、缓存用 JSON。
- **模块化核心**：每个大功能作为 capability 挂载，避免一个巨大的 `extension.ts`。
- **地基优先**：v0.0-v0.2 要优先验证架构边界、数据契约和模块依赖方向；宁可少做功能，也要避免后期牵一发而动全身。
- **预览优先**：导入、同步、修复、批量编辑、AI 写入和蓝图变更都必须先预览。
- **AI 可选**：核心功能不需要 API key、模型、网络或外部服务。
- **不锁定用户**：即使移除插件，项目文件依然能被人直接阅读和修复。
- **Schema 可扩展**：故事元素类型、模板和视图通过注册扩展，而不是写死在核心。
- **兼容性分界清楚**：v1.0 之前，存储结构和代码架构可以为了正确设计而破坏式调整；v1.0 之后，任何项目格式变化都必须兼容旧版本并提供 migration。

## 地基设计要求

v0.0-v0.2 是地基期，目标不是堆功能，而是把后续所有能力的承重结构做干净。

### 必须尽早稳定的边界

- **Workspace 边界**：所有用户数据都必须在当前 workspace 内，路径统一使用 workspace-relative。
- **Project Manifest 边界**：manifest 只记录项目身份、版本和启用能力，不承载每个模块的全部业务细节；全局索引入口等字段等后续版本（v0.5 引入索引后）真正需要时再加。
- **Capability 边界**：每个能力模块只能通过公开 kernel API 注册命令、视图、schema、文件 watcher、diagnostics 和窄 service；跨模块协作必须通过公开 reader、actions 和 events。
- **Storage 边界**：用户可读内容、机器索引、缓存、诊断和快照必须分开存放。
- **Schema 边界**：每类文档必须有 `schemaVersion` 或等价版本标记，方便未来迁移。
- **Mutation 边界**：任何批量写入、导入、同步、修复、AI 建议和蓝图转换都必须走统一 preview/apply 流程。
- **Reference 边界**：引用关系不直接写死在正文里，优先通过稳定 ID、frontmatter 和索引建立。

### 必须保持可替换的部分

- 目录布局在 v1.0 前可以调整。
- 具体 story element 类型可以增删。
- webview UI 可以推翻重做。
- 大纲、时间线、蓝图的内部表示可以迭代。
- AI provider 和请求格式必须保持可替换。

### 禁止的架构形态

- 一个模块直接读取或修改另一个模块的私有文件。
- 核心层依赖 AI、webview、导出器或具体 story element 类型。
- 为了某个 UI 方便，把 UI 状态写进 canon 数据。
- 在手稿正文中塞隐藏元数据。
- 没有 preview 的批量修改。
- 把索引结果当成唯一真实数据源。

## 能力分层

1. **Kernel**：项目识别、schema 注册、迁移、安全写入、命令注册、日志、诊断。
2. **Manuscript**：书、卷、章、章节状态、字数、草稿。
3. **Story Bible**：故事元素、模板、别名、标签、隐藏事实、公开事实。
4. **Structure**：大纲、场景卡、剧情矩阵、故事弧、写作方法模板。
5. **Knowledge Graph**：反链、未链接提及、引用、实体图、进展记录。
6. **Timeline**：故事时间、叙事顺序、事件绑定、因果、连续性检查。
7. **Consistency Lab**：项目健康、引用健康、规则检查、进展检查。
8. **Compile**：Markdown/TXT/DOCX/EPUB/PDF 导出、快照、排版配置。
9. **Assistant**：可选模型集成、摘要、diff 编辑、待审建议。
10. **Blueprint Studio**：高级可视化规划，使用可审计 Markdown directive。
11. **Template System**：题材包、写作方法包、故事元素 schema 包。

## 目标文件结构

```text
.loredock/
  project.json
  schemas/
  indexes/
  snapshots/
  diagnostics/
manuscript/
  manifest.json
  book-001/
    agent.md
    volume-001/
      chapter-001.md
  notes.md
lore/
  characters/
  locations/
  rules/
  factions/
  items/
  events/
outlines/
boards/
timelines/
exports/
```

## 版本总览

| 版本 | 名称 | 主要目标 |
| --- | --- | --- |
| v0.0 | Project Kernel | 建立可扩展的插件地基 |
| v0.1 | Manuscript Core | 完成最小本地写作闭环 |
| v0.2 | Story Bible Core | 加入本地 Markdown 人物、地点和规则 |
| v0.3 | Outline and Scene Cards | 加入结构规划和场景级管理 |
| v0.4 | Plot Grid | 加入可视化剧情结构和故事线追踪 |
| v0.5 | Knowledge Graph | 加入提及、反链、引用和局部图谱 |
| v0.6 | World Modules | 用可插拔 schema 扩展世界观类型 |
| v0.7 | Timeline Engine | 加入故事时间、叙事顺序和时间线检查 |
| v0.8 | Consistency Lab | 加入长篇连续性和项目健康诊断 |
| v0.9 | Writing Desk | 加入围绕当前章节的写作驾驶舱 |
| v1.0 | Local Stable | 稳定核心产品和 schema |
| v1.1 | Compile | 加入成书导出、排版和发布流水线 |
| v1.2 | Snapshots and Versions | 加入快照、对比和恢复工作流 |
| v1.3 | Assistant Layer | 加入可选 AI 辅助层 |
| v1.4 | Blueprint Studio | 加入高级图形规划和蓝图 Markdown 同步 |
| v1.5 | Template Packs | 加入本地题材、方法和 schema 模板包 |

## 每个版本的发布节奏

每个版本都分三步完成：

1. **实现**：先做最小完整功能闭环。
2. **优化**：优化性能、数据流、交互和失败处理。
3. **打磨**：统一命名、空状态、文档、测试和用户流程。

一个版本没有明确验收前，不进入下一层复杂能力。

## 兼容性政策

v1.0 是 LoreDock 的兼容性分界线。

### v1.0 之前

- 可以随时调整存储结构、目录布局、schema 字段和代码架构。
- 可以重命名 capability、命令、模块和内部 API。
- 可以删除不合适的早期实验设计。
- 不承诺旧 pre-1.0 项目可以无痛打开。
- 每次破坏式调整都要在文档中写清楚原因和新结构。
- 优先级是：架构干净、边界清楚、可扩展，而不是兼容早期草稿。

### v1.0 之后

- 必须兼容 v1.0 及之后所有正式项目格式。
- schema 变化必须增加 migration。
- 命令和公开文件结构不能随意删除；必须先 deprecated，再迁移。
- 用户内容文件不能因为升级丢失或被静默改写。
- 任何自动迁移都必须可诊断、可失败恢复，重要迁移需要预览或快照。
- 新版本必须带有旧版本 fixture 测试，确保历史项目能打开。

## v1.0 前不做的事

- 云同步。
- 多人协作编辑。
- 移动端。
- 专有数据库。
- AI 作为必需配置。
- 在手稿里写隐藏元数据。
- 自动改写手稿正文。
- 在本地项目模型稳定前做过重的视觉画布。

## 详细版本方案

每个版本的独立方案见 `docs/versions/`。
