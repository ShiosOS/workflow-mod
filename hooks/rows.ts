import type { Board, Chat, PrStatus, Repo, Worktree } from '../types'

type Base = { key: string; depth: number; guide: string }

export type Row =
  | Base & { kind: 'gap'; parent: null }
  | Base & { kind: 'repo'; parent: null; repo: Repo; isOpen: boolean }
  | Base & { kind: 'worktree'; parent: string; wt: Worktree; isOpen: boolean }
  | Base & { kind: 'quiet'; parent: string; count: number; isOpen: boolean }
  | Base & { kind: 'pr'; parent: string; wt: Worktree; pr: PrStatus }
  | Base & { kind: 'chat'; parent: string; wt: Worktree; chat: Chat; hotkey: string | null }
  | Base & { kind: 'older'; parent: string; wt: Worktree; isShowingAll: boolean }
  | Base & { kind: 'add'; parent: null }

type Foldable = Extract<Row, { isOpen: boolean }>

export const isFoldable = (row: Row): row is Foldable =>
  row.kind === 'repo' || row.kind === 'worktree' || row.kind === 'quiet'

export const isNavigable = (row: Row) => row.kind !== 'gap'

const isOpen = (key: string, byDefault: boolean, toggled: readonly string[]) =>
  byDefault !== toggled.includes(key)

const isQuiet = (wt: Worktree) => wt.chats.length === 0 && wt.olderCount === 0 && wt.pr === null

const branch = (isLast: boolean) => (isLast ? '└── ' : '├── ')
const stem = (isLast: boolean) => (isLast ? '    ' : '│   ')
const INDENT = '    '

export const ADD_PROJECT = 'add-project'

export const buildRows = (
  board: Board,
  toggled: readonly string[],
  showingAll: readonly string[],
): Row[] => {
  const rows: Row[] = []
  let hotkey = 1

  const pushWorktree = (wt: Worktree, parent: string, depth: number, byDefault: boolean, guide: string, childGuide: string) => {
    const key = `wt:${wt.path}`
    const open = isOpen(key, byDefault, toggled)
    rows.push({ kind: 'worktree', key, parent, depth, guide, wt, isOpen: open })
    if (!open) return
    const child = { parent: key, depth: depth + 1, guide: childGuide, wt }
    if (wt.pr !== null) rows.push({ ...child, kind: 'pr', key: `pr:${wt.path}`, pr: wt.pr })
    for (const chat of wt.chats) {
      const digit = chat.signal === 'here' || hotkey > 9 ? null : String(hotkey++)
      rows.push({ ...child, kind: 'chat', key: `chat:${chat.sessionId}`, chat, hotkey: digit })
    }
    if (wt.olderCount > 0 || showingAll.includes(wt.path)) {
      rows.push({ ...child, kind: 'older', key: `older:${wt.path}`, isShowingAll: wt.olderCount === 0 })
    }
  }

  const space = (key: string, guide: string) =>
    rows.push({ kind: 'gap', key: `gap:${key}`, parent: null, depth: 0, guide })

  for (const repo of board.repos) {
    if (rows.length > 0) {
      space(`${repo.root}:before`, '')
      space(`${repo.root}:before-2`, '')
    }
    const key = `repo:${repo.root}`
    const open = isOpen(key, true, toggled)
    rows.push({ kind: 'repo', key, parent: null, depth: 0, guide: '', repo, isOpen: open })
    if (!open) continue
    const busy = repo.worktrees.filter(one => !isQuiet(one))
    const quiet = repo.worktrees.filter(isQuiet)
    busy.forEach((wt, i) => {
      const isLast = i === busy.length - 1 && quiet.length === 0
      space(wt.path, '│')
      pushWorktree(wt, key, 1, true, branch(isLast), stem(isLast))
    })
    if (quiet.length === 0) continue
    const quietKey = `quiet:${repo.root}`
    const quietOpen = isOpen(quietKey, false, toggled)
    space(quietKey, '│')
    rows.push({ kind: 'quiet', key: quietKey, parent: key, depth: 1, guide: branch(true), count: quiet.length, isOpen: quietOpen })
    if (!quietOpen) continue
    quiet.forEach((wt, i) => {
      const isLast = i === quiet.length - 1
      space(wt.path, `${INDENT}│`)
      pushWorktree(wt, quietKey, 2, false, `${INDENT}${branch(isLast)}`, `${INDENT}${stem(isLast)}`)
    })
  }
  if (rows.length > 0) {
    space('add:before', '')
    space('add:before-2', '')
  }
  rows.push({ kind: 'add', key: ADD_PROJECT, parent: null, depth: 0, guide: '' })
  return rows
}

export type Tally = { needs: number; working: number; failed: number; chats: number }

export const tally = (chats: readonly Chat[]): Tally => ({
  needs: chats.filter(chat => chat.signal === 'needs-input' || chat.signal === 'your-turn').length,
  working: chats.filter(chat => chat.signal === 'working').length,
  failed: chats.filter(chat => chat.signal === 'failed').length,
  chats: chats.length,
})

export const repoChats = (repo: Repo) => repo.worktrees.flatMap(wt => wt.chats)

const isAnimated = (chat: Chat) =>
  chat.signal === 'working' || chat.signal === 'needs-input' || chat.signal === 'your-turn'

export const isMoving = (board: Board) =>
  board.repos.some(repo =>
    repo.worktrees.some(wt => wt.pr?.checks === 'pending' || wt.chats.some(isAnimated)),
  )
