#!/usr/bin/env node
/**
 * Entry point for the DSH bridge MCP server.
 *
 * Codex starts this process with `node server/main.mjs`, speaks MCP over
 * stdin/stdout, and shuts it down by closing stdin.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createMcpServer } from './mcp.mjs';
import { tools } from './tools.mjs';

const manifestUrl = new URL('../.codex-plugin/plugin.json', import.meta.url);
let manifest = { name: 'dsh-bridge', version: '0.0.0' };
try {
  manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
} catch {
  // The manifest is only used for reporting; keep the server usable without it.
}

const INSTRUCTIONS = [
  'DeepSeek Harness (DSH) bridge.',
  '',
  'DSH is a separate coding agent installed on this machine. Use `dsh_run` to hand it a self-contained task; it works in the given directory with its own tools and returns a final answer and a session id. Continue that work with `dsh_resume`, and inspect earlier work with `dsh_sessions` / `dsh_session_read`.',
  '',
  'DSH cannot see this conversation, so every prompt must carry the facts and constraints it needs. Do not delegate work that depends on unstated context. If a DSH tool fails, call `dsh_doctor` before retrying.',
].join('\n');

function rootsFromContext(ctx) {
  return async () => {
    if (!ctx.clientCapabilities || !ctx.clientCapabilities.roots) return undefined;
    try {
      const result = await ctx.request('roots/list', {}, 3_000);
      for (const root of (result && result.roots) || []) {
        if (root && typeof root.uri === 'string' && root.uri.startsWith('file:')) {
          return fileURLToPath(root.uri);
        }
      }
    } catch {
      // The client may not implement roots; callers fall back to their cwd.
    }
    return undefined;
  };
}

const wrappedTools = tools.map((tool) => ({
  definition: tool.definition,
  call: (args, ctx) => tool.call(args, { ...ctx, defaultRoot: rootsFromContext(ctx) }),
}));

const server = createMcpServer({
  name: manifest.name || 'dsh-bridge',
  version: manifest.version || '0.0.0',
  instructions: INSTRUCTIONS,
  tools: wrappedTools,
});

server.listen();
