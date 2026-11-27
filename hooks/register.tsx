import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { Snapshot, Tab } from '../types'
import {
  ACTIVE_RUN, busyAgents, dedupeChatEvents, feedItem, orgGroups, runBrief, runView, type Json,
} from './model'
import { bandView, paneView, type Actions, type Ui } from './view'

const PANE = 'company-hq'
const TITLE = 'Claude HQ'
const POLL_MS = 2000
const ANIMATION_MS = 250
const TAIL_BYTES = 24 * 1024
const FEED_LINES = 60
const RUNS_SHOWN = 6
const HQ_TIMEOUT_MS = 60_000
const NOTICE_MS = 15_000
const NO_TEAM_RECHECK_MS = 30_000
const CHAT_FEED_MS = 3_600_000
const MAX_OPEN_SPAWNS = 200
const TEAM_TYPES = new Set(['startup', 'research', 'software'])
const TABS = new Set<Tab>(['overview', 'team', 'tasks', 'activity'])
const USAGE = [
  '/hq                 open the HQ pane',
  '/hq run <request>   hand a request to the company (runs in the background)',
  '/hq init [startup|research|software]   hire a team for this project',
  '/hq stop            stop the active run',
  '/hq resume          carry on a paused or unfinished run (keeps approved work)',
  '/hq status          recent runs',
].join('\n')

// Tag changes when Snapshot's fields change, so a value an older version stored is declined.
const snapshot = atom({ plugin: 'company-hq', key: 'snapshot' } as const, null, { shape: 'snap-4' })
const isBandHidden = atom({ plugin: 'company-hq', key: 'isBandHidden' } as const, false)
const notice = atom({ plugin: 'company-hq', key: 'notice' } as const, '')
const tab = atom({ plugin: 'company-hq', key: 'tab' } as const, 'overview' as Tab)
const pickedRun = atom({ plugin: 'company-hq', key: 'pickedRun' } as const, '')
const frame = atom({ plugin: 'company-hq', key: 'frame' } as const, 0)
const openTask = atom({ plugin: 'company-hq', key: 'openTask' } as const, '')

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

/** The engine's bundled catalog.json with ~/.claude/company/catalog.json roles on top, as the engine layers them. */
async function loadRoles($: Engine, pluginRoot: string, home: string): Promise<Json> {
  const bundled = (await readJson($, join(pluginRoot, 'engine', 'catalog.json')))?.roles ?? {}
  const user = (await readJson($, join(home, '.claude', 'company', 'catalog.json')))?.roles ?? {}
  return { ...bundled, ...user }
}

const STALE_SLOT_MS = 3 * 60 * 60 * 1000
const DEFAULT_MAX_PROCESSES = 2

type Slot = { label: string; project: string; since: string; runId: string }

/**
 * Who holds the machine's Claude process slots right now, across every project's HQ runs.
 * A slot file older than 3 hours is a leftover of an engine that died and is ignored.
 */
async function readSlots($: Engine, home: string): Promise<{ max: number; holders: Slot[] }> {
  const companyHome = join(home, '.claude', 'company')
  const max = Number((await readJson($, join(companyHome, 'config.json')))?.maxProcesses) || DEFAULT_MAX_PROCESSES
  let names: string[] = []
  try {
    names = (await $.fs.list(join(companyHome, 'state', 'slots'))).filter(e => e.kind === 'file').map(e => e.name)
  } catch {
    return { max, holders: [] }
  }
  const now = Date.now()
  const slots = await Promise.all(names.map(n => readJson($, join(companyHome, 'state', 'slots', n))))
  const holders = slots.flatMap(s => {
    const ts = Number(s?.ts)
    if (!s || !Number.isFinite(ts) || now - ts > STALE_SLOT_MS) return []
    return [{ label: String(s.label ?? 'Claude process'), project: String(s.project ?? ''), since: new Date(ts).toISOString(), runId: String(s.runId ?? '') }]
  })
  return { max, holders: holders.sort((a, b) => a.since.localeCompare(b.since)) }
}

// Per-load caches: the catalog rarely changes (a reload re-reads it), and the last good parse of each
// run's state.json stands in while the engine is mid-write, so the pane does not flicker.
const cache = { roles: null as Json | null, states: new Map<string, Json>() }

async function readRunState($: Engine, root: string, id: string): Promise<Json | null> {
  const fresh = await readJson($, join(root, '.company', 'runs', id, 'state.json'))
  if (fresh) cache.states.set(id, fresh)
  return fresh ?? cache.states.get(id) ?? null
}

