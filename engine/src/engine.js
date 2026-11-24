import fs from 'node:fs';
import { loadConfig, loadCatalog, resolveClaude } from './config.js';
import { loadOrg } from './org.js';
import { PLAN_SCHEMA, VERDICT_SCHEMA, BOARD_SCHEMA, validatePlan, readyTasks, blockedTasks, isTerminal } from './plan.js';
import { acquireSlot, releaseSlot } from './slots.js';
import { runClaude } from './claude.js';
import { isAgentTool } from './stream.js';
import * as P from './prompts.js';
import { openRun, updateTask } from './runstore.js';

const READ_ONLY = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StopError extends Error {
  constructor() { super('stopped by owner'); this.code = 'stopped'; }
}

/** Create the context object shared by every phase of one run. */
function makeContext(projectPath, runId) {
  const config = loadConfig();
  const org = loadOrg(projectPath);
  if (!org) throw new Error(`No team yet for ${projectPath}. Run: hq init "${projectPath}"`);
  return {
    projectPath, config, org, catalog: loadCatalog(projectPath), bin: resolveClaude(config),
    store: openRun(projectPath, runId), runId, abort: new AbortController(),
  };
}

function stopped(ctx) {
  return Boolean(ctx.store.reload()?.stopRequested);
}

/** Run one Claude process inside a global RAM-aware slot, logging worker delegation. */
async function claudeInSlot(ctx, { label, taskId, ...opts }) {
  const { config, store } = ctx;
  let waited = false;
  const slot = await acquireSlot({
    maxProcesses: config.maxProcesses, minFreeMemMB: config.minFreeMemMB,
    starvationGraceSec: config.starvationGraceSec, pollMs: config.pollMs, label,
    isStopped: () => stopped(ctx),
    onWait: ({ live, freeMB }) => {
      if (!waited) store.event('slot.wait', { label, taskId, live, freeMB });
      waited = true;
    },
  });
  const workers = new Map();
  try {
    if (slot.lowMemory) store.event('slot.lowmem', { label, freeMB: slot.freeMB });
    store.event('process.start', { label, taskId });
    const res = await runClaude({
      bin: ctx.bin, cwd: ctx.projectPath, env: { HQ_RUN_ID: ctx.runId }, signal: ctx.abort.signal,
      timeoutMs: (config.processTimeoutMin || 90) * 60000,
      name: `HQ · ${label}`, logFile: store.logFile(label.replace(/[^\w.-]+/g, '_')), ...opts,
      onEvent: (ev) => {
        if (ev.kind === 'tool' && isAgentTool(ev.name) && !ev.parent) {
          const w = { id: ev.id, agent: ev.input.subagent_type || 'general-purpose', description: ev.input.description || '', status: 'working' };
          workers.set(ev.id, w);
          store.event('worker.start', { taskId, label, agent: w.agent, description: w.description });
          if (taskId) updateTask(store, taskId, (t) => ({ workers: [...(t.workers || []), w] }));
        } else if (ev.kind === 'tool_result' && workers.has(ev.id)) {
          const w = workers.get(ev.id);
          const status = ev.isError ? 'failed' : 'done';
          store.event('worker.done', { taskId, label, agent: w.agent, description: w.description, status });
          if (taskId) updateTask(store, taskId, (t) => ({ workers: (t.workers || []).map((x) => (x.id === ev.id ? { ...x, status } : x)) }));
        }
      },
    });
    store.update((s) => ({ ...s, cost: (s.cost || 0) + (res.cost || 0) }));
    store.event('process.end', { label, taskId, ok: res.ok, cost: res.cost, error: res.error || undefined });
    if (res.auth) throw Object.assign(new Error(res.error), { code: 'auth' });
    if (res.aborted) throw new StopError();
    return res;
  } finally {
    releaseSlot(slot);
  }
}

