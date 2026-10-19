# dsh-codex-bridge

Connect **OpenAI Codex** to **DeepSeek Harness (DSH)**.

A Codex plugin that gives Codex five MCP tools: hand a self-contained task to the
DeepSeek Harness agent, continue that work in the same DSH session, and read what DSH
did — without leaving Codex.

```
┌──────────┐   MCP over stdio   ┌──────────────┐   spawn    ┌────────────────────────┐
│  Codex   │ ─────────────────► │  dsh-bridge  │ ─────────► │ dsh headless --json -  │
│  (MCP    │ ◄───────────────── │  (Node, no   │ ◄───────── │ (DeepSeek Harness CLI) │
│  client) │   tools/results    │  deps)       │  NDJSON    └───────────┬────────────┘
└──────────┘                    └──────┬───────┘                        │
                                       │ read-only                      │ writes
                                       ▼                                ▼
                              ~/.dsh/sessions/**            workspace files, tools
                              (v4 JSONL, zstd)
```

## Why

Codex is good at driving a repository. DSH is a separate agent with its own model,
tools, permissions and session history. Sometimes a task is better delegated — a long
refactor, a second opinion, work you want DeepSeek to own — and sometimes you want to
know what DSH already did.

This plugin turns both directions into normal Codex tool calls.

## Tools

| Tool | What it does |
| --- | --- |
| `dsh_run` | Runs a complete task in DSH (new session), returns the final answer and a session id. |
| `dsh_resume` | Continues an existing DSH session with a follow-up prompt. |
| `dsh_sessions` | Lists recent DSH sessions with title, workspace, and message count. |
| `dsh_session_read` | Renders a stored DSH transcript; optionally includes tool calls and results. |
| `dsh_doctor` | Checks the launcher, version, profiles, credentials, and session storage. |

Plus a `dsh` skill that teaches Codex when to delegate, how to write a DSH prompt, and
how to recover from failures.

## Requirements

- **Codex** with plugin support (`codex plugin --help` works). Verified with
  `codex-cli 0.163.0-alpha.10.2`.
- **DeepSeek Harness** — the desktop app (its CLI is auto-detected) or a `dsh` CLI on
  `PATH`.
- **Node.js ≥ 22.15** for the MCP server. Node 20 runs the runner tools but cannot read
  zstd session files (`dsh_sessions` / `dsh_session_read` will say so).
- A **DeepSeek API key** for `dsh_run`: the headless profile does not reuse the desktop
  app's account login.

## Install

```bash
codex plugin marketplace add wangziheng598-collab/dsh-codex-bridge
codex plugin add dsh-bridge@dsh-codex
```

Start a new Codex session and ask it to run `dsh_doctor`, or check the plugin is
registered:

```bash
codex plugin list
```

To update later: `codex plugin marketplace upgrade dsh-codex` (or re-add the
marketplace), then reinstall the plugin.

### Give DSH a key

`dsh_run` launches `dsh headless`, which authenticates with `DEEPSEEK_API_KEY`:

```powershell
# Windows (PowerShell) — new terminals pick this up
setx DEEPSEEK_API_KEY "sk-..."
```

```bash
# macOS / Linux
export DEEPSEEK_API_KEY="sk-..."
```

Confirm DSH itself works before involving Codex:

```bash
dsh headless "Reply with PONG"
```

If that prints `MISSING_CREDENTIAL`, Codex will report the same; fix the key first.

### Manual MCP setup (no plugin)

If you prefer plain MCP configuration:

```bash
codex mcp add dsh --env DEEPSEEK_API_KEY="$env:DEEPSEEK_API_KEY" -- node <path-to-repo>/plugins/dsh-bridge/server/main.mjs
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.dsh]
command = "node"
args = ["<path-to-repo>/plugins/dsh-bridge/server/main.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 1200

[mcp_servers.dsh.env]
DEEPSEEK_API_KEY = "sk-..."
```

## Using it

Typical requests in Codex:

- "Delegate this to DSH: add integration tests for `parser.ts`, run them, and report
  the failures you could not fix."
- "Continue the DSH session from earlier and ask it to split that commit."
- "List my recent DSH sessions and summarize the newest one."
- "DSH failed — run dsh_doctor."

