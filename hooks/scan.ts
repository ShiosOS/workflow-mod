import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry } from 'claude-code'

import type { Board, Chat, ChatLive, Repo, Signal, Worktree } from '../types'
import { listWorktrees, rootOf } from './git'
import { forgetPrs, hasOwnPr, prsOf } from './github'
import { claudeDir, listAgents } from './host'
import { parseHistory, titleOf } from './parse'
import type { AgentRow, HistoryRow, WorktreeRef } from './parse'
import { joinPath, lastSegment, pathKey, projectDirName, samePath } from './paths'
import { repoChats } from './rows'
import { BOARD_SHAPE, keep, load } from './state'
import type { Saved } from './state'
import { clip, defaultTitle } from './text'

// The state this file reads or writes, declared here: the engine lists a
// module's state from the literal references in the file that uses them.
const board = atom({ plugin: 'worktrees', key: 'board' } as const, null, { shape: BOARD_SHAPE })
const showingAll = atom({ plugin: 'worktrees', key: 'showingAll' } as const, [])
const yourTurn = atom({ plugin: 'worktrees', key: 'yourTurn' } as const, [])

const RECENT = 6
const TITLE_TTL_MS = 30_000
const MAX_READ = 4 * 1024 * 1024

type Scan = {
  agents: AgentRow[]
  projects: string
  folders: Map<string, string>
  currentId: string
  showingAll: string[]
  chatTitles: Saved['titles']
  workspaceTitles: Saved['workspaceTitles']
  waiting: Set<string>
  now: number
}

let history: { mtimeMs: number; rows: HistoryRow[] } | null = null

export async function readHistory($: EngineInterface) {
  const path = joinPath(await claudeDir($), 'history.jsonl')
  const stat = await $.fs.stat(path).catch(() => null)
  if (stat !== null && history?.mtimeMs === stat.mtimeMs) return history.rows
  if (stat !== null && stat.size > MAX_READ) return []
  const text = await $.fs.read(path).catch(() => '')
  const rows = parseHistory(typeof text === 'string' ? text : '')
  if (stat !== null) history = { mtimeMs: stat.mtimeMs, rows }
  return rows
}

async function latestPrompt($: EngineInterface, sessionId: string) {
  return (await readHistory($)).findLast(row => row.sessionId === sessionId && row.display !== null)?.display ?? undefined
}

type Read = { kind: 'titled'; text: string } | { kind: 'untitled' }
type TranscriptTitle = Read | { kind: 'unread' }

type Cached = { mtimeMs: number; read: Read; readAt: number }
const titles = new Map<string, Cached>()

const readOf = (title: string | null): Read =>
  title === null ? { kind: 'untitled' } : { kind: 'titled', text: title }

const stale = (cached: Cached | undefined): TranscriptTitle =>
  cached?.read.kind === 'titled' ? cached.read : { kind: 'unread' }

async function transcriptTitle($: EngineInterface, path: string, file: FsEntry, now: number): Promise<TranscriptTitle> {
  const cached = titles.get(path)
  const isFresh = cached !== undefined && (cached.mtimeMs === file.mtimeMs || now - cached.readAt < TITLE_TTL_MS)
  if (isFresh) return cached.read
  if (file.size > MAX_READ) return stale(cached)
  const text = await $.fs.read(path).catch(() => null)
  if (typeof text !== 'string') return stale(cached)
  const read = readOf(titleOf(text))
  titles.set(path, { mtimeMs: file.mtimeMs, read, readAt: now })
  return read
}

export const forgetTitle = (transcript: string) => titles.delete(transcript)

const isBusy = (live: ChatLive) =>
  live.status === 'busy' || live.state === 'working' || live.state === 'running'

const signalOf = (sessionId: string, live: ChatLive | null, scan: Scan): Signal => {
  if (sessionId === scan.currentId) return 'here'
  if (live === null) return 'closed'
  if (live.kind === 'background' && live.state === 'blocked') return 'needs-input'
  if (live.kind === 'background' && live.state === 'failed') return 'failed'
  if (isBusy(live)) return 'working'
  if (scan.waiting.has(sessionId)) return 'your-turn'
  return 'idle'
}

const RANK: Record<Signal, number> = {
  'needs-input': 0, 'your-turn': 1, failed: 2, working: 3, here: 4, idle: 5, closed: 6,
}

const byUrgencyThenRecent = (a: Chat, b: Chat) =>
  RANK[a.signal] - RANK[b.signal] || b.updatedAt - a.updatedAt

const lastActive = (wt: Worktree) => Math.max(0, ...wt.chats.map(chat => chat.updatedAt))
const urgency = (wt: Worktree) => Math.min(6, ...wt.chats.map(chat => RANK[chat.signal]))

const byImportance = (a: Worktree, b: Worktree) =>
  Number(b.isMain) - Number(a.isMain) || urgency(a) - urgency(b) || lastActive(b) - lastActive(a)