async function planPhase(ctx, request) {
  const { store, org, catalog, config } = ctx;
  store.update({ status: 'planning' });
  const res = await claudeInSlot(ctx, {
    label: 'CEO · plan', model: config.models.ceo, prompt: P.ceoPrompt({ org, catalog, request }),
    schema: PLAN_SCHEMA, disallowedTools: READ_ONLY, permissionMode: 'default',
  });
  if (!res.ok || !res.structured) throw new Error(`CEO planning failed: ${res.error || 'no plan returned'}`);
  const { ok, errors, tasks } = validatePlan(res.structured, org, catalog);
  if (!ok) throw new Error(`CEO plan invalid: ${errors.join('; ')}`);
  const plan = { goal: res.structured.goal, doneMeans: res.structured.doneMeans || '', questions: res.structured.questions || [] };
  store.update({
    plan,
    tasks: tasks.map((t) => ({ ...t, status: 'pending', round: 0, workers: [], deliverablePath: store.deliverable(t.id) })),
  });
  store.event('plan.ready', { goal: plan.goal, tasks: tasks.length, questions: plan.questions.length });
}

async function review(ctx, task) {
  const { config, catalog, store } = ctx;
  const res = await claudeInSlot(ctx, {
    label: `Review · ${task.id}`, taskId: task.id, model: config.models.reviewer,
    prompt: P.reviewTask({ task, deliverablePath: task.deliverablePath }),
    systemPromptFile: store.promptFile(`review-${task.id}`, P.reviewSystem({ catalog, task })),
    schema: VERDICT_SCHEMA, disallowedTools: READ_ONLY, permissionMode: 'default',
  });
  if (!res.ok || !res.structured?.verdict) return { verdict: 'revise', summary: `Review did not complete: ${res.error || 'no verdict'}`, issues: [] };
  return res.structured;
}

/** Manager executes, panel reviews, manager revises — up to policies.reviewRounds revisions. */
async function runTask(ctx, task) {
  const { org, catalog, config, store } = ctx;
  const dept = org.departments.find((d) => d.id === task.department);
  const rounds = org.policies?.reviewRounds ?? 2;
  const depFiles = task.dependsOn.map((d) => store.deliverable(d));
  const systemPromptFile = store.promptFile(`manager-${task.id}`, P.managerSystem({ org, catalog, dept }));
  let sessionId = null;
  let feedback = null;
  for (let round = 0; round <= rounds; round += 1) {
    if (stopped(ctx)) throw new StopError();
    updateTask(store, task.id, { status: round ? 'revising' : 'running', round });
    const res = await claudeInSlot(ctx, {
      label: `${dept.name} · ${task.id}${round ? ` r${round}` : ''}`, taskId: task.id, model: config.models.manager,
      prompt: P.managerTask({ goal: store.state.plan.goal, task, deliverablePath: task.deliverablePath, dependencyFiles: depFiles, feedback }),
      systemPromptFile, resume: sessionId, permissionMode: config.permissionMode,
    });
    sessionId = res.sessionId || sessionId;
    updateTask(store, task.id, { sessionId, summary: (res.result || '').slice(-1500) });
    if (!res.ok) {
      updateTask(store, task.id, { status: 'failed', error: res.error });
      store.event('task.failed', { taskId: task.id, error: res.error });
      return;
    }
    if (!task.reviewers.length) break;
    updateTask(store, task.id, { status: 'review' });
    const verdict = await review(ctx, { ...task, deliverablePath: task.deliverablePath });
    updateTask(store, task.id, { verdict });
    store.event('review.verdict', { taskId: task.id, verdict: verdict.verdict, score: verdict.score, summary: verdict.summary });
    if (verdict.verdict === 'approve') break;
    if (verdict.verdict === 'reject') {
      updateTask(store, task.id, { status: 'failed', error: `rejected by review: ${verdict.summary}` });
      return;
    }
    if (round === rounds) {
      updateTask(store, task.id, { unresolvedReview: true });
      break;
    }
    feedback = [verdict.summary, ...(verdict.issues || [])].join('\n- ');
  }
  updateTask(store, task.id, { status: 'approved' });
  store.event('task.approved', { taskId: task.id });
}

