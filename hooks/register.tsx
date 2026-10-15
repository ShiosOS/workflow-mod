import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardProps } from '../types'
import { addProject, dispatch, removeProject } from './actions'
import { hostOf } from './host'
import { parseMessage } from './messages'
import { refresh, sinceRefresh } from './scan'
import { BOARD_SHAPE, load, PANE } from './state'

// The state this file reads or writes, declared here: the engine lists a
// module's state from the literal references in the file that uses them.
const board = atom({ plugin: 'worktrees', key: 'board' } as const, null, { shape: BOARD_SHAPE })
const showingAll = atom({ plugin: 'worktrees', key: 'showingAll' } as const, [])
const toggled = atom({ plugin: 'worktrees', key: 'toggled' } as const, [])
const branches = atom({ plugin: 'worktrees', key: 'branches' } as const, null)
const projects = atom({ plugin: 'worktrees', key: 'projects' } as const, null)

const POLL_MS = 5000
const HIDDEN_POLL_MS = 30_000

// The surface raises a pane over the others only while the prompt holds the
// keys, which it does not while /worktrees runs: asked again once it ended.
const raise = async ($: EngineInterface) => {
  await $.ui.open({ id: PANE, title: 'Worktrees', focus: true })
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane !== undefined && !pane.isShown) {
    $.ui.toast('Worktrees is open as a tab behind another pane: click its tab to show it.', { timeoutMs: 8000 })
  }
}

const poll = async ($: EngineInterface) => {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane === undefined) return
  if (pane.isShown || sinceRefresh(await $.clock.now()) >= HIDDEN_POLL_MS) await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktrees',
      description: 'Show git worktrees and their Claude chats; open one in a new tab',
      argumentHint: '[add|remove <repo path>]',
    })
    const kept = await load($, 'folds')
    await update($, toggled, keys => (keys.length > 0 ? keys : kept))
    void $.ui.open({ id: PANE, title: 'Worktrees' })
    void refresh($)
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    if ((await $.env.get('WT_SESSION')) !== undefined) void hostOf($)
    return started
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    const edit = /^(add|remove)\s+(.+)$/i.exec(e.args.trim())
    const path = edit?.[2]?.trim().replace(/^["']|["']$/g, '')
    const said = edit === null || path === undefined
      ? null
      : edit[1]?.toLowerCase() === 'add'
        ? await addProject($, path)
        : await removeProject($, path)

    const opened = await $.ui.open({ id: PANE, title: 'Worktrees' })
    void refresh($)
    $.clock.after(250, () => {
      void raise($)
    })
    const pane = opened.isPlaced
      ? 'Worktrees pane open. Click the list, then j/k move, h/l fold, Enter opens, a new workspace, r rename, d remove; right-click or m for a menu.'
      : `Worktrees pane is waiting to be placed: ${opened.reason}`
    return { text: said === null ? pane : `${said} ${pane}` }
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const message = parseMessage(e.data)
    if (message !== null) await dispatch($, message, e.surface)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The worktrees list draws in the terminal and the desktop app.</Text>
    }
    const { Client, Text } = $.ui.resolve(e)
    const view = await read($, board)
    if (view === null) return <Text dimColor>Reading worktrees…</Text>
    const props: BoardProps = {
      surface: e.surface,
      branches: await read($, branches),
      projects: await read($, projects),
      board: view,
      toggled: await read($, toggled),
      showingAll: await read($, showingAll),
    }
    return e.surface === 'terminal'
      ? <Client key="board" module="./board.tsx" props={props} width="100%" height={Math.max(3, e.props.scroll.bodyRows)} />
      : <Client key="board" module="./board.tsx" props={props} width="100%" />
  })
}
