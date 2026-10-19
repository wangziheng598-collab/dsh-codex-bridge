import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { listSessions, parseRecords, readSession, sessionsSupport } from '../plugins/dsh-bridge/server/sessions.mjs';

const originalHome = process.env.DSH_HOME;

function writeSession(root, workspace, id, records, { compress = true } = {}) {
  const directory = path.join(root, 'sessions', workspace, id);
  mkdirSync(directory, { recursive: true });
  const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  if (compress) {
    writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')));
  } else {
    writeFileSync(path.join(directory, 'session.jsonl'), text, 'utf8');
  }
}

const header = {
  type: 'session',
  version: 4,
  id: 'session-test-1',
  createdAt: '2026-10-19T00:00:00.000Z',
  cwd: 'C:\\work\\demo',
};
const records = [
  header,
  { type: 'user/message', seq: 1, time: 1_760_000_000_000, data: { role: 'user', content: [{ type: 'text', text: 'Fix the build' }] } },
  {
    type: 'tool/call',
    seq: 2,
    time: 1_760_000_001_000,
    data: { name: 'pwsh', arguments: '{"command":"npm test"}' },
  },
  {
    type: 'tool/result',
    seq: 3,
    time: 1_760_000_002_000,
    data: { message: { role: 'tool', isError: false, content: [{ type: 'text', text: 'all tests passed' }] } },
  },
  {
    type: 'assistant/message',
    seq: 4,
    time: 1_760_000_003_000,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'The build is fixed.' }], source: { model: 'deepseek-flash' } },
    },
  },
  { type: 'session/title', seq: 5, time: 1_760_000_004_000, data: { title: 'Build fix' } },
];

describe('session storage', () => {
  let root;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dsh-sessions-test-'));
    process.env.DSH_HOME = root;
    if (sessionsSupport().zstd) {
      writeSession(root, '--C-work-demo--', 'session-test-1', records);
      writeSession(root, '--C-work-legacy--', 'session-legacy', records, { compress: false });
    }
  });

  after(() => {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  });

  it('parses records and skips malformed lines', () => {
    const parsed = parseRecords('{"type":"a"}\nnot json\n{"type":"b"}\n');
    assert.deepEqual(parsed.map((record) => record.type), ['a', 'b']);
  });

  it('lists sessions with titles, workspaces and counts', { skip: !zstdCompressSync }, async () => {
    const sessions = await listSessions({ limit: 10 });
    const found = sessions.find((session) => session.id === 'session-test-1');
    assert.ok(found, 'finds the compressed session');
    assert.equal(found.title, 'Build fix');
    assert.equal(found.workspace, 'C:\\work\\demo');
    assert.equal(found.messages, 2);
  });

  it('reads the legacy uncompressed layout', { skip: !zstdCompressSync }, async () => {
    const text = await readSession('session-legacy');
    assert.match(text, /Fix the build/);
  });

  it('filters by workspace', { skip: !zstdCompressSync }, async () => {
    const sessions = await listSessions({ limit: 10, workspace: 'legacy' });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'session-legacy');
  });

  it('renders prose without tool noise by default', { skip: !zstdCompressSync }, async () => {
    const text = await readSession('session-test-1');
    assert.match(text, /# Build fix/);
    assert.match(text, /Fix the build/);
    assert.match(text, /The build is fixed\./);
    assert.doesNotMatch(text, /npm test/);
  });

  it('includes tool activity on request', { skip: !zstdCompressSync }, async () => {
    const text = await readSession('session-test-1', { includeToolResults: true });
    assert.match(text, /npm test/);
    assert.match(text, /all tests passed/);
  });

  it('fails with a helpful message for unknown ids', async () => {
    await assert.rejects(readSession('nope-nope'), /No DSH session found/);
  });
});
