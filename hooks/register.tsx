import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { OrgLine, RunBrief, RunView, Snapshot, TaskRow, Tone } from '../types'

const PANE = 'company-hq'
const TITLE = 'Claude HQ'
const POLL_MS = 2000
const TAIL_BYTES = 24 * 1024
const FEED_LINES = 40
const RUNS_SHOWN = 5
const HQ_TIMEOUT_MS = 60_000
const NOTICE_MS = 15_000
const NO_TEAM_RECHECK_MS = 30_000
const TEAM_TYPES = new Set(['startup', 'research', 'software'])
const ACTIVE = new Set(['queued', 'planning', 'executing', 'board'])
const BUSY_TASK = new Set(['queued', 'running', 'revising', 'review'])
const ICON: Record<string, string> = {
  pending: '○', queued: '◌', running: '●', revising: '↻', review: '⚖',
  approved: '✓', failed: '✗', blocked: '⊘', stopped: '■',
}
const TONE_COLOR: Record<Tone, string | undefined> = {
  board: 'claude', exec: 'permission', dept: undefined, busyDept: 'success',
  worker: undefined, busy: 'success', review: 'subtle',
}
const USAGE = [
  '/hq                 open the HQ pane',
  '/hq run <request>   hand a request to the company (runs in the background)',
  '/hq init [startup|research|software]   hire a team for this project',
  '/hq stop            stop the active run',
  '/hq status          recent runs',
].join('\n')

// Tag changes when Snapshot's fields change, so a value an older version stored is declined.
const snapshot = atom({ plugin: 'company-hq', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const isBandHidden = atom({ plugin: 'company-hq', key: 'isBandHidden' } as const, false)
const notice = atom({ plugin: 'company-hq', key: 'notice' } as const, '')

type Json = Record<string, any>

// ---------- reading the company's files ----------

const join = (...parts: string[]) => parts.join('/').replace(/[\\/]+/g, '/')
const parentOf = (dir: string) => dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')

async function readJson($: Engine, path: string): Promise<Json | null> {
  try {
    return JSON.parse(String(await $.fs.read(path)).replace(/^﻿/, ''))
  } catch {
    return null
  }
}

async function readJsonlTail($: Engine, path: string): Promise<Json[]> {
  try {
    const { size } = await $.fs.stat(path)
    const offset = Math.max(0, size - TAIL_BYTES)
    let text = String(await $.fs.read(path, { offset, length: size - offset }))
    if (offset > 0) text = text.slice(text.indexOf('\n') + 1)
    return text.split(/\r?\n/).flatMap(line => {
      try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
    })
  } catch {
    return []
  }
}

/** The project root is the session folder or a parent of it that holds .company/org.json. */
async function findRoot($: Engine, cwd: string): Promise<{ root: string; org: Json | null }> {
  let dir = cwd
  for (let i = 0; i < 4 && dir; i += 1) {
    const org = await readJson($, join(dir, '.company', 'org.json'))
    if (org) return { root: dir, org }
    const up = parentOf(dir)
    if (up === dir) break
    dir = up
  }
  return { root: cwd, org: null }
}

async function listRunIds($: Engine, root: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(join(root, '.company', 'runs'))
    return entries.filter(e => e.kind === 'dir').map(e => e.name).sort().reverse().slice(0, RUNS_SHOWN)
  } catch {
    return []
  }
}

// ---------- turning files into what is drawn ----------

function busyAgents(run: Json | null, interactive: Json[]): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (agent: string) => counts.set(agent, (counts.get(agent) ?? 0) + 1)
  if (run && ACTIVE.has(run.status)) {
    for (const t of run.tasks ?? []) for (const w of t.workers ?? []) if (w.status === 'working') bump(w.agent)
  }
  const open = new Map<string, string>()
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const ev of interactive) {
    if (Date.parse(ev.ts) < cutoff) continue
    if (ev.type === 'worker.start') open.set(ev.toolUseId, ev.agent)
    if (ev.type === 'worker.done') open.delete(ev.toolUseId)
  }
  for (const agent of open.values()) bump(agent)
  return counts
}

