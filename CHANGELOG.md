# Changelog

## 0.1.0 — 2026-10-19

First release.

- Codex plugin (`dsh-bridge`) and marketplace (`dsh-codex`).
- MCP server over stdio with five tools: `dsh_run`, `dsh_resume`, `dsh_sessions`,
  `dsh_session_read`, `dsh_doctor`.
- DSH CLI discovery: `DSH_CODEX_DSH`, `PATH`, and the DeepSeek Harness desktop app on
  Windows, macOS, and Linux.
- Headless runs driven through `dsh headless --json -`, with prompts on stdin and
  structured turn errors.
- Read-only access to DSH v4 zstd session logs.
- Skill with delegation and prompt-writing guidance for Codex.
- Tests for the MCP protocol, launcher/quoting, and session storage.
