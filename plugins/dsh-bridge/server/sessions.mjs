/**
 * Reading the sessions DeepSeek Harness persists under `$DSH_HOME/sessions`.
 *
 * Layout (DSH 0.2.x):
 *   sessions/<encoded-workspace>/<session-id>/session.v4.jsonl.zstd
 *
 * Each session is a newline-delimited record log. The first record describes
 * the session; later records carry user/assistant messages, tool calls, and the
 * generated title. Files are zstd-compressed, so reading them needs Node 22.15+
 * (or a graceful "sessions are unavailable" answer on older runtimes).
 */

import { existsSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

import { dshHome } from './dsh.mjs';

const HEAD_BYTES = 256 * 1024;
const HEAD_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const CACHE_LIMIT = 512;

/** file path -> { mtimeMs, size, info } */
const infoCache = new Map();

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

function canInflate() {
  return typeof zstdDecompressSync === 'function';
}

async function readPrefix(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { buffer, size: stats.size };
  } finally {
    await handle.close();
  }
}

/** Inflate whatever prefix is available; a truncated frame is not an error. */
function inflatePartial(buffer, maxOutputBytes) {
  return new Promise((resolve) => {
    const inflater = createZstdDecompress();
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        inflater.destroy();
      } catch {
        // Ignore.
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    inflater.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxOutputBytes) finish();
    });
    inflater.on('end', finish);
    inflater.on('error', finish);
    inflater.end(buffer);
  });
}

function inflateAll(buffer) {
  return new Promise((resolve, reject) => {
    const inflater = createZstdDecompress();
    const chunks = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    inflater.on('data', (chunk) => chunks.push(chunk));
    inflater.on('end', () => finish());
    inflater.on('error', finish);
    inflater.end(buffer);
  });
}

export async function decodeText(file, { maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  const buffer = await readFile(file);
  const compressed = file.endsWith('.zstd');
  const text = compressed ? (canInflate() ? zstdDecompressSync(buffer).toString('utf8') : await inflateAll(buffer)) : buffer.toString('utf8');
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

export function parseRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === 'object') records.push(record);
    } catch {
      // A partially written trailing line is expected while a session is live.
    }
  }
  return records;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'image') parts.push('[image]');
    else if (item.type === 'tool_use') parts.push(`[tool_use ${item.name || ''}]`.trim());
    else if (item.type === 'reasoning') continue;
    else if (typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n').trim();
}

function firstUserText(records) {
  for (const record of records) {
    if (record.type !== 'user/message') continue;
    const text = contentText(record.data && record.data.content);
    if (text) return text;
  }
  return '';
}

function sessionTitle(records) {
  let title = '';
  for (const record of records) {
    if (record.type === 'session/title' && record.data && typeof record.data.title === 'string') {
      title = record.data.title.trim();
    }
  }
  return title;
}

function sessionHeader(records) {
  for (const record of records) {
    if (record.type === 'session') return record;
  }
  return null;
}

function toIso(value) {
  if (!value) return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function summarize(records) {
  const header = sessionHeader(records);
  const first = firstUserText(records);
  const title = sessionTitle(records) || first.split(/\r?\n/).find((line) => line.trim()) || '';
  let messages = 0;
  for (const record of records) {
    if (record.type === 'user/message' || record.type === 'assistant/message') messages += 1;
  }
  return {
    cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: header && header.createdAt ? toIso(header.createdAt) : null,
    title: title.slice(0, 120),
    messages,
  };
}

async function sessionFile(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const preferred = [
    'session.v4.jsonl.zstd',
    ...files.filter((name) => name.endsWith('.v4.jsonl.zstd')),
    'session.jsonl',
    ...files.filter((name) => name.endsWith('.jsonl')),
  ];
  for (const name of preferred) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function readInfo(file, stats) {
  const cached = infoCache.get(file);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.info;

  let info = { cwd: '', createdAt: null, title: '', messages: 0 };
  try {
    if (file.endsWith('.zstd')) {
      if (!canInflate()) throw new Error('zstd support requires Node 22.15 or newer');
      const { buffer } = await readPrefix(file, HEAD_BYTES);
      const text = await inflatePartial(buffer, HEAD_OUTPUT_BYTES);
      info = summarize(parseRecords(text));
    } else {
      const { buffer } = await readPrefix(file, HEAD_BYTES);
      info = summarize(parseRecords(buffer.toString('utf8')));
    }
  } catch (error) {
    info = { ...info, title: `(unreadable session: ${error.message})` };
  }

  if (infoCache.size >= CACHE_LIMIT) {
    const oldest = infoCache.keys().next().value;
    if (oldest) infoCache.delete(oldest);
  }
  infoCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, info });
  return info;
}

async function listSessionDirectories() {
  const root = sessionsRoot();
  let workspaceEntries;
  try {
    workspaceEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const workspace of workspaceEntries) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    let sessionEntries;
    try {
      sessionEntries = await readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessionEntries) {
      if (!session.isDirectory()) continue;
      const directory = path.join(workspacePath, session.name);
      const file = await sessionFile(directory);
      if (!file) continue;
      let stats;
      try {
        stats = await stat(file);
      } catch {
        continue;
      }
      found.push({ id: session.name, workspace: workspace.name, directory, file, stats });
    }
  }
  return found;
}

