# LoreDock

LoreDock 是一个本地优先的 VS Code 长篇小说 AI 写作工作台。它把手稿、人物卡、地点卡、世界规则、章节摘要和 AI 上下文预览放进同一个 workspace，让作者能在不牺牲控制权的前提下使用 AI 续写、润色和沉淀长期记忆。

## MVP 能力

- 一键初始化小说项目，创建 `.loredock/`、`manuscript/`、`codex/` 本地结构。
- 在 Activity Bar 的 LoreDock 面板里浏览卷、章节、人物、地点和世界规则。
- 一键创建卷、章节、人物卡、地点卡和世界规则草稿；标题和设定可以之后再补。
- 支持创作助手：左侧和 AI 聊小说方向，右侧自动沉淀标题、文风、人物、地点、世界规则和章节/场景规划草稿，确认后写入项目。
- 支持世界观记忆 v0.2：资料卡可记录记忆状态、来源引用、AI 推测、人物关系、知情状态、事件因果和时间线影响，帮助 AI 读取大型世界观时保留推理依据。
- 支持删除书籍项目、卷、章节和资料卡，删除前会明确确认。
- 使用 VS Code 原生编辑器打开章节 Markdown 和资料卡 JSON。
- 支持章节状态切换和写作统计面板。
- 支持每日/全书写作目标，并在统计面板显示进度。
- 支持打开全局文风指南，编辑叙事视角、风格偏好和禁止事项。
- 支持伏笔、时间线、场景和 Beat 草稿卡，作为长期写作结构进入资料库和 AI 上下文。
- 支持资料卡表单编辑、按类型/标签筛选、伏笔看板、时间线看板、场景/Beat 看板和顺序归一化。
- 支持选择 Beat 一键扩写，确认写回后自动标记为已扩写。
- 支持从 Markdown/TXT 导入已有手稿并按标题拆章。
- 支持将整本书按卷章顺序导出为 Markdown、TXT、DOCX、EPUB 或 PDF，并可通过导出样式文件控制标题、作者、卷标题、字号和行距等。
- 通过 `.loredock/ai.local.jsonc` 配置供应商/模型，通过 `.loredock/ai.env` 填写本地 API key，支持 GPT/OpenAI、Claude、Gemini 和 OpenAI-compatible 服务。
- LoreDock 侧边栏提供齿轮设置页，可以像插件设置一样直接编辑 AI provider、baseUrl、模型、温度、超时和各平台 API key。
- VS Code 底部状态栏会显示当前正在使用的模型；点击模型名即可拉取模型列表并切换。
- 填好 key 后可以读取当前供应商可用模型列表，并选择模型写回配置文件。
- 执行章节续写、选区润色、章节摘要生成和一致性检查。
- 每次 AI 调用前预览即将发送的上下文，并可手动排除非必需段落；AI 结果必须确认后才会追加、插入、替换或保存。润色支持 VS Code Diff 和分段接受/保留。
- 本地记录 AI 操作历史，并提供历史查看/复制/清空面板。
- 章节摘要保存后，会从人物变化、地点变化、新设定、伏笔和未解决问题生成待确认资料库更新建议，并支持逐条接受/跳过后写回资料库。
- 支持本地确定性一致性检查，先抓隐藏真相提前出现、人物状态复核、绝对规则疑似违反和时间线多地点冲突等问题。
- 一致性上下文会明确区分已确认正史和 AI 推测层；pending 推测会标注依据和置信度，普通续写仍默认排除 `secrets` / `hiddenSecrets`。

## 本地项目结构

初始化后会创建：

