---
name: dsh
description: Delegate a task to DeepSeek Harness (DSH) with dsh_run, continue an existing DSH session with dsh_resume, or inspect DSH work with dsh_sessions and dsh_session_read. Use when a self-contained job benefits from a second agent, when the user asks for DeepSeek/DSH, or when a DSH tool fails and you need dsh_doctor.
---

# Working with DeepSeek Harness

DSH is a separate coding agent installed on this machine. It has its own tools, its
own model, and its own session history — it does **not** see this conversation.

## Choosing a tool

| Situation | Tool |
| --- | --- |
| A self-contained task DSH can finish on its own | `dsh_run` |
| Iterating on work DSH already started | `dsh_resume` |
| Finding earlier DSH work | `dsh_sessions` |
| Reviewing what DSH actually did | `dsh_session_read` |
| A DSH tool failed or looks unconfigured | `dsh_doctor` |

Prefer doing the work yourself when it is small, needs this conversation's context,
or is mostly a single edit. Delegate when the task is large, independent, or the
user explicitly wants DeepSeek to handle it.

## Writing a prompt for `dsh_run`

DSH starts cold. A good prompt contains:

1. **Goal** — the outcome, in one sentence.
2. **Workspace** — the absolute path (also pass it as `cwd`).
3. **Constraints** — files to avoid, style, commands to use, what "done" means.
4. **Verification** — the check DSH should run before answering.
5. **Return format** — what you need back (summary, file list, diff, test output).

Do not say "as discussed" or "the file from earlier"; DSH never saw it. If the task
depends on context from this conversation, restate the relevant facts.

## Continuing work

`dsh_run` returns a session id. Reuse it with `dsh_resume` instead of starting over —
the session keeps DSH's earlier context, including its tool results. Pass the same
`cwd` unless you deliberately want DSH to work somewhere else.

## Reviewing results

`dsh_session_read` renders the stored transcript. Set `include_tool_results` when you
need evidence of what ran (commands, outputs, errors), not just the prose answer.

## When something fails

Run `dsh_doctor` first. The two common causes are:

- **No launcher** — DSH is not installed, not on `PATH`, and the desktop app was not
  found. Set `DSH_CODEX_DSH` to the launcher path.
- **MISSING_CREDENTIAL** — the headless profile has no DeepSeek API key. Export
  `DEEPSEEK_API_KEY` before starting Codex. The desktop app's account login is not
  shared with the headless CLI.

Report the failure and the doctor output to the user instead of retrying the same call.
