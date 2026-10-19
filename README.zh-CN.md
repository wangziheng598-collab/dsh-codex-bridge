# dsh-codex-bridge

把 **OpenAI Codex** 接到 **DeepSeek Harness（DSH）**。

这是一个 Codex 插件：给 Codex 增加 5 个 MCP 工具，可以把一件完整的任务交给 DSH 的
DeepSeek 智能体去做，在同一个 DSH 会话里继续追问，并读取 DSH 实际做了什么，全程不用
离开 Codex。

```
┌──────────┐   MCP / stdio      ┌──────────────┐   spawn    ┌────────────────────────┐
│  Codex   │ ─────────────────► │  dsh-bridge  │ ─────────► │ dsh headless --json -  │
│ (MCP     │ ◄───────────────── │  Node 零依赖 │ ◄───────── │ (DeepSeek Harness CLI) │
│  客户端) │    工具调用/结果    │              │   NDJSON   └───────────┬────────────┘
└──────────┘                    └──────┬───────┘                        │
                                       │ 只读读取                        │ 写入
                                       ▼                                ▼
                              ~/.dsh/sessions/**                工作区文件、DSH 工具
                              (v4 JSONL, zstd)
```

## 为什么做这个

Codex 擅长在一个仓库里干活；DSH 是另一个智能体，有自己的模型、工具、权限和会话历史。
有些任务更适合外包出去——长时间重构、要第二个意见、或者你希望 DeepSeek 来负责的那部分；
有时你只是想看看 DSH 之前到底做了什么。

