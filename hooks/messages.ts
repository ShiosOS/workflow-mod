import type { BoardMessage } from '../types'

type Action = BoardMessage['action']

type KindOf<V> = V extends string ? 'string' : V extends boolean ? 'boolean' : never

type FieldsOf<M> = { readonly [F in Exclude<keyof M, 'action'>]-?: KindOf<M[F]> }

const FIELDS: { readonly [A in Action]: FieldsOf<Extract<BoardMessage, { action: A }>> } = {
  'open-chat': { sessionId: 'string' },
  'new-chat': { path: 'string' },
  'toggle-fold': { key: 'string' },
  'toggle-older': { path: 'string' },
  'rename-chat': { sessionId: 'string', title: 'string' },
  'remove-project': { root: 'string' },
  copy: { text: 'string' },
  reveal: { path: 'string' },
  browse: { url: 'string' },
  'delete-chat': { sessionId: 'string' },
  'remove-workspace': { path: 'string', dropBranch: 'boolean', force: 'boolean' },
  'clean-merged': { root: 'string' },
  'list-branches': { root: 'string' },
  'list-projects': {},
  'add-project': { path: 'string' },
  'new-workspace': { root: 'string', title: 'string', base: 'string', prompt: 'string' },
  'rename-workspace': { path: 'string', title: 'string' },
  prune: { root: 'string' },
  refresh: {},
  close: {},
}

const isAction = (action: string): action is Action => Object.hasOwn(FIELDS, action)

// A post comes from this plugin's Client, which can be an older build than
// these hooks while the engine hot-reloads them.
export const parseMessage = (data: unknown): BoardMessage | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const posted = data as Readonly<Record<string, unknown>>
  const { action } = posted
  if (typeof action !== 'string' || !isAction(action)) return null
  const fields = Object.entries(FIELDS[action])
  if (fields.some(([field, kind]) => typeof posted[field] !== kind)) return null
  return Object.fromEntries([['action', action], ...fields.map(([field]) => [field, posted[field]])]) as BoardMessage
}
