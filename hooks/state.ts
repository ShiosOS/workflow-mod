import type { EngineInterface } from 'claude-code'

import { pathKey } from './paths'
import type { PathKey } from './paths'

export const PANE = 'worktrees'

export const BOARD_SHAPE = 'board-2'

// Each name is the key users' stores already hold that value under.
export type Saved = {
  repos: string[]
  titles: Record<string, string>
  workspaceTitles: Record<PathKey, string>
  folds: string[]
  deleted: string[]
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []

const texts = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}

const PARSE: { readonly [K in keyof Saved]: (value: unknown) => Saved[K] } = {
  repos: strings,
  titles: texts,
  workspaceTitles: texts,
  folds: strings,
  deleted: strings,
}

export async function load<K extends keyof Saved>($: EngineInterface, key: K): Promise<Saved[K]> {
  return PARSE[key](await $.store.get(key))
}

export function keep<K extends Exclude<keyof Saved, 'workspaceTitles'>>($: EngineInterface, key: K, value: Saved[K]) {
  return $.store.set(key, value)
}

export async function retitleWorkspace($: EngineInterface, path: string, title: string) {
  const key = pathKey(path)
  const { [key]: _, ...rest } = await load($, 'workspaceTitles')
  await $.store.set('workspaceTitles', title === '' ? rest : { ...rest, [key]: title })
}
