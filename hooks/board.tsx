import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { BoardMessage, BoardProps } from '../types'
import { isPicking, onEditKey, pickerLines, take } from './editing'
import type { Editing, Picking, Step } from './editing'
import { boxOf, confirmMenu, lineAt, menuBox, menuFor, removalMenu } from './menus'
import type { Menu } from './menus'
import { ADD_PROJECT, buildRows, isFoldable, isMoving, isNavigable } from './rows'
import type { Row } from './rows'
import { fitRight, partsOf, segsWidth, withTyping } from './segments'
import type { Seg } from './segments'
import { clip, charCount } from './text'

type Local = {
  cursor: string | null
  hover: number | null
  isPendingG: boolean
  editing: Editing | null
  menu: Menu | null
  frame: number
  top: number
  latest: { props: BoardProps }
}

const FRAME_MS = 120
const MIN_NAME_CELLS = 12
const PLUS_CELLS = 2

const factsBudget = (cells: number) => Math.max(0, Math.min(cells - MIN_NAME_CELLS, Math.floor(cells / 2)))

const rowsOf = (props: BoardProps) => buildRows(props.board, props.toggled, props.showingAll)

const firstChat = (rows: Row[]) =>
  rows.find(row => row.kind === 'chat' && row.chat.signal !== 'here') ?? rows.find(isNavigable)

const initialState = (props: BoardProps): Local => ({
  cursor: firstChat(rowsOf(props))?.key ?? null,
  hover: null,
  isPendingG: false,
  editing: null,
  menu: null,
  frame: 0,
  top: 0,
  latest: { props },
})

