/**
 * A fake `dsh` launcher used by the tests. It reads the prompt from stdin,
 * records it, and emits the same NDJSON events the real CLI produces.
 */

import { writeFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  if (process.env.STUB_CAPTURE) writeFileSync(process.env.STUB_CAPTURE, prompt, 'utf8');
  const mode = process.env.STUB_MODE || 'ok';
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

  if (mode === 'credential') {
    process.stderr.write('dsh: MISSING_CREDENTIAL: no API key for provider route "deepseek-official"\n');
    process.exitCode = 1;
    return;
  }

  emit({ type: 'session', sessionId: 'session-stub', cwd: process.cwd() });
  emit({ type: 'status', phase: 'turn_start', turn: 1 });

  if (mode === 'error') {
    emit({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'error', error: { message: 'stub exploded', code: 'STUB_ERROR' } },
    });
    emit({ type: 'final', text: '' });
    process.stderr.write('dsh: STUB_ERROR: stub exploded\n');
    process.exitCode = 3;
    return;
  }

  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'stop' } });
  emit({ type: 'final', text: 'stub answer' });
  process.exitCode = 0;
});
