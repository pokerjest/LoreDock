# LoreDock 地基架构原则

这份文档约束 v0.0-v0.2 的实现方向。目标是避免后期功能增加时牵一发而动全身。

## 核心判断

地基阶段最重要的不是功能数量，而是边界质量。

如果一个功能需要绕过 Kernel、直接读写其他模块私有文件、把 UI 状态写进 canon 数据，或者跳过 preview/apply 流程，它就不应该进入当前版本。

## 依赖方向

正确方向：

```text
Kernel
  -> Capability API
    -> Feature Module
      -> Projection / View
```

禁止方向：

```text
Feature Module -> Kernel 私有实现
Feature Module -> 另一个 Feature Module 私有实现
View/Webview -> 直接修改 canon 文件
Assistant -> 直接修改 manuscript 或 lore
Index -> 成为唯一真实数据源
```

跨 capability 读取只能通过公开 capability service。比如后续大纲、图谱、时间线、导出和 AI 需要读取手稿时，应该依赖 Manuscript 暴露的 reader、actions 和 events 接口，而不是直接读取或修改 `manuscript/manifest.json`。

## 数据分层

```text
用户内容层：manuscript/、lore/、outlines/
项目配置层：.loredock/project.json、.loredock/schemas/
索引层：.loredock/indexes/
诊断层：.loredock/diagnostics/
快照层：.loredock/snapshots/
导出层：exports/
```

规则：

- 用户内容层必须人可读。
- 索引层可以删除后重建。
- 诊断层不能作为 canon。
- 快照层只用于恢复，不参与正常读取。
- 导出层永远不是源数据。

## Canon 与 Projection

Canon 是真实数据，例如章节 Markdown、故事卡 Markdown、manifest。

Projection 是为了 UI 或检查生成的派生数据，例如树节点、剧情矩阵数据、引用索引、图谱节点。

规则：

- Projection 可以缓存，但必须能从 canon 重建。
- UI 只能通过明确 action 修改 canon。
- 任何批量 action 都必须 preview first。
- 索引错误不能污染 canon。

## Capability Service 边界

Kernel 需要提供最小 service registry，让 capability 之间可以通过窄接口协作：

- service 只能暴露明确的 reader、actions 和 events。
- reader 可以返回 canon 的只读 projection，但不能泄露模块私有写入细节。
- actions 负责受控修改本模块 canon，复杂写入必须走 preview、confirm、apply。
- events 只通知变化类型和必要 ID，不传递可被其他模块直接写回的内部对象引用。
- 后续模块不能为了方便直接读写另一个模块的私有 canon 文件。

## 写入模型

所有复杂写入都走同一套流程：

1. collect：收集输入。
2. preview：生成将要变化的文件列表和 diff/摘要。
3. confirm：用户确认。
4. apply：执行写入。
5. verify：重新读取并验证。
6. report：输出结果。

适用范围：

- 大纲导入。
- 批量重命名。
- 手稿结构创建、移动和删除。
- 自动修复。
- 时间线同步。
- AI 建议应用。
- 蓝图 Pull/Push。
- 模板包启用。

## ID 策略

- 用户可见标题可以改。
- 文件名可以改。
- 稳定引用依赖 ID。
- ID 生成由 Kernel 或统一 utility 负责。
- 同一项目内 ID 必须唯一。
- v1.0 前 ID 格式可以调整；v1.0 后必须迁移兼容。

## v0.0-v0.2 地基验收

- 新 capability 可以不改 Kernel 内部代码而注册。
- 每个模块都有自己的 schema 和文件边界。
- 所有项目数据路径都是 workspace-relative。
- 没有绝对路径写入项目文件。
- 没有 AI、webview 或导出器依赖进入 Kernel。
- 没有模块把自己的 UI 状态写入其他模块 canon。
- 至少有一条 preview/apply 流程被真实功能使用。
