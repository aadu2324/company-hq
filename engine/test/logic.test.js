import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePlan, readyTasks, blockedTasks, findCycle } from '../src/plan.js';
import { validateOrg, orgRows, loadTemplate, PROJECT_TYPES } from '../src/org.js';
import { parseStreamLine, extractJson, isAuthFailure } from '../src/stream.js';
import { buildArgs } from '../src/claude.js';
import { acquireSlot, releaseSlot, liveSlots } from '../src/slots.js';
import { formatEvent, liveActivity } from '../src/tui/format.js';
import { isCandidate, normalizePath } from '../src/projects.js';
import { loadCatalog, loadRawCatalog, PLUGIN_DIR } from '../src/config.js';
import { roleCandidates } from '../src/agents.js';

const catalog = loadCatalog();
const org = loadTemplate('startup');

test('every shipped template validates against the catalog', () => {
  for (const t of PROJECT_TYPES) {
    const r = validateOrg(loadTemplate(t), catalog);
    assert.deepEqual(r.errors, [], `${t}: ${r.errors.join('; ')}`);
  }
});

test('every co-* agent the bundled catalog asks for ships in the plugin agents/ folder', () => {
  const dir = path.join(PLUGIN_DIR, 'agents');
  const wanted = Object.values(loadRawCatalog().roles).flatMap(roleCandidates).filter((a) => a.startsWith('co-'));
  assert.ok(wanted.length > 10, 'the catalog should reference the bundled co-* agents');
  for (const agent of wanted) assert.ok(fs.existsSync(path.join(dir, `${agent}.md`)), agent);
});

test('every resolved catalog role names a spawnable agent', () => {
  for (const [id, role] of Object.entries(catalog.roles)) {
    assert.equal(typeof role.agent, 'string', id);
    if (role.isFallback) assert.ok(role.charter, `${id} falls back without a charter`);
  }
});

test('validateOrg reports unknown roles and missing ceo', () => {
  const bad = { executives: [{ id: 'x' }], departments: [{ id: 'd', name: 'D', workers: ['nope'], reviewers: [] }] };
  const r = validateOrg(bad, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ceo')));
  assert.ok(r.errors.some((e) => e.includes('nope')));
  assert.ok(r.errors.some((e) => e.includes('reviewer')));
});

test('orgRows nests departments under their executive', () => {
  const rows = orgRows(org, catalog);
  const cmo = rows.findIndex((r) => r.key === 'exec:cmo');
  const outreach = rows.findIndex((r) => r.key === 'dept:outreach');
  assert.ok(cmo > 0 && outreach > cmo);
  assert.ok(rows[outreach].depth > rows[cmo].depth);
});

test('validatePlan merges department reviewers, drops bad deps and unknown reviewers', () => {
  const plan = { tasks: [
    { id: 'T1', department: 'engineering', title: 'api', brief: 'b', reviewers: ['legal', 'bogus'] },
    { id: 'T2', department: 'outreach', title: 'emails', brief: 'b', dependsOn: ['T1', 'T9'] },
  ] };
  const r = validatePlan(plan, org, catalog);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.deepEqual(r.tasks[0].reviewers, ['legal', 'code-reviewer', 'security-reviewer']);
  assert.deepEqual(r.tasks[1].dependsOn, ['T1']);
});

test('the lean caps keep the CEO-picked reviewers first and limit tasks', () => {
  const plan = { tasks: [
    { id: 'T1', department: 'engineering', title: 'api', brief: 'b', reviewers: ['legal'] },
    { id: 'T2', department: 'engineering', title: 'tests', brief: 'b' },
    { id: 'T3', department: 'outreach', title: 'emails', brief: 'b' },
  ] };
  const lean = validatePlan(plan, org, catalog, { maxReviewers: 2, maxTasks: 2 });
  assert.equal(lean.ok, true, lean.errors.join(';'));
  assert.deepEqual(lean.tasks.map((t) => t.id), ['T1', 'T2']);
  assert.deepEqual(lean.tasks[0].reviewers, ['legal', 'code-reviewer']);
  const full = validatePlan(plan, org, catalog);
  assert.equal(full.tasks.length, 3);
  assert.equal(full.tasks[0].reviewers.length, 3);
});

test('validatePlan rejects unknown departments and cycles', () => {
  const r1 = validatePlan({ tasks: [{ id: 'A', department: 'nowhere', title: 'x', brief: 'x' }] }, org, catalog);
  assert.equal(r1.ok, false);
  const r2 = validatePlan({ tasks: [
    { id: 'A', department: 'product', title: 'a', brief: 'a', dependsOn: ['B'] },
    { id: 'B', department: 'product', title: 'b', brief: 'b', dependsOn: ['A'] },
  ] }, org, catalog);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('cycle')));
});

test('findCycle returns null for a DAG', () => {
  assert.equal(findCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }]), null);
});

