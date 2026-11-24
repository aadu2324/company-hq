export const STATUS_STYLE = Object.freeze({
  pending: { icon: '○', color: 'gray' },
  queued: { icon: '◌', color: 'gray' },
  running: { icon: '●', color: 'green' },
  revising: { icon: '↻', color: 'yellow' },
  review: { icon: '⚖', color: 'yellow' },
  approved: { icon: '✓', color: 'cyan' },
  failed: { icon: '✗', color: 'red' },
  blocked: { icon: '⊘', color: 'red' },
  stopped: { icon: '■', color: 'gray' },
  working: { icon: '●', color: 'green' },
  idle: { icon: ' ', color: undefined },
});

export function styleFor(status) {
  return STATUS_STYLE[status] || { icon: '·', color: undefined };
}

const RUN_ACTIVE = new Set(['queued', 'planning', 'executing', 'board']);

export function isRunActive(run) {
  return RUN_ACTIVE.has(run?.status);
}

function clock(ts) {
  return ts ? String(ts).slice(11, 16) : '     ';
}

/** One human-readable line per engine or interactive event. */
export function formatEvent(ev) {
  const t = clock(ev.ts);
  const who = ev.source === 'interactive' ? `[chat ${String(ev.session || '').slice(0, 4)}] ` : '';
  switch (ev.type) {
    case 'run.start': return `${t} ▶ run started`;
    case 'plan.ready': return `${t} CEO planned ${ev.tasks} task(s): ${ev.goal}${ev.questions ? ` (${ev.questions} question(s) for you)` : ''}`;
    case 'process.start': return `${t} ⚙ ${ev.label}`;
    case 'process.end': return `${t} ${ev.ok ? '■' : '✗'} ${ev.label}${ev.error ? ` — ${ev.error}` : ''}`;
    case 'slot.wait': return `${t} … ${ev.label} waiting for a slot (${ev.live} running, ${ev.freeMB} MB free)`;
    case 'slot.lowmem': return `${t} ! low memory (${ev.freeMB} MB) — started anyway so work cannot stall`;
    case 'worker.start': return `${t} ${who}→ ${ev.agent}: ${ev.description || ''}`;
    case 'worker.done': return `${t} ${who}${ev.status === 'failed' ? '✗' : '✓'} ${ev.agent}`;
    case 'review.verdict': return `${t} ⚖ ${ev.taskId} ${ev.verdict}${ev.score != null ? ` (${ev.score}/10)` : ''}: ${ev.summary || ''}`;
    case 'task.approved': return `${t} ✓ ${ev.taskId} approved`;
    case 'task.failed': return `${t} ✗ ${ev.taskId} failed: ${ev.error || ''}`;
    case 'task.blocked': return `${t} ⊘ ${ev.taskId} blocked by a failed dependency`;
    case 'board.decision': return `${t} 🏛 Board: ${ev.decision} — ${ev.summary || ''}`;
    case 'run.end': return `${t} ■ run ${ev.status}${ev.error ? `: ${ev.error}` : ''}`;
    default: return `${t} ${ev.type}`;
  }
}

const RECENT_MS = 30 * 60 * 1000;

/**
 * Which agents and departments are busy right now, from the selected run's state plus
 * interactive-session hook events (start without a matching done in the last 30 minutes).
 */
export function liveActivity(run, interactiveEvents, now = Date.now()) {
  const agents = new Map();
  const depts = new Map();
  const bump = (agent) => agents.set(agent, (agents.get(agent) || 0) + 1);
  if (isRunActive(run)) {
    for (const t of run.tasks || []) {
      if (['running', 'revising', 'review', 'queued'].includes(t.status)) depts.set(t.department, t.status);
      for (const w of t.workers || []) if (w.status === 'working') bump(w.agent);
    }
  }
  const open = new Map();
  for (const ev of interactiveEvents) {
    if (now - Date.parse(ev.ts) > RECENT_MS) continue;
    if (ev.type === 'worker.start') open.set(ev.toolUseId, ev.agent);
    if (ev.type === 'worker.done') open.delete(ev.toolUseId);
  }
  for (const agent of open.values()) bump(agent);
  return { agents, depts };
}

export function truncate(text, width) {
  const s = String(text ?? '');
  if (width <= 1) return '';
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}