Codex decides when to call the tools; the bundled skill nudges it toward delegation for
large, self-contained jobs and away from it for small edits that need the current
conversation.

## How it works

- The MCP server speaks newline-delimited JSON-RPC 2.0 on stdio (protocol
  `2025-06-18`, with fallbacks), and has **no runtime dependencies**.
- A run is `dsh headless --json [--session-id <id>] -`; the prompt is written to stdin,
  so quotes, newlines, and CJK text never pass through a shell.
- DSH emits NDJSON events (`session`, `status`, `text`, `final`); the server keeps the
  session id, final message, and structured turn errors.
- Launcher discovery order: `DSH_CODEX_DSH` → `dsh` on `PATH` → the CLI bundled with the
  DeepSeek Harness desktop app (Windows, macOS, Linux locations).
- Sessions are read directly from `$DSH_HOME/sessions/<workspace>/<id>/session.v4.jsonl.zstd`
  (read-only, decompressed on demand, cached by mtime).

### Environment variables

| Variable | Meaning |
| --- | --- |
| `DEEPSEEK_API_KEY` | Credential used by the DSH headless profile. Required by `dsh_run`. |
| `DSH_CODEX_DSH` | Absolute path to the `dsh` launcher, overriding auto-detection. |
| `DSH_CODEX_DEFAULT_CWD` | Workspace used when a tool call omits `cwd`. |
| `DSH_HOME` | DSH home directory (default `~/.dsh`). |

## Security and permissions

- Everything is local: the bridge talks to Codex over stdio, spawns a local CLI, and
  reads local session files. It never sends repository data anywhere itself.
- `dsh_run` gives DSH a real workspace and its own tools. DSH's sandbox and approval
  policy apply to what it does; the bridge does not loosen them. Review DSH's settings
  before delegating to an untrusted directory.
- The API key stays in the environment Codex passes to the MCP server; it is not copied,
  logged, or persisted by the bridge.
- Session reads are read-only. A live DSH session may be a few seconds behind.

## Limitations

- One-shot runs cannot answer interactive approval prompts. DSH must be configured to
  work without them (its headless defaults are non-interactive).
- The desktop app's account login is not shared with the headless CLI; `dsh_run` needs
  an API key.
- Tools are available only when DSH is installed on the same machine as Codex.
- Verified on Windows 11 with DSH `0.2.1-rc.2` and Codex `0.163.0-alpha.10.2`; macOS and
  Linux use the same CLI contract and bundled-app layouts.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `DeepSeek Harness CLI was not found` | Install DSH, add `dsh` to `PATH`, or set `DSH_CODEX_DSH` to the launcher path. `dsh_doctor` prints what was detected. |
| `MISSING_CREDENTIAL` | Set `DEEPSEEK_API_KEY` in the environment Codex starts from, then restart Codex. |
| Sessions are unreadable | Node is older than 22.15. Upgrade Node, or ignore the session tools. |
| Tools never appear | `codex plugin list`, then start a new session. For manual setup, `codex mcp list`. |
| Runs time out | Raise `timeout_seconds` (max 3600) or narrow the task. |

## Development

```bash
npm test          # protocol, launcher, and session tests (node:test)
npm run smoke     # start the server like Codex does and call dsh_doctor/dsh_sessions
node scripts/validate.mjs   # manifests, paths, and assets
```

Layout:

```
.agents/plugins/marketplace.json   Codex marketplace
.claude-plugin/marketplace.json    Claude Code-compatible mirror
plugins/dsh-bridge/
  .codex-plugin/plugin.json        plugin manifest
  .mcp.json                        MCP server registration
  server/                          MCP server (mcp, dsh, sessions, tools)
  skills/dsh/SKILL.md              delegation guidance for Codex
```

The test suite uses a stub launcher to exercise the real spawn path — including Windows
`.cmd` quoting and stdin prompt delivery — so it runs without DSH or an API key. The
end-to-end path was additionally verified against a local streaming mock of the DeepSeek
Messages API; see `test/fixtures/stub-dsh.mjs` for the event contract.

## License

MIT — see [LICENSE](LICENSE).