```text
.loredock/
  project.json
  ai.local.jsonc
  ai.env
  style-guide.md
  export-style.jsonc
  goals.json
  summaries/
  history/
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

`project.json`、摘要、历史、手稿和资料卡都保存在本地 workspace。AI key 推荐写在 `.loredock/ai.env`，供应商、模型和 baseUrl 写在 `.loredock/ai.local.jsonc`。初始化时会创建 `.loredock/.gitignore` 忽略这两个 local 配置文件，避免误提交。

## 开发

```bash
npm install
npm run compile
npm test
npm run test:integration
```

在 VS Code 中按 `F5` 启动 Extension Development Host。命令面板里主要保留 `LoreDock: 初始化小说项目`；初始化后优先使用 Activity Bar 里的 LoreDock 面板：

- 手稿栏顶部“更多操作”只保留项目级动作，例如统计、目标、文风、导入导出、AI 历史、摘要建议和本地检查。
- 资料库栏顶部“更多操作”只保留打开资料卡、表单编辑、筛选和刷新。

初始化不会强迫你先起书名、填作者或创建角色。LoreDock 会用当前 workspace 名称作为临时标题，创建第一卷和第一章；之后可以直接开始写，也可以在手稿栏“更多操作”里打开“创作助手”。

创作助手是一个左右分栏页面：左边是 Workshop Chat，可以用 Enter 发送、Shift+Enter 换行，也可以点快捷提示让 AI 从零构建、深化主角、提取资料库或生成第一卷规划；右边是 Codex Memory，显示 AI 从聊天里整理出的设定草稿、参考设定、AI 推测、潜在矛盾、待确认问题和计数。草稿不会自动写入文件；点击“应用项目”“应用文风”“应用资料库/记忆”“应用规划”或“应用全部”后，才会分别写入 `.loredock/project.json`、`.loredock/style-guide.md` 和 `codex/` 资料卡。已有同名人物、地点、世界规则、时间线事件、场景和 Beat 会被更新，找不到才会新建。AI 推测会写入对应资料卡的 `inferences`，默认状态是 `pending`，不会直接覆盖正史字段。

## 世界观记忆模型

LoreDock 现在把大型世界观拆成可维护的本地记忆层：

- `memoryStatus`：标记资料卡是 `draft`、`confirmed` 还是 `deprecated`。
- `sourceRefs`：记录设定来自聊天、章节摘要、手动编辑或其他资料卡。
- `inferences`：保存 AI 推测，包括对象、字段、推测内容、依据、置信度和状态；`pending` 表示只供参考，`accepted` 才代表作者认可。
- 人物卡支持 `relationships`、`knows`、`doesNotKnow`，用于维护人物关系和“谁知道什么”。
- 世界规则支持 `category`、`rules`、`scope`、相关人物/地点/组织、已知例外，适合力量体系、政治体系、宗教制度等大型设定。
- 时间线事件支持 `sequence`、`causes`、`consequences`、`knownBy`、`unknownBy` 和关系影响，用来维护事件因果和信息公开状态。

AI 续写、润色、摘要和一致性检查前会构建上下文包，只选择与当前章节、选区或用户要求相关的记忆。上下文中会标明“AI 推测层（不是正史）”，并继续排除人物/地点的 `secrets` 和 `hiddenSecrets`。

添加和删除主要从 LoreDock 侧边栏完成。为了避免重复入口，能从右键或底部状态区完成的动作不再塞进顶部“更多操作”：

- 手稿栏/资料库栏标题处的齿轮会打开 `LoreDock Settings`。
- 手稿栏顶部“更多操作”里可以完成项目级管理动作。
- 右键书籍可以新建卷或删除当前 LoreDock 书籍项目；删除只会删除 `.loredock/`、`manuscript/`、`codex/`，不会删除整个 workspace。
- 右键卷可以新建章节，或删除该卷及其章节文件。
- 右键章节可以删除对应 Markdown 文件。
- 右键章节可以设置状态、续写、生成摘要或做一致性检查。
- 右键资料库分类可以新建对应资料卡。
- 资料库栏顶部“更多操作”里可以打开、筛选和表单编辑资料卡。
- 右键资料卡可以打开 JSON、表单编辑或删除对应 JSON 文件。
- 右键伏笔、时间线、场景或 Beat 分类可以打开对应看板；右键场景/Beat 分类可以整理顺序；右键 Beat 分类可以扩写 Beat。

章节摘要保存后，如果 AI 提取到人物状态变化、地点变化、新设定、伏笔或未解决问题，LoreDock 会在 `.loredock/pending-updates/` 生成 Markdown 建议文件。也可以在手稿栏“更多操作”里运行“应用摘要建议”，逐条接受或跳过；接受后会写回人物卡、地点卡、世界规则或伏笔卡。

导入功能支持 Markdown 标题和常见“第 X 章”文本标题，会创建一个新的“导入：文件名”卷。导出功能会把文件写入 `exports/`，例如 `exports/novel.md`、`exports/novel.docx` 或 `exports/novel.pdf`。它只读取当前章节正文并生成合并文件，不会修改手稿。

润色结果面板提供 `打开 Diff`，会使用 VS Code 原生 diff 比较原文和 AI 改稿；也可以点“分段应用”，逐段选择使用 AI 改稿或保留原文。只有点击替换、分段应用、插入或复制后才会应用。

## AI 配置

点击 LoreDock 侧边栏标题处的齿轮会打开 `LoreDock Settings`。AI 配置可以直接在设置页里编辑：

- `常规`：默认语言。
- `AI 配置`：provider、baseUrl、model、apiKeyEnv、temperature、maxOutputTokens、timeoutMs。
- `API Key`：`OPENROUTER_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`。
- `诊断`：AI 请求预检、测试 AI 连接。

VS Code 底部状态栏会显示当前模型。点击底部模型名，会使用 VS Code 原生弹出列表读取当前 provider 的模型并切换。

如果需要直接编辑文件，设置页里也有“打开配置文件”，会同时打开两个文件：

- `.loredock/ai.local.jsonc`：选择 provider、baseUrl、model、温度等非秘密配置。
- `.loredock/ai.env`：填写 API key，例如 `ANTHROPIC_API_KEY=...`。

`.loredock/ai.local.jsonc` 里有这些配置块：

- `gpt`：OpenAI GPT 接口
- `claude`：Anthropic Claude 接口
- `gemini`：Google Gemini 接口
- `openai-compatible`：通用 `/chat/completions` 兼容接口
- `openrouter`、`lm-studio`、`ollama`、`deepseek`、`custom`

把 `activeProvider` 改成要使用的供应商，然后在对应配置块里填写 `baseUrl`。把 key 写进 `.loredock/ai.env` 并保存后，点击底部状态栏里的当前模型，插件会调用当前供应商的模型列表接口，让你选择一个模型并写回 `model` 字段。

如果认证异常，先在 `LoreDock Settings` 的 `诊断` 里运行 `AI 请求预检`。OpenRouter 模式下它会用同样的认证头请求 `https://openrouter.ai/api/v1/key`，不发送小说正文；报告会显示实际 URL、认证方式、key 掩码长度、HTTP 状态和服务端响应。

