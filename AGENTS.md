# LoreDock Agent Rules

## Blueprint Markdown Conversion

These rules are mandatory for AI/agent work on LoreDock blueprint Markdown conversion.

- Blueprint Markdown files live under `.loredock/blueprints-md/`.
- Blueprint Markdown must not be stored in or mixed with `manuscript/`.
- A Blueprint Markdown document is a readable outline plus visible blueprint code. Do not use hidden HTML comments, base64 blobs, or opaque metadata.
- The readable outline uses:
  - `#` for volume-level outline text.
  - `##` for chapter-level outline text.
  - `###` for scene-level outline text.
  - `-` for Beat or note-level outline text.
- The visible blueprint code must use explicit symbol/keyword directives:

```markdown
# 蓝图 示例蓝图
@blueprint id="blueprint-id" title="示例蓝图" outlineId="outline-id" outlinePath=".loredock/outlines/example.json"

## 大纲
# 第一卷
## 第一章
### 场景一
- Beat 一

## 蓝图代码
### 节点
@node id="node-a" kind="scene" title="场景一" x=80 y=80 width=240 height=112 color="#4e9aef" tags="开场,关键" locked=false collapsed=false
note: 节点备注明文写在这里

### 关系
@port node="node-a" id="out" name="out" direction="output" kind="exec" label="剧情输出"
@port node="node-b" id="in" name="in" direction="input" kind="exec" label="剧情输入"
@wire id="edge-a-b" from="node-a.out" to="node-b.in" type="flow" label="推进" strength="normal" status="draft"
note: 关系说明明文写在这里

### 视角
@view id="view-main" title="主视角" x=0 y=0 scale=1 createdAt="2026-01-01T00:00:00.000Z"
```

- Blueprint code must preserve identity, title, outline binding, nodes, ports, wires, references, layout, colors, tags, locked/collapsed flags, relation labels/notes/strength/status, and viewport bookmarks in plain text.
- New exports must use `@wire from="node.port" to="node.port"` for relations. Old `@edge from="node" to="node"` is import-only compatibility and should be re-exported as `@wire`.
- If Markdown has no `@blueprint`, `@node`, `@port`, `@wire`, or `@edge` directives, import it as readable outline only and rebuild only outline nodes plus `flow` relations.
- If a file still contains `loredock-blueprint-meta`, treat it as an old hidden format and report it as a planning warning. New exports must never write that marker.
- Synchronization must be explicit preview first. Conflicts default to skip.
- Push writes Markdown from the current blueprint. Pull updates the blueprint from Markdown.
- Only `.loredock/outlines/`, `.loredock/blueprints/`, and `.loredock/blueprints-md/` may be changed by blueprint Markdown conversion.
- Conversion must not create or modify `manuscript/`.
- Do not add AI, API key, model, prompt, network, or external-service dependencies for this feature.
