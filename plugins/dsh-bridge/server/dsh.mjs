/**
 * Locating and driving the DeepSeek Harness (`dsh`) CLI.
 *
 * The bridge intentionally uses the public one-shot CLI:
 *
 *   dsh headless --json [--session-id <id>] -
 *
 * The task text is written to stdin, so prompts containing quotes, newlines or
 * non-ASCII text never travel through a command line. `--json` turns the run
 * into newline-delimited events, which gives us the session id, the final
 * message, and structured turn errors.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const IS_WINDOWS = process.platform === 'win32';
const MAX_EVENTS = 2_000;
const MAX_STDERR_CHARS = 256_000;
const MAX_FINAL_CHARS = 1_000_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const NO_LAUNCHER_HELP = [
  'DeepSeek Harness CLI was not found.',
  '',
  'The bridge looks for, in order:',
  '  1. the DSH_CODEX_DSH environment variable (absolute path to the dsh launcher)',
  '  2. `dsh` on PATH',
  '  3. the CLI bundled with the DeepSeek Harness desktop app',
  '',
  'Install DeepSeek Harness, put its CLI on PATH, or point DSH_CODEX_DSH at the launcher.',
].join('\n');

const CREDENTIAL_HELP = [
  'DSH could not authenticate against the DeepSeek API for its headless profile.',
  '',
  'The headless profile does not reuse the desktop app login. Give it an API key by',
  'exporting DEEPSEEK_API_KEY in the environment Codex starts from, then restart Codex.',
  '',
  '  Windows (PowerShell):  setx DEEPSEEK_API_KEY "sk-..."',
  '  macOS / Linux:         export DEEPSEEK_API_KEY="sk-..."',
  '',
  'Alternatively run `dsh web`, open Models, and store the key there, then run',
  '`dsh headless "hi"` once to confirm it works outside Codex.',
].join('\n');

export function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || homedir(), '.dsh');
}

export function isBatchFile(file) {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(file);
}

function quoteForCmd(value) {
  if (value === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Build the argv used to start the launcher. Batch launchers must go through
 * cmd.exe; everything else is spawned directly.
 */
export function buildLaunch(launcherPath, args) {
  if (isBatchFile(launcherPath)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const inner = [quoteForCmd(launcherPath), ...args.map(quoteForCmd)].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: launcherPath, args, windowsVerbatimArguments: false };
}

