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
}

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
}

export type Tab = 'overview' | 'team' | 'tasks' | 'activity'

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
    }
  }
}