/**
 * @param {{ limit?: number, workspace?: string }} options
 */
export async function listSessions({ limit = 20, workspace = '' } = {}) {
  const directories = await listSessionDirectories();
  directories.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

  const needle = workspace.trim().toLowerCase();
  const result = [];
  let inspected = 0;
  for (const entry of directories) {
    if (inspected >= 400 && result.length >= limit) break;
    inspected += 1;
    const info = await readInfo(entry.file, entry.stats);
    if (needle) {
      const haystack = `${info.cwd} ${entry.workspace}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    result.push({
      id: entry.id,
      title: info.title || '(untitled)',
      workspace: info.cwd || `(encoded workspace: ${entry.workspace})`,
      createdAt: info.createdAt,
      updatedAt: new Date(entry.stats.mtimeMs).toISOString(),
      messages: info.messages,
      bytes: entry.stats.size,
    });
    if (result.length >= limit) break;
  }
  return result;
}

async function findSessionDirectory(id) {
  const directories = await listSessionDirectories();
  const exact = directories.find((entry) => entry.id === id);
  if (exact) return exact;
  const partial = directories.filter((entry) => entry.id.includes(id));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`Session id "${id}" is ambiguous; candidates: ${partial.slice(0, 8).map((entry) => entry.id).join(', ')}`);
  }
  return null;
}

/** Metadata for one session, without rendering the transcript. */
export async function sessionInfo(id) {
  if (!id || typeof id !== 'string') throw new Error('A DSH session id is required.');
  const entry = await findSessionDirectory(id);
  if (!entry) return null;
  const info = await readInfo(entry.file, entry.stats);
  return { id: entry.id, ...info };
}

function clock(record) {
  const time = record && record.time;
  if (!time) return '';
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').slice(0, 16);
}

function clip(text, max) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n[truncated ${trimmed.length - max} characters]`;
}

/**
 * Render one session as a readable transcript.
 *
 * @param {string} id
 * @param {{ maxMessages?: number, includeToolResults?: boolean, maxCharsPerMessage?: number }} options
 */
export async function readSession(id, { maxMessages = 60, includeToolResults = false, maxCharsPerMessage = 8_000 } = {}) {
  if (!id || typeof id !== 'string') throw new Error('A DSH session id is required.');
  const entry = await findSessionDirectory(id);
  if (!entry) throw new Error(`No DSH session found with id "${id}". Use dsh_sessions to list available sessions.`);

  const text = await decodeText(entry.file);
  const records = parseRecords(text);
  const info = summarize(records);

  const lines = [];
  lines.push(`# ${info.title || info.cwd || entry.id}`);
  lines.push('');
  lines.push(`- session: ${entry.id}`);
  if (info.cwd) lines.push(`- workspace: ${info.cwd}`);
  if (info.createdAt) lines.push(`- created: ${info.createdAt}`);
  lines.push(`- records: ${records.length}`);
  lines.push('');

  let shown = 0;
  let truncated = false;
  for (const record of records) {
    if (record.type === 'user/message') {
      if (shown >= maxMessages) {
        truncated = true;
        break;
      }
      const body = contentText(record.data && record.data.content);
      if (!body) continue;
      shown += 1;
      lines.push(`## User${clock(record) ? ` · ${clock(record)}` : ''}`);
      lines.push('');
      lines.push(clip(body, maxCharsPerMessage));
      lines.push('');
    } else if (record.type === 'assistant/message') {
      const message = record.data && record.data.message;
      const body = contentText(message && message.content);
      if (!body) continue;
      if (shown >= maxMessages) {
        truncated = true;
        break;
      }
      shown += 1;
      const meta = record.data && record.data.message && record.data.message.source;
      const who = meta && meta.model ? `DSH (${meta.model})` : 'DSH';
      lines.push(`## ${who}${clock(record) ? ` · ${clock(record)}` : ''}`);
      lines.push('');
      lines.push(clip(body, maxCharsPerMessage));
      lines.push('');
    } else if (record.type === 'tool/call' && includeToolResults) {
      const data = record.data || {};
      const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {});
      lines.push(`- tool \`${data.name || 'unknown'}\` ${clip(args, 400).replace(/\n/g, ' ')}`);
    } else if (record.type === 'tool/result' && includeToolResults) {
      const message = record.data && record.data.message;
      const body = contentText(message && message.content);
      if (body) lines.push(`  - result${message && message.isError ? ' (error)' : ''}: ${clip(body, 800).replace(/\n/g, ' ')}`);
    }
  }

  if (truncated) {
    lines.push(`_Transcript truncated at ${maxMessages} messages. Pass a larger max_messages to see more._`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function sessionsSupport() {
  return { zstd: canInflate(), root: sessionsRoot(), exists: existsSync(sessionsRoot()) };
}
