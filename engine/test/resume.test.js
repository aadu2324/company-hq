import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareResume, latestResumable, answerCheckpoint } from '../src/resume.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqresume-'));
  fs.mkdirSync(path.join(dir, '.company'));
  fs.copyFileSync(path.join(here, '..', 'templates', 'startup.json'), path.join(dir, '.company', 'org.json'));
  return dir;
}

function runFake(proj, runId, stateDir, env = {}) {
  const shim = path.join(stateDir, 'fake-claude.mjs');
  fs.copyFileSync(path.join(here, 'fake-claude.mjs'), shim);
  execFileSync(process.execPath, [path.join(here, 'run-engine-with-fake.mjs'), proj, runId, shim], {
    env: { ...process.env, FAKE_STATE_DIR: stateDir, ...env }, stdio: 'pipe', timeout: 60000,
  });
  return JSON.parse(fs.readFileSync(path.join(proj, '.company', 'runs', runId, 'state.json'), 'utf8'));
}

const calls = (stateDir) => fs.readFileSync(path.join(stateDir, 'calls.log'), 'utf8').split('\n').filter(Boolean);

test('the usage limit pauses a run with its work kept, and resume finishes it without redoing anything', () => {
  const proj = project();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  const runId = 'limit-run';
  const runDir = path.join(proj, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project: proj, prompt: 'launch it', status: 'queued', tasks: [], cost: 0, createdAt: new Date().toISOString() }));

  // First attempt: T2's manager hits the limit.
  const paused = runFake(proj, runId, stateDir, { FAKE_LIMIT_TASK: 'T2' });
  assert.equal(paused.status, 'paused', paused.error);
  assert.equal(paused.resets, '4:20pm (America/Chicago)');
  assert.deepEqual(paused.tasks.map((t) => t.status), ['approved', 'pending']);
  assert.ok(paused.tasks[1].sessionId, 'the interrupted manager session is kept');
  assert.equal(paused.board, undefined, 'the Board does not sit on a paused run');
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"run.paused"/);
  assert.doesNotMatch(events, /"task.failed"/);
  const before = calls(stateDir);

  // Resume: plan kept, T1 not redone, T2 continues its manager session, then the Board signs off.
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(prepareResume(state)));
  const done = runFake(proj, runId, stateDir);
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(done.tasks.map((t) => t.status), ['approved', 'approved']);
  assert.equal(done.resumes, 1);
  const after = calls(stateDir).slice(before.length);
  assert.ok(!after.includes('ceo'), `no re-planning: ${after}`);
  assert.ok(!after.some((c) => c.startsWith('manager:T1')), `T1 is not redone: ${after}`);
  assert.equal(after[0], 'manager:T2:resume', `T2 continues its session: ${after}`);
  assert.ok(after.includes('board'));
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"run.resumed"/);
});

test('a limit during a revision round resumes that round with the reviewer feedback', () => {
  const proj = project();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  const runId = 'revision-run';
  const runDir = path.join(proj, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project: proj, prompt: 'launch it', status: 'queued', tasks: [], cost: 0 }));

  // T1's first review asks for a revision (the fake always does); the revision call hits the limit.
  const paused = runFake(proj, runId, stateDir, { FAKE_LIMIT_TASK: 'T1', FAKE_LIMIT_ON_REVISION: '1' });
  assert.equal(paused.status, 'paused', paused.error);
  assert.equal(paused.tasks[0].round, 1, 'paused in revision round 1');
  assert.equal(paused.tasks[0].verdict.verdict, 'revise');
  const before = calls(stateDir);

  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(prepareResume(paused)));
  const done = runFake(proj, runId, stateDir);
  assert.equal(done.status, 'done', done.error);
  const after = calls(stateDir).slice(before.length);
  assert.equal(after[0], 'manager:T1:resume:revision', `continues round 1 with the review feedback: ${after}`);
  assert.equal(after.filter((c) => c.startsWith('manager:T1')).length, 1, `T1's first attempt is not redone: ${after}`);
  assert.equal(done.tasks[0].round, 1);
});