async function buildSnapshot($: Engine, cwd: string, home: string, picked: string): Promise<Snapshot> {
  const { root, org } = await findRoot($, cwd)
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  const empty: Snapshot = {
    root, hasTeam: false, projectName: name, type: '', departments: 0, org: [], runs: [], run: null,
    isLatest: true, feed: [], activeRuns: 0, working: 0, slots: { used: 0, max: 2, holders: [] }, updatedAt: '',
  }
  if (!org) return empty
  cache.roles ??= await loadRoles($, live.pluginRoot, home)
  const roles = cache.roles ?? {}
  const ids = await listRunIds($, root)
  const states = (await Promise.all(ids.map(id => readRunState($, root, id)))).filter(Boolean) as Json[]
  const latest = states.find(s => ACTIVE_RUN.has(s.status)) ?? states[0] ?? null
  const current = (picked && states.find(s => s.id === picked)) || latest
  const chat = dedupeChatEvents(await readJsonlTail($, join(root, '.company', 'events.jsonl')))
  const runEvents = current ? await readJsonlTail($, join(root, '.company', 'runs', current.id, 'events.jsonl')) : []
  const slots = await readSlots($, home)
  const busy = busyAgents(latest, chat)
  const now = Date.now()
  const feed = [...runEvents, ...chat.filter(e => now - Date.parse(e.ts) < CHAT_FEED_MS)]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-FEED_LINES).map(feedItem)
  const deptNames = new Map<string, string>((org.departments ?? []).map((d: Json) => [String(d.id), String(d.name ?? d.id)]))
  return {
    ...empty,
    hasTeam: true,
    projectName: String(org.project?.name || name),
    type: String(org.project?.type ?? ''),
    departments: (org.departments ?? []).length,
    org: orgGroups(org, roles, latest, busy),
    runs: states.map(runBrief),
    run: current ? runView(current, deptNames, roles, runEvents, slots.holders.map(h => ({ ...h, isThisRun: h.runId === current.id }))) : null,
    isLatest: !current || !latest || current.id === latest.id,
    feed,
    activeRuns: states.filter(s => ACTIVE_RUN.has(s.status)).length,
    working: [...busy.values()].reduce((a, b) => a + b, 0),
    slots: { used: slots.holders.length, max: slots.max, holders: slots.holders.map(h => ({ label: h.label, project: h.project, since: h.since, isThisRun: Boolean(current && h.runId === current.id) })) },
    updatedAt: String(runEvents.at(-1)?.ts ?? current?.updatedAt ?? ''),
  }
}

// ---------- the hq CLI ----------

/** The engine ships inside this plugin, at <plugin>/engine. */
const enginePath = (...parts: string[]) => join(live.pluginRoot, 'engine', ...parts)

