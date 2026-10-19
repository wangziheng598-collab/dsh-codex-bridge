import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLaunch, explainFailure, findLauncher, invalidateLauncherCache, runHeadless } from '../plugins/dsh-bridge/server/dsh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(here, 'fixtures', 'stub-dsh.mjs');
const originalLauncherEnv = process.env.DSH_CODEX_DSH;

function makeLauncher(directory) {
  if (process.platform === 'win32') {
    const file = path.join(directory, 'dsh.cmd');
    writeFileSync(file, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`, 'utf8');
    return file;
  }
  const file = path.join(directory, 'dsh');
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { encoding: 'utf8', mode: 0o755 });
  return file;
}

describe('launcher discovery and headless runs', () => {
  let directory;
  let launcher;

  before(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-test-'));
    launcher = makeLauncher(directory);
    process.env.DSH_CODEX_DSH = launcher;
    invalidateLauncherCache();
  });

  after(() => {
    if (originalLauncherEnv === undefined) delete process.env.DSH_CODEX_DSH;
    else process.env.DSH_CODEX_DSH = originalLauncherEnv;
    invalidateLauncherCache();
  });

  it('prefers DSH_CODEX_DSH', () => {
    const found = findLauncher();
    assert.equal(found.source, 'env');
    assert.equal(found.path, launcher);
  });

  it('builds a cmd.exe invocation for batch launchers', () => {
    const launch = buildLaunch('C:\\Program Files\\DeepSeek Harness\\dsh.cmd', ['headless', '--json', '-']);
    if (process.platform === 'win32') {
      assert.match(launch.command, /cmd\.exe$/i);
      assert.equal(launch.args[0], '/d');
      assert.match(launch.args[3], /headless --json -/);
    } else {
      assert.equal(launch.command, 'C:\\Program Files\\DeepSeek Harness\\dsh.cmd');
    }
  });

  it('passes the prompt through stdin and parses events', async () => {
    const capture = path.join(directory, 'capture.txt');
    const prompt = '请修复构建\n并运行测试 "quoted" & special';
    process.env.STUB_CAPTURE = capture;
    process.env.STUB_MODE = 'ok';
    const result = await runHeadless({ prompt, cwd: directory, timeoutMs: 30_000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.text, 'stub answer');
    assert.equal(result.sessionId, 'session-stub');
    assert.equal(result.code, 0);
    assert.equal(readFileSync(capture, 'utf8'), prompt);
  });

  it('reports turn errors with diagnostics', async () => {
    process.env.STUB_MODE = 'error';
    const result = await runHeadless({ prompt: 'x', cwd: directory, timeoutMs: 30_000 });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'turn-error');
    assert.equal(result.turnError.message, 'stub exploded');
    const message = explainFailure(result);
    assert.match(message, /exit code 3/);
    assert.match(message, /stub exploded/);
  });

  it('explains missing credentials', async () => {
    process.env.STUB_MODE = 'credential';
    const result = await runHeadless({ prompt: 'x', cwd: directory, timeoutMs: 30_000 });
    assert.equal(result.ok, false);
    const message = explainFailure(result);
    assert.match(message, /DEEPSEEK_API_KEY/);
    assert.match(message, /MISSING_CREDENTIAL/);
  });

  it('rejects malformed session ids before spawning', async () => {
    const result = await runHeadless({ prompt: 'x', cwd: directory, sessionId: '--help' });
    assert.equal(result.kind, 'bad-session-id');
  });
});
