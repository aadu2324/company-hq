/**
 * Optional Obsidian integration: every run becomes a note in the owner's vault, with a per-project
 * index and an HQ dashboard, all wiki-linked so runs sit next to the project's own notes in the graph.
 *
 * Off unless ~/.claude/company/config.json has { "obsidian": { "vault": "<vault folder>" } }.
 * "folder" (default "HQ") is where inside the vault the notes go. The vault itself is never created:
 * a missing vault folder turns the export off. Notes are regenerated from the run's state each time,
 * so they carry a header saying edits are overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { loadOrg } from './org.js';
import { listRuns } from './runstore.js';
import { isUsageLimit, limitResetText } from './stream.js';

const GENERATED = '<!-- written by company-hq: this note is regenerated from the run, so edits here are replaced -->';
const MAX_NAME = 60;

/** Where notes go, or null when the integration is off or the vault is missing. */
export function obsidianDir(config = loadConfig()) {
  const vault = config.obsidian?.vault;
  if (!vault || !fs.existsSync(vault)) return null;
  const folder = String(config.obsidian.folder || 'HQ').replace(/^[\\/]+|[\\/]+$/g, '');
  const dir = path.resolve(vault, folder);
  // A folder setting may not leave the vault. A prefix check would let "../Vault2" through; relative() does not.
  const inside = path.relative(path.resolve(vault), dir);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return dir;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A file and link name Obsidian and every OS accept. Names that would mean something to the file
 * system ("." or "..", Windows' CON, NUL, COM1 …) are prefixed so they stay ordinary names.
 */
export function safeName(text, max = MAX_NAME) {
  const clean = String(text || '').replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = (clean.length > max ? clean.slice(0, max).trim() : clean).replace(/[. ]+$/, '');
  if (!cut) return '';
  return /^\.+$/.test(cut) || WINDOWS_RESERVED.test(cut) ? `_${cut}` : cut;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * The project's name in the vault: its folder name, the way vaults usually name project notes
 * ("MICA" for .../MICA), so [[MICA]] links to the note that already exists. The org's display name
 * ("MICA (Doc MICA)") is only used as a label.
 */
export function projectName(projectPath, org) {
  return safeName(path.basename(projectPath)) || safeName(org?.project?.name) || 'Project';
}

/**
 * The note's name for a run: "2026-11-24 1407 continue working (2966)". Stable, so re-exports overwrite
 * it; the run id's last part keeps two runs started in the same minute with the same words apart.
 */
export function runNoteName(state) {
  const when = stamp(state.createdAt || state.startedAt) || state.id;
  const words = safeName(String(state.prompt || '').split('\n')[0], 40) || 'run';
  const tag = safeName(String(state.id || '').split('-').pop(), 8);
  return safeName(`${when} ${words}${tag ? ` (${tag})` : ''}`, 90);
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
const yaml = (s) => JSON.stringify(String(s ?? ''));
const list = (title, items) => (items?.length ? `\n### ${title}\n${items.map((i) => `- ${cell(i)}`).join('\n')}\n` : '');

function callout(state, resets) {
  switch (state.status) {
    case 'paused': return `> [!warning] Paused by the Claude usage limit${resets ? `, which resets ${resets}` : ''}\n> Finished tasks are kept. Carry on with \`/hq resume\` in a session for this project.`;
    case 'done': return `> [!success] Done${state.board ? `. The Board said **${state.board.decision}**.` : '.'}`;
    case 'done_with_failures': return resets
      ? `> [!warning] Stopped short by the Claude usage limit (resets ${resets})\n> Finished tasks are kept. Carry on with \`/hq resume\`.`
      : '> [!warning] Finished with problems\n> Some tasks failed or were blocked. `/hq resume` runs them again and keeps what was approved.';
    case 'failed': return `> [!failure] Failed: ${cell(state.error) || 'see the run log'}`;
    case 'stopped': return '> [!info] Stopped by the owner. `/hq resume` carries on from here.';
    default: return `> [!info] In progress: ${state.status}`;
  }
}

/** The run as a Markdown note with frontmatter. */
export function renderRunNote(state, { project, deptNames = new Map(), runDir = '' }) {
  const tasks = state.tasks || [];
  const approved = tasks.filter((t) => t.status === 'approved').length;
  const failed = tasks.filter((t) => ['failed', 'blocked'].includes(t.status)).length;
  const limitText = [state.error, ...tasks.map((t) => t.error)].find((t) => isUsageLimit(t)) || '';
  const resets = state.resets || limitResetText(limitText);
  const tag = safeName(project).toLowerCase().replace(/\s+/g, '-');
  const title = safeName(String(state.prompt || '').split('\n')[0], 120) || state.id;
  const rows = tasks.map((t) => {
    const v = t.verdict ? `${t.verdict.verdict}${t.verdict.score != null ? ` ${t.verdict.score}/10` : ''}${t.unresolvedReview ? ' (unresolved)' : ''}` : '';
    return `| ${cell(t.id)} | ${cell(t.title)} | ${cell(deptNames.get(t.department) || t.department)} | ${cell(t.status)} | ${cell(v)} |`;
  });
  const problems = tasks.filter((t) => t.error || t.unresolvedReview || ['revise', 'reject'].includes(t.verdict?.verdict))
    .map((t) => `- **${cell(t.title)}**: ${cell(t.error || t.verdict?.summary || 'approved with review issues still open')}`);
  const board = state.board;
  const report = runDir ? path.join(runDir, 'report.md') : '';
  const link = (p) => `file:///${p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/ /g, '%20')}`;
  return `---
type: hq-run
project: ${yaml(project)}
run_id: ${yaml(state.id)}
status: ${state.status}
started: ${yaml(stamp(state.startedAt || state.createdAt))}
finished: ${yaml(stamp(state.finishedAt || state.pausedAt || ''))}
cost_usd: ${Number(state.cost || 0).toFixed(2)}
tasks: ${tasks.length}
approved: ${approved}
failed: ${failed}
board: ${yaml(board?.decision || '')}
resets: ${yaml(resets)}
resumes: ${state.resumes || 0}
tags: [hq, hq-run, ${tag}]
---
${GENERATED}

# ${title}

Project: [[${project}]] · Runs: [[${project} HQ]] · Run \`${state.id}\`

${callout(state, resets)}

**Tasks approved:** ${approved} of ${tasks.length} · **Cost:** $${Number(state.cost || 0).toFixed(2)}

## Request
${String(state.prompt || '').trim()}
${state.plan ? `\n## Plan\n**Goal:** ${cell(state.plan.goal)}\n${state.plan.doneMeans ? `\n**Done means:** ${cell(state.plan.doneMeans)}\n` : ''}${list('Open questions', state.plan.questions)}` : ''}
${rows.length ? `\n## Tasks\n| Id | Task | Department | Status | Review |\n|---|---|---|---|---|\n${rows.join('\n')}\n` : ''}${problems.length ? `\n### Needs attention\n${problems.join('\n')}\n` : ''}${board ? `\n## Board\n**${board.decision}**: ${cell(board.summary)}\n${list('Strengths', board.strengths)}${list('Concerns', board.concerns)}${list('Follow-ups', board.followUps)}` : ''}
${report && fs.existsSync(report) ? `\n## Files\n- [Board report](${link(report)})\n- [Deliverables](${link(path.join(runDir, 'deliverables'))})\n` : ''}`;
}

const STATUS_ICON = { done: '✅', done_with_failures: '⚠️', paused: '⏸️', failed: '❌', stopped: '⏹️' };

function renderIndex(project, runs) {
  const rows = runs.map(({ state, note }) => {
    const tasks = state.tasks || [];
    const ok = tasks.filter((t) => t.status === 'approved').length;
    return `| ${STATUS_ICON[state.status] || '▶️'} | [[${note}]] | ${cell(state.status)} | ${ok}/${tasks.length} | $${Number(state.cost || 0).toFixed(2)} |`;
  });
  const total = runs.reduce((sum, r) => sum + Number(r.state.cost || 0), 0);
  return `---
type: hq-project
project: ${yaml(project)}
runs: ${runs.length}
cost_usd: ${total.toFixed(2)}
tags: [hq, hq-project]
---
${GENERATED}

# ${project} HQ

Company runs for [[${project}]], newest first. Total cost $${total.toFixed(2)}.

| | Run | Status | Tasks approved | Cost |
|---|---|---|---|---|
${rows.join('\n')}
`;
}

function renderDashboard(dir) {
  const projects = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return `---
type: hq-dashboard
tags: [hq]
---
${GENERATED}

# HQ

Every project's company runs. Each project page lists its runs; each run links back to the project note.

${projects.map((p) => `- [[${p} HQ]]`).join('\n')}
`;
}

/** Writes (or rewrites) one run's note, its project's index and the dashboard. Returns the note path or null. */
export function exportRunToObsidian(projectPath, state, config = loadConfig()) {
  const dir = obsidianDir(config);
  if (!dir || !state?.id) return null;
  const org = loadOrg(projectPath);
  const project = projectName(projectPath, org);
  const projectDir = path.join(dir, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const deptNames = new Map((org?.departments || []).map((d) => [d.id, d.name]));
  const runDir = path.join(projectPath, '.company', 'runs', state.id);
  const file = path.join(projectDir, `${runNoteName(state)}.md`);
  fs.writeFileSync(file, renderRunNote(state, { project, deptNames, runDir }));
  const runs = listRuns(projectPath, 500)
    .map((s) => ({ state: s.id === state.id ? state : s, note: runNoteName(s.id === state.id ? state : s) }))
    .filter((r) => fs.existsSync(path.join(projectDir, `${r.note}.md`)));
  fs.writeFileSync(path.join(projectDir, `${project} HQ.md`), renderIndex(project, runs));
  fs.writeFileSync(path.join(dir, 'HQ.md'), renderDashboard(dir));
  return file;
}

/** Exports every run of a project (newest first). Returns how many notes were written. */
export function backfillObsidian(projectPath, config = loadConfig()) {
  if (!obsidianDir(config)) return 0;
  let written = 0;
  for (const state of listRuns(projectPath, 500).reverse()) {
    if (exportRunToObsidian(projectPath, state, config)) written += 1;
  }
  return written;
}
