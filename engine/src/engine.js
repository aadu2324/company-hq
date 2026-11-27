import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadCatalog, resolveClaude, processOptions } from './config.js';
import { loadOrg } from './org.js';
import { PLAN_SCHEMA, VERDICT_SCHEMA, BOARD_SCHEMA, validatePlan, readyTasks, blockedTasks, isTerminal } from './plan.js';
import { acquireSlot, releaseSlot } from './slots.js';
import { runClaude } from './claude.js';
import { isAgentTool } from './stream.js';
import * as P from './prompts.js';
import { openRun, updateTask } from './runstore.js';
import { exportRunToObsidian } from './obsidian.js';

const READ_ONLY = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StopError extends Error {
  constructor() { super('stopped by owner'); this.code = 'stopped'; }
}

/** Claude's usage limit stopped a process: the run pauses with its work kept, instead of failing. */
class LimitError extends Error {
  constructor(resets) {
    super(`Paused by the Claude usage limit${resets ? `, which resets ${resets}` : ''}.`);
    this.code = 'limit';
    this.resets = resets || '';
  }
}

/** Codes that end the whole run (every sibling task is cancelled) rather than one task. */
const RUN_ENDING = new Set(['stopped', 'auth', 'limit']);

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
async function claudeInSlot(ctx, { label, taskId, isManager = false, ...opts }) {
  const { config, store } = ctx;
  let waited = false;
  const slot = await acquireSlot({
    maxProcesses: config.maxProcesses, minFreeMemMB: config.minFreeMemMB,
    starvationGraceSec: config.starvationGraceSec, pollMs: config.pollMs, label,
    meta: { project: String(ctx.org.project?.name || path.basename(ctx.projectPath)), runId: ctx.runId, taskId: taskId || null },
    // A run-ending error elsewhere (usage limit, auth, stop) aborts the run: stop waiting for a slot too,
    // or a sibling queued behind another project could hold the run open for a long time.
    isStopped: () => stopped(ctx) || ctx.abort.signal.aborted,
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
    // Keep an interrupted manager's conversation (never a reviewer's) so `hq resume` continues it, whether
    // this process hit the limit itself or was cut short because a sibling did.
    if ((res.limited || res.aborted) && isManager && taskId && res.sessionId) {
      updateTask(store, taskId, { sessionId: res.sessionId });
    }
    if (res.limited) throw new LimitError(res.resets);
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
    label: 'CEO · plan', ...processOptions(config, 'ceo'), prompt: P.ceoPrompt({ org, catalog, request, maxTasks: config.maxTasks }),
    schema: PLAN_SCHEMA, disallowedTools: READ_ONLY, permissionMode: 'default',
  });
  if (!res.ok || !res.structured) throw new Error(`CEO planning failed: ${res.error || 'no plan returned'}`);
  const { ok, errors, tasks } = validatePlan(res.structured, org, catalog, { maxReviewers: config.maxReviewers, maxTasks: config.maxTasks });
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
    label: `Review · ${task.id}`, taskId: task.id, ...processOptions(config, 'reviewer'),
    prompt: P.reviewTask({ task, deliverablePath: task.deliverablePath }),
    systemPromptFile: store.promptFile(`review-${task.id}`, P.reviewSystem({ catalog, task, mode: config.reviewMode })),
    schema: VERDICT_SCHEMA, permissionMode: 'default',
    // A single-pass reviewer reads the work once itself: no reviewer subagents waking it up again and again.
    disallowedTools: config.reviewMode === 'single' ? [...READ_ONLY, 'Agent', 'Task'] : READ_ONLY,
  });
  if (!res.ok || !res.structured?.verdict) return { verdict: 'revise', summary: `Review did not complete: ${res.error || 'no verdict'}`, issues: [] };
  return res.structured;
}

/** The reviewer's verdict as the manager's revision brief. */
function revisionFeedback(verdict) {
  const issues = Array.isArray(verdict?.issues) ? verdict.issues : [];
  return [verdict?.summary || '', ...issues.map((i) => (typeof i === 'string' ? i : JSON.stringify(i)))].join('\n- ');
}