async function runHq($: Engine, root: string, args: string[]): Promise<string> {
  try {
    const res = await $.process.run(['node', enginePath('bin', 'hq.js'), ...args], { cwd: root, timeoutMs: HQ_TIMEOUT_MS })
    const out = `${res.stdout}${res.stderr}`.trim()
    return out || (res.exitCode === 0 ? 'Done.' : `hq exited ${res.exitCode}`)
  } catch (err) {
    return `Could not run hq: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ---------- module state ----------

// Per-load runtime state (a reload starts it over; the snapshot itself lives in $.state).
const live = {
  cwd: '', home: '', pluginRoot: '', isInteractive: false,
  timer: null as Timer | null, animation: null as Timer | null,
  isRefreshing: false, last: '', noTeamUntil: 0, noticeAt: 0,
  /** Chat delegation is logged only in interactive sessions the HQ engine did not start (it logs its own). */
  isLoggingChat: false,
  spawned: new Map<string, { toolUseId: string; description: string }>(),
}

// ---------- chat delegation → .company/events.jsonl ----------

/**
 * Hands one spawn or finish to the engine's delegation-log script, which finds the project's
 * .company folder and appends a line. Fire-and-forget: logging never delays or fails the agent.
 */
function logDelegation($: Engine, record: { phase: 'start' | 'done'; agent: string; toolUseId: string; description: string; isFailed?: boolean }): void {
  const input = {
    hook_event_name: record.phase === 'start' ? 'PreToolUse' : 'PostToolUse',
    tool_name: 'Agent',
    cwd: live.cwd,
    session_id: 'chat',
    tool_use_id: record.toolUseId,
    tool_input: { subagent_type: record.agent, description: record.description },
    tool_response: { is_error: Boolean(record.isFailed) },
  }
  try {
    void $.process.run(['node', enginePath('hooks', 'delegation-log.cjs')], { cwd: live.cwd, stdin: JSON.stringify(input), timeoutMs: 5000 })
      .catch(() => undefined)
  } catch {
    // Logging is best-effort: a host that cannot run it must never break the spawn.
  }
}

// ---------- refresh and animation ----------

/** The spinner ticks only while a run is active in an interactive session; otherwise no timer runs. */
function syncAnimation($: Engine, isActive: boolean): void {
  if (isActive && live.isInteractive && !live.animation) {
    try {
      live.animation = $.clock.every(ANIMATION_MS, () => { void update($, frame, n => (n + 1) % 1000) })
    } catch {
      live.animation = null
    }
  } else if (!isActive && live.animation) {
    live.animation.cancel?.()
    live.animation = null
  }
}

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
    const snap = await buildSnapshot($, live.cwd, live.home, await read($, pickedRun))
    live.noTeamUntil = snap.hasTeam ? 0 : now + NO_TEAM_RECHECK_MS
    syncAnimation($, snap.activeRuns > 0)
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

async function say($: Engine, text: string): Promise<void> {
  await update($, notice, () => text.split('\n')[0] ?? '')
  live.noticeAt = Date.now()
}

async function act($: Engine, args: string[]): Promise<string> {
  const snap = await read($, snapshot)
  const text = await runHq($, snap?.root ?? live.cwd, args)
  await say($, text)
  await refresh($, true)
  return text
}

/** Every button and box in the pane and band, bound to this session. */
function actionsFor($: Engine, root: string): Actions {
  return {
    setTab: next => { void update($, tab, () => next) },
    pick: id => { void update($, pickedRun, () => id).then(() => refresh($, true)) },
    run: request => {
      void update($, pickedRun, () => '')
      void update($, tab, () => 'overview')
      void act($, ['run', root, request])
    },
    hire: type => { void act($, ['init', root, '--background', ...(type && TEAM_TYPES.has(type) ? ['--type', type] : [])]) },
    stop: runId => { void act($, ['stop', root, runId]) },
    resume: runId => {
      void update($, pickedRun, () => '')
      void act($, ['resume', root, runId])
    },
    toggleTask: id => { void update($, openTask, current => (current === id ? '' : id)) },
    refresh: () => { void refresh($, true) },
    toggleBand: () => { void update($, isBandHidden, v => !v) },
    open: () => { void $.ui.open({ id: PANE, title: TITLE }) },
  }
}

// ---------- module ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    live.cwd = e.cwd
    live.home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    live.pluginRoot = $.plugin.root
    live.isInteractive = e.isInteractive
    live.isLoggingChat = e.isInteractive && !(await $.env.get('HQ_RUN_ID'))
    await $.command.register({ name: 'hq', description: 'Company HQ: open the company pane, or run / init / stop / status', argumentHint: '[run <request> | init [type] | stop | resume | status]' })
    await refresh($)
    live.timer?.cancel?.()
    live.timer = null
    // Headless sessions (the engine's own claude -p processes among them) draw nothing, so they skip the poll.
    if (e.isInteractive) {
      try {
        live.timer = $.clock.every(POLL_MS, () => { void refresh($) })
      } catch {
        live.timer = null // no timer on this host: the pane still shows the snapshot and refreshes on actions
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      const hasTeam = Boolean((await read($, snapshot))?.hasTeam)
      if (live.isLoggingChat && hasTeam && !e.fork && started.deny === undefined && started.agentId) {
        const description = String(e.description ?? '').slice(0, 120)
        const toolUseId = e.tool_use_id || started.agentId
        if (live.spawned.size >= MAX_OPEN_SPAWNS) live.spawned.delete(live.spawned.keys().next().value as string)
        live.spawned.set(started.agentId, { toolUseId, description })
        logDelegation($, { phase: 'start', agent: e.subagentType || 'general-purpose', toolUseId, description })
      }
    } catch {
      // Never turn a successful spawn into a hook error.
    }
    return started
  })

  on('agent.report', async ($, e, next) => {
    const reported = await next(e)
    try {
      const spawn = live.spawned.get(e.agentId)
      if (spawn) {
        live.spawned.delete(e.agentId)
        logDelegation($, { phase: 'done', agent: e.subagentType || 'general-purpose', toolUseId: spawn.toolUseId, description: spawn.description, isFailed: e.status !== 'completed' })
      }
    } catch {
      // Never turn a delivered report into a hook error.
    }
    return reported
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
      await update($, pickedRun, () => '')
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
      const active = snap?.run && ACTIVE_RUN.has(snap.run.status) && snap.isLatest ? snap.run.id : null
      return { text: active ? await act($, ['stop', root, active]) : 'No active run to stop.' }
    }
    if (sub === 'status') return { text: await runHq($, root, ['status', root]) }
    if (sub === 'resume') {
      await update($, pickedRun, () => '')
      const text = await act($, ['resume', root, ...(rest[0] ? [rest[0]] : [])])
      void $.ui.open({ id: PANE, title: TITLE })
      return { text }
    }
    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as unknown as Ui
    const snap = await read($, snapshot)
    const current = await read($, tab)
    const state = {
      tab: TABS.has(current) ? current : 'overview' as Tab,
      frame: await read($, frame),
      notice: await read($, notice),
      isBandHidden: await read($, isBandHidden),
      openTask: await read($, openTask),
    }
    return paneView(ui, snap, state, String(e.props.placement), actionsFor($, snap?.root ?? live.cwd))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap?.hasTeam || (await read($, isBandHidden))) return next(e)
    const ui = $.ui.resolve(e) as unknown as Ui
    return bandView(ui, snap, await read($, frame), actionsFor($, snap.root))
  })
}