test('a checkpoint waits for the owner, and the answer re-plans the rest without redoing anything', () => {
  const proj = project();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  const runId = 'checkpoint-run';
  const runDir = path.join(proj, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project: proj, prompt: 'find a gap and pursue it', status: 'queued', tasks: [], cost: 0 }));

  const waiting = runFake(proj, runId, stateDir, { FAKE_CHECKPOINT: '1' });
  assert.equal(waiting.status, 'awaiting_owner', waiting.error);
  assert.equal(waiting.checkpoint.question, 'Which gap should we pursue?');
  assert.equal(waiting.checkpoint.taskId, 'T1');
  assert.deepEqual(waiting.tasks.map((t) => t.status), ['approved', 'pending'], 'nothing after the checkpoint starts');
  assert.equal(waiting.board, undefined, 'the Board waits too');
  assert.throws(() => answerCheckpoint(waiting, '   '), /empty/);
  const before = calls(stateDir);

  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(answerCheckpoint(waiting, 'Pursue gap A')));
  const done = runFake(proj, runId, stateDir);
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(done.tasks.map((t) => `${t.id}:${t.status}`), ['T1:approved', 'T3:approved'], 'unstarted T2 is replaced by the re-plan');
  assert.match(done.tasks[1].brief, /Pursue gap A/);
  assert.equal(done.ownerAnswers.length, 1);
  const after = calls(stateDir).slice(before.length);
  assert.equal(after[0], 'ceo:replan');
  assert.ok(!after.includes('ceo'), 'no fresh plan');
  assert.ok(!after.some((c) => c.startsWith('manager:T1')), 'T1 is not redone');
  assert.ok(after.includes('board'));
});

test('an answer that needs no further work finishes the run instead of failing it', () => {
  const proj = project();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  const runId = 'empty-replan';
  const runDir = path.join(proj, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project: proj, prompt: 'p', status: 'queued', tasks: [], cost: 0 }));
  const waiting = runFake(proj, runId, stateDir, { FAKE_CHECKPOINT: '1' });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(answerCheckpoint(waiting, 'that is all')));
  const done = runFake(proj, runId, stateDir, { FAKE_REPLAN_EMPTY: '1' });
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.replanFrom, undefined);
});

test('a run waiting for the owner can be stopped instead of answered', async () => {
  const { stopRun } = await import('../src/launcher.js');
  const proj = project();
  const runDir = path.join(proj, '.company', 'runs', 'waiting-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: 'waiting-run', status: 'awaiting_owner', pid: null,
    checkpoint: { taskId: 'T1', question: 'Which?' }, tasks: [{ id: 'T1', status: 'approved' }, { id: 'T2', status: 'pending' }] }));
  stopRun(proj, 'waiting-run');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'stopped');
  assert.deepEqual(state.tasks.map((t) => t.status), ['approved', 'stopped']);
});

test('a run without a checkpoint never waits for the owner', () => {
  const proj = project();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  const runId = 'no-checkpoint';
  const runDir = path.join(proj, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project: proj, prompt: 'launch it', status: 'queued', tasks: [], cost: 0 }));
  const state = runFake(proj, runId, stateDir);
  assert.equal(state.status, 'done');
  assert.ok(!calls(stateDir).includes('ceo:replan'));
  assert.throws(() => answerCheckpoint(state, 'anything'), /not waiting/);
});

test('without the usage limit the same run is not paused', () => {
  const proj = project();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqfake-'));
  const runId = 'plain-run';
  const runDir = path.join(proj, '.company', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: runId, project: proj, prompt: 'launch it', status: 'queued', tasks: [], cost: 0 }));
  const state = runFake(proj, runId, stateDir);
  assert.equal(state.status, 'done');
  assert.equal(calls(stateDir).filter((c) => c === 'ceo').length, 1);
});

test('prepareResume keeps approved work, retries failures fresh, and refuses active runs', () => {
  const limit = "You've hit your 5-hour limit · resets 4:20pm (America/Chicago)";
  const state = {
    id: 'r', status: 'done_with_failures', board: { decision: 'reject' }, error: 'x', stopRequested: true,
    tasks: [
      { id: 'A', status: 'approved', sessionId: 's1', round: 1 },
      { id: 'B', status: 'failed', sessionId: 's2', round: 2, error: 'rejected by review: bad', verdict: { verdict: 'reject' } },
      { id: 'C', status: 'failed', sessionId: 's3', round: 1, error: limit },
      { id: 'D', status: 'blocked' },
    ],
  };
  const next = prepareResume(state);
  assert.equal(next.status, 'queued');
  assert.equal(next.stopRequested, false);
  assert.equal(next.board, undefined);
  assert.deepEqual(next.tasks.map((t) => t.status), ['approved', 'pending', 'pending', 'pending']);
  assert.equal(next.tasks[0].sessionId, 's1');
  assert.equal(next.tasks[1].sessionId, undefined, 'a task that failed on its merits starts fresh');
  assert.equal(next.tasks[1].round, 0);
  assert.equal(next.tasks[2].sessionId, 's3', 'a task the usage limit stopped continues its session');
  assert.throws(() => prepareResume({ ...state, status: 'executing' }), /only a paused/);
  assert.equal(latestResumable([{ id: 'n', status: 'done' }, { id: 'o', status: 'paused' }])?.id, 'o');
  assert.equal(latestResumable([{ id: 'n', status: 'done' }]), null);
});