`.loredock/ai.env` 使用普通 env 文件格式：

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-v1-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...
```

也兼容从 `.zshrc` 复制过来的写法：

```dotenv
export ANTHROPIC_API_KEY=sk-ant-...
```

每个 provider 都支持 `apiKeyEnv`，例如 Claude 默认：

```jsonc
"claude": {
  "baseUrl": "https://api.anthropic.com",
  "model": "",
  "apiKey": "",
  "apiKeyEnv": "ANTHROPIC_API_KEY"
}
```

如果你在 `~/.zshrc` 里写了 `export ANTHROPIC_API_KEY=...`，从终端启动 VS Code 时通常能读到；从 Dock 或 Finder 启动 VS Code 时，扩展宿主可能读不到 zshrc。更稳定的做法是把同一行复制到 `.loredock/ai.env`。

如果你的 Claude CLI 能用，并且 `~/.claude/settings.json` 里配置了 `ANTHROPIC_BASE_URL`，可以在 `LoreDock Settings` 的 `AI 配置` 里点击 `使用 Claude CLI 配置`。LoreDock 会把当前小说项目切到 `claude` provider，复用 Claude CLI 的代理地址、模型和 `ANTHROPIC_API_KEY`。

常见配置示例：

- LM Studio: `http://localhost:1234/v1`
- Ollama OpenAI-compatible endpoint: `http://localhost:11434/v1`
- OpenRouter: `https://openrouter.ai/api/v1`
- DeepSeek compatible API: `https://api.deepseek.com/v1`
- GPT/OpenAI: `https://api.openai.com/v1`
- Claude: `https://api.anthropic.com` 或 `https://api.anthropic.com/v1`
- Gemini: `https://generativelanguage.googleapis.com/v1beta`

Claude/Anthropic 注意事项：

