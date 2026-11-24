import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import { discoverProjects } from '../projects.js';
import { loadOrg } from '../org.js';
import { loadCatalog, loadConfig } from '../config.js';
import { listRuns, readRunEvents, readInteractiveEvents } from '../runstore.js';
import { liveSlots, freeMemMB } from '../slots.js';
import { startRun, startInit, stopRun, openInteractive } from '../launcher.js';
import { styleFor, formatEvent, liveActivity, isRunActive, truncate } from './format.js';

const h = React.createElement;
const PROJECT_REFRESH_MS = 15000;
const TICK_MS = 1000;
const PANES = ['projects', 'org', 'runs', 'prompt'];

function useTick(ms) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

function Pane({ title, focused, width, height, children }) {
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'cyan' : 'gray', width, height, paddingX: 1, overflow: 'hidden' },
    h(Text, { bold: true, color: focused ? 'cyan' : undefined }, title), children);
}

function ProjectList({ projects, sel, width, rows, activeRuns }) {
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), projects.length - rows));
  return projects.slice(start, start + rows).map((p, i) => {
    const idx = start + i;
    const busy = activeRuns.get(p.path);
    const mark = p.hasCompany ? '●' : '○';
    return h(Text, { key: p.path, inverse: idx === sel, color: p.hasCompany ? undefined : 'gray', wrap: 'truncate' },
      truncate(`${mark} ${p.name}${busy ? ` ▶${busy}` : ''}`, width - 4));
  });
}

function OrgChart({ org, catalog, activity, width, rows, project, offset = 0 }) {
  if (!org) {
    return [
      h(Text, { key: 'a', color: 'yellow' }, 'No team hired for this project yet.'),
      h(Text, { key: 'b' }, `Press i to hire a ${project?.type || ''} team (org designer tailors it to the repo).`),
    ];
  }
  const lines = buildOrgLines(org, catalog, activity);
  const start = Math.max(0, Math.min(offset, lines.length - rows));
  return lines.slice(start, start + rows).map((l, i) => h(Text, { key: i, color: l.color, dimColor: l.dim, bold: l.bold, wrap: 'truncate' }, truncate(l.text, width - 4)));
}

function buildOrgLines(org, catalog, activity) {
  const out = [{ text: '🏛  Board of Directors  (chair · risk · quality)', bold: true }];
  const execs = org.executives || [];
  const walk = (exec, depth) => {
    const pad = '  '.repeat(depth);
    out.push({ text: `${pad}★ ${exec.title}`, bold: true, color: 'magenta' });
    for (const d of (org.departments || []).filter((x) => (x.reportsTo || 'ceo') === exec.id)) {
      const st = activity.depts.get(d.id);
      const s = styleFor(st || 'idle');
      out.push({ text: `${pad}  ${s.icon} ${d.name} — ${d.manager || 'Manager'}${st ? ` [${st}]` : ''}`, color: s.color || 'white', bold: Boolean(st) });
      for (const w of d.workers || []) {
        const role = typeof w === 'string' ? { id: w, ...catalog.roles[w] } : w;
        if (!role?.title) continue;
        const n = activity.agents.get(role.agent) || 0;
        out.push({ text: `${pad}      ${n ? `● ${role.title} ×${n}` : `· ${role.title}`}`, color: n ? 'green' : undefined, dim: !n });
      }
    }
    for (const c of execs.filter((e) => e.reportsTo === exec.id)) walk(c, depth + 1);
  };
  for (const root of execs.filter((e) => !e.reportsTo)) walk(root, 0);
  return out;
}