/** Manager executes, panel reviews, manager revises — up to policies.reviewRounds revisions. */
async function runTask(ctx, task) {
  const { org, catalog, config, store } = ctx;
  const dept = org.departments.find((d) => d.id === task.department);
  const rounds = Math.min(org.policies?.reviewRounds ?? 2, config.reviewRounds ?? 2);
  const depFiles = task.dependsOn.map((d) => store.deliverable(d));
  const systemPromptFile = store.promptFile(`manager-${task.id}`, P.managerSystem({ org, catalog, dept, maxWorkers: config.maxWorkers }));
  // A resumed task picks its manager's conversation back up instead of starting over, in the round it was
  // in, with the review feedback that round was answering (task.round is the round in progress).
  let sessionId = task.sessionId || null;
  const startRound = sessionId ? Math.min(Number(task.round) || 0, rounds) : 0;
  let feedback = startRound > 0 && task.verdict?.verdict === 'revise' ? revisionFeedback(task.verdict) : null;
  for (let round = startRound; round <= rounds; round += 1) {
    if (stopped(ctx)) throw new StopError();
    updateTask(store, task.id, { status: round ? 'revising' : 'running', round });
    const res = await claudeInSlot(ctx, {
      label: `${dept.name} · ${task.id}${round ? ` r${round}` : ''}`, taskId: task.id, isManager: true, ...processOptions(config, 'manager'),
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
    feedback = revisionFeedback(verdict);
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
          if (RUN_ENDING.has(err.code)) throw err;
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
      // Run-ending (stop, auth, usage limit): kill sibling processes and wait for them before the final state write.
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
  const reportPath = path.join(store.dir, 'report.md');
  const res = await claudeInSlot(ctx, {
    label: 'Board · sign-off', ...processOptions(config, 'board'),
    prompt: P.boardPrompt({ org, state: store.state, reportPath, isLean: config.profile === 'lean' }),
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

/** Whatever happens to a run, its note in the owner's Obsidian vault (if configured) is brought up to date. */
function exportNote(projectPath, store) {
  try {
    exportRunToObsidian(projectPath, store.reload() ?? store.state);
  } catch (err) {
    store.event('obsidian.failed', { error: err.message });
  }
}

export async function runEngine(projectPath, runId) {
  const store = openRun(projectPath, runId);
  const fail = (err) => {
    const status = err.code === 'stopped' ? 'stopped' : 'failed';
    // `hq stop` already ended the run and logged it; the engine's own unwinding must not log it again.
    if (status === 'stopped' && store.reload()?.status === 'stopped') return;
    store.update((s) => ({
      ...s, status, pid: null, error: err.message, finishedAt: new Date().toISOString(),
      tasks: (s.tasks || []).map((t) => (isTerminal(t.status) ? t : { ...t, status: 'stopped' })),
    }));
    store.event('run.end', { status, error: err.message });
    exportNote(projectPath, store);
  };
  // The usage limit pauses the run: finished tasks stay approved, interrupted ones go back to
  // pending with their manager session kept, and `hq resume` carries on from there.
  const pause = (err) => {
    store.update((s) => ({
      ...s, status: 'paused', pid: null, error: err.message, resets: err.resets, pausedAt: new Date().toISOString(),
      tasks: (s.tasks || []).map((t) => (isTerminal(t.status) ? t : {
        ...t, status: 'pending', workers: (t.workers || []).map((w) => (w.status === 'working' ? { ...w, status: 'interrupted' } : w)),
      })),
    }));
    store.event('run.paused', { reason: 'usage-limit', resets: err.resets });
    exportNote(projectPath, store);
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
  const isResume = Boolean(store.state.plan && store.state.tasks?.length);
  store.update((s) => ({ ...s, pid: process.pid, startedAt: s.startedAt || new Date().toISOString() }));
  store.event(isResume ? 'run.resumed' : 'run.start', { prompt: store.state.prompt });
  try {
    if (!isResume) await planPhase(ctx, store.state.prompt);
    await executePhase(ctx);
    if (org.policies?.boardSignoff !== false) await boardPhase(ctx);
    const failed = store.state.tasks.some((t) => ['failed', 'blocked'].includes(t.status));
    store.update({ status: failed ? 'done_with_failures' : 'done', pid: null, finishedAt: new Date().toISOString() });
    store.event('run.end', { status: store.state.status });
    exportNote(projectPath, store);
  } catch (err) {
    ctx.abort.abort();
    if (err.code === 'limit') pause(err);
    else fail(err);
  }
}
