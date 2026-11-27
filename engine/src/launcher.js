import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { companyDir } from './config.js';
import { ensureDir } from './fsutil.js';
import { newRunId, openRun, listRuns } from './runstore.js';
import { prepareResume, latestResumable } from './resume.js';
import { exportRunToObsidian } from './obsidian.js';
import { isPidAlive } from './slots.js';
import { killTree } from './claude.js';

const HQ_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hq.js');

/** Start a node child of bin/hq.js that survives the TUI closing. */
function spawnDetached(args, logFile) {
  ensureDir(path.dirname(logFile));
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [HQ_BIN, ...args], {
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  child.on('error', (err) => fs.appendFileSync(logFile, `spawn failed: ${err.message}\n`));
  child.unref();
  fs.closeSync(out);
  if (!child.pid) throw new Error('could not start the HQ engine process');
  return child.pid;
}

export function startRun(projectPath, prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is empty');
  if (!fs.existsSync(path.join(companyDir(projectPath), 'org.json'))) {
    throw new Error(`No team yet for this project. Press i (or run: hq init "${projectPath}").`);
  }
  const runId = newRunId();
  const store = openRun(projectPath, runId);
  store.init({ id: runId, project: projectPath, prompt: text, status: 'queued', tasks: [], cost: 0, createdAt: new Date().toISOString() });
  const pid = spawnDetached(['_engine', projectPath, runId], path.join(store.dir, 'engine.log'));
  store.update({ pid });
  return runId;
}

export function startInit(projectPath, type) {
  const args = ['init', projectPath, ...(type ? ['--type', type] : [])];
  return spawnDetached(args, path.join(companyDir(projectPath), 'init.log'));
}

/**
 * Carry on a paused, failed, stopped or partly failed run: approved work and the plan are kept,
 * the rest runs again. With no runId, the newest resumable run of the project. Returns the run id.
 */
export function resumeRun(projectPath, runId) {
  const id = runId || latestResumable(listRuns(projectPath, 50))?.id;
  if (!id) throw new Error('No paused or unfinished run to resume in this project.');
  const store = openRun(projectPath, id);
  if (store.state?.pid && isEngineProcess(store.state.pid)) throw new Error(`run ${id} is already running`);
  store.update((s) => prepareResume(s));
  const pid = spawnDetached(['_engine', projectPath, id], path.join(store.dir, 'engine.log'));
  store.update({ pid });
  store.event('run.queued', { resumed: true });
  return id;
}

const ACTIVE = new Set(['queued', 'planning', 'executing', 'board']);

/** True only if pid is a live node process, so a recycled PID never gets killed. */
function isEngineProcess(pid) {
  if (!pid || !isPidAlive(pid)) return false;
  if (process.platform === 'win32') {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' });
    return /^"node\.exe"/i.test((out.stdout || '').trim());
  }
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return /(^|\/)node$/.test((out.stdout || '').trim());
}

export function stopRun(projectPath, runId) {
  const store = openRun(projectPath, runId);
  if (!store.state || !ACTIVE.has(store.state.status)) {
    throw new Error(`run ${runId} is not active (${store.state?.status || 'missing'})`);
  }
  const state = store.update({ stopRequested: true });
  if (isEngineProcess(state.pid)) killTree(state.pid);
  store.reload();
  store.update((s) => ({
    ...s, status: 'stopped', pid: null, finishedAt: new Date().toISOString(),
    tasks: (s.tasks || []).map((t) => (['approved', 'failed', 'blocked'].includes(t.status) ? t : { ...t, status: 'stopped' })),
  }));
  store.event('run.end', { status: 'stopped' });
  try { exportRunToObsidian(projectPath, store.reload() ?? store.state); } catch { /* the note is a convenience */ }
}

/** Open an interactive Claude Code session in a new PowerShell window. */
// Fixed script: nothing user- or path-derived is interpolated. The folder comes from cwd and
// the prompt file path from an environment variable, so no quoting or injection is possible.
const INTERACTIVE_SCRIPT = 'if ($env:HQ_PROMPT_FILE) { claude (Get-Content -Raw -LiteralPath $env:HQ_PROMPT_FILE) } else { claude }';

export function openInteractive(projectPath, prompt) {
  if (process.platform !== 'win32') {
    throw new Error(`Opening a new Claude Code window works on Windows only. Run claude in ${projectPath}.`);
  }
  const env = { ...process.env };
  delete env.HQ_RUN_ID;
  delete env.HQ_PROMPT_FILE;
  if (prompt?.trim()) {
    const file = path.join(ensureDir(path.join(companyDir(projectPath), 'tmp')), `prompt-${Date.now()}.txt`);
    fs.writeFileSync(file, prompt);
    env.HQ_PROMPT_FILE = file;
  }
  // detached on Windows gives the console app its own new window.
  const child = spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command', INTERACTIVE_SCRIPT], {
    cwd: projectPath, env, detached: true, stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}
