import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Redirect spawn('HANG', …) to a node script that never exits, so the abort path kills a real process.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqhang-'));
const hang = path.join(dir, 'hang.cjs');
fs.writeFileSync(hang, 'process.stdin.resume(); setInterval(() => {}, 1000);');
const realSpawn = cp.spawn;
cp.spawn = (bin, args, opts) => (bin === 'HANG' ? realSpawn(process.execPath, [hang], opts) : realSpawn(bin, args, opts));
syncBuiltinESMExports();
const { runClaude } = await import('../src/claude.js');

test('runClaude kills a hung process when the signal aborts', async () => {
  const ctl = new AbortController();
  const started = Date.now();
  const p = runClaude({ bin: 'HANG', cwd: dir, prompt: 'x', signal: ctl.signal });
  setTimeout(() => ctl.abort(), 400);
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.aborted, true);
  assert.ok(Date.now() - started < 10000);
});

test('runClaude watchdog kills a process that exceeds its timeout', async () => {
  const res = await runClaude({ bin: 'HANG', cwd: dir, prompt: 'x', timeoutMs: 400 });
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/);
});