async function executePhase(ctx) {
  const { store, org } = ctx;
  store.update({ status: 'executing' });
  const limit = Math.max(1, org.policies?.maxParallelTasks ?? 2);
  const running = new Map();
  for (;;) {
    if (stopped(ctx)) throw new StopError();
    for (const t of blockedTasks(store.state.tasks)) {
      updateTask(store, t.id, { status: 'blocked' });
      store.event('task.blocked', { taskId: t.id });
    }
    const tasks = store.state.tasks;
    if (tasks.every((t) => isTerminal(t.status))) return;
    for (const t of readyTasks(tasks).filter((x) => !running.has(x.id)).slice(0, limit - running.size)) {
      updateTask(store, t.id, { status: 'queued' });
      const p = runTask(ctx, t)
        .catch((err) => {
          if (err.code === 'stopped' || err.code === 'auth') throw err;
          updateTask(store, t.id, { status: 'failed', error: err.message });
        })
        .finally(() => running.delete(t.id));
      p.catch(() => { /* surfaced through Promise.race below; avoid unhandled rejection for siblings */ });
      running.set(t.id, p);
    }
    if (running.size === 0) {
      // Nothing running and nothing ready: remaining tasks are unreachable.
      for (const t of store.state.tasks.filter((x) => !isTerminal(x.status))) updateTask(store, t.id, { status: 'blocked' });
      return;
    }
    try {
      await Promise.race([...running.values()]);
    } catch (err) {
      // Fatal (stop or auth): kill sibling processes and wait for them before the final state write.
      ctx.abort.abort();
      await Promise.allSettled([...running.values()]);
      throw err;
    }
    await sleep(50);
  }
}

async function boardPhase(ctx) {
  const { store, org, config } = ctx;
  store.update({ status: 'board' });
  const reportPath = `${store.dir}\\report.md`;
  const res = await claudeInSlot(ctx, {
    label: 'Board · sign-off', model: config.models.board,
    prompt: P.boardPrompt({ org, state: store.state, reportPath }),
    schema: BOARD_SCHEMA, disallowedTools: READ_ONLY, permissionMode: 'default',
  });
  const board = res.structured || { decision: 'reject', summary: `Board did not convene: ${res.error || 'no decision'}` };
  store.update({ board });
  fs.writeFileSync(reportPath, renderReport(store.state, board));
  store.event('board.decision', { decision: board.decision, summary: board.summary });
}

export function renderReport(state, board) {
  const list = (title, items) => (items?.length ? `\n## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n` : '');
  const tasks = state.tasks.map((t) => `| ${t.id} | ${t.department} | ${t.title} | ${t.status}${t.unresolvedReview ? ' ⚠' : ''} | ${t.verdict?.verdict || '-'} |`).join('\n');
  return `# Run report — ${state.id}

**Request:** ${state.prompt}

**Board decision:** ${board.decision}

${board.summary}
${list('Strengths', board.strengths)}${list('Concerns', board.concerns)}${list('Follow-ups', board.followUps)}
## Tasks
| id | dept | title | status | review |
|---|---|---|---|---|
${tasks}

Cost: $${(state.cost || 0).toFixed(2)}
`;
}

export async function runEngine(projectPath, runId) {
  const store = openRun(projectPath, runId);
  const fail = (err) => {
    const status = err.code === 'stopped' ? 'stopped' : 'failed';
    store.update((s) => ({
      ...s, status, pid: null, error: err.message, finishedAt: new Date().toISOString(),
      tasks: (s.tasks || []).map((t) => (isTerminal(t.status) ? t : { ...t, status: 'stopped' })),
    }));
    store.event('run.end', { status, error: err.message });
  };
  // Last line of defence: never leave a run stuck "executing" after a crash.
  process.on('uncaughtException', (err) => { fail(err); process.exit(1); });
  process.on('unhandledRejection', (err) => { fail(err instanceof Error ? err : new Error(String(err))); process.exit(1); });
  let ctx;
  try {
    ctx = makeContext(projectPath, runId);
  } catch (err) {
    fail(err);
    return;
  }
  const { org } = ctx;
  ctx.store = store;
  store.update({ pid: process.pid, startedAt: new Date().toISOString() });
  store.event('run.start', { prompt: store.state.prompt });
  try {
    await planPhase(ctx, store.state.prompt);
    await executePhase(ctx);
    if (org.policies?.boardSignoff !== false) await boardPhase(ctx);
    const failed = store.state.tasks.some((t) => ['failed', 'blocked'].includes(t.status));
    store.update({ status: failed ? 'done_with_failures' : 'done', pid: null, finishedAt: new Date().toISOString() });
    store.event('run.end', { status: store.state.status });
  } catch (err) {
    ctx.abort.abort();
    fail(err);
  }
}
