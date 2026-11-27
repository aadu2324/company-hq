/**
 * Picking a run back up after the usage limit (or a failure, or a stop) without redoing its work.
 * Approved tasks stay approved and the plan is kept, so the CEO does not plan again. A task the
 * usage limit interrupted keeps its manager's session and continues that conversation; any other
 * unfinished task starts fresh.
 */
import { isUsageLimit } from './stream.js';

export const RESUMABLE = new Set(['paused', 'failed', 'stopped', 'done_with_failures']);

function resetTask(t) {
  if (t.status === 'approved') return t;
  const keepSession = t.status === 'pending' || isUsageLimit(t.error);
  return {
    ...t,
    status: 'pending',
    error: undefined,
    verdict: keepSession ? t.verdict : undefined,
    round: keepSession ? t.round || 0 : 0,
    sessionId: keepSession ? t.sessionId : undefined,
    workers: (t.workers || []).filter((w) => w.status !== 'working' && w.status !== 'interrupted'),
  };
}

/** The state a resumable run restarts from. Throws if the run cannot be resumed. */
export function prepareResume(state, now = new Date()) {
  if (!state) throw new Error('run not found');
  if (!RESUMABLE.has(state.status)) throw new Error(`run ${state.id} is ${state.status}; only a paused, failed, stopped or partly failed run can be resumed`);
  return {
    ...state,
    status: 'queued',
    tasks: (state.tasks || []).map(resetTask),
    board: undefined,
    error: undefined,
    resets: undefined,
    stopRequested: false,
    pid: null,
    finishedAt: undefined,
    resumedAt: now.toISOString(),
    resumes: (state.resumes || 0) + 1,
  };
}

/** The newest run that can be resumed, from listRuns order (newest first). */
export function latestResumable(runs) {
  return runs.find((r) => RESUMABLE.has(r.status)) || null;
}