const Board: ClientModule<BoardProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(initialState(props))
    listen(surface)
  }
  const s = surface.state ?? initialState(props)
  // The engine starts `surface.every` once and hands it no props, so the
  // timer and the listeners set up beside it read the latest props here.
  s.latest.props = props

  const rows = rowsOf(props)
  const now = props.board.refreshedAt
  const isTerminal = props.surface === 'terminal'
  const columns = surface.columns > 0 ? surface.columns : 60
  const height = isTerminal && surface.rows > 0 ? surface.rows : rows.length
  const top = isTerminal ? Math.min(s.top, Math.max(0, rows.length - height)) : 0

  const line = (row: Row, index: number) => {
    if (row.kind === 'gap') {
      return (
        <Box key={row.key} height={1}>
          <Text dimColor>{isTerminal && row.guide !== '' ? `  ${row.guide}` : ' '}</Text>
        </Box>
      )
    }
    const isCursor = row.key === s.cursor
    const isLit = isCursor || index === s.hover
    const pointer: Seg = isCursor
      ? { text: '❯', color: 'claude', bold: true }
      : { text: index === s.hover ? '›' : ' ', dimColor: true }
    const drawn = partsOf(row, { isCursor, isLit, frame: s.frame, now })
    const { marks, name, facts, ends } = s.editing?.key === row.key ? withTyping(drawn, s.editing) : drawn

    const used = 2 + charCount(row.guide) + segsWidth(marks)
    const endsWidth = ends.length === 0 ? 0 : segsWidth(ends) + 1
    const fitted = fitRight(facts, factsBudget(columns - used - endsWidth))
    const factsWidth = fitted.length === 0 ? 0 : segsWidth(fitted) + 1
    const room = Math.max(1, columns - used - factsWidth - endsWidth - 1)
    const only = name[0]
    const shown = isTerminal && name.length === 1 && only !== undefined ? [{ ...only, text: clip(only.text, room) }] : name
    const text = (seg: Seg) => (
      <Text color={seg.color} bold={seg.bold} dimColor={seg.dimColor} wrap="truncate-end">
        {seg.text}
      </Text>
    )
    return (
      <Box key={row.key} height={1} width="100%">
        <Box flexShrink={0} width={2}>{text(pointer)}</Box>
        {isTerminal
          ? row.guide !== '' && <Box flexShrink={0}>{text({ text: row.guide, dimColor: true })}</Box>
          : <Box flexShrink={0} paddingLeft={charCount(row.guide)} />}
        {marks.length > 0 && <Box flexShrink={0}>{marks.map(text)}</Box>}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{shown.map(text)}</Box>
        {fitted.length > 0 && <Box flexShrink={0} paddingLeft={1}>{fitted.map(text)}</Box>}
        {ends.length > 0 && <Box flexShrink={0} paddingLeft={1}>{ends.map(text)}</Box>}
      </Box>
    )
  }

  const menu = s.menu
  const box = menu === null ? null : menuBox(menu, columns, height)

  const picking = isPicking(s.editing) ? s.editing : null
  const pickerAt = picking === null ? -1 : rows.findIndex(row => row.key === picking.key) - top
  const picker = picking === null || pickerAt < 0 ? null : pickerLines(picking, props)
  const pickerBox = picker === null ? null : boxOf(picker.labels, pickerAt, 4, columns, height)

  return (
    <Box flexDirection="column">
      {rows.slice(top, top + height).map((row, i) => line(row, top + i))}
      {picking !== null && picker !== null && pickerBox !== null && (
        <Box
          key="picker"
          position="absolute"
          top={pickerBox.top}
          left={pickerBox.left}
          width={pickerBox.w}
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
        >
          {picker.labels.map((label, i) => {
            const isSelected = picker.choices.length > 0 && picker.start + i === picking.selected
            return (
              <Text inverse={isSelected} bold={isSelected} dimColor={picker.choices.length === 0}>
                {` ${clip(label, pickerBox.w - 4).padEnd(pickerBox.w - 4)} `}
              </Text>
            )
          })}
        </Box>
      )}
      {menu !== null && box !== null && (
        <Box
          key="menu"
          position="absolute"
          top={box.top}
          left={box.left}
          width={box.w}
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
        >
          {menu.items.map((item, i) => (
            <Text
              inverse={i === menu.selected}
              bold={i === menu.selected}
              color={item.isDanger === true ? 'error' : undefined}
            >
              {` ${item.label.padEnd(box.w - 4)} `}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

const listen = (surface: ClientSurface<Local>) => {
  const post = (message: BoardMessage) => surface.post(message)
  const state = () => surface.state
  const set = (patch: Partial<Local>) => {
    const s = state()
    if (s !== undefined) surface.setState({ ...s, ...patch })
  }
  const rowsNow = () => {
    const s = state()
    return s === undefined ? [] : rowsOf(s.latest.props)
  }
  const regionHeight = (rows: Row[]) =>
    state()?.latest.props.surface === 'terminal' && surface.rows > 0 ? surface.rows : rows.length
  const regionColumns = () => (surface.columns > 0 ? surface.columns : 60)

  const apply = (step: Step) => {
    if (step.editing !== state()?.editing) set({ editing: step.editing })
    if (step.message !== undefined) post(step.message)
  }

  const moveTo = (rows: Row[], row: Row | undefined) => {
    const s = state()
    if (s === undefined || row === undefined) return
    const at = rows.indexOf(row)
    const height = regionHeight(rows)
    const top = at < s.top ? at : at >= s.top + height ? at - height + 1 : s.top
    set({ cursor: row.key, top, isPendingG: false })
  }

  const moveBy = (rows: Row[], delta: number) => {
    const stops = rows.filter(isNavigable)
    const at = stops.findIndex(row => row.key === state()?.cursor)
    moveTo(rows, stops[Math.max(0, Math.min(stops.length - 1, (at < 0 ? 0 : at) + delta))])
  }

  const activate = (row: Row) => {
    switch (row.kind) {
      case 'repo':
      case 'worktree':
      case 'quiet':
        return post({ action: 'toggle-fold', key: row.key })
      case 'chat':
        return post({ action: 'open-chat', sessionId: row.chat.sessionId })
      case 'older':
        return post({ action: 'toggle-older', path: row.wt.path })
      case 'pr':
        return post({ action: 'browse', url: row.pr.url })
      case 'add':
        return startProject()
      case 'gap':
        return
    }
  }

  const foldOrClimb = (rows: Row[], row: Row) => {
    if (isFoldable(row) && row.isOpen) return post({ action: 'toggle-fold', key: row.key })
    const parent = rows.find(one => one.key === row.parent)
    if (parent === undefined) return
    moveTo(rows, parent)
    if (isFoldable(parent) && parent.isOpen && row.kind !== 'worktree') post({ action: 'toggle-fold', key: parent.key })
  }

  const unfoldOrEnter = (rows: Row[], row: Row) => {
    if (!isFoldable(row)) return activate(row)
    if (!row.isOpen) return post({ action: 'toggle-fold', key: row.key })
    moveBy(rows, 1)
  }

  const startRename = (row: Row | undefined) => {
    if (row?.kind === 'chat') {
      set({ cursor: row.key, menu: null, editing: { purpose: 'rename-chat', key: row.key, sessionId: row.chat.sessionId, text: row.chat.title } })
    } else if (row?.kind === 'worktree') {
      set({ cursor: row.key, menu: null, editing: { purpose: 'rename-workspace', key: row.key, path: row.wt.path, text: row.wt.title } })
    }
  }

  const startWorkspace = (row: Row | undefined) => {
    const rows = rowsNow()
    let at = row
    while (at !== undefined && at.kind !== 'repo') at = rows.find(one => one.key === at?.parent)
    if (at?.kind !== 'repo') return
    set({ cursor: at.key, menu: null, editing: { purpose: 'new-workspace', step: 'title', key: at.key, root: at.repo.root, text: '' } })
  }

  const startProject = () => {
    set({ cursor: ADD_PROJECT, menu: null, editing: { purpose: 'add-project', key: ADD_PROJECT, text: '', selected: 0 } })
    post({ action: 'list-projects' })
  }

  const pickAt = (rows: Row[], editing: Picking, props: BoardProps, event: ClientPointerEvent) => {
    const lines = pickerLines(editing, props)
    if (lines.choices.length === 0) return null
    const y = rows.findIndex(row => row.key === editing.key) - (state()?.top ?? 0)
    const box = boxOf(lines.labels, y, 4, regionColumns(), regionHeight(rows))
    const index = lineAt(box, lines.labels.length, event.x, event.y)
    return index === null ? null : lines.start + index
  }

  const startRemoval = (rows: Row[], row: Row) => {
    const menu = removalMenu(row, rows.indexOf(row) - (state()?.top ?? 0), 4 + charCount(row.guide))
    if (menu !== null) set({ cursor: row.key, menu })
  }

  const openMenu = (row: Row | undefined, y: number, x: number) => {
    if (row === undefined) return
    const items = menuFor(row)
    if (items.length === 0) return activate(row)
    set({ cursor: row.key, menu: { key: row.key, items, selected: 0, y, x } })
  }

  const choose = (menu: Menu, index: number) => {
    const item = menu.items[index]
    set({ menu: null })
    if (item === undefined || item.run === 'cancel') return
    const row = rowsNow().find(one => one.key === menu.key)
    if (item.run === 'rename') return startRename(row)
    if (item.run === 'workspace') return startWorkspace(row)
    if (item.run === 'project') return startProject()
    if ('confirm' in item.run) return set({ menu: confirmMenu(menu, item.run) })
    post(item.run)
  }

  const onMenuKey = (k: string, menu: Menu) => {
    const count = menu.items.length
    if (k === 'j' || k === 'down') return set({ menu: { ...menu, selected: (menu.selected + 1) % count } })
    if (k === 'k' || k === 'up') return set({ menu: { ...menu, selected: (menu.selected + count - 1) % count } })
    if (k === 'return' || k === 'l' || k === 'o') return choose(menu, menu.selected)
    set({ menu: null })
  }

  surface.onKey(key => {
    const s = state()
    if (s === undefined) return
    if (s.editing !== null) return apply(onEditKey(s.editing, key, s.latest.props))
    if (s.menu !== null) return onMenuKey(key.key, s.menu)
    const rows = rowsNow()
    const stops = rows.filter(isNavigable)
    const row = rows.find(one => one.key === s.cursor) ?? stops[0]
    const half = Math.max(1, Math.floor(regionHeight(rows) / 2))
    const k = key.key
    const isShiftG = k === 'G' || (k === 'g' && key.shift === true)

    if (k === 'g' && !isShiftG) {
      if (s.isPendingG) moveTo(rows, stops[0])
      else set({ isPendingG: true })
      return
    }
    if (s.isPendingG) set({ isPendingG: false })
    if (isShiftG) return moveTo(rows, stops.at(-1))
    if (key.ctrl === true && k === 'd') return moveBy(rows, half)
    if (key.ctrl === true && k === 'u') return moveBy(rows, -half)
    if (k === 'j' || k === 'down') return moveBy(rows, 1)
    if (k === 'k' || k === 'up') return moveBy(rows, -1)
    if (row === undefined) return
    if (k === 'h' || k === 'left') return foldOrClimb(rows, row)
    if (k === 'l' || k === 'right') return unfoldOrEnter(rows, row)
    if (k === 'return' || k === 'o') return activate(row)
    if (k === 'r') return startRename(row)
    if (k === 'a') return startWorkspace(row)
    if (k === 'P') return startProject()
    if (k === 'd') return startRemoval(rows, row)
    if (k === 'm') return openMenu(row, rows.indexOf(row) - s.top, 4 + charCount(row.guide))
    if (k === 'n' && 'wt' in row) return post({ action: 'new-chat', path: row.wt.path })
    if (k === 'x' && row.kind === 'repo' && !row.repo.isCurrent) return post({ action: 'remove-project', root: row.repo.root })
    if (k === 'R') return post({ action: 'refresh' })
    if (k === 'q') return post({ action: 'close' })
    if (/^[1-9]$/.test(k)) {
      const target = rows.find(one => one.kind === 'chat' && one.hotkey === k)
      if (target !== undefined) {
        moveTo(rows, target)
        activate(target)
      }
    }
  })

  surface.onPointer((event: ClientPointerEvent) => {
    const s = state()
    if (s === undefined) return
    const rows = rowsNow()
    const index = s.top + event.y
    const row = rows[index]

    if (s.menu !== null) {
      const item = lineAt(menuBox(s.menu, regionColumns(), regionHeight(rows)), s.menu.items.length, event.x, event.y)
      if (event.type === 'move') {
        if (item !== null && item !== s.menu.selected) set({ menu: { ...s.menu, selected: item } })
        return
      }
      if (event.type !== 'down') return
      if (item !== null && event.button === 'left') return choose(s.menu, item)
      set({ menu: null })
      if (event.button === 'right' && row !== undefined && isNavigable(row)) openMenu(row, event.y, event.x)
      return
    }

    const editing = s.editing
    if (isPicking(editing)) {
      const at = pickAt(rows, editing, s.latest.props, event)
      if (at !== null && event.type === 'move' && at !== editing.selected) return set({ editing: { ...editing, selected: at } })
      if (at !== null && event.type === 'down' && event.button === 'left') return apply(take(editing, at, s.latest.props))
      if (at !== null) return
    }

    if (event.type === 'leave') return set({ hover: null })
    if (event.type === 'move' && event.button === undefined) {
      if (s.hover !== index) set({ hover: index })
      return
    }
    if (event.type !== 'down') return
    if (s.editing !== null) return set({ editing: null })
    if (row === undefined || !isNavigable(row)) return
    if (event.button === 'right') return openMenu(row, event.y, event.x)
    if (event.button !== 'left') return
    set({ cursor: row.key, isPendingG: false })
    if (row.kind === 'worktree' && event.x >= regionColumns() - PLUS_CELLS) return post({ action: 'new-chat', path: row.wt.path })
    activate(row)
  })

  surface.every(FRAME_MS, () => {
    const s = state()
    if (s === undefined) return
    if (isMoving(s.latest.props.board)) set({ frame: s.frame + 1 })
  })
}

export default Board
