import type { BoardMessage } from '../types'
import type { Row } from './rows'
import { clip, plural, charCount } from './text'

type Confirm = { confirm: string; then: BoardMessage }
type MenuItem = {
  label: string
  run: BoardMessage | Confirm | 'rename' | 'workspace' | 'project' | 'cancel'
  isDanger?: boolean
}
type Removal = MenuItem & { run: Confirm }
export type Menu = { key: string; items: MenuItem[]; selected: number; y: number; x: number }

const removalsFor = (row: Row): Removal[] => {
  if (row.kind === 'chat') {
    if (row.chat.signal === 'here') return []
    const verb = row.chat.live === null ? 'Delete' : 'Stop and delete'
    const confirm = `${verb} "${clip(row.chat.title, 28)}"`
    return [{ label: 'Delete chat…', run: { confirm, then: { action: 'delete-chat', sessionId: row.chat.sessionId } }, isDanger: true }]
  }
  const isHome = row.kind === 'worktree' && row.wt.chats.some(chat => chat.signal === 'here')
  if (row.kind === 'worktree' && !row.wt.isMain && !isHome) {
    const name = clip(row.wt.title, 28)
    const running = row.wt.chats.filter(chat => chat.live !== null).length
    const stop = running === 0 ? '' : `stop ${plural(running, 'chat')} and `
    const ask = (what: string) => `${stop}${what}`.replace(/^./, first => first.toUpperCase())
    const remove = (dropBranch: boolean, force: boolean) =>
      ({ action: 'remove-workspace', path: row.wt.path, dropBranch, force }) as const
    return [
      { label: 'Remove workspace…', run: { confirm: ask(`remove ${name}`), then: remove(false, false) }, isDanger: true },
      { label: 'Remove workspace and branch…', run: { confirm: ask(`remove ${name} and its branch`), then: remove(true, false) }, isDanger: true },
      { label: 'Discard changes and remove…', run: { confirm: ask(`discard all changes in ${name}`), then: remove(false, true) }, isDanger: true },
    ]
  }
  return []
}

export const menuFor = (row: Row): MenuItem[] => {
  switch (row.kind) {
    case 'chat': {
      const live = row.chat.live
      const resume = live?.kind === 'background' && live.jobId !== null
        ? `claude attach ${live.jobId}`
        : `claude --resume ${row.chat.sessionId}`
      return [
        { label: 'Open in new tab', run: { action: 'open-chat', sessionId: row.chat.sessionId } },
        { label: 'Rename…', run: 'rename' },
        { label: 'Copy resume command', run: { action: 'copy', text: `cd "${row.wt.path}"; ${resume}` } },
        { label: 'Copy session ID', run: { action: 'copy', text: row.chat.sessionId } },
        ...removalsFor(row),
      ]
    }
    case 'pr':
      return [
        { label: 'Open PR in browser', run: { action: 'browse', url: row.pr.url } },
        { label: 'Copy PR link', run: { action: 'copy', text: row.pr.url } },
        { label: 'New chat here', run: { action: 'new-chat', path: row.wt.path } },
      ]
    case 'worktree':
      return [
        { label: 'New chat here', run: { action: 'new-chat', path: row.wt.path } },
        { label: 'Rename…', run: 'rename' },
        { label: row.isOpen ? 'Fold' : 'Unfold', run: { action: 'toggle-fold', key: row.key } },
        { label: 'Open folder', run: { action: 'reveal', path: row.wt.path } },
        { label: 'Copy path', run: { action: 'copy', text: row.wt.path } },
        ...removalsFor(row),
      ]
    case 'repo': {
      const merged = row.repo.worktrees.filter(wt => !wt.isMain && wt.pr?.state === 'MERGED').length
      const cleanUp: MenuItem[] = merged === 0 ? [] : [{
        label: `Clean up ${merged} merged…`,
        run: { confirm: `Remove ${plural(merged, 'merged workspace')}`, then: { action: 'clean-merged', root: row.repo.root } },
        isDanger: true,
      }]
      return [
        { label: 'New workspace…', run: 'workspace' },
        { label: 'Add project…', run: 'project' },
        { label: row.isOpen ? 'Fold' : 'Unfold', run: { action: 'toggle-fold', key: row.key } },
        { label: 'Refresh', run: { action: 'refresh' } },
        { label: 'Open folder', run: { action: 'reveal', path: row.repo.root } },
        ...cleanUp,
        { label: 'Prune missing workspaces', run: { action: 'prune', root: row.repo.root } },
        ...(row.repo.isCurrent ? [] : [{ label: 'Remove from list', run: { action: 'remove-project', root: row.repo.root } } as const]),
      ]
    }
    default:
      return []
  }
}

export const confirmMenu = (menu: Menu, confirm: Confirm): Menu => ({
  ...menu,
  items: [{ label: confirm.confirm, run: confirm.then, isDanger: true }, { label: 'Cancel', run: 'cancel' }],
  selected: 1,
})

export const removalMenu = (row: Row, y: number, x: number): Menu | null => {
  const first = removalsFor(row)[0]
  return first === undefined ? null : confirmMenu({ key: row.key, items: [], selected: 0, y, x }, first.run)
}

export const boxOf = (labels: readonly string[], y: number, x: number, columns: number, height: number) => {
  const w = Math.min(columns, Math.max(12, ...labels.map(charCount)) + 4)
  const h = labels.length + 2
  const top = y + 1 + h <= height ? y + 1 : Math.max(0, y - h)
  const left = Math.max(0, Math.min(x, columns - w))
  return { top, left, w, h }
}

export const menuBox = (menu: Menu, columns: number, height: number) =>
  boxOf(menu.items.map(item => item.label), menu.y, menu.x, columns, height)

export const lineAt = (box: { top: number; left: number; w: number }, count: number, x: number, y: number) => {
  const index = y - box.top - 1
  return x > box.left && x < box.left + box.w - 1 && index >= 0 && index < count ? index : null
}
