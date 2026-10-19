/**
 * Tool definitions and handlers exposed to Codex.
 *
 * Every handler returns either a string (rendered as MCP text content) or a
 * full MCP tool result. Expected failures throw ToolError, which the server
 * turns into an `isError` result instead of a transport error.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  dshHome,
  explainFailure,
  findLauncher,
  probeLauncher,
  runHeadless,
} from './dsh.mjs';
import { listSessions, readSession, sessionInfo, sessionsSupport } from './sessions.mjs';

class ToolError extends Error {}

function requirePrompt(value, name = 'prompt') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`\`${name}\` must be a non-empty string.`);
  }
  if (value.length > 200_000) {
    throw new ToolError(`\`${name}\` is ${value.length} characters; the limit is 200000.`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ToolError(`\`${name}\` must be a string.`);
  return value;
}

function timeoutMs(value, fallbackSeconds = 900) {
  if (value === undefined || value === null) return fallbackSeconds * 1000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ToolError('`timeout_seconds` must be a positive number.');
  return Math.round(Math.min(Math.max(seconds, 10), 3_600) * 1000);
}

function integer(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ToolError(`\`${name}\` must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

async function resolveCwd(args, ctx) {
  const explicit = optionalString(args.cwd, 'cwd');
  if (explicit) {
    const resolved = path.resolve(explicit);
    assertDirectory(resolved);
    return resolved;
  }
  const configured = optionalString(process.env.DSH_CODEX_DEFAULT_CWD, 'DSH_CODEX_DEFAULT_CWD');
  if (configured) {
    const resolved = path.resolve(configured);
    assertDirectory(resolved);
    return resolved;
  }
  if (ctx && typeof ctx.defaultRoot === 'function') {
    try {
      const root = await ctx.defaultRoot();
      if (root && existsSync(root) && statSync(root).isDirectory()) return root;
    } catch {
      // Roots are advisory; fall through to the working directory.
    }
  }
  return process.cwd();
}

function assertDirectory(directory) {
  let stats;
  try {
    stats = statSync(directory);
  } catch {
    throw new ToolError(`Workspace directory does not exist: ${directory}`);
  }
  if (!stats.isDirectory()) throw new ToolError(`Workspace path is not a directory: ${directory}`);
}

function formatDuration(ms) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function renderRun(result, { resumed }) {
  const header = [
    `DSH ${resumed ? 'continued' : 'finished'} in ${formatDuration(result.durationMs)}.`,
    result.sessionId ? `Session: ${result.sessionId}` : null,
    `Workspace: ${result.cwd}`,
    resumed ? null : `Resume with: dsh_resume(session_id="${result.sessionId || '…'}", prompt="…")`,
  ]
    .filter(Boolean)
    .join('\n');
  const body = result.text && result.text.trim() ? result.text.trim() : '(DSH produced no final message.)';
  return `${header}\n\n--- DSH answer ---\n${body}`;
}

const runTool = {
  definition: {
    name: 'dsh_run',
    title: 'Run a task in DeepSeek Harness',
    description:
      'Delegate a self-contained task to DeepSeek Harness (DSH), a separate agent that can read and write files and run commands inside `cwd`. This call blocks until DSH finishes and returns its final answer plus a session id. DSH cannot see this conversation, so include every fact and constraint it needs in `prompt`. Requires the `dsh` CLI (or the DSH desktop app) and a DeepSeek API key in the environment (see dsh_doctor).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete task for DSH, written as if handing it to a new engineer.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute path to the workspace DSH should work in. Defaults to the Codex workspace root.',
        },
        timeout_seconds: {
          type: 'integer',
          minimum: 10,
          maximum: 3600,
          default: 900,
          description: 'Abort the DSH run after this many seconds.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async call(args, ctx) {
    const prompt = requirePrompt(args.prompt);
    const cwd = await resolveCwd(args, ctx);
    const result = await runHeadless({ prompt, cwd, timeoutMs: timeoutMs(args.timeout_seconds) });
    if (!result.ok) throw new ToolError(explainFailure(result));
    return renderRun(result, { resumed: false });
  },
};

const resumeTool = {
  definition: {
    name: 'dsh_resume',
    title: 'Continue a DeepSeek Harness session',
    description:
      'Continue an existing DeepSeek Harness session with a follow-up prompt. The session keeps its earlier context, so this is the right way to iterate on work dsh_run started. Returns the new final answer.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id returned by dsh_run, or one listed by dsh_sessions.',
        },
        prompt: { type: 'string', description: 'The follow-up instruction for DSH.' },
        cwd: {
          type: 'string',
          description: 'Absolute workspace path. Defaults to the session’s original workspace.',
        },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 3600, default: 900 },
      },
      required: ['session_id', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async call(args, ctx) {
    const sessionId = optionalString(args.session_id, 'session_id');
    if (!sessionId) throw new ToolError('`session_id` is required.');
    const prompt = requirePrompt(args.prompt);

    let cwd = optionalString(args.cwd, 'cwd');
    if (cwd) {
      cwd = path.resolve(cwd);
      assertDirectory(cwd);
    } else {
      const info = await sessionInfo(sessionId).catch(() => null);
      cwd = (info && info.cwd) || (await resolveCwd({}, ctx));
    }

    const result = await runHeadless({
      prompt,
      cwd,
      sessionId,
      timeoutMs: timeoutMs(args.timeout_seconds),
    });
    if (!result.ok) throw new ToolError(explainFailure(result));
    return renderRun(result, { resumed: true });
  },
};

const sessionsTool = {
  definition: {
    name: 'dsh_sessions',
    title: 'List DSH sessions',
    description:
      'List recent DeepSeek Harness sessions stored on this machine, newest first, with their ids, titles, workspaces and message counts. Use it to find a session to read with dsh_session_read or to resume with dsh_resume.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        workspace: {
          type: 'string',
          description: 'Only return sessions whose workspace path contains this text (case-insensitive).',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args) {
    const limit = integer(args.limit, 'limit', 20, 1, 100);
    const workspace = optionalString(args.workspace, 'workspace') || '';
    const sessions = await listSessions({ limit, workspace });
    if (sessions.length === 0) {
      return workspace
        ? `No DSH sessions found for workspace filter "${workspace}".`
        : 'No DSH sessions found yet. Sessions appear here after DSH runs in any workspace.';
    }
    const lines = [`Recent DSH sessions (${sessions.length}):`, ''];
    sessions.forEach((session, index) => {
      lines.push(`${index + 1}. ${session.id}`);
      lines.push(`   title: ${session.title}`);
      lines.push(`   workspace: ${session.workspace || '(unknown)'}`);
      lines.push(`   updated: ${session.updatedAt.replace('T', ' ').slice(0, 16)} · ${session.messages} messages`);
    });
    return lines.join('\n');
  },
};

const sessionReadTool = {
  definition: {
    name: 'dsh_session_read',
    title: 'Read a DSH session transcript',
    description:
      'Read the conversation stored for one DeepSeek Harness session, rendered as a readable transcript. Use it to review what DSH did, recover results, or decide whether to resume the session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from dsh_run or dsh_sessions.' },
        max_messages: { type: 'integer', minimum: 1, maximum: 500, default: 60 },
        include_tool_results: {
          type: 'boolean',
          default: false,
          description: 'Include tool calls and their results in the transcript.',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args) {
    const sessionId = optionalString(args.session_id, 'session_id');
    if (!sessionId) throw new ToolError('`session_id` is required.');
    const maxMessages = integer(args.max_messages, 'max_messages', 60, 1, 500);
    return readSession(sessionId, {
      maxMessages,
      includeToolResults: args.include_tool_results === true,
    });
  },
};

const doctorTool = {
  definition: {
    name: 'dsh_doctor',
    title: 'Check the DSH bridge setup',
    description:
      'Diagnose the DeepSeek Harness connection: which dsh launcher is used, its version and profile, where sessions live, and whether the API key needed by dsh_run is present. Run this first when a DSH tool fails.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call() {
    const launcher = findLauncher();
    const probe = launcher ? await probeLauncher(launcher) : null;
    const support = sessionsSupport();
    const profiles = [];
    try {
      for (const entry of readdirSync(path.join(dshHome(), 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) profiles.push(entry.name);
      }
    } catch {
      // No profiles directory yet.
    }
    const sessionCount = await listSessions({ limit: 100 })
      .then((sessions) => sessions.length)
      .catch(() => 0);

    const lines = ['DSH bridge doctor', ''];
    if (launcher) {
      lines.push(`launcher: ${launcher.path}`);
      lines.push(`launcher source: ${launcher.source}`);
      lines.push(`dsh version: ${probe && probe.ok ? probe.version : `unavailable (${(probe && probe.message) || 'probe failed'})`}`);
    } else {
      lines.push('launcher: NOT FOUND');
      lines.push('  Install DeepSeek Harness, add dsh to PATH, or set DSH_CODEX_DSH to the launcher path.');
    }
    lines.push(`DSH_HOME: ${dshHome()}`);
    lines.push(`profiles: ${profiles.length > 0 ? profiles.join(', ') : '(none yet)'}`);
    lines.push(`DEEPSEEK_API_KEY: ${process.env.DEEPSEEK_API_KEY ? 'set' : 'NOT SET (dsh_run will fail until it is exported)'}`);
    lines.push(`sessions: ${support.exists ? `${sessionCount} listed` : 'no sessions directory yet'} (${support.root})`);
    lines.push(`zstd session support: ${support.zstd ? 'yes' : 'no — Node 22.15+ is required to read sessions'}`);
    lines.push(`node: ${process.version} (${process.platform}/${process.arch})`);
    return lines.join('\n');
  },
};

export const tools = [runTool, resumeTool, sessionsTool, sessionReadTool, doctorTool];
