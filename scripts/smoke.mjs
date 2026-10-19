#!/usr/bin/env node
/**
 * End-to-end smoke test for the MCP server: start it exactly as Codex would,
 * perform the initialize handshake, list tools, and call dsh_doctor.
 *
 *   node scripts/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'plugins', 'dsh-bridge', 'server', 'main.mjs');
const pluginRoot = path.join(here, '..', 'plugins', 'dsh-bridge');

const child = spawn(process.execPath, [serverEntry], {
  cwd: pluginRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    console.error('non-JSON stdout:', trimmed);
    process.exitCode = 1;
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});

function send(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: 'dsh-bridge-smoke', version: '0.0.0' },
  });
  console.log('initialize:', JSON.stringify(init.serverInfo), 'protocol', init.protocolVersion);
  notify('notifications/initialized');

  const list = await send('tools/list', {});
  console.log('tools:', list.tools.map((tool) => tool.name).join(', '));

  const doctor = await send('tools/call', { name: 'dsh_doctor', arguments: {} });
  console.log('--- dsh_doctor ---');
  console.log(doctor.content.map((item) => item.text).join('\n'));

  const sessions = await send('tools/call', { name: 'dsh_sessions', arguments: { limit: 3 } });
  console.log('--- dsh_sessions ---');
  console.log(sessions.content.map((item) => item.text).join('\n'));

  if (doctor.isError) throw new Error('dsh_doctor returned an error result');
  if (!init.serverInfo || init.serverInfo.name !== 'dsh-bridge') throw new Error('unexpected serverInfo');
  console.log('\nSMOKE OK');
} catch (error) {
  console.error('SMOKE FAILED:', error.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
}