- Anthropic Console 里的 API key 通常以 `sk-ant-` 开头。
- 仅仅 `sk-` 开头不够判断；OpenAI key 也常见 `sk-...`。
- 如果一个 `sk` 开头 key 可以同时选择 GPT、Claude、DeepSeek 等很多模型，它通常是模型路由/聚合平台 key，不是 Anthropic 原生 key。
- 多模型路由 key 请把 `activeProvider` 设为 `openrouter` 或 `openai-compatible`，不要设为 `claude`。
- 如果 key 是 OpenAI 原生的，请把 `activeProvider` 设为 `gpt`；如果是 Anthropic 原生的，请设为 `claude` 或 `anthropic`。
- 如果 key 来自 Claude 兼容代理，不要求以 `sk-ant-` 开头；此时 `activeProvider` 仍用 `claude`，但 `claude.baseUrl` 必须是代理地址，而不是官方 Anthropic 地址。

OpenRouter / 多模型路由示例：

```jsonc
{
  "activeProvider": "openrouter",
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "anthropic/claude-sonnet-4",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

对应 `.loredock/ai.env`：

```dotenv
OPENROUTER_API_KEY=sk-or-v1-...
```

如果你已经把这个多模型 key 写在 `ANTHROPIC_API_KEY=...`，LoreDock 在 `openrouter` 和远程 `openai-compatible` 模式下也会尝试读取它；不过为了不混淆，推荐后续改填到 `OPENROUTER_API_KEY=`。

从网页或示例复制 key 时，LoreDock 会自动兼容这些常见写法：

```dotenv
OPENROUTER_API_KEY=Bearer sk-or-v1-...
OPENROUTER_API_KEY=sk-or-v1-... # 注释
export OPENROUTER_API_KEY="sk-or-v1-..."
```

如果你看到错误里写着：

```text
provider=openai-compatible
baseUrl=http://localhost:1234/v1
```

说明当前还在使用默认的 LM Studio 本地地址。若你手里的 `sk-...` key 是多模型路由 key，请在 `LoreDock Settings` 的 `AI 配置` 里点 `套用 OpenRouter`，或手动把配置改成 `activeProvider: "openrouter"`。

如果你的平台不是 OpenRouter，但兼容 OpenAI 的 `/chat/completions` 和 `/models`，可以使用：

```jsonc
{
  "activeProvider": "openai-compatible",
  "providers": {
    "openai-compatible": {
      "baseUrl": "你的平台 baseUrl，例如 https://example.com/v1",
      "model": "平台返回的模型名",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

如果出现 `fetch failed`：

- 先检查 `baseUrl` 是否是完整 URL，必须包含 `https://` 或 `http://`。
- OpenRouter 通常是 `https://openrouter.ai/api/v1`。
- OpenAI-compatible 平台通常也要以 `/v1` 结尾，具体以平台文档为准。
- LM Studio 默认是 `http://localhost:1234/v1`，需要先启动本地 server。
- Ollama OpenAI-compatible endpoint 默认是 `http://localhost:11434/v1`，需要先启动 Ollama。
- 如果错误提示是 DNS、证书、连接拒绝或超时，请优先检查网络、代理、证书或本地服务端口。

如果出现 `Missing Authentication header`：

- 当前请求没有带上 API key。
- 先在 `LoreDock Settings` 的 `诊断` 里运行 `AI 请求预检`，确认当前服务端能接受认证。
- 如果使用 OpenRouter 或模型路由平台，请确认 `activeProvider` 是 `openrouter` 或远程 `openai-compatible`。
- 请把 key 填到 `.loredock/ai.env`，例如 `OPENROUTER_API_KEY=sk-...` 或 `ANTHROPIC_API_KEY=sk-ant-...`。
- 如果 key 只在 `~/.zshrc` 里，例如 `export ANTHROPIC_API_KEY=...`，从 Dock/Finder 启动的 VS Code 可能读不到；可以把这一行复制到 `.loredock/ai.env`，或从终端用 `code .` 启动。
- 如果诊断说会发送 Bearer，但 OpenRouter 仍报缺少认证头，请运行 `AI 请求预检`。若预检也显示 Missing Authentication header，优先检查 baseUrl 是否被代理或网关改写；若显示 invalid/unauthorized，则通常是 key 不属于当前平台。

## 当前范围

本仓库当前实现设计文档中的 P0/MVP，并补入多项 P1/P2 的本地 MVP：伏笔、时间线、场景、Beat、章节状态、写作目标与统计、AI 历史 UI、上下文手动排除、一致性检查、摘要后的资料库更新建议、导入、多格式导出和基础导出样式。

仍属于后续版本的内容包括：初始化向导、可视化时间线、人物关系图、本地向量检索、高级多模型策略、更完整的导出排版模板、云同步和多人协作。