async function worktreeOf($: EngineInterface, scan: Scan, ref: WorktreeRef): Promise<Omit<Worktree, 'pr'>> {
  const folder = scan.folders.get(projectDirName(ref.path).toLowerCase())
  const folderPath = folder === undefined ? null : joinPath(scan.projects, folder)
  const files = folderPath === null
    ? []
    : (await $.fs.list(folderPath).catch(() => []))
        .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const unseen = new Map(
    scan.agents.filter(agent => samePath(agent.cwd, ref.path)).map(agent => [agent.sessionId, agent]),
  )
  const limit = scan.showingAll.includes(ref.path) ? Infinity : RECENT
  const chats: Chat[] = []
  let olderCount = 0

  for (const file of files) {
    const sessionId = file.name.slice(0, -'.jsonl'.length)
    const agent = unseen.get(sessionId)
    unseen.delete(sessionId)
    const isPinned = agent !== undefined || sessionId === scan.currentId
    const closedShown = chats.filter(chat => chat.signal === 'closed').length
    if (!isPinned && closedShown >= limit) {
      olderCount += 1
      continue
    }
    const transcript = joinPath(folderPath ?? '', file.name)
    const found = await transcriptTitle($, transcript, file, scan.now)
    if (found.kind === 'untitled' && !isPinned) continue
    chats.push({
      sessionId,
      title: scan.chatTitles[sessionId] ??
        (found.kind === 'titled' ? found.text : undefined) ??
        agent?.name ??
        (await latestPrompt($, sessionId)) ??
        `chat ${sessionId.slice(0, 8)}`,
      updatedAt: file.mtimeMs,
      signal: signalOf(sessionId, agent?.live ?? null, scan),
      live: agent?.live ?? null,
      transcript,
    })
  }
  for (const agent of unseen.values()) {
    chats.push({
      sessionId: agent.sessionId,
      title: scan.chatTitles[agent.sessionId] ?? agent.name ?? 'new chat',
      updatedAt: agent.startedAt,
      signal: signalOf(agent.sessionId, agent.live, scan),
      live: agent.live,
      transcript: null,
    })
  }

  chats.sort(byUrgencyThenRecent)
  return {
    path: ref.path,
    title: scan.workspaceTitles[pathKey(ref.path)] ?? defaultTitle(ref.branch, ref.path),
    branch: ref.branch,
    isMain: ref.isMain,
    chats,
    olderCount,
  }
}

const wasBusy = new Set<string>()

async function trackTurns($: EngineInterface, agents: AgentRow[], currentId: string) {
  const waiting = new Set(await read($, yourTurn))
  for (const agent of agents) {
    if (agent.sessionId === currentId) continue
    if (isBusy(agent.live)) {
      wasBusy.add(agent.sessionId)
      waiting.delete(agent.sessionId)
    } else if (wasBusy.delete(agent.sessionId)) {
      waiting.add(agent.sessionId)
    }
  }
  const live = new Set(agents.map(agent => agent.sessionId))
  for (const id of waiting) if (!live.has(id)) waiting.delete(id)
  await update($, yourTurn, () => [...waiting])
  return waiting
}

async function repoOf($: EngineInterface, scan: Scan, root: string, refs: WorktreeRef[] | null, isCurrent: boolean): Promise<Repo> {
  const all = refs ?? []
  const [prs, worktrees] = await Promise.all([
    prsOf($, root, all.map(ref => ref.branch).filter(hasOwnPr), scan.now),
    Promise.all(all.map(ref => worktreeOf($, scan, ref))),
  ])
  return {
    root,
    name: lastSegment(root),
    isCurrent,
    worktrees: worktrees
      .map((wt): Worktree => ({ ...wt, pr: hasOwnPr(wt.branch) ? (prs.get(wt.branch) ?? null) : null }))
      .sort(byImportance),
    isUnavailable: refs === null,
  }
}

async function scanBoard($: EngineInterface): Promise<Board> {
  const [now, listed, deleted, dir, currentId, showing, known, chatTitles, workspaceTitles, here] = await Promise.all([
    $.clock.now(),
    listAgents($),
    load($, 'deleted'),
    claudeDir($),
    $.session.id(),
    read($, showingAll),
    load($, 'repos'),
    load($, 'titles'),
    load($, 'workspaceTitles'),
    listWorktrees($),
  ])
  const projects = joinPath(dir, 'projects')
  const folders = new Map(
    (await $.fs.list(projects).catch(() => []))
      .filter(entry => entry.kind === 'dir')
      .map(entry => [entry.name.toLowerCase(), entry.name]),
  )
  const gone = new Set(deleted)
  const agents = listed.filter(agent => !gone.has(agent.sessionId))
  const waiting = await trackTurns($, agents, currentId)
  const scan: Scan = { agents, projects, folders, currentId, showingAll: showing, chatTitles, workspaceTitles, waiting, now }

  const hereRoot = here === null ? undefined : rootOf(here)
  const isNew = hereRoot !== undefined && !known.some(root => samePath(root, hereRoot))
  const roots = isNew ? [...known, hereRoot] : known
  if (isNew) await keep($, 'repos', roots)
  const repos = await Promise.all(roots.map(async root => {
    const isCurrent = hereRoot !== undefined && samePath(root, hereRoot)
    return repoOf($, scan, root, isCurrent ? here : await listWorktrees($, root), isCurrent)
  }))
  return { repos, refreshedAt: now }
}

const lastSignals = new Map<string, Signal>()

function signalChanges($: EngineInterface, next: Board) {
  const isFirst = lastSignals.size === 0
  for (const chat of next.repos.flatMap(repoChats)) {
    const before = lastSignals.get(chat.sessionId)
    const needs = chat.signal === 'needs-input' || chat.signal === 'your-turn'
    if (!isFirst && needs && before !== chat.signal) {
      $.ui.toast(`"${clip(chat.title, 40)}" ${chat.signal === 'needs-input' ? 'needs your input' : 'is waiting for you'}`, { timeoutMs: 8000 })
    }
    lastSignals.set(chat.sessionId, chat.signal)
  }
}

let isRefreshing = false
let lastRefreshAt = 0

export const sinceRefresh = (now: number) => now - lastRefreshAt

export async function refresh($: EngineInterface, options: { isForced?: boolean } = {}) {
  if (isRefreshing) return
  isRefreshing = true
  if (options.isForced === true) forgetPrs()
  try {
    const next = await scanBoard($)
    lastRefreshAt = next.refreshedAt
    await update($, board, () => next)
    signalChanges($, next)
  } catch (error) {
    $.ui.toast(`worktrees: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    isRefreshing = false
  }
}
