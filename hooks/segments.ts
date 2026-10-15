import type { ThemeKey } from 'claude-code'

import type { Chat, PrStatus, Worktree } from '../types'
import { promptOf } from './editing'
import type { Editing } from './editing'
import { WAITING, WORKING, frameOf } from './glyphs'
import { repoChats, tally } from './rows'
import type { Row, Tally } from './rows'
import { ago, clip, plural, charCount } from './text'

export type Seg = { text: string; color?: ThemeKey; bold?: boolean; dimColor?: boolean }

type Look = { glyph: string; color: ThemeKey; meta: string; metaColor: ThemeKey | undefined; isLoud: boolean }

const WAITING_STEP = 2

const working = (frame: number) => frameOf(WORKING, frame)
const waiting = (frame: number) => frameOf(WAITING, frame, WAITING_STEP)

const lookOf = (chat: Chat, frame: number, now: number): Look => {
  switch (chat.signal) {
    case 'here':
      return { glyph: '▌', color: 'claude', meta: '', metaColor: 'claude', isLoud: false }
    case 'working':
      return { glyph: working(frame), color: 'claude', meta: 'working', metaColor: 'claude', isLoud: false }
    case 'needs-input':
      return { glyph: waiting(frame), color: 'warning', meta: 'needs input', metaColor: 'warning', isLoud: true }
    case 'your-turn':
      return { glyph: waiting(frame), color: 'success', meta: 'your turn', metaColor: 'success', isLoud: true }
    case 'failed':
      return { glyph: '✗', color: 'error', meta: 'failed', metaColor: 'error', isLoud: true }
    case 'idle':
      return { glyph: '●', color: 'success', meta: chat.live?.kind === 'background' ? 'bg idle' : 'open', metaColor: undefined, isLoud: false }
    case 'closed':
      return { glyph: '○', color: 'inactive', meta: ago(chat.updatedAt, now), metaColor: undefined, isLoud: false }
  }
}

const SEPARATOR: Seg = { text: ' · ', dimColor: true }

const joined = (chips: Seg[]): Seg[] => chips.flatMap((chip, i) => (i === 0 ? [chip] : [SEPARATOR, chip]))

const chatChips = (t: Tally, frame: number): Seg[] => {
  const chips: Seg[] = []
  if (t.needs > 0) chips.push({ text: `${waiting(frame)} ${t.needs} need you`, color: 'warning', bold: true })
  if (t.working > 0) chips.push({ text: `${working(frame)} ${t.working} working`, color: 'claude' })
  if (t.failed > 0) chips.push({ text: `✗ ${t.failed} failed`, color: 'error' })
  return chips
}

const prChips = (pr: PrStatus, frame: number, isBrief: boolean): Seg[] => {
  const chips: Seg[] = []
  if (pr.state === 'MERGED') chips.push({ text: 'merged', color: 'merged', bold: true })
  if (pr.state === 'CLOSED') chips.push({ text: 'closed', dimColor: true })
  if (pr.state === 'OPEN' && pr.isDraft) chips.push({ text: 'draft', dimColor: true })
  if (pr.checks === 'failing') chips.push({ text: '✗ CI', color: 'error', bold: true })
  if (pr.checks === 'pending') chips.push({ text: `${working(frame)} CI`, color: 'claude' })
  if (!isBrief && pr.checks === 'passing') chips.push({ text: '✓ CI', color: 'success' })
  if (pr.review === 'changes') chips.push({ text: 'changes requested', color: 'warning', bold: true })
  if (pr.threads > 0) chips.push({ text: `${pr.threads} unresolved`, color: 'warning', bold: true })
  if (!isBrief && pr.review === 'approved') chips.push({ text: '✓ approved', color: 'success' })
  if (!isBrief && pr.comments > 0) chips.push({ text: plural(pr.comments, 'comment'), dimColor: true })
  return chips
}

export const segsWidth = (segs: Seg[]) => segs.reduce((sum, seg) => sum + charCount(seg.text), 0)

