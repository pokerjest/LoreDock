# LoreDock

LoreDock 是一个本地优先的 VS Code 长篇小说结构工作台。它把手稿、人物卡、地点卡、世界规则、伏笔、时间线、场景和 Beat 放进同一个 workspace，帮助作者维护长篇项目的结构、资料库和导出流程。

## MVP 能力

- 一键初始化小说项目，创建 `.loredock/`、`manuscript/`、`codex/` 和 `exports/` 本地结构。
- 在 Activity Bar 的 LoreDock 面板里浏览卷、章节、人物、地点、世界规则、伏笔、时间线、场景和 Beat。
- 创建、打开、重命名、删除卷和章节，并维护章节状态。
- 创建和编辑人物卡、地点卡、世界规则、伏笔、时间线事件、场景和 Beat。
- 使用 Plan / Matrix 查看章节、场景、Beat 和资料卡引用关系。
- 从 Markdown/TXT 大纲导入卷、章节、场景和 Beat。
- 支持资料卡表单编辑、按类型/标签筛选、伏笔看板、时间线看板、场景/Beat 看板和顺序归一化。
- 支持打开全局文风指南，维护叙事视角、风格偏好和禁止事项。
- 支持章节状态统计、每日/全书写作目标和写作统计面板。
- 支持从 Markdown/TXT/DOCX 导入已有手稿。
- 支持将整本书按卷章顺序导出为 Markdown、TXT、DOCX、EPUB 或 PDF，并通过导出样式文件控制标题、作者、卷标题、字号和行距等。
- 支持资料库 ZIP 导入导出，方便备份或迁移。
- 支持本地确定性一致性检查，先抓隐藏真相提前出现、人物状态复核、绝对规则疑似违反和时间线多地点冲突等问题。
- 蓝图 Markdown 采用“可读大纲 + 明文蓝图代码”格式，使用 `@blueprint`、`@node`、`@port`、`@wire`、`@view` 等符号关键字还原脑图；AI/agent 维护规则见 `AGENTS.md`。

## 本地项目结构

初始化后会创建：

```text
.loredock/
  project.json
  style-guide.md
  export-style.jsonc
  goals.json
  summaries/
  blueprints-md/
  pending-updates/
manuscript/
  volume-001/
    chapter-001.md
codex/
  characters/
  locations/
  world-rules/
  foreshadowing/
  timeline/
  scenes/
  beats/
exports/
```

`project.json`、摘要、手稿和资料卡都保存在本地 workspace。LoreDock 不要求联网，也不创建联网配置文件。

## 使用方式

在 VS Code 中打开一个文件夹，运行 `LoreDock: 初始化小说项目`。初始化后优先使用 Activity Bar 里的 LoreDock 面板：

- 手稿栏顶部“更多操作”用于项目级动作，例如 Plan / Matrix、从大纲创建规划、统计、目标、文风、导入导出、摘要建议、引用索引和本地检查。
- 资料库栏顶部“更多操作”用于打开资料卡、表单编辑、筛选、引用索引、导入导出和刷新。
- 右键书籍可以新建卷或删除当前 LoreDock 书籍项目。
- 右键卷可以新建章节，或删除该卷及其章节文件。
- 右键章节可以打开、重命名、设置状态、删除或运行本地一致性检查。
- 右键资料库分类可以新建对应资料卡。
- 右键伏笔、时间线、场景或 Beat 分类可以打开对应看板。
- 右键场景/Beat 分类可以整理顺序。

## 开发

```bash
npm install
npm run compile
npm test
npm run test:integration
```

在 VS Code 中按 `F5` 启动 Extension Development Host。
