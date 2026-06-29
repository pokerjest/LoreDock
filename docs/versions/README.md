# LoreDock 版本方案索引

本目录为 LoreDock 全新重构的每个版本保存独立方案。

每个版本都使用同一套结构：

- **目标**：这个版本要证明什么。
- **实现**：必须完成的功能。
- **优化**：基础功能跑通后需要优化什么。
- **打磨**：让这个版本真正像完成品的细节。
- **验收标准**：如何判断这个版本可以进入下一阶段。
- **风险**：哪些事情会让这个版本变脏、变重或偏航。

版本可以在这套结构之外补充额外的约束小节（例如 v0.0 的“干净与可扩展性约束”），用于展开该版本特有的边界要求。

## 兼容性边界

v1.0 之前允许破坏式重构。存储结构、目录、schema、代码架构和命令命名都可以为了更干净的长期设计而调整。

v1.0 之后进入正式兼容期。任何后续版本都必须兼容 v1.0 及之后的项目格式，并为 schema 变化提供 migration、测试 fixture 和必要的恢复路径。

## 版本目录

- [v0.0 Project Kernel](v0.0-project-kernel.md)
- [v0.1 Manuscript Core](v0.1-manuscript-core.md)
- [v0.2 Story Bible Core](v0.2-story-bible-core.md)
- [v0.3 Outline and Scene Cards](v0.3-outline-scene-cards.md)
- [v0.4 Plot Grid](v0.4-plot-grid.md)
- [v0.5 Knowledge Graph](v0.5-knowledge-graph.md)
- [v0.6 World Modules](v0.6-world-modules.md)
- [v0.7 Timeline Engine](v0.7-timeline-engine.md)
- [v0.8 Consistency Lab](v0.8-consistency-lab.md)
- [v0.9 Writing Desk](v0.9-writing-desk.md)
- [v1.0 Local Stable](v1.0-local-stable.md)
- [v1.1 Compile](v1.1-compile.md)
- [v1.2 Snapshots and Versions](v1.2-snapshots-and-versions.md)
- [v1.3 Assistant Layer](v1.3-assistant-layer.md)
- [v1.4 Blueprint Studio](v1.4-blueprint-studio.md)
- [v1.5 Template Packs](v1.5-template-packs.md)
