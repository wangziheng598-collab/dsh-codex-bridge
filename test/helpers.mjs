import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const pluginRoot = path.join(here, '..', 'plugins', 'dsh-bridge');
export const serverEntry = path.join(pluginRoot, 'server', 'main.mjs');

/** Start the MCP server exactly as Codex does and return a tiny JSON-RPC client. */
export function startServer({ cwd = pluginRoot, env = {} } = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
      else waiter.resolve(message.result);
    }
  });

  const request = (method, params, timeoutMs = 60_000) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}; stderr:\n${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  };

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('close', resolve);
      child.stdin.end();
    });

  return {
    child,
    request,
    notify,
    stop,
    getStderr: () => stderr,
  };
}