function pathDirectories() {
  return (process.env.PATH || process.env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
}

function windowsExtensions() {
  return (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
}

function findOnPath() {
  const names = IS_WINDOWS ? ['dsh', 'dsh-cli'] : ['dsh'];
  for (const directory of pathDirectories()) {
    for (const name of names) {
      if (IS_WINDOWS) {
        for (const extension of windowsExtensions()) {
          const candidate = path.join(directory, `${name}${extension}`);
          if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
      } else {
        const candidate = path.join(directory, name);
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
    }
  }
  return null;
}

function appBundledCandidates() {
  const candidates = [];
  const add = (base) => {
    if (!base) return;
    candidates.push(
      path.join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', IS_WINDOWS ? 'dsh.cmd' : 'dsh'),
      path.join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
      path.join(base, 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
      path.join(base, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
    );
  };

  if (IS_WINDOWS) {
    add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'));
    add(process.env.ProgramFiles);
    add(process.env['ProgramFiles(x86)']);
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
    );
  } else {
    candidates.push(
      '/opt/deepseek-harness/resources/runtime/cli/bin/dsh',
      '/usr/lib/deepseek-harness/resources/runtime/cli/bin/dsh',
      path.join(homedir(), '.local', 'share', 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
      '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
    );
  }

  // Catch installs under a versioned or localised directory name.
  const scanRoots = [];
  if (IS_WINDOWS && process.env.LOCALAPPDATA) scanRoots.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
  if (process.platform === 'darwin') scanRoots.push('/Applications');
  if (scanRoots.length > 0) {
    for (const root of scanRoots) {
      try {
        for (const entry of readdirSync(root)) {
          if (/deepseek.*harness/i.test(entry)) {
            add(path.join(root, entry, '..'));
          }
        }
      } catch {
        // Best effort only.
      }
    }
  }
  return candidates;
}

let cachedLauncher;

/**
 * @returns {{path: string, source: 'env'|'path'|'desktop'} | null}
 */
export function findLauncher({ refresh = false } = {}) {
  if (!refresh && cachedLauncher !== undefined) return cachedLauncher;

  const explicit = process.env.DSH_CODEX_DSH;
  if (explicit && existsSync(explicit)) {
    cachedLauncher = { path: explicit, source: 'env' };
    return cachedLauncher;
  }
  const onPath = findOnPath();
  if (onPath) {
    cachedLauncher = { path: onPath, source: 'path' };
    return cachedLauncher;
  }
  for (const candidate of appBundledCandidates()) {
    if (candidate && existsSync(candidate)) {
      cachedLauncher = { path: candidate, source: 'desktop' };
      return cachedLauncher;
    }
  }
  cachedLauncher = null;
  return null;
}

export function invalidateLauncherCache() {
  cachedLauncher = undefined;
}

function spawnLauncher(launcherPath, args, options) {
  const launch = buildLaunch(launcherPath, args);
  return spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WINDOWS && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Fall through to child.kill().
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  const escalation = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, 3_000);
  escalation.unref();
}

function appendCapped(buffer, chunk, cap) {
  const next = buffer + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Run one DSH headless task.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} options.cwd
 * @param {string} [options.sessionId]
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string>} [options.env]
 */
export async function runHeadless({
  prompt,
  cwd,
  sessionId,
  timeoutMs = 900_000,
  env: extraEnv = {},
}) {
  const launcher = findLauncher();
  if (!launcher) {
    return { ok: false, kind: 'no-launcher', message: NO_LAUNCHER_HELP };
  }
  if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, kind: 'bad-session-id', message: `Invalid DSH session id: ${sessionId}` };
  }

  const args = ['headless', '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');

  const startedAt = Date.now();
  const events = [];
  let session = null;
  let finalText = null;
  let turnError = null;
  let stderr = '';
  let timedOut = false;
  let spawnError = null;

  let child;
  try {
    child = spawnLauncher(launcher.path, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
    });
  } catch (error) {
    return { ok: false, kind: 'spawn-error', message: `Could not start DSH: ${error.message}`, launcher, cwd };
  }

  const completed = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  child.stdout.setEncoding('utf8');
  const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let parsedEvents = 0;
  stdoutLines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    parsedEvents += 1;
    if (events.length < MAX_EVENTS) events.push(event);
    if (event.type === 'session' && event.sessionId) session = event;
    if (event.type === 'final' && typeof event.text === 'string') finalText = event.text;
    if (event.type === 'status' && event.phase === 'turn_end' && event.reason && event.reason.kind === 'error') {
      turnError = event.reason.error || { message: 'DSH reported an unspecified turn error' };
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = appendCapped(stderr, chunk, MAX_STDERR_CHARS);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, Math.max(5_000, Math.min(timeoutMs, 3_600_000)));

  child.stdin.on('error', () => {
    // The CLI may exit before consuming stdin; the close handler reports why.
  });
  child.stdin.end(prompt, 'utf8');

  const { code, signal } = await completed;
  clearTimeout(timer);
  stdoutLines.close();

  const durationMs = Date.now() - startedAt;
  const text = (finalText || '').slice(0, MAX_FINAL_CHARS);
  const ok = !timedOut && !spawnError && code === 0 && !turnError;

  return {
    ok,
    kind: ok ? 'ok' : spawnError ? 'spawn-error' : timedOut ? 'timeout' : turnError ? 'turn-error' : 'exit-error',
    launcher: launcher.path,
    launcherSource: launcher.source,
    cwd,
    sessionId: (session && session.sessionId) || sessionId || null,
    text,
    turnError,
    stderr: stderr.trim(),
    events: events.length,
    parsedEvents,
    code,
    signal,
    timedOut,
    spawnError: spawnError ? spawnError.message : null,
    durationMs,
  };
}

/** Read the launcher's reported version, or a diagnostic string. */
export async function probeLauncher(launcher = findLauncher()) {
  if (!launcher) return { ok: false, message: 'launcher not found' };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnLauncher(launcher.path, ['--version'], {
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (error) {
      resolve({ ok: false, message: error.message });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ ok: false, message: 'version probe timed out' });
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      resolve({
        ok: code === 0 && Boolean(version),
        version,
        code,
        message: code === 0 ? '' : err.trim() || `exited with code ${code}`,
      });
    });
  });
}

/** Turn a failed run into a message a model (and a human) can act on. */
export function explainFailure(result) {
  if (!result) return 'DSH run failed without a result.';
  if (result.kind === 'no-launcher') return NO_LAUNCHER_HELP;
  if (result.kind === 'bad-session-id') return result.message;
  if (result.kind === 'spawn-error') {
    return [`Could not start DSH at ${result.launcher ? result.launcher.path : '(unknown)'}.`, result.spawnError || result.message || '']
      .filter(Boolean)
      .join('\n');
  }

  const diagnostic = [result.stderr, result.turnError && result.turnError.message, result.turnError && result.turnError.code]
    .filter(Boolean)
    .join('\n');
  if (/MISSING_CREDENTIAL|no API key/i.test(diagnostic)) {
    return `${CREDENTIAL_HELP}\n\n--- DSH output ---\n${diagnostic}`;
  }
  if (result.timedOut) {
    return [
      `DSH run timed out after ${Math.round(result.durationMs / 1000)}s and was terminated.`,
      `Session: ${result.sessionId || '(not created)'}`,
      diagnostic ? `--- DSH output ---\n${diagnostic}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `DSH run failed (exit code ${result.code === null ? 'unknown' : result.code}${result.signal ? `, signal ${result.signal}` : ''}).`,
    `Session: ${result.sessionId || '(not created)'}`,
    diagnostic ? `--- DSH output ---\n${diagnostic}` : 'No diagnostics were written.',
  ].join('\n');
}

export const helpText = {
  noLauncher: NO_LAUNCHER_HELP,
  credentials: CREDENTIAL_HELP,
};
