import type { ChatLive } from '../types'
import { toNativePath } from './paths'
import { oneLine } from './text'

export type WorktreeRef = { path: string; branch: string | null; isMain: boolean }

export type AgentRow = {
  sessionId: string
  cwd: string
  kind: 'interactive' | 'background'
  name: string | null
  startedAt: number
  live: ChatLive
}

export type HistoryRow = { sessionId: string | null; display: string | null; project: string | null; at: number }

// `git worktree list --porcelain` lists the main worktree first.
export const parseWorktrees = (porcelain: string): WorktreeRef[] =>
  porcelain
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(line => line !== ''))
    .flatMap((lines, index) => {
      const head = lines.find(line => line.startsWith('worktree '))
      const isUnusable =
        lines.includes('bare') || lines.some(line => line.startsWith('prunable'))
      if (head === undefined || isUnusable) return []
      const branch = lines.find(line => line.startsWith('branch '))
      return [{
        path: toNativePath(head.slice('worktree '.length)),
        branch: branch === undefined
          ? null
          : branch.slice('branch '.length).replace(/^refs\/heads\//, ''),
        isMain: index === 0,
      }]
    })

export const parseAgents = (json: string): AgentRow[] => {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row): AgentRow[] => {
    if (typeof row !== 'object' || row === null) return []
    const r = row as Record<string, unknown>
    if (typeof r.sessionId !== 'string' || typeof r.cwd !== 'string') return []
    const kind = r.kind === 'background' ? 'background' : 'interactive'
    return [{
      sessionId: r.sessionId,
      cwd: r.cwd,
      kind,
      name: typeof r.name === 'string' ? r.name : null,
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
      live: {
        kind,
        status: typeof r.status === 'string' ? r.status : null,
        state: typeof r.state === 'string' ? r.state : null,
        pid: typeof r.pid === 'number' ? r.pid : null,
        jobId: typeof r.id === 'string' ? r.id : null,
      },
    }]
  })
}

const TITLE_RECORDS = [
  ['custom-title', 'customTitle'],
  ['agent-name', 'agentName'],
  ['ai-title', 'aiTitle'],
  ['last-prompt', 'lastPrompt'],
] as const

const lineAt = (text: string, at: number) => {
  const end = text.indexOf('\n', at)
  return text.slice(at, end < 0 ? undefined : end)
}

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const firstPrompt = (text: string): string | null => {
  let at = text.indexOf('"type":"user"')
  while (at >= 0) {
    const start = text.lastIndexOf('\n', at) + 1
    const row = parseLine(lineAt(text, start))
    const message = row?.message as { content?: unknown } | undefined
    const content = message?.content
    const said = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(b => (b as { text?: unknown }).text).filter(t => typeof t === 'string').join(' ')
        : ''
    if (row?.isMeta !== true && said.trim() !== '' && !said.trimStart().startsWith('<')) {
      return oneLine(said)
    }
    at = text.indexOf('"type":"user"', at + 1)
  }
  return null
}

export const titleOf = (text: string): string | null => {
  for (const [type, field] of TITLE_RECORDS) {
    const at = text.lastIndexOf(`{"type":"${type}"`)
    if (at < 0) continue
    const value = parseLine(lineAt(text, at))?.[field]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
  }
  return firstPrompt(text)
}

export const parseHistory = (text: string): HistoryRow[] =>
  text.split('\n').flatMap(line => {
    const row = parseLine(line)
    if (row === null) return []
    const field = (key: string) => {
      const value = row[key]
      return typeof value === 'string' ? value : null
    }
    const display = field('display')
    return [{
      sessionId: field('sessionId'),
      display: display === null ? null : oneLine(display),
      project: field('project'),
      at: typeof row.timestamp === 'number' ? row.timestamp : 0,
    }]
  })
