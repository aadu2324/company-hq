/**
 * Pure functions from the company's files to what the pane draws. Nothing here touches `$`,
 * so every rule (stages, narration, colours, dedupe) is testable on plain objects.
 */
import type { AgentRole, AgentRow, DeptCard, ExecGroup, FeedItem, Hue, LiveProc, PlanStep, RunBrief, RunView, SlotHolder, Stage, TaskRow, Verdict } from '../types'

export type Json = Record<string, any>

export const ACTIVE_RUN = new Set(['queued', 'planning', 'executing', 'board'])
/** Runs `hq resume` can carry on. */
export const RESUMABLE = new Set(['paused', 'failed', 'stopped', 'done_with_failures'])
export const BUSY_TASK = new Set(['queued', 'running', 'working', 'revising', 'review'])
export const STAGES: readonly { id: Stage; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'review', label: 'Review' },
  { id: 'board', label: 'Board' },
  { id: 'report', label: 'Report' },
]

type Look = { label: string; hue: Hue; icon: string }

/** How each run status reads at a glance. */
export const RUN_LOOK: Record<string, Look> = {
  queued: { label: 'QUEUED', hue: 'inactive', icon: '◌' },
  planning: { label: 'PLANNING', hue: 'planMode', icon: '◆' },
  executing: { label: 'WORKING', hue: 'suggestion', icon: '▶' },
  board: { label: 'BOARD REVIEW', hue: 'merged', icon: '⚖' },
  paused: { label: 'PAUSED', hue: 'warning', icon: '⏸' },
  awaiting_owner: { label: 'NEEDS YOU', hue: 'permission', icon: '?' },
  done: { label: 'DONE', hue: 'success', icon: '✓' },
  done_with_failures: { label: 'DONE WITH ISSUES', hue: 'warning', icon: '!' },
  failed: { label: 'FAILED', hue: 'error', icon: '✗' },
  stopped: { label: 'STOPPED', hue: 'inactive', icon: '■' },
  idle: { label: 'IDLE', hue: 'inactive', icon: '·' },
}

/** How each task status reads at a glance. */
export const TASK_LOOK: Record<string, Look> = {
  pending: { label: 'WAITING', hue: 'inactive', icon: '○' },
  queued: { label: 'QUEUED', hue: 'inactive', icon: '◌' },
  running: { label: 'WORKING', hue: 'suggestion', icon: '●' },
  working: { label: 'WORKING', hue: 'suggestion', icon: '●' },
  review: { label: 'IN REVIEW', hue: 'merged', icon: '⚖' },
  revising: { label: 'REVISING', hue: 'warning', icon: '↻' },
  approved: { label: 'APPROVED', hue: 'success', icon: '✓' },
  failed: { label: 'FAILED', hue: 'error', icon: '✗' },
  blocked: { label: 'BLOCKED', hue: 'error', icon: '⊘' },
  stopped: { label: 'STOPPED', hue: 'inactive', icon: '■' },
}

export const runLook = (status: string): Look => RUN_LOOK[status] ?? { label: status.toUpperCase(), hue: 'subtle', icon: '·' }
export const taskLook = (status: string): Look => TASK_LOOK[status] ?? { label: status.toUpperCase(), hue: 'subtle', icon: '·' }

// ---------- agents and roles ----------

/** A role asks for agents best first; a spawned agent counts for it under any of those names, namespaced or not. */
export function roleMatches(role: Json, agent: string): boolean {
  const candidates = [role?.agent, role?.fallback].flat().filter((c): c is string => typeof c === 'string' && c.length > 0)
  return candidates.some(c => agent === c || agent.endsWith(`:${c}`))
}

/**
 * One line per spawn and per finish. A machine that also has the older settings.json delegation hook
 * logs each chat spawn twice under the same tool_use_id; the first copy is kept.
 */
