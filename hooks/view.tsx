/**
 * What the HQ pane, its corner widget and the band above the prompt draw. Plain functions of the
 * snapshot: every press goes through `Actions`, so nothing here reaches `$`.
 */
import type { ExecGroup, FeedItem, Hue, RunView, Snapshot, Tab, TaskRow } from '../types'
import { ACTIVE_RUN, BUSY_TASK, PULSE, SPINNER, STAGES, ago, blocks, clock, runLook, taskLook, ticking } from './model'

/** The elements a surface resolves; each is used through JSX only. */
export type Ui = { Box: any; Text: any; Button: any; Progress: any; Input: any }

export type Actions = {
  setTab: (tab: Tab) => void
  pick: (runId: string) => void
  run: (request: string) => void
  hire: (type?: string) => void
  stop: (runId: string) => void
  resume: (runId: string) => void
  answer: (text: string) => void
  toggleTask: (taskId: string) => void
  refresh: () => void
  toggleBand: () => void
  open: () => void
}

export type PaneState = { tab: Tab; frame: number; notice: string; isBandHidden: boolean; openTask: string }

const SCAN_WIDTH = 22

/** An indeterminate bar that sweeps back and forth while the company is busy: ───━━●━━─── */
function scanner(frame: number, width = SCAN_WIDTH): string {
  const span = width - 3
  const step = frame % (span * 2)
  const at = step < span ? step : span * 2 - step
  return `${'─'.repeat(at)}━●━${'─'.repeat(span - at)}`
}

/** Slot dots: ●● filled for each Claude process running on this machine, ○ for free ones. */
function slotDots(used: number, max: number): string {
  return `${'●'.repeat(Math.min(used, max))}${'○'.repeat(Math.max(0, max - used))}`
}

const TABS: readonly { id: Tab; label: string; hotkey: string }[] = [
  { id: 'overview', label: 'Overview', hotkey: '1' },
  { id: 'team', label: 'Team', hotkey: '2' },
  { id: 'tasks', label: 'Tasks', hotkey: '3' },
  { id: 'activity', label: 'Activity', hotkey: '4' },
]
const TASKS_ON_OVERVIEW = 5
const FEED_ON_OVERVIEW = 5
const RUNS_LISTED = 5

const isLive = (run: RunView | null) => Boolean(run && ACTIVE_RUN.has(run.status))
const spin = (frame: number): string => SPINNER[frame % SPINNER.length] ?? '·'
const pulse = (frame: number): string => PULSE[frame % PULSE.length] ?? '●'
const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

function Pill(ui: Ui, label: string, hue: Hue) {
  return <ui.Text backgroundColor={hue} color="inverseText" bold> {label} </ui.Text>
}

function runIcon(run: RunView | null, frame: number): string {
  if (!run) return '·'
  return isLive(run) ? spin(frame) : runLook(run.status).icon
}

// ---------- header ----------

function Header(ui: Ui, snap: Snapshot, frame: number) {
  const { Box, Text } = ui
  const run = snap.run
  const look = run ? runLook(run.status) : runLook('idle')
  const isRunning = isLive(run)
  const stats = [
    snap.working ? `${snap.working} agent${snap.working === 1 ? '' : 's'} working` : 'no agents working',
    run ? `${run.done}/${run.tasks.length} tasks approved` : `${snap.departments} departments`,
    run && run.cost ? `$${run.cost.toFixed(2)}` : '',
    run ? (isRunning ? `running ${ticking(run.runningSince)}` :(run.finishedAt ? `took ${ticking(run.startedAt, Date.parse(run.finishedAt))}` : '')) : '',
  ].filter(Boolean).join('  ·  ')
  const slotHue: Hue = snap.slots.used >= snap.slots.max ? 'warning' : snap.slots.used ? 'success' : 'inactive'
  return (
    <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color="claude" bold>◆ Claude HQ</Text>
          <Text bold>{snap.projectName}</Text>
          {snap.type ? <Text dimColor>{snap.type}</Text> : null}
        </Box>
        <Box gap={1}>
          <Text color={look.hue}>{runIcon(run, frame)}</Text>
          {Pill(ui, look.label, look.hue)}
        </Box>
      </Box>
      <Text dimColor wrap="truncate">{stats}</Text>
      <Box gap={1}>
        <Text dimColor>Claude slots</Text>
        <Text color={slotHue}>{slotDots(snap.slots.used, snap.slots.max)}</Text>
        <Text dimColor>{snap.slots.used}/{snap.slots.max} in use</Text>
        {snap.updatedAt ? <Text dimColor>· updated {ago(snap.updatedAt)}</Text> : null}
      </Box>
    </Box>
  )
}