export function orgLines(org: Json, roles: Json, run: Json | null, busy: Map<string, number>): OrgLine[] {
  const busyDepts = new Set<string>(
    run && ACTIVE.has(run.status) ? (run.tasks ?? []).filter((t: Json) => BUSY_TASK.has(t.status)).map((t: Json) => t.department) : [],
  )
  const out: OrgLine[] = [{ text: 'Board of Directors · chair, risk, quality', tone: 'board' }]
  const execs: Json[] = org.executives ?? []
  const walk = (exec: Json, depth: number) => {
    const pad = '  '.repeat(depth)
    out.push({ text: `${pad}★ ${exec.title}`, tone: 'exec' })
    for (const d of (org.departments ?? []).filter((x: Json) => (x.reportsTo ?? 'ceo') === exec.id)) {
      const isBusy = busyDepts.has(d.id)
      out.push({ text: `${pad}  ${isBusy ? '●' : '·'} ${d.name} — ${d.manager ?? 'Manager'}`, tone: isBusy ? 'busyDept' : 'dept' })
      for (const w of d.workers ?? []) {
        const role = typeof w === 'string' ? roles[w] : w
        if (!role?.title) continue
        const n = busy.get(role.agent) ?? 0
        out.push({ text: `${pad}      ${n ? `● ${role.title} ×${n}` : role.title}`, tone: n ? 'busy' : 'worker' })
      }
      const reviewers = (d.reviewers ?? []).map((r: Json) => (typeof r === 'string' ? roles[r]?.title : r?.title)).filter(Boolean)
      if (reviewers.length) out.push({ text: `${pad}      review: ${reviewers.join(', ')}`, tone: 'review' })
    }
    for (const c of execs.filter(e => e.reportsTo === exec.id)) walk(c, depth + 1)
  }
  for (const root of execs.filter(e => !e.reportsTo)) walk(root, 0)
  return out
}

function runView(s: Json): RunView {
  const tasks: TaskRow[] = (s.tasks ?? []).map((t: Json) => ({
    id: String(t.id), department: String(t.department), title: String(t.title), status: String(t.status),
    working: (t.workers ?? []).filter((w: Json) => w.status === 'working').length, round: Number(t.round) || 0,
  }))
  return {
    id: String(s.id), status: String(s.status), prompt: String(s.prompt ?? ''), goal: String(s.plan?.goal ?? ''),
    questions: (s.plan?.questions ?? []).map(String), tasks,
    board: s.board ? `${s.board.decision}: ${s.board.summary}` : '', error: String(s.error ?? ''), cost: Number(s.cost) || 0,
  }
}

const clock = (ts: string) => String(ts ?? '').slice(11, 16)

export function feedLine(ev: Json): string {
  const t = clock(ev.ts)
  const who = ev.source === 'interactive' ? 'chat ' : ''
  switch (ev.type) {
    case 'plan.ready': return `${t} CEO planned ${ev.tasks} task(s): ${ev.goal}`
    case 'process.start': return `${t} ⚙ ${ev.label}`
    case 'process.end': return `${t} ${ev.ok ? '■' : '✗'} ${ev.label}${ev.error ? ` — ${ev.error}` : ''}`
    case 'slot.wait': return `${t} … ${ev.label} waiting for memory (${ev.freeMB} MB free)`
    case 'worker.start': return `${t} ${who}→ ${ev.agent}: ${ev.description ?? ''}`
    case 'worker.done': return `${t} ${who}${ev.status === 'failed' ? '✗' : '✓'} ${ev.agent}`
    case 'review.verdict': return `${t} ⚖ ${ev.taskId} ${ev.verdict}${ev.score != null ? ` (${ev.score}/10)` : ''}: ${ev.summary ?? ''}`
    case 'task.approved': return `${t} ✓ ${ev.taskId} approved`
    case 'task.failed': return `${t} ✗ ${ev.taskId} failed: ${ev.error ?? ''}`
    case 'board.decision': return `${t} Board: ${ev.decision} — ${ev.summary ?? ''}`
    case 'run.end': return `${t} ■ run ${ev.status}${ev.error ? `: ${ev.error}` : ''}`
    default: return `${t} ${ev.type}`
  }
}

// Per-load caches: the catalog rarely changes (a reload re-reads it), and the last good parse of each
// run's state.json stands in while the engine is mid-write, so the pane does not flicker.
const cache = { roles: null as Json | null, states: new Map<string, Json>() }

async function readRunState($: Engine, root: string, id: string): Promise<Json | null> {
  const fresh = await readJson($, join(root, '.company', 'runs', id, 'state.json'))
  if (fresh) cache.states.set(id, fresh)
  return fresh ?? cache.states.get(id) ?? null
}

