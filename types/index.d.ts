export type ChatLive = {
  kind: 'interactive' | 'background'
  status: string | null
  state: string | null
  pid: number | null
  jobId: string | null
}

export type Signal = 'here' | 'needs-input' | 'your-turn' | 'failed' | 'working' | 'idle' | 'closed'

export type Chat = {
  sessionId: string
  title: string
  updatedAt: number
  signal: Signal
  live: ChatLive | null
  transcript: string | null
}

export type PrStatus = {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  checks: 'passing' | 'failing' | 'pending' | 'none'
  review: 'approved' | 'changes' | 'pending' | 'none'
  threads: number
  comments: number
}

export type Worktree = {
  path: string
  title: string
  branch: string | null
  isMain: boolean
  chats: Chat[]
  olderCount: number
  pr: PrStatus | null
}

export type Repo = {
  root: string
  name: string
  isCurrent: boolean
  worktrees: Worktree[]
  isUnavailable: boolean
}

export type Board = {
  repos: Repo[]
  refreshedAt: number
}

export type BranchList = {
  root: string
  refs: string[]
  defaultRef: string | null
  isLoading: boolean
}

export type ProjectList = {
  paths: string[]
  isLoading: boolean
}

export type BoardProps = {
  surface: 'terminal' | 'desktop'
  branches: BranchList | null
  projects: ProjectList | null
  board: Board
  toggled: string[]
  showingAll: string[]
}

export type BoardMessage =
  | { action: 'open-chat'; sessionId: string }
  | { action: 'new-chat'; path: string }
  | { action: 'toggle-fold'; key: string }
  | { action: 'toggle-older'; path: string }
  | { action: 'rename-chat'; sessionId: string; title: string }
  | { action: 'remove-project'; root: string }
  | { action: 'copy'; text: string }
  | { action: 'reveal'; path: string }
  | { action: 'browse'; url: string }
  | { action: 'delete-chat'; sessionId: string }
  | { action: 'remove-workspace'; path: string; dropBranch: boolean; force: boolean }
  | { action: 'clean-merged'; root: string }
  | { action: 'list-branches'; root: string }
  | { action: 'list-projects' }
  | { action: 'add-project'; path: string }
  | { action: 'new-workspace'; root: string; title: string; base: string; prompt: string }
  | { action: 'rename-workspace'; path: string; title: string }
  | { action: 'prune'; root: string }
  | { action: 'refresh' }
  | { action: 'close' }

declare module 'claude-code' {
  interface PluginState {
    worktrees: {
      board: Shaped<Board | null>
      showingAll: string[]
      toggled: string[]
      yourTurn: string[]
      branches: BranchList | null
      projects: ProjectList | null
    }
  }
}