/** What this run has going right now: each process with a live timer, or who holds the slots it waits for. */
function Live(ui: Ui, snap: Snapshot, frame: number) {
  const { Box, Text } = ui
  const run = snap.run
  if (!run || !isLive(run) || !snap.isLatest) return null
  const others = snap.slots.holders.filter(holder => !holder.isThisRun)
  const isQueued = run.status === 'queued' || run.live.every(p => p.isWaiting)
  return (
    <Box borderStyle="round" borderColor="permission" paddingX={1} flexDirection="column">
      <Box gap={1}>
        <Text color="permission" bold>{spin(frame)} Live</Text>
        <Text color="claude">{scanner(frame)}</Text>
      </Box>
      {run.live.length === 0 ? <Text dimColor>Starting the next step…</Text> : null}
      {run.live.map(p => (
        <Box key={p.label} gap={1}>
          <Text color={p.isWaiting ? 'warning' : 'success'}>{p.isWaiting ? '◌' : spin(frame + 3)}</Text>
          <Text bold={!p.isWaiting} wrap="truncate">{p.label}</Text>
          <Text dimColor>{p.isWaiting ? `waiting ${ticking(p.since)}${p.freeMB != null ? ` · ${p.freeMB} MB free` : ''}` : ticking(p.since)}</Text>
        </Box>
      ))}
      {isQueued && others.length ? (
        <Box flexDirection="column">
          <Text color="warning">Slots taken by other work:</Text>
          {others.map(holder => (
            <Box key={`${holder.project}-${holder.label}-${holder.since}`} gap={1}>
              <Text color="suggestion">{spin(frame + 5)}</Text>
              <Text wrap="truncate">{holder.label}</Text>
              <Text dimColor>{holder.project ? `· ${holder.project} ` : ''}· {ticking(holder.since)}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

// ---------- stage pipeline and "now" ----------

function Pipeline(ui: Ui, run: RunView, frame: number) {
  const { Box, Text } = ui
  const at = STAGES.findIndex(s => s.id === run.stage)
  const isOver = run.status === 'done'
  return (
    <Box gap={1} flexWrap="wrap">
      {STAGES.map((s, i) => {
        const isDone = i < at || (isOver && i === at)
        const isHere = i === at && !isOver
        const hue: Hue = isDone ? 'success' : isHere ? (run.isStuck ? 'error' : 'claude') : 'inactive'
        const icon = isDone ? '✓' : isHere ? (run.isStuck ? '✗' : isLive(run) ? spin(frame) : '●') : '○'
        return (
          <Box key={s.id} gap={1}>
            <Text color={hue} bold={isHere}>{icon} {s.label}</Text>
            {i < STAGES.length - 1 ? <Text color={isDone ? 'success' : 'inactive'}>──</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function Now(ui: Ui, run: RunView, frame: number) {
  const { Box, Text } = ui
  const hue: Hue = run.limitNote ? 'warning' : run.isStuck ? 'error' : isLive(run) ? 'suggestion' : 'success'
  const icon = run.limitNote ? '⏸' : isLive(run) ? spin(frame) : runLook(run.status).icon
  const isPlanning = run.status === 'planning' || run.status === 'queued'
  return (
    <Box borderStyle="round" borderColor={hue} paddingX={1} flexDirection="column">
      <Box gap={1}>
        <Text color={hue} bold>{icon} Now</Text>
        {isLive(run) ? <Text color={hue}>{scanner(frame)}</Text> : null}
        {isPlanning && isLive(run) ? <Text dimColor>{ticking(run.runningSince)}</Text> : null}
      </Box>
      <Text>{run.now}</Text>
      {run.goal ? <Text dimColor wrap="truncate">Goal: {run.goal}</Text> : null}
      {run.questions.map(q => <Text color="warning">? {q}</Text>)}
    </Box>
  )
}

/** The run is waiting for the owner: the question, the report behind it, and a box to answer. */
function Decision(ui: Ui, run: RunView, actions: Actions) {
  const { Box, Text, Input } = ui
  if (!run.checkpoint) return null
  return (
    <Box borderStyle="round" borderColor="permission" paddingX={1} flexDirection="column" gap={1}>
      <Text color="permission" bold>? Your decision</Text>
      <Text bold>{run.checkpoint.question}</Text>
      {run.checkpoint.deliverablePath ? <Text dimColor wrap="truncate-middle">Read first: {run.checkpoint.deliverablePath}</Text> : null}
      <Input
        key="answer"
        label="Your answer"
        placeholder="e.g. Pursue gap 2, but keep it within what my GPU can train"
        submitLabel="Answer"
        rows={3}
        onSubmit={(value: string) => { if (value.trim()) actions.answer(value.trim()) }}
      />
      <ui.Button key="stop-waiting" plain label="Stop this run instead" onPress={() => actions.stop(run.id)} />
    </Box>
  )
}

function Progressbar(ui: Ui, run: RunView) {
  const total = run.tasks.length
  if (total === 0) return null
  const hue: Hue = run.failed ? 'warning' : 'success'
  const extra = run.failed ? ` · ${run.failed} failed or blocked` : ''
  return <ui.Progress label="Tasks approved" value={run.done} max={total} valueText={`${run.done} of ${total}${extra}`} color={hue} />
}

// ---------- tasks ----------

/** A task approved with review issues still open reads as a warning, not a plain success. */
function lookOf(t: TaskRow) {
  const look = taskLook(t.status)
  return t.status === 'approved' && t.isUnresolved ? { label: 'APPROVED ⚠', hue: 'warning' as Hue, icon: '⚠' } : look
}

function TaskLine(ui: Ui, t: TaskRow, frame: number) {
  const { Box, Text } = ui
  const look = lookOf(t)
  const icon = BUSY_TASK.has(t.status) && t.status !== 'queued' ? spin(frame) : look.icon
  return (
    <Box gap={1}>
      <Text color={look.hue}>{icon}</Text>
      <Text bold wrap="truncate">{t.title}</Text>
      <Text dimColor wrap="truncate">· {t.department}{t.working.length ? ` · ${t.working.length} working` : ''}</Text>
    </Box>
  )
}

function TaskCard(ui: Ui, t: TaskRow, frame: number, isOpen: boolean, actions: Actions) {
  const { Box, Text, Button } = ui
  const look = lookOf(t)
  const meta = [t.department, t.id, t.round ? `revision ${t.round}` : '', t.dependsOn.length ? `after ${t.dependsOn.join(', ')}` : '']
    .filter(Boolean).join(' · ')
  const v = t.verdict
  const verdictHue: Hue = v?.decision === 'approve' ? 'success' : v?.decision === 'reject' ? 'error' : 'warning'
  return (
    <Box key={t.id} borderStyle="round" borderColor={look.hue} paddingX={1} flexDirection="column">
      <Box gap={1}>
        {Pill(ui, look.label, look.hue)}
        <Text bold wrap="truncate">{t.title}</Text>
      </Box>
      <Text dimColor wrap="truncate">{meta}</Text>
      {t.working.length ? <Text color="suggestion" wrap="truncate">{pulse(frame)} {t.working.join(', ')}</Text> : null}
      {t.reviewers.length ? <Text color="merged" dimColor wrap="truncate">⚖ {t.reviewers.join(', ')}</Text> : null}
      {v ? <Text color={verdictHue} maxLines={isOpen ? 6 : 2}>⚖ {v.decision}{v.score != null ? ` ${v.score}/10` : ''}: {v.summary}</Text> : null}
      {t.isUnresolved ? <Text color="warning">⚠ Approved after the last revision round; reviewers still had open issues.</Text> : null}
      {t.error ? <Text color="error" maxLines={isOpen ? 6 : 2}>✗ {t.error}</Text> : null}
      {isOpen ? (
        <Box flexDirection="column" marginTop={1}>
          {t.brief ? <Text bold>Brief</Text> : null}
          {t.brief ? <Text maxLines={8}>{t.brief}</Text> : null}
          {t.deliverable ? <Text dimColor maxLines={3}>Deliverable: {t.deliverable}</Text> : null}
          {t.issues.length ? <Text color="warning" bold>Open issues</Text> : null}
          {t.issues.map((i, n) => <Text color="warning" maxLines={3}>{n + 1}. {i}</Text>)}
        </Box>
      ) : null}
      <Box>
        <Button key={`task-${t.id}`} plain label={isOpen ? '▾ Hide details' : '▸ Details'} onPress={() => actions.toggleTask(t.id)} />
      </Box>
    </Box>
  )
}

function busyFirst(tasks: TaskRow[]): TaskRow[] {
  const rank = (t: TaskRow) => (BUSY_TASK.has(t.status) ? 0 : t.status === 'failed' || t.status === 'blocked' ? 1 : t.status === 'pending' ? 2 : 3)
  return [...tasks].sort((a, b) => rank(a) - rank(b))
}

// ---------- team ----------

function Team(ui: Ui, groups: ExecGroup[], frame: number) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text color="claude" bold>⚖ Board of Directors</Text>
        <Text dimColor>· chair, risk, quality</Text>
      </Box>
      {groups.map(g => (
        <Box key={`${g.title}-${g.depth}`} flexDirection="column" marginLeft={g.depth * 2} gap={0}>
          <Text color="permission" bold>★ {g.title}</Text>
          {g.departments.map(d => (
            <Box key={d.id} borderStyle="round" borderColor={d.isBusy ? 'success' : 'subtle'} paddingX={1} flexDirection="column" marginLeft={2}>
              <Box gap={1}>
                <Text color={d.isBusy ? 'success' : 'inactive'}>{d.isBusy ? pulse(frame) : '○'}</Text>
                <Text bold>{d.name}</Text>
                <Text dimColor wrap="truncate">· {d.manager}</Text>
                {d.isBusy ? Pill(ui, 'ACTIVE', 'success') : null}
              </Box>
              {d.workers.map(w => (
                <Text color={w.count ? 'success' : undefined} dimColor={!w.count} wrap="truncate">
                  {'  '}{w.count ? `${pulse(frame)} ${w.title} ×${w.count}` : `· ${w.title}`}
                </Text>
              ))}
              {d.reviewers.length ? <Text color="merged" dimColor wrap="truncate">  ⚖ {d.reviewers.join(', ')}</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// ---------- activity ----------

function FeedLine(ui: Ui, f: FeedItem) {
  const { Box, Text } = ui
  return (
    <Box gap={1}>
      <Text dimColor>{f.time}</Text>
      <Text color={f.hue}>{f.icon}</Text>
      {f.isChat ? <Text color="remember">chat</Text> : null}
      <Text wrap="truncate" dimColor={f.hue === 'subtle'}>{f.text}</Text>
    </Box>
  )
}

// ---------- overview pieces ----------

function Ask(ui: Ui, actions: Actions, isBusy: boolean) {
  return (
    <ui.Input
      key="ask"
      label={isBusy ? 'Queue another request' : 'Ask the company'}
      placeholder="e.g. Draft a launch email sequence and a landing page for it"
      submitLabel="Run"
      onSubmit={(value: string) => { if (value.trim()) actions.run(value.trim()) }}
    />
  )
}

function RunList(ui: Ui, snap: Snapshot, actions: Actions) {
  const { Box, Text, Button } = ui
  if (snap.runs.length < 2 && snap.isLatest) return null
  return (
    <Box flexDirection="column">
      <Text bold>Recent runs</Text>
      {snap.runs.slice(0, RUNS_LISTED).map(r => {
        const look = runLook(r.status)
        const isShown = snap.run?.id === r.id
        return (
          <Box key={r.id} gap={1}>
            <Text color={look.hue}>{look.icon}</Text>
            <Text dimColor>{clock(r.startedAt)}</Text>
            <Button key={`run-${r.id}`} plain label={`${isShown ? '▸ ' : ''}${short(r.prompt, 56)}`} onPress={() => actions.pick(r.id)} />
          </Box>
        )
      })}
    </Box>
  )
}

function Overview(ui: Ui, snap: Snapshot, state: PaneState, actions: Actions) {
  const { Box, Text } = ui
  const run = snap.run
  if (!run) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>The team is ready and waiting. Describe what you want done; the CEO will plan it across departments.</Text>
        {Ask(ui, actions, false)}
      </Box>
    )
  }
  const tasks = busyFirst(run.tasks)
  return (
    <Box flexDirection="column" gap={1}>
      {Pipeline(ui, run, state.frame)}
      {Now(ui, run, state.frame)}
      {snap.isLatest ? Decision(ui, run, actions) : null}
      {Live(ui, snap, state.frame)}
      {Progressbar(ui, run)}
      {tasks.length ? (
        <Box flexDirection="column">
          <Text bold>Tasks</Text>
          {tasks.slice(0, TASKS_ON_OVERVIEW).map(t => TaskLine(ui, t, state.frame))}
          {tasks.length > TASKS_ON_OVERVIEW ? <Text dimColor>+{tasks.length - TASKS_ON_OVERVIEW} more on the Tasks tab</Text> : null}
        </Box>
      ) : null}
      {run.board ? <Text color={run.board.decision === 'reject' ? 'error' : 'merged'} maxLines={3}>⚖ Board: {run.board.decision}: {run.board.summary}</Text> : null}
      {snap.feed.length ? (
        <Box flexDirection="column">
          <Text bold>Latest</Text>
          {snap.feed.slice(-FEED_ON_OVERVIEW).map(f => FeedLine(ui, f))}
        </Box>
      ) : null}
      {Ask(ui, actions, isLive(run))}
      {RunList(ui, snap, actions)}
    </Box>
  )
}

function Tabs(ui: Ui, tab: Tab, actions: Actions, snap: Snapshot) {
  const { Box, Button } = ui
  const count = (id: Tab) => (id === 'tasks' && snap.run ? ` ${snap.run.tasks.length}` : id === 'team' ? ` ${snap.departments}` : '')
  return (
    <Box gap={1} flexWrap="wrap">
      {TABS.map(t => (
        <Button
          key={`tab-${t.id}`}
          label={`${t.label}${count(t.id)}`}
          hotkey={t.hotkey}
          variant={t.id === tab ? 'primary' : 'secondary'}
          onPress={() => actions.setTab(t.id)}
        />
      ))}
    </Box>
  )
}

function Footer(ui: Ui, snap: Snapshot, state: PaneState, actions: Actions) {
  const { Box, Text, Button } = ui
  const run = snap.run
  return (
    <Box flexDirection="column">
      {state.notice ? <Text color="warning" maxLines={3}>{state.notice}</Text> : null}
      <Box gap={1} flexWrap="wrap">
        {run && isLive(run) && snap.isLatest ? <Button key="stop" label="Stop run" onPress={() => actions.stop(run.id)} /> : null}
        {run && run.canResume && snap.activeRuns === 0 ? <Button key="resume" label="▶ Resume run" variant="primary" onPress={() => actions.resume(run.id)} /> : null}
        {!snap.isLatest ? <Button key="latest" label="Back to latest run" variant="primary" onPress={() => actions.pick('')} /> : null}
        <Button key="refresh" label="Refresh" hotkey="r" onPress={actions.refresh} />
        <Button key="band" label={state.isBandHidden ? 'Show status row' : 'Hide status row'} onPress={actions.toggleBand} />
      </Box>
      {run ? <Text dimColor wrap="truncate">Report: .company/runs/{run.id}/report.md</Text> : null}
    </Box>
  )
}

// ---------- the three surfaces ----------

function NoTeam(ui: Ui, snap: Snapshot, notice: string, actions: Actions) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text color="claude" bold>◆ Claude HQ</Text>
          <Text bold>{snap.projectName}</Text>
        </Box>
        <Text>No team has been hired for this project yet.</Text>
      </Box>
      <Text dimColor>The org designer reads the repository and tailors a team: departments, managers, workers, reviewers and legal. It takes about 1–2 minutes.</Text>
      <Box gap={1} flexWrap="wrap">
        <Button key="hire" label="Hire a team" variant="primary" onPress={() => actions.hire()} />
        <Button key="hire-startup" label="Startup" onPress={() => actions.hire('startup')} />
        <Button key="hire-research" label="Research" onPress={() => actions.hire('research')} />
        <Button key="hire-software" label="Software" onPress={() => actions.hire('software')} />
        <Button key="hire-frontier" label="Frontier research" onPress={() => actions.hire('frontier')} />
      </Box>
      {notice ? <Text color="warning">{notice}</Text> : null}
    </Box>
  )
}

function Widget(ui: Ui, snap: Snapshot, frame: number) {
  const { Box, Text } = ui
  const run = snap.run
  const look = run ? runLook(run.status) : runLook('idle')
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={look.hue}>{runIcon(run, frame)}</Text>
        <Text bold wrap="truncate">{snap.projectName}</Text>
        {Pill(ui, look.label, look.hue)}
      </Box>
      {run ? Progressbar(ui, run) : <Text dimColor>{snap.hasTeam ? `${snap.departments} departments ready` : 'No team yet'}</Text>}
      {run ? <Text maxLines={2}>{run.now}</Text> : null}
    </Box>
  )
}

export function paneView(ui: Ui, snap: Snapshot | null, state: PaneState, placement: string, actions: Actions) {
  const { Box, Text } = ui
  if (!snap) return <Text dimColor>{spin(state.frame)} Loading Claude HQ…</Text>
  if (placement === 'widget') return Widget(ui, snap, state.frame)
  if (!snap.hasTeam) return NoTeam(ui, snap, state.notice, actions)
  const run = snap.run
  const body =
    state.tab === 'team' ? Team(ui, snap.org, state.frame)
      : state.tab === 'tasks' ? (run && run.tasks.length
        ? <Box flexDirection="column">{busyFirst(run.tasks).map(t => TaskCard(ui, t, state.frame, state.openTask === t.id, actions))}</Box>
        : <Text dimColor>No tasks yet. Ask the company for something on the Overview tab.</Text>)
        : state.tab === 'activity' ? (snap.feed.length
          ? <Box flexDirection="column">{snap.feed.map(f => FeedLine(ui, f))}</Box>
          : <Text dimColor>Nothing yet. Delegation from this chat shows here too.</Text>)
          : Overview(ui, snap, state, actions)
  return (
    <Box flexDirection="column" gap={1}>
      {Header(ui, snap, state.frame)}
      {!snap.isLatest ? <Text color="warning">Viewing a past run.</Text> : null}
      {Tabs(ui, state.tab, actions, snap)}
      {body}
      {Footer(ui, snap, state, actions)}
    </Box>
  )
}

/** The row above the prompt: status pill, a progress bar in blocks, and what is happening now. */
export function bandView(ui: Ui, snap: Snapshot, frame: number, actions: Actions) {
  const { Box, Text, Button } = ui
  const run = snap.run
  const live = isLive(run)
  const needsYou = Boolean(run?.checkpoint && snap.isLatest)
  const look = (live || needsYou) && run ? runLook(run.status) : runLook('idle')
  const progress = live && run && run.tasks.length ? `${blocks(run.done, run.tasks.length)} ${run.done}/${run.tasks.length}` : ''
  const said = needsYou && run?.checkpoint
    ? `${run.checkpoint.question} · answer in the pane or /hq answer <text>`
    : live && run ? run.now : `${snap.departments} departments ready · /hq run <request>`
  return (
    <Box gap={1}>
      <Text color="claude" bold>{live ? spin(frame) : '◆'} HQ</Text>
      {Pill(ui, look.label, look.hue)}
      {progress ? <Text color="success">{progress}</Text> : null}
      <Text dimColor={!live} wrap="truncate">{said}</Text>
      <Button key="open" label="Open" onPress={actions.open} />
      <Button key="hide" label="Hide" onPress={actions.toggleBand} />
    </Box>
  )
}
