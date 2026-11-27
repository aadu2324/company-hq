/** A theme colour key the pane draws with (Claude Code's own palette, so it follows the user's theme). */
export type Hue =
  | 'claude' | 'success' | 'error' | 'warning' | 'suggestion' | 'permission' | 'planMode'
  | 'autoAccept' | 'merged' | 'remember' | 'subtle' | 'inactive' | 'text'

/** Where a run is in its life, left to right. */
export type Stage = 'plan' | 'build' | 'review' | 'board' | 'report'

export type Worker = { title: string; count: number }

/** One department, drawn as a card on the Team tab. */
export type DeptCard = {
  id: string
  name: string
  manager: string
  isBusy: boolean
  workers: Worker[]
  reviewers: string[]
}

/** An executive and the departments that report to them. */
export type ExecGroup = { title: string; depth: number; departments: DeptCard[] }

export type Verdict = { decision: string; score: number | null; summary: string }

export type TaskRow = {
  id: string
  department: string
  title: string
  status: string
  round: number
  /** Agents working on it right now. */
  working: string[]
  reviewers: string[]
  dependsOn: string[]
  verdict: Verdict | null
  error: string
  brief: string
  deliverable: string
  /** The review's open issues, most severe first. */
  issues: string[]
  /** Approved after the last revision round while reviewers still had issues. */
  isUnresolved: boolean
}

/** Who an agent is in the company, which decides its icon and colour. */
export type AgentRole = 'ceo' | 'manager' | 'reviewer' | 'board' | 'worker' | 'chat'

/** One agent's piece of work: a process (CEO, manager, reviewer, Board) or a worker subagent. */
export type AgentRow = {
  who: string
  role: AgentRole
  doing: string
  task: string
  since: string
  ended: string
  status: 'working' | 'done' | 'failed'
}

/** The plan's tasks in steps: a step starts when the steps before it are finished. */
export type PlanStep = { n: number; taskIds: string[] }

/** A Claude process this run has going right now, or one waiting for a slot. */
export type LiveProc = { label: string; since: string; isWaiting: boolean; freeMB: number | null }

/** Who holds a Claude process slot on this machine (any project). */
export type SlotHolder = { label: string; project: string; since: string; isThisRun: boolean }

export type RunView = {
  id: string
  status: string
  prompt: string
  goal: string
  questions: string[]
  tasks: TaskRow[]
  stage: Stage
  /** True when the run ended or stopped short of the stage it shows. */
  isStuck: boolean
  /** One plain sentence: what the company is doing right now. */
  now: string
  /** Set when Claude's usage limit stopped the work, with when it resets. */
  limitNote: string
  board: Verdict | null
  error: string
  cost: number
  startedAt: string
  finishedAt: string
  done: number
  failed: number
  /** Processes of this run running or waiting right now. */
  live: LiveProc[]
  /** When the current stretch of work began: the resume, or the start. */
  runningSince: string
  /** Paused, failed, stopped or partly failed: `hq resume` can carry it on. */
  canResume: boolean
  /** The question the run is waiting on the owner for, with the report it is based on. */
  checkpoint: { question: string; deliverablePath: string } | null
  doneMeans: string
  /** Every question the owner has answered on this run, oldest first. */
  decisions: { question: string; answer: string }[]
  steps: PlanStep[]
  resumes: number
}

export type RunBrief = { id: string; status: string; prompt: string; startedAt: string }

export type FeedItem = { time: string; icon: string; hue: Hue; text: string; isChat: boolean }

/** Everything the pane and band draw, rebuilt from .company files on a timer. */
export type Snapshot = {
  root: string
  hasTeam: boolean
  projectName: string
  type: string
  departments: number
  org: ExecGroup[]
  runs: RunBrief[]
  run: RunView | null
  /** True when the run shown is the newest one (not a past run picked from the list). */
  isLatest: boolean
  feed: FeedItem[]
  activeRuns: number
  working: number
  /** Claude process slots across every HQ run on this machine. */
  slots: { used: number; max: number; holders: SlotHolder[] }
  /** When the run last wrote anything (ISO), so the pane can say how fresh it is. */
  updatedAt: string
  /** Every agent of the shown run and the chat: who is working now, and who finished recently. */
  agents: { working: AgentRow[]; recent: AgentRow[] }
}

export type Tab = 'overview' | 'plan' | 'agents' | 'team' | 'tasks' | 'activity'

declare module 'claude-code' {
  interface PluginState {
    'company-hq': {
      snapshot: Shaped<Snapshot | null>
      isBandHidden: boolean
      notice: string
      tab: Tab
      /** A past run picked from the list; empty follows the newest run. */
      pickedRun: string
      /** Animation frame, ticking only while a run is active. */
      frame: number
      /** The task whose card is opened for details on the Tasks tab, or ''. */
      openTask: string
    }
  }
}
