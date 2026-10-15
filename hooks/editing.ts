import type { ClientKeyEvent } from 'claude-code'

import type { BoardMessage, BoardProps, BranchList, ProjectList } from '../types'
import { clip, charCount } from './text'

export type Editing =
  | { purpose: 'rename-chat'; key: string; sessionId: string; text: string }
  | { purpose: 'rename-workspace'; key: string; path: string; text: string }
  | { purpose: 'new-workspace'; step: 'title'; key: string; root: string; text: string }
  | { purpose: 'new-workspace'; step: 'base'; key: string; root: string; title: string; text: string; selected: number }
  | { purpose: 'new-workspace'; step: 'prompt'; key: string; root: string; title: string; base: string; text: string }
  | { purpose: 'add-project'; key: string; text: string; selected: number }

export type Picking = Extract<Editing, { selected: number }>

export const isPicking = (editing: Editing | null): editing is Picking =>
  editing !== null && 'selected' in editing

export type Step = { editing: Editing | null; message?: BoardMessage }

const PICKER_ROWS = 8

const matching = (items: readonly string[], filter: string) => {
  const wanted = filter.trim().toLowerCase()
  return items.filter(item => item.toLowerCase().includes(wanted))
}

const looksLikePath = (text: string) => /^([A-Za-z]:[\\/]|[\\/]|~)/.test(text.trim())

const optionsOf = (editing: Picking, branches: BranchList | null, projects: ProjectList | null) => {
  if (editing.purpose === 'new-workspace') {
    const isReady = branches !== null && branches.root === editing.root && !branches.isLoading
    return {
      isReady,
      choices: isReady ? matching(branches.refs, editing.text) : [],
      label: (choice: string) => (choice === branches?.defaultRef ? `${choice}  default` : choice),
      waiting: 'Loading branches…',
      empty: 'No branch matches',
    }
  }
  const typed = editing.text.trim()
  const listed = projects === null || projects.isLoading ? [] : matching(projects.paths, typed)
  const isTyped = looksLikePath(typed) && !listed.some(path => path.toLowerCase() === typed.toLowerCase())
  return {
    isReady: (projects !== null && !projects.isLoading) || isTyped,
    choices: isTyped ? [typed, ...listed] : listed,
    label: (choice: string) => (isTyped && choice === typed ? `add ${choice}` : choice),
    waiting: 'Finding projects…',
    empty: 'No project matches; type a full path',
  }
}

const windowOf = (count: number, selected: number) => {
  const start = Math.max(0, Math.min(selected - Math.floor(PICKER_ROWS / 2), count - PICKER_ROWS))
  return { start, end: Math.min(count, start + PICKER_ROWS) }
}

export const pickerLines = (editing: Picking, props: BoardProps) => {
  const options = optionsOf(editing, props.branches, props.projects)
  const { choices } = options
  if (!options.isReady) return { choices: [], labels: [options.waiting], start: 0 }
  if (choices.length === 0) return { choices, labels: [options.empty], start: 0 }
  const { start, end } = windowOf(choices.length, editing.selected)
  return { choices, labels: choices.slice(start, end).map(options.label), start }
}

export const promptOf = (editing: Editing): { label: string | null; hint: string } => {
  switch (editing.purpose) {
    case 'rename-chat':
      return { label: null, hint: '⏎ save · click to cancel' }
    case 'rename-workspace':
      return { label: null, hint: '⏎ save · empty resets' }
    case 'add-project':
      return { label: '  ', hint: '↑↓ pick · ⏎ add · click to cancel' }
    case 'new-workspace':
      switch (editing.step) {
        case 'title':
          return { label: '  new workspace ', hint: '⏎ next · click to cancel' }
        case 'base':
          return { label: `  ${clip(editing.title, 20)} · from `, hint: '↑↓ pick · ⏎ next' }
        case 'prompt':
          return { label: `  ${clip(editing.title, 16)} off ${clip(editing.base, 16)} · first prompt `, hint: '⏎ start · click to cancel' }
      }
  }
}

export const take = (editing: Picking, index: number, props: BoardProps): Step => {
  const choice = pickerLines(editing, props).choices[index]
  if (editing.purpose === 'new-workspace') {
    const base = choice ?? props.branches?.defaultRef ?? 'HEAD'
    return { editing: { purpose: 'new-workspace', step: 'prompt', key: editing.key, root: editing.root, title: editing.title, base, text: '' } }
  }
  const path = choice ?? (looksLikePath(editing.text) ? editing.text.trim() : undefined)
  return path === undefined ? { editing } : { editing: null, message: { action: 'add-project', path } }
}

const submit = (editing: Editing, props: BoardProps): Step => {
  const text = editing.text.trim()
  switch (editing.purpose) {
    case 'rename-chat':
      return text === '' ? { editing: null } : { editing: null, message: { action: 'rename-chat', sessionId: editing.sessionId, title: text } }
    case 'rename-workspace':
      return { editing: null, message: { action: 'rename-workspace', path: editing.path, title: text } }
    case 'add-project':
      return take(editing, editing.selected, props)
    case 'new-workspace':
      switch (editing.step) {
        case 'title':
          return text === ''
            ? { editing: null }
            : {
                editing: { purpose: 'new-workspace', step: 'base', key: editing.key, root: editing.root, title: text, text: '', selected: 0 },
                message: { action: 'list-branches', root: editing.root },
              }
        case 'base':
          return take(editing, editing.selected, props)
        case 'prompt':
          return { editing: null, message: { action: 'new-workspace', root: editing.root, title: editing.title, base: editing.base, prompt: text } }
      }
  }
}

const pick = (editing: Picking, key: ClientKeyEvent, count: number): Editing | null => {
  const isDown = key.key === 'down' || (key.ctrl === true && key.key === 'n') || key.key === 'tab'
  const isUp = key.key === 'up' || (key.ctrl === true && key.key === 'p')
  if (isDown) return count > 0 ? { ...editing, selected: Math.min(count - 1, editing.selected + 1) } : editing
  if (isUp) return { ...editing, selected: Math.max(0, editing.selected - 1) }
  return null
}

const typed = (editing: Editing, key: ClientKeyEvent): Editing => {
  const text = key.key === 'backspace' || key.key === 'delete'
    ? [...editing.text].slice(0, -1).join('')
    : key.ctrl === true && key.key === 'u'
      ? ''
      : key.ctrl !== true && key.meta !== true && charCount(key.key) === 1
        ? editing.text + key.key
        : null
  if (text === null) return editing
  return isPicking(editing) ? { ...editing, text, selected: 0 } : { ...editing, text }
}

export const onEditKey = (editing: Editing, key: ClientKeyEvent, props: BoardProps): Step => {
  if (key.key === 'return') return submit(editing, props)
  const picked = isPicking(editing) ? pick(editing, key, pickerLines(editing, props).choices.length) : null
  return { editing: picked ?? typed(editing, key) }
}