async function buildSnapshot($: Engine, cwd: string, home: string): Promise<Snapshot> {
  const { root, org } = await findRoot($, cwd)
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  const empty: Snapshot = {
    root, hasTeam: false, projectName: name, type: '', departments: 0, org: [], runs: [], run: null, feed: [], activeRuns: 0, working: 0,
  }
  if (!org) return empty
  cache.roles ??= (await readJson($, join(home, '.claude', 'company', 'catalog.json')))?.roles ?? null
  const roles = cache.roles ?? {}
  const ids = await listRunIds($, root)
  const states = (await Promise.all(ids.map(id => readRunState($, root, id)))).filter(Boolean) as Json[]
  const current = states.find(s => ACTIVE.has(s.status)) ?? states[0] ?? null
  const interactive = await readJsonlTail($, join(root, '.company', 'events.jsonl'))
  const runEvents = current ? await readJsonlTail($, join(root, '.company', 'runs', current.id, 'events.jsonl')) : []
  const busy = busyAgents(current, interactive)
  const feed = [...runEvents, ...interactive.filter(e => Date.now() - Date.parse(e.ts) < 3_600_000)]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-FEED_LINES).map(feedLine)
  const runs: RunBrief[] = states.map(s => ({ id: String(s.id), status: String(s.status), prompt: String(s.prompt ?? '') }))
  return {
    ...empty, hasTeam: true, projectName: String(org.project?.name || name), type: String(org.project?.type ?? ''), departments: (org.departments ?? []).length,
    org: orgLines(org, roles, current, busy), runs, run: current ? runView(current) : null, feed,
    activeRuns: states.filter(s => ACTIVE.has(s.status)).length,
    working: [...busy.values()].reduce((a, b) => a + b, 0),
  }
}

// ---------- the hq CLI ----------