这个插件把两个方向都变成普通的 Codex 工具调用。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_run` | 在 DSH 里跑一个完整任务（新会话），返回最终回答和会话 ID。 |
| `dsh_resume` | 用后续指令继续已有的 DSH 会话。 |
| `dsh_sessions` | 列出最近的 DSH 会话：标题、工作区、消息数。 |
| `dsh_session_read` | 读取某个会话的对话记录，可选包含工具调用与结果。 |
| `dsh_doctor` | 检查 launcher、版本、profile、密钥、会话存储是否正常。 |

另外附带一个 `dsh` skill，教 Codex 什么时候该委托、提示词该怎么写、失败后怎么恢复。

## 环境要求

- **Codex**：支持插件（`codex plugin --help` 可用）。已在 `codex-cli 0.163.0-alpha.10.2` 验证。
- **DeepSeek Harness**：桌面版（自动找到内置 CLI）或 `PATH` 上的 `dsh` CLI。
- **Node.js ≥ 22.15**：MCP 服务本体；低于此版本仍可运行任务，但读不了 zstd 会话文件
  （`dsh_sessions` / `dsh_session_read` 会明确提示）。
- **DeepSeek API Key**：`dsh_run` 需要。headless profile 不会复用桌面版的账号登录。

## 安装

```bash
codex plugin marketplace add wangziheng598-collab/dsh-codex-bridge
codex plugin add dsh-bridge@dsh-codex
```

开一个新的 Codex 会话，让它跑一次 `dsh_doctor`；或确认插件已注册：

```bash
codex plugin list
```

以后更新：`codex plugin marketplace upgrade dsh-codex`，再重装插件。

### 给 DSH 配置密钥

`dsh_run` 调的是 `dsh headless`，它从环境变量读取 `DEEPSEEK_API_KEY`：

```powershell
# Windows PowerShell（新开终端生效）
setx DEEPSEEK_API_KEY "sk-..."
```

```bash
# macOS / Linux
export DEEPSEEK_API_KEY="sk-..."
```

先脱离 Codex 确认 DSH 本身能跑：

```bash
dsh headless "Reply with PONG"
```

如果这里就报 `MISSING_CREDENTIAL`，Codex 里也会一样——先把密钥问题解决。

### 手动配置 MCP（不用插件）

```bash
codex mcp add dsh --env DEEPSEEK_API_KEY="$env:DEEPSEEK_API_KEY" -- node <本仓库路径>/plugins/dsh-bridge/server/main.mjs
```

或写进 `~/.codex/config.toml`：

```toml
[mcp_servers.dsh]
command = "node"
args = ["<本仓库路径>/plugins/dsh-bridge/server/main.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 1200

[mcp_servers.dsh.env]
DEEPSEEK_API_KEY = "sk-..."
```

## 用法示例

在 Codex 里可以直接说：

- “把这件事交给 DSH：给 `parser.ts` 补集成测试，跑一遍，修不了的把失败信息带回来。”
- “继续刚才那个 DSH 会话，让它把那个提交拆一下。”
- “列一下我最近的 DSH 会话，把最新那个总结给我。”
- “DSH 报错了，跑一下 dsh_doctor。”

什么时候调用由 Codex 决定；skill 会引导它把大型、独立的任务委托出去，而小改动、依赖当前
对话上下文的任务自己完成。

## 实现说明

- MCP 服务用 stdio 上的换行分隔 JSON-RPC 2.0（协议 `2025-06-18`，带降级），**没有运行时依赖**。
- 一次运行就是 `dsh headless --json [--session-id <id>] -`；提示词写进 stdin，所以引号、
  换行、中文都不会经过 shell。
- DSH 输出 NDJSON 事件（`session`、`status`、`text`、`final`），服务从中取会话 ID、最终回答
  和结构化错误。
- launcher 查找顺序：`DSH_CODEX_DSH` → `PATH` 上的 `dsh` → 桌面版自带 CLI（Windows / macOS /
  Linux 常见路径）。
- 会话直接从 `$DSH_HOME/sessions/<工作区>/<id>/session.v4.jsonl.zstd` 读取（只读、按需解压、
  按 mtime 缓存）。

### 环境变量

| 变量 | 含义 |
| --- | --- |
| `DEEPSEEK_API_KEY` | headless profile 使用的密钥，`dsh_run` 必需。 |
| `DSH_CODEX_DSH` | 指定 `dsh` launcher 的绝对路径，覆盖自动探测。 |
| `DSH_CODEX_DEFAULT_CWD` | 工具调用没传 `cwd` 时使用的工作区。 |
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh`。 |

## 安全与权限

- 全部在本地：与 Codex 走 stdio，启动本地 CLI，读取本地会话文件；桥接自身不向外发送仓库内容。
- `dsh_run` 会把一个真实工作区交给 DSH，DSH 用自己的沙箱和审批策略干活；桥接不会放宽它们。
  把不可信目录交给它之前，先确认 DSH 的权限设置。
- 密钥只留在 Codex 传给 MCP 服务的环境变量里，不复制、不打印、不落盘。
- 读会话是只读操作；正在运行的 DSH 会话可能滞后几秒。

## 限制

- 一次性运行没法回答交互式审批，DSH 必须能在非交互模式下完成（headless 默认如此）。
- 桌面版的账号登录不与 headless CLI 共享，`dsh_run` 需要 API Key。
- Codex 和 DSH 必须在同一台机器上。
- 已在 Windows 11 + DSH `0.2.1-rc.2` + Codex `0.163.0-alpha.10.2` 验证；macOS / Linux 使用
  同一套 CLI 约定和桌面版目录布局。

## 排错

| 现象 | 处理 |
| --- | --- |
| `DeepSeek Harness CLI was not found` | 安装 DSH、把 `dsh` 加进 `PATH`，或用 `DSH_CODEX_DSH` 指向 launcher。`dsh_doctor` 会打印探测结果。 |
| `MISSING_CREDENTIAL` | 在启动 Codex 的环境里设置 `DEEPSEEK_API_KEY`，然后重启 Codex。 |
| 会话读不出来 | Node 低于 22.15。升级 Node，或忽略会话类工具。 |
| 工具不出现 | `codex plugin list` 查看，然后新开会话；手动配置的用 `codex mcp list`。 |
| 运行超时 | 调大 `timeout_seconds`（最大 3600），或把任务拆小。 |

## 开发

```bash
npm test          # 协议、launcher、会话三类测试（node:test）
npm run smoke     # 像 Codex 一样启动服务，调用 dsh_doctor / dsh_sessions
node scripts/validate.mjs   # 校验 manifest、路径和资源
```

目录：

```
.agents/plugins/marketplace.json   Codex marketplace
.claude-plugin/marketplace.json    兼容 Claude Code 的镜像
plugins/dsh-bridge/
  .codex-plugin/plugin.json        插件 manifest
  .mcp.json                        MCP 服务注册
  server/                          MCP 服务（mcp / dsh / sessions / tools）
  skills/dsh/SKILL.md              给 Codex 的委托指引
```

测试用 stub launcher 走真实的 spawn 路径（包括 Windows `.cmd` 引号和 stdin 提示词投递），
所以不需要装 DSH、也不需要密钥。端到端链路另外用本地 DeepSeek Messages 流式 mock 验证过；
事件约定见 `test/fixtures/stub-dsh.mjs`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