export const fitRight = (segs: Seg[], max: number): Seg[] => {
  const fitted = [...segs]
  while (fitted.length > 1 && segsWidth(fitted) > max) fitted.pop()
  while (fitted.at(-1) === SEPARATOR) fitted.pop()
  const only = fitted[0]
  if (fitted.length === 1 && only !== undefined && segsWidth(fitted) > max) fitted[0] = { ...only, text: clip(only.text, Math.max(0, max)) }
  return fitted.filter(seg => seg.text !== '')
}

type Parts = { marks: Seg[]; name: Seg[]; facts: Seg[]; ends: Seg[] }

type View = { isCursor: boolean; isLit: boolean; frame: number; now: number }

const parts = (some: Partial<Parts> & Pick<Parts, 'name'>): Parts => ({ marks: [], facts: [], ends: [], ...some })

const branchFact = (wt: Worktree): Seg[] => {
  const bare = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  return wt.branch === null || bare(wt.branch) === bare(wt.title) ? [] : [{ text: wt.branch, dimColor: true }]
}

export const partsOf = (row: Exclude<Row, { kind: 'gap' }>, { isCursor, isLit, frame, now }: View): Parts => {
  switch (row.kind) {
    case 'repo':
      return parts({
        marks: row.isOpen ? [] : [{ text: '▸ ', dimColor: true }],
        name: [{ text: row.repo.name, color: 'claude', bold: true }],
        facts: row.repo.isUnavailable
          ? [{ text: 'unavailable', color: 'error' }]
          : joined([...chatChips(tally(repoChats(row.repo)), frame), { text: plural(row.repo.worktrees.length, 'workspace'), dimColor: true }]),
      })
    case 'worktree': {
      const t = tally(row.wt.chats)
      const isEmpty = t.chats === 0 && row.wt.pr === null
      return parts({
        name: [{ text: row.wt.title, bold: !isEmpty || isCursor, dimColor: isEmpty && !isLit }],
        facts: row.isOpen
          ? branchFact(row.wt)
          : joined([
              ...chatChips(t, frame),
              ...(row.wt.pr === null ? [] : prChips(row.wt.pr, frame, true)),
              ...(t.chats === 0 ? [] : [{ text: plural(t.chats, 'chat'), dimColor: true }]),
            ]),
        ends: [{ text: '+', color: isLit ? 'claude' : undefined, bold: isLit, dimColor: !isLit }],
      })
    }
    case 'quiet':
      return parts({
        name: [{ text: plural(row.count, 'more workspace'), dimColor: !isCursor }],
        ends: [{ text: row.isOpen ? '▾' : '▸', dimColor: true }],
      })
    case 'pr':
      return parts({
        name: [
          { text: `#${row.pr.number}`, bold: true, color: isLit ? 'claude' : undefined, dimColor: !isLit },
          { text: '  ' },
          ...joined(prChips(row.pr, frame, false)),
        ],
      })
    case 'chat': {
      const look = lookOf(row.chat, frame, now)
      const isHere = row.chat.signal === 'here'
      const marks: Seg[] = [{ text: `${look.glyph}  `, color: look.color, bold: look.isLoud || isHere }]
      return isHere
        ? parts({ marks, name: [{ text: row.chat.title, bold: true, color: 'claude' }] })
        : parts({
            marks,
            name: [{ text: row.chat.title, bold: look.isLoud || isCursor }],
            facts: [{ text: look.meta, color: look.metaColor, bold: look.isLoud, dimColor: look.metaColor === undefined }],
          })
    }
    case 'older':
      return parts({ name: [{ text: row.isShowingAll ? '− show fewer' : `… ${row.wt.olderCount} older`, dimColor: !isCursor }] })
    case 'add':
      return parts({ name: [{ text: '+ add project', color: isLit ? 'claude' : undefined, bold: isLit, dimColor: !isLit }] })
  }
}

export const withTyping = (drawn: Parts, editing: Editing): Parts => {
  const { label, hint } = promptOf(editing)
  const typed: Seg = { text: `${editing.text}█`, color: 'claude' }
  return {
    ...drawn,
    name: label === null ? [typed] : [...drawn.name, { text: label, dimColor: true }, typed],
    facts: [{ text: hint, dimColor: true }],
  }
}
