export const MAX_TASKS = 8;
export const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['goal', 'tasks'],
  properties: {
    goal: { type: 'string' },
    doneMeans: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'department', 'title', 'brief'],
        properties: {
          id: { type: 'string' },
          department: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string' },
          deliverable: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          reviewers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise', 'reject'] },
    score: { type: 'number' },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
};

export const BOARD_SCHEMA = {
  type: 'object',
  required: ['decision', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'approve_with_conditions', 'reject'] },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    followUps: { type: 'array', items: { type: 'string' } },
  },
};

/** Detects a dependency cycle among tasks; returns the id where one was found, or null. */
export function findCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'active') return id;
    state.set(id, 'active');
    for (const dep of byId.get(id)?.dependsOn || []) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    state.set(id, 'done');
    return null;
  };
  for (const t of tasks) {
    const hit = visit(t.id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Validate a CEO plan against the org and return normalised tasks.
 * Unknown reviewers are dropped; department reviewers are always included.
 */
export function validatePlan(plan, org, catalog) {
  const errors = [];
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return { ok: false, errors: ['plan has no tasks'], tasks: [] };
  }
  const depts = new Map((org.departments || []).map((d) => [d.id, d]));
  const raw = plan.tasks.slice(0, MAX_TASKS);
  const ids = new Set();
  for (const t of raw) {
    if (!t.id || ids.has(t.id)) errors.push(`missing or duplicate task id "${t.id}"`);
    // Ids become file names; reject anything that could escape the run directory.
    if (t.id && !TASK_ID.test(t.id)) errors.push(`task id "${t.id}" must match ${TASK_ID}`);
    ids.add(t.id);
    if (!depts.has(t.department)) errors.push(`task ${t.id}: unknown department "${t.department}"`);
  }
  const tasks = raw.map((t) => {
    const dept = depts.get(t.department);
    const reviewers = [...new Set([...(dept?.reviewers || []).map(String), ...(t.reviewers || [])])]
      .filter((r) => typeof r === 'string' && catalog.roles[r]);
    return {
      id: String(t.id),
      department: t.department,
      title: String(t.title || t.id),
      brief: String(t.brief || ''),
      deliverable: String(t.deliverable || ''),
      dependsOn: (t.dependsOn || []).filter((d) => ids.has(d) && d !== t.id),
      reviewers,
    };
  });
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`dependency cycle through task ${cycle}`);
  return { ok: errors.length === 0, errors, tasks };
}

const TERMINAL = new Set(['approved', 'failed', 'blocked', 'stopped']);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

/** Tasks whose dependencies are all approved and that have not started. */
export function readyTasks(tasks) {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks.filter((t) => t.status === 'pending' && t.dependsOn.every((d) => status.get(d) === 'approved'));
}

/** Pending tasks that can never run because a dependency failed or was blocked. */
export function blockedTasks(tasks) {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks.filter((t) => t.status === 'pending'
    && t.dependsOn.some((d) => ['failed', 'blocked', 'stopped'].includes(status.get(d))));
}
