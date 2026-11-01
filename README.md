# Omni-Skill-Proxy

> **把所有客套话挡在网关之外，把最纯粹的代码留给开发者。**
>
> *Blocking every pleasantry at the gateway, keeping only pure code for developers.*

Omni-Skill-Proxy 是一个纯 Node.js / TypeScript 编写的**本地 AI 代理网关**，零原生依赖（Win7 友好）。它拦截所有发往 LLM 的请求，强制注入“只输出代码、禁止废话”的 System Prompt；同时拦截 LLM 返回的流式 SSE 响应，实时剥离“好的”、“当然可以”、“以下是代码”等无意义解释文字——客户端拿到的，永远是最纯粹的代码。

Omni-Skill-Proxy is a **local AI gateway** written in pure Node.js / TypeScript with zero native dependencies (Windows 7 friendly). It intercepts every request going to an LLM, force-injects a "code only, no chatter" system prompt, and intercepts the streaming SSE response on the way back, stripping filler like "Sure", "Of course" or "好的，以下是代码" in real time — the client only ever receives the pure code.

灵感来源：掘金热榜《让 Codex/Claude Code 少说废话、先给答案》。
Inspired by the Juejin trending article *"Make Codex/Claude Code talk less and answer first"*.

---

## 特性 / Features

- 🚀 **零原生依赖** —— 只用 Node 内置 `http` / `https` / `stream` 模块，Win7 / 老机器直接跑。*Zero native deps — built-in modules only.*
- 🔌 **双格式兼容** —— 同时支持 OpenAI（`/v1/chat/completions`）与 Anthropic（`/v1/messages`）线路格式。*OpenAI & Anthropic wire formats.*
- 💉 **强制规则注入** —— 在每个请求的 system 位前置不可覆盖的“仅代码”规则，合并 `skills/*.skill.md` 动态规则。*Force-injects code-only rules, merged with dynamic skill files.*
- ✂️ **流式废话剥离** —— 有状态机解析 SSE 流：废话前缀丢弃、围栏整体透传、代码块闭合后进入静默态。*State-machine SSE stripper: drops filler, passes fences verbatim, goes silent after the code block closes.*
- 🧩 **Skill 热重载** —— `skills/` 目录下 `.skill.md` 增删改后 300ms 内热生效，无需重启。*Hot-reloadable skill files.*
- 🧪 **一键离线演示** —— `npm run demo` 自带 mock 上游，不配任何 Key 就能看到前后对比。*Offline one-click demo, no API key needed.*

## 快速开始 / Quick Start

```bash
# 安装构建期依赖（仅 typescript + @types/node）
npm install

# 编译 TS -> dist/
npm run build

# 启动网关（默认 127.0.0.1:8888）
npm start

# 一键离线演示（自带 mock 上游，无需任何 API Key）
npm run demo
```

然后把你的客户端（Codex / Claude Code / DSH / 任意 OpenAI SDK）的 base URL 指向网关：
Then point your client's base URL at the gateway:

```bash
# OpenAI 客户端 / OpenAI clients
export OPENAI_BASE_URL=http://127.0.0.1:8888/v1
export OPENAI_API_KEY=sk-your-real-key

# Anthropic 客户端 / Anthropic clients
export ANTHROPIC_BASE_URL=http://127.0.0.1:8888
export ANTHROPIC_API_KEY=sk-ant-your-real-key
```

环境变量配置 / Configuration via environment:

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 / listen address |
| `PORT` | `8888` | 监听端口 / listen port |
| `UPSTREAM_BASE_URL` | — | 真实上游地址，如 `https://api.intern-ai.cn` / `https://api.openai.com` / `https://api.anthropic.com` |
| `UPSTREAM_API_KEY` | — | 上游 API Key（注入 `Authorization: Bearer` 或 `x-api-key`）|
| `SKILLS_DIR` | `skills` | `.skill.md` 文件目录 / skill files directory |
| `INJECT` | `1` | 是否注入系统规则 / `0` 关闭 |
| `STRIP` | `1` | 是否剥离废话流 / `0` 透传 |
| `MAX_HOLD_CHARS` | `200` | 废话缓冲上限（防饿死客户端）/ filler hold limit |

## 工作原理 / How It Works

```
客户端 ──POST──► [proxy_server:8888]
                    │
                    ├─ 1. skill_loader 读取 skills/*.skill.md
                    ├─ 2. injector 强制注入 system 规则（不可被用户消息覆盖）
                    ├─ 3. upstream 转发到真实 API（原生 http/https）
                    └─ 4. stream_stripper 过滤 SSE 流
                            │
                            ├─ 代码块外：缓冲 → 匹配废话词表 → 丢弃
                            ├─ 进入围栏 ```：无缝透传
                            └─ 围栏闭合后：静默态，块后一切丢弃
                                   │
客户端 ◄──纯代码 SSE──┘
```

## 目录结构 / Project Layout

```
omni-skill-proxy/
├── src/
│   ├── types.ts            # 共享类型与配置 / types & env config
│   ├── proxy_server.ts     # 极简本地转发网关 / the gateway itself
│   ├── stream_stripper.ts  # SSE 流式废话过滤器 / the SSE stripper (core)
│   ├── skill_loader.ts     # 动态 SKILL.md 注入 / skill file loader
│   ├── injector.ts         # System Prompt 注入器 / prompt injector
│   └── upstream.ts         # 原生 http/https 上游客户端 / upstream client
├── skills/                 # 预置 .skill.md 规则（priority 越高越靠前）
├── demo/
│   └── demo.js             # 一键离线演示 / one-click offline demo
├── package.json
├── tsconfig.json
└── README.md
```

## 自定义 Skill / Custom Skills

在 `skills/` 下新建任意 `*.skill.md`，用极简 front-matter 声明优先级（越大越靠前）：
Create any `*.skill.md` under `skills/` with a minimal priority front-matter:

```markdown
---
priority: 100
---
# Skill: Code-Only Output / 仅输出代码
- 回答只能是一个围栏代码块，块外不许任何文字
```

网关会在每次请求时把这些规则合并进 system prompt，并热重载。
The gateway merges these rules into the system prompt of every request, hot-reloaded on file changes.

## 开源协议 / License

MIT — 随便用，别客气。*MIT — do whatever you want.*