export function dedupeChatEvents(events: Json[]): Json[] {
  const seen = new Set<string>()
  return events.filter(ev => {
    if (!ev.toolUseId) return true
    const key = `${ev.type}:${ev.toolUseId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const CHAT_WINDOW_MS = 30 * 60 * 1000

/** Agents working right now, by agent name: the active run's workers plus open chat spawns. */
export function busyAgents(run: Json | null, chat: Json[], now = Date.now()): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (agent: string) => counts.set(agent, (counts.get(agent) ?? 0) + 1)
  if (run && ACTIVE_RUN.has(run.status)) {
    for (const t of run.tasks ?? []) for (const w of t.workers ?? []) if (w.status === 'working') bump(String(w.agent))
  }
  const open = new Map<string, string>()
  for (const ev of chat) {
    if (now - Date.parse(ev.ts) > CHAT_WINDOW_MS) continue
    if (ev.type === 'worker.start') open.set(ev.toolUseId, ev.agent)
    if (ev.type === 'worker.done') open.delete(ev.toolUseId)
  }
  for (const agent of open.values()) bump(String(agent))
  return counts
}

const titleOf = (ref: unknown, roles: Json): string =>
  typeof ref === 'string' ? String(roles[ref]?.title ?? ref) : String((ref as Json)?.title ?? '')

/** The org chart as executive groups of department cards, with live worker counts. */
export function orgGroups(org: Json, roles: Json, run: Json | null, busy: Map<string, number>): ExecGroup[] {
  const busyDepts = new Set<string>(
    run && ACTIVE_RUN.has(run.status) ? (run.tasks ?? []).filter((t: Json) => BUSY_TASK.has(t.status)).map((t: Json) => t.department) : [],
  )
  const execs: Json[] = org.executives ?? []
  const groups: ExecGroup[] = []
  const card = (d: Json): DeptCard => ({
    id: String(d.id),
    name: String(d.name ?? d.id),
    manager: String(d.manager ?? 'Manager'),
    isBusy: busyDepts.has(d.id),
    workers: (d.workers ?? []).flatMap((w: unknown) => {
      const role = typeof w === 'string' ? roles[w] : w
      if (!role?.title) return []
      let count = 0
      for (const [agent, n] of busy) if (roleMatches(role, agent)) count += n
      return [{ title: String(role.title), count }]
    }),
    reviewers: (d.reviewers ?? []).map((r: unknown) => titleOf(r, roles)).filter(Boolean),
  })
  const walk = (exec: Json, depth: number) => {
    groups.push({
      title: String(exec.title ?? exec.id),
      depth,
      departments: (org.departments ?? []).filter((d: Json) => (d.reportsTo ?? 'ceo') === exec.id).map(card),
    })
    for (const child of execs.filter(e => e.reportsTo === exec.id)) walk(child, depth + 1)
  }
  for (const root of execs.filter(e => !e.reportsTo)) walk(root, 0)
  return groups
}

// ---------- runs ----------

const LIMIT = /(hit your|usage|rate)[^.]*limit/i
const RESETS = /resets?\s+([^·()]+?(\([^)]*\))?)\s*$/i

/** Claude's usage limit stopped the work: say so plainly, with when it resets if the message says. */
export function limitNote(texts: string[]): string {
  const hit = texts.find(t => LIMIT.test(t))
  if (!hit) return ''
  const resets = RESETS.exec(hit.replace(/Â/g, ''))?.[1]?.trim()
  return `Paused by your Claude usage limit${resets ? `, which resets ${resets}` : ''}. Run the request again after that.`
}

function verdictOf(v: Json | null | undefined): Verdict | null {
  if (!v || typeof v !== 'object') return null
  const decision = String(v.verdict ?? v.decision ?? '')
  if (!decision) return null
  return { decision, score: typeof v.score === 'number' ? v.score : null, summary: String(v.summary ?? '') }
}

function stageOf(status: string, tasks: TaskRow[]): Stage {
  if (status === 'queued' || status === 'planning') return 'plan'
  if (status === 'board') return 'board'
  if (status === 'done' || status === 'done_with_failures') return 'report'
  if (tasks.some(t => t.status === 'review' || t.status === 'revising')) return 'review'
  if (tasks.length && tasks.every(t => ['approved', 'failed', 'blocked', 'stopped'].includes(t.status))) return 'board'
  return 'build'
}

const quote = (s: string, max = 48) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * What this run's processes are doing from its events: each started process stays live until it
 * ends, and a slot wait stays open until that label's process starts.
 */
export function liveProcs(events: Json[]): LiveProc[] {
  const live = new Map<string, LiveProc>()
  for (const ev of events) {
    const label = String(ev.label ?? '')
    if (!label) continue
    if (ev.type === 'slot.wait') live.set(label, { label, since: String(ev.ts), isWaiting: true, freeMB: Number.isFinite(ev.freeMB) ? Number(ev.freeMB) : null })
    if (ev.type === 'process.start') live.set(label, { label, since: String(ev.ts), isWaiting: false, freeMB: null })
    if (ev.type === 'process.end') live.delete(label)
    if (ev.type === 'run.end' || ev.type === 'run.paused') live.clear()
  }
  return [...live.values()]
}

const holderText = (h: SlotHolder) => `${h.label}${h.isThisRun ? '' : ` (${h.project})`}`

/** One plain sentence saying what the company is doing right now. */
export function narrate(
  status: string, tasks: TaskRow[], board: Verdict | null, error: string, limit: string,
  context: { live?: LiveProc[]; holders?: SlotHolder[] } = {},
): string {
  const { live = [], holders = [] } = context
  if (limit && (status === 'paused' || !ACTIVE_RUN.has(status))) return limit
  const failed = tasks.filter(t => t.status === 'failed').length
  const others = holders.filter(h => !h.isThisRun)
  const waiting = live.find(p => p.isWaiting)
  switch (status) {
    case 'queued': return others.length
      ? `Queued: every Claude slot is busy. Running now: ${others.slice(0, 2).map(holderText).join('; ')}.`
      : 'Queued: starting as soon as a Claude slot is free.'
    case 'paused': return 'Paused. Resume to carry on; approved work is kept.'
    case 'awaiting_owner': return 'Your decision is needed before the company plans the rest.'
    case 'planning': return 'The CEO is reading the project and splitting the request into tasks.'
    case 'board': return 'The Board is reviewing everything that was delivered.'
    case 'done': return board?.decision === 'approve' || board?.decision === 'approve_with_conditions'
      ? `Finished. The Board approved: ${board.summary}`
      : `Finished. ${board ? `The Board said ${board.decision}: ${board.summary}` : 'All tasks are complete.'}`
    case 'done_with_failures': return `Finished with problems: ${plural(failed, 'task')} failed. ${board ? `Board: ${board.decision}.` : ''}`.trim()
    case 'failed': return `The run failed: ${error || 'see the activity log.'}`
    case 'stopped': return 'Stopped. Nothing else will run.'
    default: break
  }
  const doing = tasks.flatMap(t => {
    if (t.status === 'running' || t.status === 'working') {
      return [`${t.department} is working on ${quote(t.title)}${t.working.length ? ` with ${plural(t.working.length, 'agent')}` : ''}`]
    }
    if (t.status === 'review') return [`${t.reviewers.length ? t.reviewers.slice(0, 2).join(' and ') : 'Reviewers'} ${t.reviewers.length === 1 ? 'is' : 'are'} checking ${quote(t.title)}`]
    if (t.status === 'revising') return [`${t.department} is fixing ${quote(t.title)} after review (round ${t.round})`]
    return []
  })
  if (doing.length === 0) {
    if (waiting) {
      const why = waiting.freeMB != null && others.length === 0 ? `memory (${waiting.freeMB} MB free)` : 'a free Claude slot'
      return `${waiting.label} is waiting for ${why}${others.length ? `; running now: ${others.slice(0, 2).map(holderText).join('; ')}` : ''}.`
    }
    return 'Between steps: the next task is about to start.'
  }
  const extra = doing.length > 2 ? `, and ${doing.length - 2} more` : ''
  return `${doing.slice(0, 2).join('; ')}${extra}.`
}

const MAX_ISSUES = 5

/** A run's state.json as the pane sees it. Department ids become their names. */
export function runView(s: Json, deptNames: Map<string, string>, roles: Json, events: Json[] = [], holders: SlotHolder[] = []): RunView {
  const tasks: TaskRow[] = (s.tasks ?? []).map((t: Json) => ({
    id: String(t.id),
    department: deptNames.get(t.department) ?? String(t.department),
    title: String(t.title ?? t.id),
    status: String(t.status ?? 'pending'),
    round: Number(t.round) || 0,
    working: (t.workers ?? []).filter((w: Json) => w.status === 'working').map((w: Json) => String(w.agent)),
    reviewers: (t.reviewers ?? []).map((r: unknown) => titleOf(r, roles)).filter(Boolean),
    dependsOn: (t.dependsOn ?? []).map(String),
    verdict: verdictOf(t.verdict),
    error: String(t.error ?? ''),
    brief: String(t.brief ?? ''),
    deliverable: String(t.deliverable ?? ''),
    // A verdict parsed from free text is not schema-checked: anything but a list of issues shows none.
    issues: (Array.isArray(t.verdict?.issues) ? t.verdict.issues : []).slice(0, MAX_ISSUES).map((i: unknown) => (typeof i === 'string' ? i : JSON.stringify(i))),
    isUnresolved: Boolean(t.unresolvedReview),
  }))
  const status = String(s.status ?? 'queued')
  const board = verdictOf(s.board)
  const error = String(s.error ?? '')
  const limit = s.status === 'paused' && s.resets
    ? `Paused by your Claude usage limit, which resets ${s.resets}. Resume after that; approved work is kept.`
    : limitNote([error, board?.summary ?? '', ...tasks.map(t => t.error)])
  const stage = stageOf(status, tasks)
  const live = ACTIVE_RUN.has(status) ? liveProcs(events) : []
  return {
    id: String(s.id),
    status,
    prompt: String(s.prompt ?? ''),
    goal: String(s.plan?.goal ?? ''),
    questions: (s.plan?.questions ?? []).map(String),
    tasks,
    stage,
    isStuck: ['failed', 'stopped', 'done_with_failures', 'paused'].includes(status),
    now: narrate(status, tasks, board, error, limit, { live, holders }),
    limitNote: limit,
    board,
    error,
    cost: Number(s.cost) || 0,
    startedAt: String(s.startedAt ?? s.createdAt ?? ''),
    finishedAt: String(s.finishedAt ?? ''),
    done: tasks.filter(t => t.status === 'approved').length,
    failed: tasks.filter(t => t.status === 'failed' || t.status === 'blocked').length,
    live,
    // A resumed run counts from the resume, not across the paused hours.
    runningSince: String(s.resumedAt ?? s.startedAt ?? s.createdAt ?? ''),
    canResume: RESUMABLE.has(status),
    doneMeans: String(s.plan?.doneMeans ?? ''),
    decisions: (Array.isArray(s.ownerAnswers) ? s.ownerAnswers : []).map((a: Json) => ({ question: String(a.question ?? ''), answer: String(a.answer ?? '') })),
    steps: planSteps(s.tasks ?? []),
    checkpoint: status === 'awaiting_owner' && s.checkpoint
      ? { question: String(s.checkpoint.question ?? ''), deliverablePath: String(s.checkpoint.deliverablePath ?? '') }
      : null,
    resumes: Number(s.resumes) || 0,
  }
}

/**
 * The plan as steps: a task with no dependencies is step 1; otherwise one after its latest dependency.
 * Dependencies outside the plan (or cycles, which validation rejects anyway) count as step 1.
 */
export function planSteps(tasks: Json[]): PlanStep[] {
  const byId = new Map(tasks.map(t => [String(t.id), t]))
  const level = new Map<string, number>()
  const levelOf = (id: string, seen: Set<string>): number => {
    if (level.has(id)) return level.get(id) as number
    const t = byId.get(id)
    if (!t || seen.has(id)) return 0
    seen.add(id)
    const deps = (t.dependsOn ?? []).map(String).filter((d: string) => byId.has(d))
    const n = deps.length ? 1 + Math.max(...deps.map((d: string) => levelOf(d, seen))) : 0
    level.set(id, n)
    return n
  }
  for (const t of tasks) levelOf(String(t.id), new Set())
  const steps: PlanStep[] = []
  for (const t of tasks) {
    const n = level.get(String(t.id)) ?? 0
    while (steps.length <= n) steps.push({ n: steps.length + 1, taskIds: [] })
    steps[n]!.taskIds.push(String(t.id))
  }
  return steps.filter(s => s.taskIds.length)
}

const RECENT_AGENTS = 12

/** Who a process is in the company, from its label ("CEO · plan", "Review · T1", "Engineering · T2"). */
export function roleOf(label: string): AgentRole {
  if (/^CEO|^Org designer/.test(label)) return 'ceo'
  if (/^Review/.test(label)) return 'reviewer'
  if (/^Board/.test(label)) return 'board'
  return 'manager'
}

/**
 * Every agent's piece of work from the run's events and the chat's: processes (CEO, managers,
 * reviewers, Board) from process.start/end, worker subagents from worker.start/done. Open ones are
 * working; closed ones are recent, newest first.
 */
export function agentRoster(events: Json[]): { working: AgentRow[]; recent: AgentRow[] } {
  const open: AgentRow[] = []
  const closed: AgentRow[] = []
  const close = (match: (a: AgentRow) => boolean, ts: string, failed: boolean) => {
    const i = open.findIndex(match)
    if (i < 0) return
    const [row] = open.splice(i, 1)
    closed.push({ ...row!, ended: ts, status: failed ? 'failed' : 'done' })
  }
  for (const ev of [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    const ts = String(ev.ts ?? '')
    const isChat = ev.source === 'interactive'
    if (ev.type === 'process.start') {
      const label = String(ev.label ?? '')
      open.push({ who: label, role: roleOf(label), doing: roleOf(label) === 'reviewer' ? 'reviewing the work' : roleOf(label) === 'ceo' ? 'planning' : roleOf(label) === 'board' ? 'signing off' : 'running the task', task: String(ev.taskId ?? ''), since: ts, ended: '', status: 'working' })
    } else if (ev.type === 'process.end') {
      close(a => a.who === ev.label && a.role !== 'worker' && a.role !== 'chat', ts, !ev.ok)
    } else if (ev.type === 'worker.start') {
      open.push({ who: String(ev.agent ?? 'agent'), role: isChat ? 'chat' : 'worker', doing: String(ev.description ?? ''), task: String(ev.taskId ?? ''), since: ts, ended: '', status: 'working' })
    } else if (ev.type === 'worker.done') {
      close(a => (a.role === 'worker' || a.role === 'chat') && a.who === ev.agent && a.doing === String(ev.description ?? a.doing), ts, ev.status === 'failed')
    } else if (ev.type === 'run.end' || ev.type === 'run.paused' || ev.type === 'run.checkpoint') {
      // The run stopped: whatever its processes had open ended with it (chat agents are separate).
      for (const a of open.filter(x => x.role !== 'chat')) close(x => x === a, ts, ev.type === 'run.end' && ev.status !== 'done')
    }
  }
  return { working: open, recent: closed.sort((a, b) => b.ended.localeCompare(a.ended)).slice(0, RECENT_AGENTS) }
}

/** "3m 07s" / "1h 04m": a live counter, recomputed every animation frame. */
export function ticking(from: string, now = Date.now()): string {
  const start = Date.parse(from)
  if (!Number.isFinite(start)) return ''
  const secs = Math.max(0, Math.floor((now - start) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
  return `${Math.floor(secs / 3600)}h ${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`
}

/** "just now", "12s ago", "3m ago": how fresh the run's files are. */
export function ago(ts: string, now = Date.now()): string {
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return ''
  const secs = Math.max(0, Math.round((now - t) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

export const runBrief = (s: Json): RunBrief => ({
  id: String(s.id), status: String(s.status), prompt: String(s.prompt ?? ''), startedAt: String(s.startedAt ?? s.createdAt ?? ''),
})

/** "4m", "1h 12m": how long a run has been going, or went. */
export function elapsed(from: string, to: string, now = Date.now()): string {
  const start = Date.parse(from)
  if (!Number.isFinite(start)) return ''
  const end = to ? Date.parse(to) : now
  const mins = Math.max(0, Math.round((end - start) / 60000))
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/** A local HH:MM for an ISO time. */
export function clock(ts: string): string {
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
}

// ---------- activity ----------

/** One event as a coloured line with an icon. */
export function feedItem(ev: Json): FeedItem {
  const isChat = ev.source === 'interactive'
  const at = (icon: string, hue: Hue, text: string): FeedItem => ({ time: clock(ev.ts), icon, hue, text, isChat })
  switch (ev.type) {
    case 'run.start': return at('▶', 'claude', 'Run started')
    case 'run.resumed': return at('▶', 'claude', 'Run resumed: approved work kept, the rest carries on')
    case 'run.queued': return at('◌', 'inactive', 'Queued to resume')
    case 'run.paused': return at('⏸', 'warning', `Paused by the Claude usage limit${ev.resets ? `, resets ${ev.resets}` : ''}`)
    case 'run.checkpoint': return at('?', 'permission', `Waiting for you: ${ev.question ?? ''}`)
    case 'owner.answer': return at('✎', 'permission', `You answered: ${ev.answer ?? ''}`)
    case 'plan.revised': return at('◆', 'planMode', `CEO re-planned around your answer: ${plural(Number(ev.tasks) || 0, 'new task')}`)
    case 'knowledge.filed': return at('◇', 'remember', `Filed to your second brain: ${plural(Number(ev.papers) || 0, 'paper')}, ${plural(Number(ev.gaps) || 0, 'gap')}${ev.fields ? `, now watching ${plural(Number(ev.fields), 'field')}` : ''}`)
    case 'obsidian.failed': return at('!', 'warning', `Could not write the Obsidian note: ${ev.error ?? ''}`)
    case 'plan.ready': return at('◆', 'planMode', `CEO planned ${plural(Number(ev.tasks) || 0, 'task')}: ${ev.goal ?? ''}`)
    case 'process.start': return at('⚙', 'subtle', `Started ${ev.label ?? 'a process'}`)
    case 'process.end': return ev.ok ? at('■', 'subtle', `Finished ${ev.label ?? 'a process'}`) : at('✗', 'error', `${ev.label ?? 'A process'} stopped: ${ev.error ?? 'error'}`)
    case 'slot.wait': return at('…', 'warning', `${ev.label ?? 'Next task'} is waiting for memory (${ev.freeMB} MB free)`)
    case 'worker.start': return at('→', isChat ? 'remember' : 'suggestion', `${ev.agent} started: ${ev.description ?? ''}`)
    case 'worker.done': return ev.status === 'failed' ? at('✗', 'error', `${ev.agent} failed`) : at('✓', 'success', `${ev.agent} finished${ev.description ? `: ${ev.description}` : ''}`)
    case 'review.verdict': return at('⚖', ev.verdict === 'approve' ? 'success' : ev.verdict === 'reject' ? 'error' : 'warning',
      `${ev.taskId} ${ev.verdict}${ev.score != null ? ` ${ev.score}/10` : ''}: ${ev.summary ?? ''}`)
    case 'task.approved': return at('✓', 'success', `${ev.taskId} approved`)
    case 'task.failed': return at('✗', 'error', `${ev.taskId} failed: ${ev.error ?? ''}`)
    case 'task.blocked': return at('⊘', 'error', `${ev.taskId} blocked${ev.reason ? `: ${ev.reason}` : ' by a failed dependency'}`)
    case 'board.decision': return at('⚖', ev.decision === 'reject' ? 'error' : 'merged', `Board: ${ev.decision}: ${ev.summary ?? ''}`)
    case 'run.end': return at('■', ev.status === 'done' ? 'success' : 'warning', `Run ${String(ev.status).replace(/_/g, ' ')}${ev.error ? `: ${ev.error}` : ''}`)
    default: return at('·', 'subtle', String(ev.type))
  }
}

/** A text bar for places without a Progress element (the band): ▰▰▰▱▱. */
export function blocks(done: number, total: number, width = 8): string {
  if (total <= 0) return '▱'.repeat(width)
  const filled = Math.round((Math.min(done, total) / total) * width)
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

/** Spinner frames for an active run; one advances per animation tick. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
export const PULSE = ['●', '◉', '○', '◉'] as const
