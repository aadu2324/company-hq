// Runs the real engine against a fake claude CLI. The engine spawns its binary directly
// (no shell), so `spawn('FAKE', …)` is redirected to `node fake-claude.mjs …` here.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const [project, runId, fakeScript] = process.argv.slice(2);
const realSpawn = cp.spawn;
cp.spawn = (bin, args, opts) => (bin === 'FAKE' ? realSpawn(process.execPath, [fakeScript, ...args], opts) : realSpawn(bin, args, opts));
syncBuiltinESMExports();

process.env.HQ_CLAUDE_BIN = 'FAKE';
process.env.HQ_CONFIG_JSON = JSON.stringify({ minFreeMemMB: 0, maxProcesses: 4, pollMs: 20 });
const { runEngine } = await import('../src/engine.js');
await runEngine(project, runId);
