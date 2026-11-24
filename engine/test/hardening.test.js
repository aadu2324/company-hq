import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePlan } from '../src/plan.js';
import { loadTemplate } from '../src/org.js';
import { loadCatalog } from '../src/config.js';
import { openRun } from '../src/runstore.js';
import { stopRun } from '../src/launcher.js';

const catalog = loadCatalog();

test('a run id that could leave the runs folder is refused, a plain one is accepted', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hqrunid-'));
  for (const bad of ['../escape', '..', 'a/b', 'a\\b', '', 'x'.repeat(65)]) {
    assert.throws(() => openRun(project, bad), /invalid run id/, JSON.stringify(bad));
  }
  assert.ok(fs.existsSync(openRun(project, '20261123-101500-ab12').dir));
  assert.ok(!fs.existsSync(path.join(project, '.company', 'escape')));
});

test('an inline role from org.json always runs as general-purpose with clipped text', async () => {
  const { resolveRole } = await import('../src/org.js');
  const role = resolveRole({ id: 'x', title: 'T'.repeat(200), agent: 'evil:agent', charter: 'C'.repeat(5000) }, catalog);
  assert.equal(role.agent, 'general-purpose');
  assert.equal(role.title.length, 80);
  assert.equal(role.charter.length, 600);
});

test('task ids that could escape the run directory are rejected', () => {
  const org = loadTemplate('software');
  for (const id of ['../x', 'a/b', 'a\\b', 'x'.repeat(41)]) {
    const r = validatePlan({ tasks: [{ id, department: 'product', title: 't', brief: 'b' }] }, org, catalog);
    assert.equal(r.ok, false, id);
  }
});

test('an object patch keeps a stopRequested written by another process', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hqstop-'));
  const engine = openRun(project, 'r1');
  engine.init({ id: 'r1', status: 'executing', tasks: [] });
  const other = openRun(project, 'r1');
  other.update({ stopRequested: true });
  const s = engine.update({ status: 'board' });
  assert.equal(s.stopRequested, true);
});

test('stopRun refuses runs that are not active and never kills anything', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hqstop-'));
  const store = openRun(project, 'r2');
  store.init({ id: 'r2', status: 'done', pid: process.pid, tasks: [] });
  assert.throws(() => stopRun(project, 'r2'), /not active/);
  assert.equal(openRun(project, 'r2').state.status, 'done');
});
