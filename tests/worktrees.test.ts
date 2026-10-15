import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Board, BoardProps, Chat, Worktree } from '../types'
import { WAITING, WORKING, dotsOf } from '../hooks/glyphs'
import { parseWorktrees, titleOf } from '../hooks/parse'
import { buildRows, isNavigable } from '../hooks/rows'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const PORCELAIN = [
  'worktree D:/repos/app', 'HEAD aaa', 'branch refs/heads/main', '',
  'worktree C:/wt/feature', 'HEAD bbb', 'branch refs/heads/feature-x', '',
  'worktree C:/wt/quiet', 'HEAD eee', 'branch refs/heads/quiet-branch', '',
  'worktree C:/wt/a-worktree-folder-with-a-rather-long-name-of-its-own', 'HEAD fff',
  'branch refs/heads/feature/a-branch-name-long-enough-to-crowd-the-row-out', '',
  'worktree C:/wt/gone', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
].join('\n')

const OTHER_PORCELAIN = ['worktree D:/repos/other', 'HEAD ddd', 'branch refs/heads/main', ''].join('\n')

const agents = (busy2: 'busy' | 'idle') => [
  { pid: 10, cwd: 'D:\\repos\\app', kind: 'interactive', sessionId: 'current-1', name: 'app-1', status: 'busy', startedAt: NOW - HOUR },
  { pid: 11, cwd: 'C:\\wt\\feature', kind: 'interactive', sessionId: 'busy-2', name: 'feature-1', status: busy2, startedAt: NOW - HOUR },
  { id: 'job77', cwd: 'C:\\wt\\feature', kind: 'background', sessionId: 'bg-4', name: 'nightly migration', state: 'blocked', startedAt: NOW - HOUR },
]

const STORE_TERMINAL = 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.24_x64__8wekyb3d8bbwe\\WindowsTerminal.exe'
const STORE_WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'

