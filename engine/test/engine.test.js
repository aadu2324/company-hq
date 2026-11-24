import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const hq = path.join(here, '..', 'bin', 'hq.js');

/**
 * Full pipeline through the real engine with a fake claude binary:
 * CEO plan → T1 (revise once) → T2 after T1 → board → report.
 */
test('engine runs plan, dependent tasks, a revision round and board sign-off', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hqproj-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  fs.mkdirSync(path.join(project, '.company'));
  fs.copyFileSync(path.join(here, '..', 'templates', 'startup.json'), path.join(project, '.company', 'org.json'));

  // A .cmd shim is not spawnable without a shell, so point the engine at node + the fake script via a wrapper exe-less path:
  // the engine spawns `bin` directly, so we use node itself and prepend the script through NODE_OPTIONS-free argv trick.
  const shim = path.join(stateDir, 'fake-claude.mjs');
  fs.copyFileSync(path.join(here, 'fake-claude.mjs'), shim);
  const runId = 'test-run';
  const runDir = path.join(project, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project, prompt: 'launch it', status: 'queued', tasks: [], cost: 0 }));

  execFileSync(process.execPath, [path.join(here, 'run-engine-with-fake.mjs'), project, runId, shim], {
    env: { ...process.env, FAKE_STATE_DIR: stateDir }, stdio: 'pipe', timeout: 60000,
  });

  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'done', state.error);
  assert.deepEqual(state.tasks.map((t) => t.status), ['approved', 'approved']);
  assert.equal(state.tasks[0].round, 1, 'T1 went through one revision round');
  assert.ok(state.tasks[1].reviewers.includes('legal'));
  assert.equal(state.board.decision, 'approve_with_conditions');
  assert.match(fs.readFileSync(path.join(runDir, 'deliverables', 'T1.md'), 'utf8'), /revised/);
  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /approve_with_conditions/);
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"worker.start"/);
  assert.match(events, /"review.verdict"/);
  const order = events.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'task.approved').map((e) => e.taskId);
  assert.deepEqual(order, ['T1', 'T2'], 'T2 must wait for T1');
  assert.ok(fs.existsSync(hq));
});