async function runHq($: Engine, home: string, root: string, args: string[]): Promise<string> {
  try {
    const res = await $.process.run(['node', join(home, '.claude', 'company', 'hq', 'bin', 'hq.js'), ...args], { cwd: root, timeoutMs: HQ_TIMEOUT_MS })
    const out = `${res.stdout}${res.stderr}`.trim()
    return out || (res.exitCode === 0 ? 'Done.' : `hq exited ${res.exitCode}`)
  } catch (err) {
    return `Could not run hq: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ---------- module ----------

// Per-load runtime state (a reload starts it over; the snapshot itself lives in $.state).
const live = { cwd: '', home: '', timer: null as Timer | null, isRefreshing: false, last: '', noTeamUntil: 0, noticeAt: 0 }

async function refresh($: Engine, isForced = false): Promise<void> {
  if (live.isRefreshing || !live.cwd) return
  const now = Date.now()
  // A folder with no team is re-checked every 30 s, not every tick.
  if (!isForced && now < live.noTeamUntil) return
  live.isRefreshing = true
  try {
    if (live.noticeAt && now - live.noticeAt > NOTICE_MS) {
      live.noticeAt = 0
      await update($, notice, () => '')
    }
    const snap = await buildSnapshot($, live.cwd, live.home)
    live.noTeamUntil = snap.hasTeam ? 0 : now + NO_TEAM_RECHECK_MS
    const key = JSON.stringify(snap)
    if (key !== live.last) {
      live.last = key
      await update($, snapshot, () => snap)
    }
  } catch {
    // A half-written state.json or a missing folder: keep the last snapshot and retry next tick.
  } finally {
    live.isRefreshing = false
  }
}

async function act($: Engine, args: string[]): Promise<string> {
  const snap = await read($, snapshot)
  const text = await runHq($, live.home, snap?.root ?? live.cwd, args)
  await update($, notice, () => text.split('\n')[0] ?? '')
  live.noticeAt = Date.now()
  await refresh($, true)
  return text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    live.cwd = e.cwd
    live.home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    await $.command.register({ name: 'hq', description: 'Company HQ: open the company pane, or run / init / stop / status', argumentHint: '[run <request> | init [type] | stop | status]' })
    await refresh($)
    live.timer?.cancel?.()
    try {
      live.timer = $.clock.every(POLL_MS, () => { void refresh($) })
    } catch {
      live.timer = null // no timer on this host: the pane still shows the snapshot and refreshes on actions
    }
    return next(e)
  })

  on('command.run', { command: 'hq' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const snap = await read($, snapshot)
    const root = snap?.root ?? live.cwd
    if (sub === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Claude HQ pane opened.' }
    }
    if (sub === 'run') {
      const request = e.args.trim().slice(3).trim()
      if (!request) return { text: 'Usage: /hq run <request>' }
      const text = await act($, ['run', root, request])
      void $.ui.open({ id: PANE, title: TITLE })
      return { text, context: [`A Company HQ run was started in the background for: ${request}. Progress shows in the HQ pane.`] }
    }
    if (sub === 'init') {
      const type = rest[0] ?? ''
      if (type && !TEAM_TYPES.has(type)) return { text: 'Usage: /hq init [startup|research|software]' }
      return { text: await act($, ['init', root, '--background', ...(type ? ['--type', type] : [])]) }
    }
    if (sub === 'stop') {
      const active = snap?.run && ACTIVE.has(snap.run.status) ? snap.run.id : null
      return { text: active ? await act($, ['stop', root, active]) : 'No active run to stop.' }
    }
    if (sub === 'status') return { text: await runHq($, live.home, root, ['status', root]) }
    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const msg = await read($, notice)
    if (!snap) return <Text dimColor>Loading Claude HQ…</Text>
    const run = snap.run
    const isActive = Boolean(run && ACTIVE.has(run.status))
    const taskRows = (run?.tasks ?? []).map(t => (
      <Text color={t.status === 'failed' || t.status === 'blocked' ? 'error' : BUSY_TASK.has(t.status) ? 'success' : undefined}>
        {ICON[t.status] ?? '·'} {t.id} {t.department}: {t.title}{t.working ? ` (${t.working} working)` : ''}{t.round ? ` r${t.round}` : ''}
      </Text>
    ))

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold>{snap.projectName} · {isActive ? `${run?.status}` : 'idle'}</Text>
          {isActive ? taskRows : <Text dimColor>{snap.hasTeam ? `${snap.departments} departments ready` : 'No team yet'}</Text>}
          {snap.working > 0 && <Text color="success">{snap.working} agent(s) working</Text>}
        </Box>
      )
    }

    if (!snap.hasTeam) {
      return (
        <Box flexDirection="column">
          <Text bold>{snap.projectName}</Text>
          <Text>No team has been hired for this project yet.</Text>
          <Text dimColor>The org designer reads the repo and tailors a startup, research or software team (about 1–2 min).</Text>
          <Box><Button key="hire" label="Hire a team" onPress={() => act($, ['init', snap.root, '--background'])} /></Box>
          {msg && <Text color="warning">{msg}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>{snap.projectName} · {snap.type} · {snap.activeRuns ? `${snap.activeRuns} active run` : 'idle'}{snap.working ? ` · ${snap.working} agent(s) working` : ''}</Text>
        <Box>
          {isActive && run && <Button key="stop" label="Stop run" onPress={() => act($, ['stop', snap.root, run.id])} />}
          <Button key="refresh" label="Refresh" onPress={() => refresh($, true)} />
        </Box>
        {msg && <Text color="warning">{msg}</Text>}
        <Text dimColor> </Text>
        <Text bold>Org chart</Text>
        {snap.org.map(l => <Text color={TONE_COLOR[l.tone]} dimColor={l.tone === 'review'} bold={l.tone === 'exec' || l.tone === 'busyDept'}>{l.text}</Text>)}
        <Text dimColor> </Text>
        <Text bold>Runs</Text>
        {snap.runs.length === 0 && <Text dimColor>No runs yet. Use /hq run &lt;request&gt;.</Text>}
        {snap.runs.map(r => <Text color={ACTIVE.has(r.status) ? 'success' : undefined} dimColor={!ACTIVE.has(r.status)}>{r.id.slice(9, 15)} {r.status} — {r.prompt}</Text>)}
        {run && (
          <Box flexDirection="column">
            <Text dimColor> </Text>
            {run.goal && <Text bold>Goal: {run.goal}</Text>}
            {run.questions.map(q => <Text color="warning">? {q}</Text>)}
            {taskRows}
            {run.board && <Text color="claude">Board — {run.board}</Text>}
            {run.error && <Text color="error">✗ {run.error}</Text>}
            <Text dimColor>cost ${run.cost.toFixed(2)} · report: .company/runs/{run.id}/report.md</Text>
          </Box>
        )}
        <Text dimColor> </Text>
        <Text bold>Activity</Text>
        {snap.feed.length === 0 && <Text dimColor>Nothing yet. Delegation from this chat shows here too.</Text>}
        {snap.feed.map(l => <Text dimColor={l.includes(' chat ')}>{l}</Text>)}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap?.hasTeam || (await read($, isBandHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const run = snap.run
    const isActive = Boolean(run && ACTIVE.has(run.status))
    const done = run ? run.tasks.filter(t => t.status === 'approved').length : 0
    const status = isActive && run
      ? `▶ ${run.status} ${done}/${run.tasks.length} tasks${snap.working ? ` · ${snap.working} agent(s) working` : ''}`
      : `${snap.departments} departments · idle`
    return (
      <Box>
        <Text color={isActive ? 'success' : undefined} dimColor={!isActive}>HQ · {snap.projectName} · {status} </Text>
        <Button key="open" label="Open" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