test('readyTasks waits for approved deps; blockedTasks catches failed deps', () => {
  const tasks = [
    { id: 'a', status: 'approved', dependsOn: [] },
    { id: 'b', status: 'pending', dependsOn: ['a'] },
    { id: 'c', status: 'failed', dependsOn: [] },
    { id: 'd', status: 'pending', dependsOn: ['c'] },
    { id: 'e', status: 'pending', dependsOn: ['b'] },
  ];
  assert.deepEqual(readyTasks(tasks).map((t) => t.id), ['b']);
  assert.deepEqual(blockedTasks(tasks).map((t) => t.id), ['d']);
});

test('parseStreamLine handles init, tool use, tool result and result', () => {
  assert.deepEqual(parseStreamLine('{"type":"system","subtype":"init","session_id":"s1"}')[0].sessionId, 's1');
  const tool = parseStreamLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'co-copywriter' } }] } }))[0];
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.input.subagent_type, 'co-copywriter');
  const res = parseStreamLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }))[0];
  assert.equal(res.isError, true);
  const fin = parseStreamLine('{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"hi","total_cost_usd":0.5,"structured_output":{"a":1}}')[0];
  assert.equal(fin.ok, true);
  assert.deepEqual(fin.structured, { a: 1 });
  assert.deepEqual(parseStreamLine('not json'), []);
});

test('extractJson finds fenced and bare objects; auth failure detection', () => {
  assert.deepEqual(extractJson('here ```json\n{"x":1}\n``` done'), { x: 1 });
  assert.deepEqual(extractJson('plan: {"y":2} end'), { y: 2 });
  assert.equal(extractJson('nothing'), null);
  assert.equal(isAuthFailure('Failed to authenticate: OAuth session expired'), true);
  assert.equal(isAuthFailure('all good'), false);
});

test('buildArgs includes schema, resume and system prompt file', () => {
  const a = buildArgs({ model: 'sonnet', schema: { type: 'object' }, resume: 'abc', systemPromptFile: 'f.md', disallowedTools: ['Edit', 'Write'] });
  assert.ok(a.includes('--json-schema') && a.includes('{"type":"object"}'));
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2), ['--resume', 'abc']);
  assert.ok(a.includes('--append-system-prompt-file'));
  assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Edit,Write');
});

test('acquireSlot enforces the process cap and memory floor, waives floor when starving', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqslots-'));
  const base = { maxProcesses: 1, minFreeMemMB: 1000, pollMs: 10, dir };
  const s1 = await acquireSlot({ ...base, memFn: () => 5000 });
  assert.equal(liveSlots(dir).length, 1);
  let second = null;
  const p = acquireSlot({ ...base, memFn: () => 5000 }).then((s) => { second = s; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(second, null, 'cap of 1 must block the second slot');
  releaseSlot(s1);
  await p;
  assert.ok(second);
  releaseSlot(second);
  const low = await acquireSlot({ ...base, memFn: () => 100, starvationGraceSec: 0.05 });
  assert.equal(low.lowMemory, true, 'starvation guard grants a slot when nothing is running');
  releaseSlot(low);
  await assert.rejects(acquireSlot({ ...base, memFn: () => 100, starvationGraceSec: 999, isStopped: () => true }), /stopped/);
});

test('liveActivity counts working agents and open interactive spawns', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  const run = { status: 'executing', tasks: [{ department: 'web', status: 'running', workers: [{ agent: 'co-copywriter', status: 'working' }, { agent: 'x', status: 'done' }] }] };
  const inter = [
    { ts: '2026-11-23T09:59:00Z', type: 'worker.start', toolUseId: 'a', agent: 'ecc:planner' },
    { ts: '2026-11-23T09:59:00Z', type: 'worker.start', toolUseId: 'b', agent: 'ecc:planner' },
    { ts: '2026-11-23T09:59:30Z', type: 'worker.done', toolUseId: 'b', agent: 'ecc:planner' },
    { ts: '2026-11-23T08:00:00Z', type: 'worker.start', toolUseId: 'old', agent: 'stale' },
  ];
  const a = liveActivity(run, inter, now);
  assert.equal(a.agents.get('co-copywriter'), 1);
  assert.equal(a.agents.get('ecc:planner'), 1);
  assert.equal(a.agents.has('stale'), false);
  assert.equal(a.depts.get('web'), 'running');
  assert.match(formatEvent({ ts: '2026-11-23T10:00:00Z', type: 'review.verdict', taskId: 'T1', verdict: 'approve', score: 8 }), /T1 approve \(8\/10\)/);
});

test('project discovery excludes home, drive roots and scratch workspaces', () => {
  assert.equal(isCandidate(os.homedir()), false);
  assert.equal(isCandidate('C:/'), false);
  assert.equal(isCandidate('C:/Users/x/AppData/Local/Claude-Data/scratch-workspaces/a'), false);
  assert.equal(isCandidate('C:/Users/x/Research Projects/demo'), true);
  assert.equal(normalizePath('c:/a/b/'), 'C:\\a\\b');
});
