export type Tone = 'board' | 'exec' | 'dept' | 'busyDept' | 'worker' | 'busy' | 'review'

export type OrgLine = { text: string; tone: Tone }

export type TaskRow = {
  id: string
  department: string
  title: string
  status: string
  working: number
  round: number
}

export type RunView = {
  id: string
  status: string
  prompt: string
  goal: string
  questions: string[]
  tasks: TaskRow[]
  board: string
  error: string
  cost: number
}

export type RunBrief = { id: string; status: string; prompt: string }

/** Everything the pane and band draw, rebuilt from .company files on a timer. */
export type Snapshot = {
  root: string
  hasTeam: boolean
  projectName: string
  type: string
  departments: number
  org: OrgLine[]
  runs: RunBrief[]
  run: RunView | null
  feed: string[]
  activeRuns: number
  working: number
}

declare module 'claude-code' {
  interface PluginState {
    'company-hq': {
      snapshot: Shaped<Snapshot | null>
      isBandHidden: boolean
      notice: string
    }
  }
}
