import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { companyDir } from './config.js';
import { ensureDir, readJson, writeJsonAtomic, appendJsonl, readJsonlTail } from './fsutil.js';

export function runsDir(projectPath) {
  return path.join(companyDir(projectPath), 'runs');
}

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** A run id is one plain folder name: no separators or dots, so it cannot leave the runs folder. */
export const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A handle over one run's files. All state changes go through update() and are persisted. */
export function openRun(projectPath, runId) {
  if (!RUN_ID.test(String(runId))) throw new Error(`invalid run id "${runId}"`);
  const dir = path.join(runsDir(projectPath), runId);
  const stateFile = path.join(dir, 'state.json');
  const eventsFile = path.join(dir, 'events.jsonl');
  ensureDir(path.join(dir, 'deliverables'));
  ensureDir(path.join(dir, 'logs'));
  let state = readJson(stateFile);
  return {
    dir,
    get state() { return state; },
    deliverable: (taskId) => path.join(dir, 'deliverables', `${taskId}.md`),
    logFile: (name) => path.join(dir, 'logs', `${name}.jsonl`),
    promptFile: (name, text) => {
      const f = path.join(dir, 'logs', `${name}.prompt.md`);
      fs.writeFileSync(f, text);
      return f;
    },
    init(initial) {
      state = { ...initial, updatedAt: new Date().toISOString() };
      writeJsonAtomic(stateFile, state);
      return state;
    },
    update(patch) {
      // stopRequested is written by another process (hq stop); never let a cached copy drop it.
      const fresh = readJson(stateFile, state) || state;
      const base = { ...state, stopRequested: Boolean(fresh?.stopRequested || state?.stopRequested) };
      const next = typeof patch === 'function' ? patch(base) : { ...base, ...patch };
      state = { ...next, updatedAt: new Date().toISOString() };
      writeJsonAtomic(stateFile, state);
      return state;
    },
    reload() {
      state = readJson(stateFile, state);
      return state;
    },
    event(type, data = {}) {
      appendJsonl(eventsFile, { ts: new Date().toISOString(), type, ...data });
    },
  };
}

export function updateTask(store, taskId, patch) {
  return store.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
  }));
}

export function listRuns(projectPath, limit = 20) {
  const dir = runsDir(projectPath);
  let names = [];
  try { names = fs.readdirSync(dir).sort().reverse().slice(0, limit); } catch { return []; }
  return names.map((n) => readJson(path.join(dir, n, 'state.json'))).filter(Boolean);
}

export function readRunEvents(projectPath, runId, limit = 200) {
  return readJsonlTail(path.join(runsDir(projectPath), runId, 'events.jsonl'), limit);
}

export function readInteractiveEvents(projectPath, limit = 100) {
  return readJsonlTail(path.join(companyDir(projectPath), 'events.jsonl'), limit);
}