function RunPane({ runs, runSel, run, events, width, rows }) {
  const out = [];
  if (!runs.length) out.push({ text: 'No runs yet. Type a request below and press Enter.', dim: true });
  runs.slice(0, 4).forEach((r, i) => out.push({
    text: `${i === runSel ? '›' : ' '} ${r.id.slice(9, 13)} ${String(r.status).padEnd(10)} ${r.prompt}`,
    color: isRunActive(r) ? 'green' : undefined, inverse: i === runSel,
  }));
  if (run) {
    out.push({ text: '' });
    if (run.plan?.goal) out.push({ text: `Goal: ${run.plan.goal}`, bold: true });
    for (const q of run.plan?.questions || []) out.push({ text: `? ${q}`, color: 'yellow' });
    for (const t of run.tasks || []) {
      const s = styleFor(t.status);
      const workers = (t.workers || []).filter((w) => w.status === 'working').length;
      out.push({ text: `${s.icon} ${t.id} ${t.department}: ${t.title}${workers ? ` (${workers} working)` : ''}${t.round ? ` r${t.round}` : ''}`, color: s.color });
    }
    if (run.board) out.push({ text: `🏛 ${run.board.decision}: ${run.board.summary}`, color: 'magenta' });
    if (run.error) out.push({ text: `✗ ${run.error}`, color: 'red' });
    out.push({ text: `cost $${(run.cost || 0).toFixed(2)} · report: .company/runs/${run.id}/report.md`, dim: true });
    out.push({ text: '── activity ──', dim: true });
  }
  const room = Math.max(0, rows - out.length);
  events.slice(-room).forEach((e) => out.push({ text: formatEvent(e), dim: e.source === 'interactive' }));
  return out.slice(0, rows).map((l, i) => h(Text, { key: i, color: l.color, bold: l.bold, dimColor: l.dim, inverse: l.inverse, wrap: 'truncate' }, truncate(l.text, width - 4)));
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const tick = useTick(TICK_MS);
  const catalog = useMemo(() => loadCatalog(), []);
  const config = useMemo(() => loadConfig(), []);
  const [projects, setProjects] = useState(() => discoverProjects());
  const [sel, setSel] = useState(0);
  const [focus, setFocus] = useState('projects');
  const [input, setInput] = useState('');
  const [runSel, setRunSel] = useState(0);
  const [orgScroll, setOrgScroll] = useState(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const id = setInterval(() => setProjects(discoverProjects()), PROJECT_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const project = projects[Math.min(sel, projects.length - 1)];
  // Re-read files every tick; all reads are small (state.json, event tails).
  const data = useMemo(() => {
    if (!project) return { org: null, runs: [], run: null, events: [], inter: [] };
    const org = loadOrg(project.path);
    const runs = listRuns(project.path, 10);
    const run = runs[Math.min(runSel, runs.length - 1)] || null;
    const events = run ? readRunEvents(project.path, run.id, 150) : [];
    const inter = readInteractiveEvents(project.path, 100);
    return { org, runs, run, events, inter };
  }, [project?.path, runSel, tick]);
  const activeRuns = useMemo(() => {
    const m = new Map();
    for (const p of projects.filter((x) => x.hasCompany)) {
      const n = listRuns(p.path, 5).filter(isRunActive).length;
      if (n) m.set(p.path, n);
    }
    return m;
  }, [projects, Math.floor(tick / 5)]);
  const sys = useMemo(() => ({ slots: liveSlots().length, free: freeMemMB() }), [tick]);
  const activity = liveActivity(data.run, data.inter);
  const feed = [...data.events, ...data.inter.filter((e) => Date.now() - Date.parse(e.ts) < 3600000)]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const act = (fn) => {
    try { setMessage(fn() || ''); } catch (err) { setMessage(`✗ ${err.message}`); }
  };

  useInput((ch, key) => {
    if (focus === 'prompt') {
      if (key.escape) return setFocus('projects');
      if (key.return) {
        return act(() => {
          const id = startRun(project.path, input);
          setInput(''); setRunSel(0);
          return `▶ Run ${id} started — the CEO is planning.`;
        });
      }
      if (key.ctrl && ch === 'o') return act(() => { openInteractive(project.path, input); setInput(''); return 'Opened Claude Code in a new window.'; });
      if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
      if (key.tab) return setFocus('projects');
      if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
      return undefined;
    }
    if (ch === 'q') return exit();
    if (key.tab) return setFocus((f) => PANES[(PANES.indexOf(f) + 1) % PANES.length]);
    if (ch === '/' || ch === 'p' || key.return) return setFocus('prompt');
    const move = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (move && focus === 'projects') { setSel((s) => Math.max(0, Math.min(projects.length - 1, s + move))); setRunSel(0); }
    if (move && focus === 'projects') setOrgScroll(0);
    if (move && focus === 'org') setOrgScroll((s) => Math.max(0, s + move * 3));
    if (move && focus === 'runs') setRunSel((s) => Math.max(0, Math.min(data.runs.length - 1, s + move)));
    if (ch === 'i' && project) {
      return act(() => {
        if (data.org) return 'This project already has a team (delete .company/org.json to re-hire).';
        startInit(project.path);
        return 'Hiring a team… the org designer is reading the project (≈1–2 min).';
      });
    }
    if (ch === 'o' && project) return act(() => { openInteractive(project.path, ''); return 'Opened Claude Code in a new window.'; });
    if (ch === 's' && data.run && isRunActive(data.run)) return act(() => { stopRun(project.path, data.run.id); return `Stopped ${data.run.id}.`; });
    if (ch === 'r') setProjects(discoverProjects());
    return undefined;
  });

  const cols = stdout?.columns || 120;
  const rows = stdout?.rows || 32;
  const bodyH = Math.max(10, rows - 6);
  const leftW = Math.min(30, Math.floor(cols * 0.22));
  const rightW = Math.floor((cols - leftW) * 0.5);
  const midW = cols - leftW - rightW;
  const inner = bodyH - 3;

  return h(Box, { flexDirection: 'column', width: cols },
    h(Box, { justifyContent: 'space-between', paddingX: 1 },
      h(Text, { bold: true, color: 'cyan' }, 'Claude HQ'),
      h(Text, { color: sys.free < config.minFreeMemMB ? 'red' : 'gray' },
        `${project ? `${project.name} · ${data.org?.project?.type || project.type}` : ''}   slots ${sys.slots}/${config.maxProcesses}   free RAM ${sys.free} MB`)),
    h(Box, { height: bodyH },
      h(Pane, { title: `Projects (${projects.length})`, focused: focus === 'projects', width: leftW, height: bodyH },
        ...ProjectList({ projects, sel, width: leftW, rows: inner, activeRuns })),
      h(Pane, { title: 'Org chart (tab here, ↑↓ scroll)', focused: focus === 'org', width: midW, height: bodyH },
        ...OrgChart({ org: data.org, catalog, activity, width: midW, rows: inner, project, offset: orgScroll })),
      h(Pane, { title: 'Runs & activity', focused: focus === 'runs', width: rightW, height: bodyH },
        ...RunPane({ runs: data.runs, runSel, run: data.run, events: feed, width: rightW, rows: inner }))),
    h(Box, { borderStyle: 'round', borderColor: focus === 'prompt' ? 'cyan' : 'gray', paddingX: 1 },
      h(Text, { color: focus === 'prompt' ? 'cyan' : 'gray' }, '› '),
      h(Text, { wrap: 'truncate' }, input || (focus === 'prompt' ? '' : 'press / to give the company a request')),
      focus === 'prompt' ? h(Text, { inverse: true }, ' ') : null),
    h(Text, { color: message.startsWith('✗') ? 'red' : 'yellow', wrap: 'truncate' }, message || ' '),
    h(Text, { dimColor: true, wrap: 'truncate' },
      'tab pane · ↑↓ select · / type request · enter run company · ctrl+o send to Claude Code · o open Claude · i hire team · s stop run · q quit'));
}

export function startTui() {
  const app = render(h(App), { exitOnCtrlC: true });
  return app.waitUntilExit();
}