const PROJECTS = 'C:\\Users\\me\\.claude\\projects'
const file = (name: string, mtimeMs: number): FsEntry =>
  ({ name, kind: 'file', size: 100, mtimeMs, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const LISTINGS: Record<string, FsEntry[]> = {
  [PROJECTS]: [dir('D--repos-app'), dir('C--wt-feature'), dir('d--repos-other'), dir('C--wt-a-worktree-folder-with-a-rather-long-name-of-its-own')],
  [`${PROJECTS}\\C--wt-a-worktree-folder-with-a-rather-long-name-of-its-own`]: [file('long-6.jsonl', NOW - 3 * HOUR)],
  [`${PROJECTS}\\D--repos-app`]: [file('current-1.jsonl', NOW), file('old-3.jsonl', NOW - 5 * HOUR), dir('old-3')],
  [`${PROJECTS}\\C--wt-feature`]: [file('busy-2.jsonl', NOW), file('bg-4.jsonl', NOW - HOUR)],
  [`${PROJECTS}\\d--repos-other`]: [file('other-5.jsonl', NOW - 2 * HOUR)],
}

const prompt = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

const FILES: Record<string, string> = {
  [`${PROJECTS}\\D--repos-app\\current-1.jsonl`]: prompt('build the mod'),
  [`${PROJECTS}\\D--repos-app\\old-3.jsonl`]: [
    prompt('fix the login bug'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login redirect', sessionId: 'old-3' }),
  ].join('\n'),
  [`${PROJECTS}\\C--wt-feature\\busy-2.jsonl`]: prompt('write the feature'),
  [`${PROJECTS}\\C--wt-feature\\bg-4.jsonl`]: prompt('migrate the schema'),
  [`${PROJECTS}\\d--repos-other\\other-5.jsonl`]: prompt('tune the other service'),
  'C:\\Users\\me\\.claude\\history.jsonl': [
    { display: 'tune it', project: 'D:\\repos\\other\\src', timestamp: NOW - 1000, sessionId: 'other-5' },
    { display: 'hello', project: 'C:\\Users\\me', timestamp: NOW, sessionId: 'home-1' },
    { display: 'build the mod', project: 'D:\\repos\\app', timestamp: NOW - 5, sessionId: 'current-1' },
  ].map(row => JSON.stringify(row)).join('\n'),
  [`${PROJECTS}\\C--wt-a-worktree-folder-with-a-rather-long-name-of-its-own\\long-6.jsonl`]:
    prompt('a prompt long enough to run past the right edge of a narrow pane by a good margin'),
}

const PULL_REQUESTS: Readonly<Record<string, object>> = {
  'feature-x': {
    number: 41, url: 'https://github.com/acme/app/pull/41', title: 'Feature X', state: 'OPEN', isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED', comments: { totalCount: 3 },
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: false }, { isResolved: true }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  },
  'quiet-branch': {
    number: 40, url: 'https://github.com/acme/app/pull/40', title: 'Quiet fix', state: 'MERGED', isDraft: false,
    reviewDecision: 'APPROVED', comments: { totalCount: 0 }, reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  },
}

const githubReply = (query: string) => ({
  data: {
    repository: Object.fromEntries(
      [...query.matchAll(/(\w+): pullRequests\(headRefName: ("(?:[^"\\]|\\.)*")/g)].map(([, alias = '', branch = '""']) => {
        const pr = PULL_REQUESTS[JSON.parse(branch) as string]
        return [alias, { nodes: pr === undefined ? [] : [pr] }]
      }),
    ),
  },
})

const ran = (stdout: string, exitCode = 0): ProcessRunResult =>
  ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

test('parses worktrees, skipping prunable ones', () => {
  expect(parseWorktrees(PORCELAIN).map(ref => ref.path)).toEqual([
    'D:\\repos\\app', 'C:\\wt\\feature', 'C:\\wt\\quiet', 'C:\\wt\\a-worktree-folder-with-a-rather-long-name-of-its-own',
  ])
})

test('no animation flashes: every frame of a set lights the same number of dots', () => {
  for (const [name, set] of [['working', WORKING], ['waiting', WAITING]] as const) {
    const counts = new Set(set.map(dotsOf))
    expect(counts.size, `${name} frames light ${[...counts].join(' or ')} dots`).toBe(1)
    expect(set.every(glyph => /^[⠀-⣿]$/.test(glyph)), `${name} is braille`).toBe(true)
  }
})

test('the guides draw a tree with room to breathe: spacers carry │ down between worktrees', () => {
  const chat = (sessionId: string): Chat =>
    ({ sessionId, title: sessionId, updatedAt: NOW, signal: 'closed', live: null, transcript: null })
  const wt = (path: string, chats: Chat[]): Worktree =>
    ({ path, title: path, branch: path, isMain: false, chats, olderCount: 0, pr: null })
  const board: Board = {
    refreshedAt: NOW,
    repos: [{
      root: 'r', name: 'r', isCurrent: true, isUnavailable: false,
      worktrees: [wt('a', [chat('a1')]), wt('b', [chat('b1')]), wt('idle-1', []), wt('idle-2', [])],
    }],
  }
  const drawn = (toggled: string[]) => buildRows(board, toggled, []).map(row => `${row.guide}${row.key}`)
  expect(drawn([])).toEqual([
    'repo:r',
    '│gap:a',
    '├── wt:a',
    '│   chat:a1',
    '│gap:b',
    '├── wt:b',
    '│   chat:b1',
    '│gap:quiet:r',
    '└── quiet:r',
    'gap:add:before',
    'gap:add:before-2',
    'add-project',
  ])
  expect(drawn(['quiet:r']).slice(-7, -3)).toEqual([
    '    │gap:idle-1',
    '    ├── wt:idle-1',
    '    │gap:idle-2',
    '    └── wt:idle-2',
  ])
})

test('a /rename title beats the generated one, which beats the first prompt', () => {
  const lines = [
    prompt('first ask'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Generated' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }),
  ]
  expect(titleOf(lines.join('\n'))).toBe('Renamed')
  expect(titleOf(lines.slice(0, 2).join('\n'))).toBe('Generated')
  expect(titleOf(lines[0] ?? '')).toBe('first ask')
  expect(titleOf('{"type":"queue-operation"}')).toBe(null)
})

const WINDOWS_TERMINAL = {
  WT_SESSION: 'tab',
  WT_PROFILE_ID: '{pwsh-profile}',
  USERPROFILE: 'C:\\Users\\me',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  CLAUDE_CODE_EXECPATH: 'C:\\bin\\claude.exe',
  OS: 'Windows_NT',
}

type Knobs = { isSessionInRepo: boolean; busy2: 'busy' | 'idle'; focusExit: number; tabExit: number }

type Opening = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  knobs?: Partial<Knobs>
  listings?: Record<string, FsEntry[]>
  files?: Record<string, string>
  surface?: 'terminal' | 'desktop'
  rows?: number
  args?: string
}

const withExtra = (listings: Record<string, FsEntry[]>, extra: Record<string, FsEntry[]> = {}) =>
  Object.fromEntries([...new Set([...Object.keys(listings), ...Object.keys(extra)])]
    .map(path => [path, [...(listings[path] ?? []), ...(extra[path] ?? [])]]))

const stage = (on: On, opening: Opening) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, opening.store ?? {})
  mock.env(on, opening.env ?? WINDOWS_TERMINAL)
  const knobs: Knobs = { isSessionInRepo: true, busy2: 'busy', focusExit: 0, tabExit: 0, ...opening.knobs }
  const world = {
    ...knobs,
    clock,
    listings: withExtra(LISTINGS, opening.listings),
    files: { ...FILES, ...opening.files },
    commands: [] as string[][],
    launched: [] as string[][],
    appended: [] as string[][],
    statuses: [] as (string | undefined)[],
    trashed: [] as string[][],
    prQueries: [] as string[],
    copied: [] as string[],
    toasts: [] as string[],
    written: [] as string[][],
  }
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    world.commands.push(argv)
    if (argv[0] === 'powershell.exe') return { value: ran(JSON.stringify({ terminal: STORE_TERMINAL, pwsh: true })) }
    if (argv[1] === 'worktree' && argv[2] === 'list') {
      const cwd = e.init?.cwd
      if (cwd === undefined) return { value: world.isSessionInRepo ? ran(PORCELAIN) : ran('', 128) }
      if (cwd.startsWith('D:\\repos\\other')) return { value: ran(OTHER_PORCELAIN) }
      if (cwd.startsWith('E:\\')) return { value: ran(`worktree ${cwd.replace(/\\/g, '/')}\nHEAD fff\nbranch refs/heads/main\n`) }
      if (cwd === 'C:\\Users\\me') return { value: ran('', 128) }
      return { value: ran(PORCELAIN) }
    }
    if (argv[1] === 'agents') return { value: ran(JSON.stringify(agents(world.busy2))) }
    if (argv[1] === 'remote') return { value: ran('https://github.com/acme/app.git\n') }
    if (argv[1] === 'rev-list') return { value: ran('0\n') }
    if (argv[1] === 'symbolic-ref') return { value: ran('origin/main\n') }
    if (argv[1] === 'rev-parse') return { value: ran('.git\n') }
    if (argv[1] === 'for-each-ref') {
      const refs = ['refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/feature-x', 'refs/heads/feature-x']
      return { value: ran(`${refs.join('\n')}\n`) }
    }
    if (argv[0] === 'gh') {
      const query = argv.at(-1) ?? ''
      world.prQueries.push(query)
      return { value: ran(JSON.stringify(githubReply(query))) }
    }
    if (argv.includes('new-tab')) {
      world.launched.push(argv)
      return { value: ran('', world.tabExit) }
    }
    if (argv.some(arg => arg.endsWith('append-line.ps1'))) world.appended.push(argv)
    if (argv.some(arg => arg.endsWith('trash-chat.ps1'))) world.trashed.push(argv)
    if (argv.some(arg => arg.endsWith('focus-tab.ps1'))) return { value: ran('', world.focusExit) }
    return { value: ran('') }
  })
  const isTrashed = (name: string) => world.trashed.some(argv => argv.some(arg => arg.endsWith(`\\${name}`)))
  on('session.id', () => ({ value: 'current-1' }))
  on('session.cwd', () => ({ value: 'D:\\repos\\app' }))
  on('fs.list', (_, e) => ({ value: (world.listings[e.path] ?? []).filter(entry => !isTrashed(entry.name)) }))
  on('fs.read', (_, e) => {
    const text = world.files[e.path]
    return text === undefined ? { deny: 'missing' } : { value: text }
  })
  on('fs.stat', () => ({ deny: 'missing' }))
  on('fs.write', (_, e) => {
    world.written.push([e.path, e.text])
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    world.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  return world
}

const openPane = async ($: Engine, surface: 'terminal' | 'desktop', rows: number, args: string) => {
  await $.command.run({
    command: 'worktrees',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  const ui = await $.ui.mount({
    plugin: 'worktrees',
    surface,
    component: 'Pane',
    requestId: 'worktrees',
    props: {
      title: 'Worktrees',
      isFocused: true,
      bodyColumns: 70,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  await ui.resize({ columns: 70, rows, in: 'board' })
  return ui
}

const openBoard = async ($: Engine, on: On, opening: Opening = {}) => {
  const world = stage(on, opening)
  const ui = await openPane($, opening.surface ?? 'terminal', opening.rows ?? 60, opening.args ?? 'add D:\\repos\\other')
  const rows = async () => {
    const client = await ui.find({ type: 'Client' })
    const { board, toggled, showingAll } = client?.props.props as BoardProps
    return buildRows(board, toggled, showingAll)
  }
  const rowOf = async (rowKey: string) => (await rows()).findIndex(row => row.key === rowKey)
  const stopOf = async (rowKey: string) => (await rows()).filter(isNavigable).findIndex(row => row.key === rowKey)
  const key = (k: string, mods: { ctrl?: true } = {}) => ui.key({ key: k, in: 'board', ...mods })
  const type = async (text: string) => {
    for (const k of text) await key(k)
  }
  const click = async (rowKey: string, button: 'left' | 'right' = 'left', x = 8) =>
    ui.pointer({ type: 'down', x, y: await rowOf(rowKey), button, in: 'board' })
  const pick = async (rowKey: string, item: number) => {
    await click(rowKey, 'right')
    for (let i = 0; i < item; i++) await key('j')
    await key('return')
  }
  const confirm = async () => {
    await key('k')
    await key('return')
  }
  const moveTo = async (rowKey: string) => {
    const stop = await stopOf(rowKey)
    await key('g')
    await key('g')
    for (let i = 0; i < stop; i++) await key('j')
  }
  const shows = async (text: RegExp) => (await ui.find({ in: 'board', text })) !== undefined
  const rowText = async (rowKey: string) => (await ui.find({ in: 'board', key: rowKey }))?.text ?? ''
  const ranGit = (...args: string[]) => world.commands.some(argv => args.every((arg, i) => argv[i + 1] === arg))
  return { world, ui, key, type, click, pick, confirm, moveTo, shows, rowText, ranGit }
}

type Pane = Awaited<ReturnType<typeof openBoard>>

test('projects show from any folder, and more are added from where Claude Code was used', async ($, on) => {
  const { world, ui, key, type, shows } = await openBoard($, on, {
    store: { repos: ['D:\\repos\\app'] },
    knobs: { isSessionInRepo: false },
    args: '',
  })
  expect(await ui.find({ in: 'board', key: 'repo:D:\\repos\\app' }), 'a saved project shows').toBeDefined()
  expect(await ui.find({ in: 'board', key: 'add-project' }), 'the add row shows').toBeDefined()

  await key('P')
  expect(await shows(/D:\\repos\\other/), 'offers the repo a subfolder was in').toBe(true)
  expect(await shows(/C:\\Users\\me/), 'leaves out a folder in no repo').toBe(false)
  await key('return')
  expect(world.toasts.at(-1)).toBe('Added other (D:\\repos\\other) to the worktrees pane.')
  expect(await ui.find({ in: 'board', key: 'repo:D:\\repos\\other' }), 'the added project shows').toBeDefined()

  await key('P')
  await type('E:\\code\\tool')
  expect(await shows(/add E:\\code\\tool/)).toBe(true)
  await key('return')
  expect(world.toasts.at(-1)).toBe('Added tool (E:\\code\\tool) to the worktrees pane.')
  await ui.unmount()
})

test('the repo a session runs in is saved, so it shows from anywhere after', async ($, on) => {
  const { world, ui, key } = await openBoard($, on, { args: '' })
  expect(await ui.find({ in: 'board', key: 'repo:D:\\repos\\app' })).toBeDefined()
  world.isSessionInRepo = false
  await key('R')
  expect(await ui.find({ in: 'board', key: 'repo:D:\\repos\\app' }), 'still listed from no repo').toBeDefined()
  await ui.unmount()
})

test('with no project yet the list offers to add one', async ($, on) => {
  const { ui } = await openBoard($, on, { knobs: { isSessionInRepo: false }, args: '' })
  const boxes = await ui.findAll({ in: 'board', type: 'Box' })
  expect(boxes.filter(box => box.key !== undefined && /^(repo|wt|chat|add-project)/.test(box.key)).map(box => box.key)).toEqual(['add-project'])
  await ui.unmount()
})

test('outside Windows Terminal, opening a chat copies the command to run', async ($, on) => {
  const { world, ui, click } = await openBoard($, on, { env: { USERPROFILE: WINDOWS_TERMINAL.USERPROFILE } })
  await click('chat:old-3')
  expect(world.copied.at(-1)).toBe('cd "D:\\repos\\app" && claude --resume old-3')
  expect(world.commands.some(argv => argv.includes('new-tab') || argv[0] === 'powershell.exe')).toBe(false)
  await ui.unmount()
})

test('when Windows Terminal refuses the tab, opening a chat copies the command instead', async ($, on) => {
  const { world, ui, click } = await openBoard($, on, { knobs: { tabExit: 1 } })
  await click('chat:old-3')
  expect(world.launched, 'the tab was tried first').toHaveLength(1)
  expect(world.copied.at(-1)).toBe('cd "D:\\repos\\app" && claude --resume old-3')
  expect(world.toasts.at(-1)).toBe('Copied; paste in a new terminal: cd "D:\\repos\\app" && claude --resume old-3')
  await ui.unmount()
})

test('on the desktop the list draws every row, at full length, without the terminal rule', async ($, on) => {
  const { ui } = await openBoard($, on, { surface: 'desktop', rows: 3 })
  expect((await ui.find({ type: 'Client' }))?.props.height).toBeUndefined()
  for (const key of ['chat:old-3', 'chat:bg-4', 'chat:other-5', 'pr:C:\\wt\\feature']) {
    expect(await ui.find({ in: 'board', key }), `${key} is drawn`).toBeDefined()
  }
  expect(await ui.find({ in: 'board', text: /──/ })).toBeUndefined()
  expect(await ui.find({ in: 'board', text: /by a good margin/ }), 'the long title is whole').toBeDefined()
  await ui.unmount()
})

test('a post the board never sends is dropped', async ($, on) => {
  const { world, ui, ranGit } = await openBoard($, on)
  const toasts = world.toasts.length
  await ui.post({ action: 'remove-workspace', path: 'C:\\wt\\quiet' }, { in: 'board' })
  await ui.post({ action: 'copy' }, { in: 'board' })
  await ui.post({ action: 'launch', path: 'C:\\wt\\quiet' }, { in: 'board' })
  expect(ranGit('worktree', 'remove', 'C:\\wt\\quiet'), 'a removal missing its options').toBe(false)
  expect(world.copied, 'a copy with no text').toEqual([])
  expect(world.toasts, 'nothing said').toHaveLength(toasts)
  await ui.post({ action: 'copy', text: 'C:\\wt\\quiet' }, { in: 'board' })
  expect(world.copied, 'a whole message still runs').toEqual(['C:\\wt\\quiet'])
  await ui.unmount()
})

const APP_CHATS = `${PROJECTS}\\D--repos-app`
const BLANK_CHAT: Opening = {
  listings: { [APP_CHATS]: [file('blank-7.jsonl', NOW - 6 * HOUR)] },
  files: { [`${APP_CHATS}\\blank-7.jsonl`]: '{"type":"queue-operation"}' },
}

test('a closed chat whose transcript names nothing is left out, and one that cannot be read is listed', async ($, on) => {
  const { ui, rowText } = await openBoard($, on, {
    ...BLANK_CHAT,
    listings: { [APP_CHATS]: [file('blank-7.jsonl', NOW - 6 * HOUR), file('locked-8.jsonl', NOW - 7 * HOUR)] },
  })
  expect(await ui.find({ in: 'board', key: 'chat:blank-7' }), 'read, with nothing to title it by').toBeUndefined()
  expect(await rowText('chat:locked-8'), 'not read').toMatch(/chat locked-8/)
  await ui.unmount()
})

test('a transcript once found to name nothing stops hiding its chat when it grows too large to read', async ($, on) => {
  const { world, ui, key, rowText } = await openBoard($, on, BLANK_CHAT)
  expect(await ui.find({ in: 'board', key: 'chat:blank-7' }), 'hidden while it names nothing').toBeUndefined()
  world.listings[APP_CHATS] = (world.listings[APP_CHATS] ?? [])
    .map(entry => entry.name === 'blank-7.jsonl' ? { ...entry, mtimeMs: NOW, size: 5 * 1024 * 1024 } : entry)
  await world.clock.advance(30_000)
  await key('R')
  expect(await rowText('chat:blank-7'), 'listed once it cannot be read again').toMatch(/chat blank-7/)
  await ui.unmount()
})

test('the main worktree offers no Remove workspace', async ($, on) => {
  const { ui, click, shows } = await openBoard($, on)
  await click('wt:D:\\repos\\app', 'right')
  expect(await shows(/Remove workspace/), 'no removal for main').toBe(false)
  await ui.unmount()
})

test('a workspace row shows its branch only when its title differs from it', async ($, on) => {
  const { ui, rowText } = await openBoard($, on)
  expect(await rowText('wt:C:\\wt\\feature')).toMatch(/Feature x/)
  expect(await rowText('wt:C:\\wt\\feature')).not.toMatch(/feature-x/)
  expect(await rowText('wt:C:\\wt\\a-worktree-folder-with-a-rather-long-name-of-its-own')).toMatch(/A branch name long.*feature\//)
  await ui.unmount()
})

test('renaming a workspace shows the new title beside its branch', async ($, on) => {
  const { world, ui, key, type, pick, rowText } = await openBoard($, on)
  await pick('wt:C:\\wt\\feature', 1)
  await key('u', { ctrl: true })
  await type('Checkout flow')
  await key('return')
  expect(await rowText('wt:C:\\wt\\feature')).toMatch(/Checkout flow.*feature-x/)
  expect(world.toasts.at(-1)).toBe('Workspace renamed to "Checkout flow".')
  await ui.unmount()
})

test('removing a workspace stops the chats running in it first', async ($, on) => {
  const { world, ui, pick, confirm, shows, ranGit } = await openBoard($, on, {
    store: { workspaceTitles: { 'c:\\wt\\feature': 'Checkout flow' } },
  })
  await pick('wt:C:\\wt\\feature', 5)
  expect(await shows(/Stop 2 chats and remove Checkout flow/), 'says it stops the running chats').toBe(true)
  await confirm()
  const stops = world.commands.filter(argv => argv[1] === 'stop' || argv[0] === 'taskkill')
  expect(stops).toEqual([['C:\\bin\\claude.exe', 'stop', 'job77'], ['taskkill', '/PID', '11', '/T', '/F']])
  expect(ranGit('worktree', 'remove', 'C:\\wt\\feature')).toBe(true)
  expect(world.toasts.at(-1)).toBe('Stopped 2 chats and removed Checkout flow.')
  await ui.unmount()
})

test('d removes a quiet workspace and keeps its branch', async ($, on) => {
  const { world, ui, key, click, confirm, shows, ranGit } = await openBoard($, on)
  await click('pr:C:\\wt\\quiet')
  await key('k')
  await key('d')
  expect(await shows(/Remove Quiet branch/)).toBe(true)
  await confirm()
  expect(ranGit('worktree', 'remove', 'C:\\wt\\quiet')).toBe(true)
  expect(ranGit('branch', '-D')).toBe(false)
  expect(world.toasts.at(-1)).toBe('Removed Quiet branch.')
  await ui.unmount()
})

test('cleaning up merged workspaces removes each with its pushed branch', async ($, on) => {
  const { world, ui, pick, confirm, shows, ranGit } = await openBoard($, on)
  await pick('repo:D:\\repos\\app', 5)
  expect(await shows(/Remove 1 merged workspace/)).toBe(true)
  await confirm()
  expect(ranGit('rev-list', '--count', 'quiet-branch', '--not', '--remotes')).toBe(true)
  expect(ranGit('branch', '-D', 'quiet-branch')).toBe(true)
  expect(world.toasts.at(-1)).toBe('Removed 1 merged workspace.')
  await ui.unmount()
})

test('pruning runs git worktree prune', async ($, on) => {
  const { ui, pick, ranGit } = await openBoard($, on)
  await pick('repo:D:\\repos\\app', 6)
  expect(ranGit('worktree', 'prune', '--verbose')).toBe(true)
  await ui.unmount()
})

const makeWorkspace = async (pane: Pane, title: string, filter: string, downs: number, firstPrompt: string) => {
  await pane.pick('repo:D:\\repos\\app', 0)
  await pane.type(title)
  await pane.key('return')
  expect(await pane.shows(/origin\/main {2}default/), 'lists the default branch first').toBe(true)
  expect(await pane.shows(/origin\/HEAD/), 'leaves out the HEAD alias').toBe(false)
  await pane.type(filter)
  for (let i = 0; i < downs; i++) await pane.key('down')
  await pane.key('return')
  expect(await pane.shows(/first prompt/), 'asks for the first prompt').toBe(true)
  await pane.type(firstPrompt)
  await pane.key('return')
}

test('a new workspace off a remote branch fetches it and opens a tab with the first prompt', async ($, on) => {
  const pane = await openBoard($, on)
  const { world, ui, ranGit } = pane
  await makeWorkspace(pane, 'Payment retries!', '', 0, 'Retry failed charges; then "report"')
  const home = 'D:\\repos\\app\\.claude\\worktrees\\payment-retries'
  expect(ranGit('fetch', '--quiet', 'origin', 'main'), 'fetches the remote base').toBe(true)
  expect(ranGit('worktree', 'add', '--no-track', '-b', 'payment-retries', home, 'origin/main'), 'adds off origin/main').toBe(true)
  const tab = world.launched.at(-1) ?? []
  expect(tab).toEqual(expect.arrayContaining(['-d', home, '--prompt-file']))
  expect(tab).not.toContain('--worktree')
  const [promptFile, written] = world.written.at(-1) ?? []
  expect(written).toBe('Retry failed charges; then "report"')
  expect(tab.at(-1)).toBe(promptFile)
  expect(world.written.some(([path, text]) => path === 'D:\\repos\\app\\.git\\info\\exclude' && text === '.claude/worktrees/\n'))
    .toBe(true)
  await ui.unmount()
})

test('a new workspace off a local branch fetches nothing', async ($, on) => {
  const pane = await openBoard($, on)
  const { world, ui, ranGit } = pane
  const fetches = world.commands.filter(argv => argv[1] === 'fetch').length
  await makeWorkspace(pane, 'Feature spike', 'feat', 1, '')
  expect(ranGit('worktree', 'add', '--no-track', '-b', 'feature-spike', 'D:\\repos\\app\\.claude\\worktrees\\feature-spike', 'feature-x'), 'adds off feature-x').toBe(true)
  expect(world.commands.filter(argv => argv[1] === 'fetch')).toHaveLength(fetches)
  await ui.unmount()
})

test('the list shows every repo\'s chats and what each asks of you', async ($, on) => {
  const { ui, shows } = await openBoard($, on)
  expect(await shows(/Fix login redirect/), 'shows Fix login redirect').toBe(true)
  expect(await shows(/tune the other service/), 'shows tune the other service').toBe(true)
  expect(await shows(/needs input/), 'shows needs input').toBe(true)
  await ui.unmount()
})

test('the chat you are in is marked, with nothing after its title', async ($, on) => {
  const { ui, rowText } = await openBoard($, on)
  const here = await rowText('chat:current-1')
  expect(here).toMatch(/▌.*build the mod/)
  expect(here.trimEnd()).toMatch(/build the mod$/)
  await ui.unmount()
})

test('the pane is the list alone: no line under the prompt', async ($, on) => {
  const { world, ui } = await openBoard($, on)
  expect(world.statuses, 'no line under the prompt').toEqual([])
  expect((await ui.drawn()).type).toBe('Client')
  await ui.unmount()
})

test('one GitHub query asks for every branch with its own PR, main left out', async ($, on) => {
  const { world, ui } = await openBoard($, on)
  expect(world.prQueries).toHaveLength(1)
  expect(world.prQueries[0]).toMatch(/headRefName: "feature-x".*headRefName: "quiet-branch"/)
  expect(world.prQueries[0]).not.toMatch(/headRefName: "main"/)
  await ui.unmount()
})

test('each PR row shows its state, checks, review and open threads', async ($, on) => {
  const { ui, rowText } = await openBoard($, on)
  const featurePr = await rowText('pr:C:\\wt\\feature')
  for (const chip of ['#41', '3 comments', 'changes requested', '2 unresolved', '✗ CI']) {
    expect(featurePr, `feature PR row has ${chip}`).toContain(chip)
  }
  expect(await rowText('pr:C:\\wt\\quiet')).toMatch(/#40\s+merged · ✓ CI · ✓ approved/)
  await ui.unmount()
})

test('a chat that needs input animates through every waiting frame', async ($, on) => {
  const { ui } = await openBoard($, on)
  const shapes = new Set<string>()
  for (let frame = 0; frame < 24; frame++) {
    await ui.advance(120)
    const glyph = (await ui.findAll({ in: 'board', type: 'Text' }))
      .map(one => one.text.trim())
      .find(text => WAITING.includes(text))
    expect(glyph, `needs-input glyph on frame ${frame}`).toBeDefined()
    shapes.add(glyph ?? '')
  }
  expect([...shapes].sort()).toEqual([...WAITING].sort())
  await ui.unmount()
})

test('no row runs past the pane\'s width', async ($, on) => {
  const { ui, shows } = await openBoard($, on)
  expect(await shows(/A branch name long/), 'the long branch row is drawn').toBe(true)
  for (const box of await ui.findAll({ in: 'board', type: 'Box' })) {
    if (box.key === undefined || !/^(repo|wt|chat|quiet|older):/.test(box.key)) continue
    expect([...box.text].length, `width of ${box.key}`).toBeLessThanOrEqual(70)
  }
  await ui.unmount()
})

test('clicking a closed chat resumes it in a new Windows Terminal tab', async ($, on) => {
  const { world, ui, click } = await openBoard($, on)
  await click('chat:old-3')
  const tab = world.launched.at(-1) ?? []
  expect(tab[0]).toBe(STORE_WT)
  expect(tab).toEqual(expect.arrayContaining(['-p', '{pwsh-profile}', '-d', 'D:\\repos\\app', 'pwsh.exe', '-NoExit', '--resume', 'old-3']))
  expect(world.toasts.at(-1)).toBe('Opened "Fix login redirect" in a new tab.')
  await ui.unmount()
})

test('clicking a running chat switches to its tab, or says where it runs when the tab is gone', async ($, on) => {
  const { world, ui, click } = await openBoard($, on)
  const tabs = world.launched.length
  await click('chat:busy-2')
  const focus = world.commands.find(argv => argv.some(arg => arg.endsWith('focus-tab.ps1'))) ?? []
  expect(focus.slice(-2)).toEqual(['-ProcessId', '11'])
  expect(world.launched).toHaveLength(tabs)
  expect(world.toasts.at(-1)).toBe('Switched to "write the feature".')
  world.focusExit = 1
  await click('chat:busy-2')
  expect(world.toasts.at(-1)).toBe('"write the feature" is open in another window (pid 11); its tab could not be found.')
  await ui.unmount()
})

test('Enter on a background chat attaches to its job', async ($, on) => {
  const { world, ui, key, moveTo } = await openBoard($, on)
  const opened = world.launched.length
  await moveTo('chat:bg-4')
  await key('return')
  expect(world.launched.length).toBe(opened + 1)
  expect(world.launched.at(-1)).toEqual(expect.arrayContaining(['-d', 'C:\\wt\\feature', 'attach', 'job77']))
  await ui.unmount()
})

test('h on a chat folds its worktree and l unfolds it', async ($, on) => {
  const { ui, key, moveTo, shows } = await openBoard($, on)
  await moveTo('chat:bg-4')
  await key('h')
  expect(await shows(/migrate the schema/), 'shows migrate the schema').toBe(false)
  await key('l')
  expect(await shows(/migrate the schema/), 'shows migrate the schema').toBe(true)
  await ui.unmount()
})

test('clicking a worktree row\'s + starts a new chat there', async ($, on) => {
  const { world, ui, click } = await openBoard($, on)
  await click('wt:C:\\wt\\feature', 'left', 69)
  const fresh = world.launched.at(-1) ?? []
  expect(fresh).toEqual(expect.arrayContaining(['-d', 'C:\\wt\\feature']))
  expect(fresh.at(-1)).toMatch(/open-chat\.ps1$/)
  await ui.unmount()
})

test('Copy path copies the worktree\'s path and closes the menu', async ($, on) => {
  const { world, ui, key, click, shows } = await openBoard($, on)
  await click('wt:C:\\wt\\feature', 'right')
  expect(await shows(/New chat here/), 'shows the worktree menu').toBe(true)
  for (let i = 0; i < 4; i++) await key('j')
  await key('return')
  expect(world.copied.at(-1)).toBe('C:\\wt\\feature')
  expect(await shows(/New chat here/), 'the menu closed').toBe(false)
  await ui.unmount()
})

test('renaming a closed chat writes the title into its transcript', async ($, on) => {
  const { world, ui, key, type, pick, shows } = await openBoard($, on)
  await pick('chat:old-3', 1)
  await key('u', { ctrl: true })
  await type('Login fix')
  await key('return')
  expect(await shows(/Login fix/), 'shows Login fix').toBe(true)
  expect(world.appended.at(-1)).toEqual(expect.arrayContaining([
    `${PROJECTS}\\D--repos-app\\old-3.jsonl`,
    JSON.stringify({ type: 'custom-title', customTitle: 'Login fix', sessionId: 'old-3' }),
  ]))
  await ui.unmount()
})

const RENAMED_OLD_3: Opening = { store: { titles: { 'old-3': 'Login fix' } } }

const askToDelete = async (pane: Pane) => {
  await pane.pick('chat:old-3', 4)
  expect(await pane.shows(/Delete "Login fix"/), 'asks to confirm').toBe(true)
}

test('Cancel on the delete confirmation keeps the chat', async ($, on) => {
  const pane = await openBoard($, on, RENAMED_OLD_3)
  const { world, ui, key, shows } = pane
  await askToDelete(pane)
  await key('return')
  expect(world.trashed).toHaveLength(0)
  expect(await shows(/Login fix/), 'cancel kept the chat').toBe(true)
  await ui.unmount()
})

test('deleting a chat moves its transcript to the trash and drops its row', async ($, on) => {
  const pane = await openBoard($, on, RENAMED_OLD_3)
  const { world, ui, confirm, shows } = pane
  await askToDelete(pane)
  await confirm()
  expect(world.trashed.at(-1)).toEqual(expect.arrayContaining([
    `${PROJECTS}\\D--repos-app\\old-3.jsonl`,
    'C:\\Users\\me\\.claude\\worktrees-trash\\D--repos-app',
  ]))
  expect(await shows(/Login fix/), 'the deleted chat is gone').toBe(false)
  await ui.unmount()
})

test('a background chat is stopped before it is deleted, and stays gone while still listed as running', async ($, on) => {
  const { world, ui, pick, confirm, shows } = await openBoard($, on)
  await pick('chat:bg-4', 4)
  expect(await shows(/Stop and delete "migrate the schema"/), 'says it stops the chat').toBe(true)
  await confirm()
  expect(world.commands).toContainEqual(['C:\\bin\\claude.exe', 'stop', 'job77'])
  expect(world.trashed.at(-1)).toEqual(expect.arrayContaining([`${PROJECTS}\\C--wt-feature\\bg-4.jsonl`]))
  expect(await ui.find({ in: 'board', key: 'chat:bg-4' }), 'the stopped chat stays gone').toBeUndefined()
  await ui.unmount()
})

test('the chat you are in has no Delete', async ($, on) => {
  const { ui, click, shows } = await openBoard($, on)
  await click('chat:current-1', 'right')
  expect(await shows(/Delete chat/), 'no delete for this chat').toBe(false)
  await ui.unmount()
})

test('a chat that stops working is flagged your turn, with no status line', async ($, on) => {
  const { world, ui, key, shows } = await openBoard($, on)
  world.busy2 = 'idle'
  await key('R')
  expect(await shows(/your turn/), 'shows your turn').toBe(true)
  expect(world.statuses, 'no line under the prompt').toEqual([])
  await ui.unmount()
})
