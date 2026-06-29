# LoreDock

LoreDock 是一个运行在 VS Code 里的本地优先故事项目系统，面向长篇小说和复杂世界观项目。

当前插件版本：**0.1.0**。

当前里程碑：**v0.1 Manuscript Core**，建立在 **v0.0 Project Kernel** 之上。

这一版已经不只是扩展脚手架：项目内核已经能管理 LoreDock 项目的初始化、清单、诊断、安全写入和 capability 生命周期；手稿能力也已经接入，可以在 VS Code 侧边栏中管理书籍、卷、章节、笔记、章节状态、目标字数、基础统计和回收站。

## 当前实现

### 项目内核

- VS Code Extension + TypeScript 工程结构。
- 以 workspace folder 作为 v0.x 阶段固定项目根目录。
- `.loredock/project.json` 项目清单生命周期，项目清单 schema 当前为 `0.0.0`。
- `LoreDock: Initialize Project` 使用 preview/apply operation plan 初始化项目。
- manifest validation 支持字段类型检查、JSON 损坏检查、未知版本检查、capability 检查和 degraded mode。
- `LoreDock: Repair Project Manifest` 会先备份损坏清单，再重建最小 v0.0 清单。
- 诊断信息保存在内存中，并输出到 LoreDock OutputChannel。
- `SafeFileWriter` 统一处理 workspace-relative 写入、同目录临时文件和 rename 替换。
- 路径安全检查覆盖绝对路径、`..` 逃逸、未声明文件/目录、父级 symlink 逃逸和目标 symlink 逃逸。
- SchemaRegistry 和 MigrationRunner 已有基础结构；v0.0 项目清单只跑 no-op migration。
- Capability API 支持命令、视图、文件监听、schema、诊断、服务注册和可释放生命周期。
- multi-root workspace 中通过显式 folder 选择路由命令。

### 手稿能力

- `manuscript.core` capability 已接入项目清单。
- LoreDock activity bar 中提供中文“手稿”树视图。
- 支持启用手稿，并创建 `manuscript/manifest.json`、`notes.md`、初始书籍、卷、章节和每本书的 `agent.md`。
- 支持新建、重命名、删除书籍/卷/章节。
- 支持章节跨卷移动、卷内排序、上移和下移。
- 支持章节状态：`idea`、`outline`、`draft`、`revise`、`done`、`archived`。
- 支持章节目标字数和基础字数统计。
- 每本书生成 `agent.md`，把只读系统规则和用户可编辑协作规则分区，方便后续 AI 插件读取。
- 手稿清单 schema 当前为 `0.1.0`。
- 手稿诊断覆盖损坏引用、非法路径、缺失文件、孤立 Markdown、重复路径和 symlink 逃逸。
- 删除书籍、卷或章节时先移入 `.loredock/trash/manuscript/`，支持还原和永久删除。
- 内核不依赖手稿实现细节，手稿通过 Capability API 挂载。

## 项目文件

初始化 LoreDock 项目只会创建：

```text
.loredock/
  project.json
```

项目清单示例：

```json
{
  "schemaVersion": "0.0.0",
  "projectId": "loredock_...",
  "title": "My Novel",
  "createdAt": "2026-06-29T00:00:00.000Z",
  "updatedAt": "2026-06-29T00:00:00.000Z",
  "capabilities": []
}
```

启用手稿后，`capabilities` 会包含 `manuscript.core`，并新增：

```text
manuscript/
  manifest.json
  notes.md
  book-001/
    agent.md
    volume-001/
      chapter-001.md
```

手稿删除项会先进入：

```text
.loredock/
  trash/
    manuscript/
```

v0.1 不会创建故事圣经、索引、快照、导出、编译产物或 AI 配置目录。

## 命令

### 项目命令

- `LoreDock：初始化项目`
- `LoreDock：打开项目清单`
- `LoreDock：显示诊断`
- `LoreDock：修复项目清单`

### 手稿命令

- `LoreDock：启用手稿`
- `LoreDock：新建书籍`
- `LoreDock：新建卷`
- `LoreDock：新建章节`
- `LoreDock：打开章节`
- `LoreDock：重命名书籍`
- `LoreDock：重命名卷`
- `LoreDock：重命名章节`
- `LoreDock：移动章节`
- `LoreDock：上移章节`
- `LoreDock：下移章节`
- `LoreDock：删除书籍`
- `LoreDock：删除卷`
- `LoreDock：删除章节`
- `LoreDock：还原回收站项目`
- `LoreDock：永久删除回收站项目`
- `LoreDock：设置章节状态`
- `LoreDock：设置章节目标字数`
- `LoreDock：刷新手稿`
- `LoreDock：切换回收站`
- `LoreDock：打开笔记`
- `LoreDock：手稿统计`

## 架构边界

LoreDock 的核心原则是本地、透明、可审计、可扩展。

- Kernel 只负责 workspace、manifest、schema、迁移入口、命令注册、诊断、安全写入和 preview/apply。
- Feature capability 只能通过公开 API 挂载，不直接依赖 Kernel 私有实现。
- 用户内容优先使用 Markdown，清单和索引用 JSON。
- 项目数据中的路径必须是 workspace-relative path。
- 所有复杂写入都必须先声明 operation plan，再执行 apply。
- v1.0 之前允许为了干净架构调整存储结构；v1.0 之后才进入正式兼容期。

## 尚未包含

`0.1.0` 仍然不包含：

- 自定义富文本手稿编辑器；章节目前是普通 Markdown 文件。
- 人物、地点、规则、势力、物品、事件等 Story Bible 模块。
- 大纲板、场景卡、剧情矩阵或时间线。
- 引用索引、反向链接、实体图谱或一致性实验室。
- AI assistant/provider 集成。
- Compile/export、快照、版本对比或发布流程。

后续路线见 [`docs/ROADMAP.md`](docs/ROADMAP.md) 和 [`docs/versions/`](docs/versions/)。

## 开发

```sh
npm install
npm run compile
npm test
```

当前测试覆盖项目清单默认值与校验、项目修复、schema registry、migration no-op、安全写入边界、项目初始化、degraded mode、capability 路由、手稿结构操作、手稿诊断、安全路径处理、回收站恢复/永久删除和字数统计。

诊断信息在 `0.1.0` 仍不写入磁盘，只保存在内存中并输出到 LoreDock OutputChannel。
