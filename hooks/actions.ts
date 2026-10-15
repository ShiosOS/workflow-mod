import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderSurface } from 'claude-code'

import type { Board, BoardMessage, Worktree } from '../types'
import { deleteBranchIfPushed, excludeWorktrees, listBranchRefs, listWorktrees, prune, removeFolder, git, rootOf } from './git'
import { claudeDir, focusTab, launch, listAgents, openExternally, runScript, say, stopChat } from './host'
import { isInside, joinPath, lastSegment, pathKey, samePath } from './paths'
import { forgetTitle, readHistory, refresh } from './scan'
import { BOARD_SHAPE, keep, load, PANE, retitleWorkspace } from './state'
import { clip, firstLine, slugOf } from './text'

// The state this file reads or writes, declared here: the engine lists a
// module's state from the literal references in the file that uses them.
const board = atom({ plugin: 'worktrees', key: 'board' } as const, null, { shape: BOARD_SHAPE })
const showingAll = atom({ plugin: 'worktrees', key: 'showingAll' } as const, [])
const toggled = atom({ plugin: 'worktrees', key: 'toggled' } as const, [])
const yourTurn = atom({ plugin: 'worktrees', key: 'yourTurn' } as const, [])
const branches = atom({ plugin: 'worktrees', key: 'branches' } as const, null)
const projects = atom({ plugin: 'worktrees', key: 'projects' } as const, null)

const findChat = (view: Board | null, sessionId: string) => {
  for (const repo of view?.repos ?? []) {
    for (const wt of repo.worktrees) {
      const chat = wt.chats.find(one => one.sessionId === sessionId)
      if (chat !== undefined) return { wt, chat }
    }
  }
  return undefined
}

const findWorkspace = (view: Board | null, path: string) => {
  for (const repo of view?.repos ?? []) {
    const wt = repo.worktrees.find(one => samePath(one.path, path))
    if (wt !== undefined) return { repo, wt }
  }
  return undefined
}

async function openChat($: EngineInterface, sessionId: string, surface: RenderSurface) {
  const found = findChat(await read($, board), sessionId)
  if (found === undefined) return
  const { wt, chat } = found
  await update($, yourTurn, ids => ids.filter(id => id !== sessionId))
  const name = `"${clip(chat.title, 40)}"`
  if (chat.signal === 'here') {
    say($, 'That is the chat you are in.')
  } else if (chat.live?.kind === 'interactive') {
    const isShown = chat.live.pid !== null && (await focusTab($, chat.live.pid))
    say($, isShown
      ? `Switched to ${name}.`
      : `${name} is open in another window (pid ${chat.live.pid}); its tab could not be found.`)
  } else {
    const jobId = chat.live?.kind === 'background' ? chat.live.jobId : null
    await launch($, wt.path, chat.title, jobId === null ? ['--resume', chat.sessionId] : ['attach', jobId], surface)
  }
  await refresh($)
}

// Windows holds a file a process just closed until the process is gone.
async function trashTranscript($: EngineInterface, transcript: string, tries: number) {
  const trash = joinPath(await claudeDir($), 'worktrees-trash', transcript.split(/[\\/]/).at(-2) ?? 'unknown')
  for (let attempt = 1; ; attempt += 1) {
    const ran = await runScript($, 'trash-chat.ps1', [transcript, trash])
    if (ran.exitCode === 0) return { trash, error: null }
    if (attempt >= tries) return { trash, error: firstLine(ran.stderr) }
    await $.clock.sleep(1000)
  }
}

async function deleteChat($: EngineInterface, sessionId: string) {
  const found = findChat(await read($, board), sessionId)
  if (found === undefined) return
  const { chat } = found
  const name = `"${clip(chat.title, 40)}"`
  if (chat.signal === 'here') {
    say($, `Kept ${name}: it is the chat you are in.`)
    return
  }
  const wasStopped = await stopChat($, chat)
  const trashed = chat.transcript === null ? null : await trashTranscript($, chat.transcript, wasStopped ? 5 : 1)
  if (trashed?.error != null) {
    say($, `Could not delete ${name}: ${trashed.error}`)
    await refresh($)
    return
  }
  await keep($, 'deleted', [...(await load($, 'deleted')), sessionId].slice(-500))
  await update($, yourTurn, ids => ids.filter(id => id !== sessionId))
  if (chat.transcript !== null) forgetTitle(chat.transcript)
  const where = trashed === null ? '' : `; it is in ${trashed.trash} if you want it back`
  say($, `${wasStopped ? 'Stopped and deleted' : 'Deleted'} ${name}${where}.`)
  await refresh($)
}

async function renameChat($: EngineInterface, sessionId: string, title: string) {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 200)
  await keep($, 'titles', { ...(await load($, 'titles')), [sessionId]: clean })
  const found = findChat(await read($, board), sessionId)
  const isClosed = found !== undefined && found.chat.live === null
  if (isClosed && found.chat.transcript !== null) {
    const record = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId })
    await runScript($, 'append-line.ps1', [found.chat.transcript, record])
  }
  say($, isClosed
    ? `Renamed to "${clean}".`
    : `Renamed to "${clean}" here; /rename in that chat renames it there too.`)
  await refresh($)
}

async function renameWorkspace($: EngineInterface, path: string, title: string) {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  await retitleWorkspace($, path, clean)
  say($, clean === '' ? 'Workspace title reset to its branch.' : `Workspace renamed to "${clean}".`)
  await refresh($)
}

async function newWorkspace($: EngineInterface, root: string, title: string, base: string, prompt: string, surface: RenderSurface) {
  const slug = slugOf(title)
  if (slug === '') {
    say($, `"${title}" has no letters or digits to name a worktree by.`)
    return
  }
  const remote = /^origin\/(.+)$/.exec(base)?.[1]
  if (remote !== undefined) await git($, root, ['fetch', '--quiet', 'origin', remote])
  const path = joinPath(root, '.claude', 'worktrees', slug)
  const added = await git($, root, ['worktree', 'add', '--no-track', '-b', slug, path, base])
  if (added.exitCode !== 0) {
    say($, `Could not make "${title}": ${firstLine(added.stderr)}`)
    return
  }
  await excludeWorktrees($, root)
  await retitleWorkspace($, path, title)
  await refresh($)
  await launch($, path, title, [], surface, prompt)
}

async function listBranches($: EngineInterface, root: string) {
  await update($, branches, () => ({ root, refs: [], defaultRef: null, isLoading: true }))
  const { defaultRef, refs } = await listBranchRefs($, root)
  await update($, branches, () => ({ root, refs, defaultRef, isLoading: false }))
}

type Removal = { isRemoved: true; stopped: number; branchNote: string } | { isRemoved: false; reason: string }

async function keepReason($: EngineInterface, wt: Worktree) {
  if (wt.isMain) return 'it is the main worktree'
  if (isInside(await $.session.cwd(), wt.path)) return 'this chat runs in it'
  return null
}

async function removeOne($: EngineInterface, root: string, wt: Worktree, options: { dropsBranch: boolean; force: boolean }): Promise<Removal> {
  const reason = await keepReason($, wt)
  if (reason !== null) return { isRemoved: false, reason }
  let stopped = 0
  for (const chat of wt.chats) if (await stopChat($, chat)) stopped += 1
  const removed = await removeFolder($, root, wt.path, options.force, stopped > 0 ? 5 : 1)
  if (removed.exitCode !== 0) {
    return {
      isRemoved: false,
      reason: /modified or untracked/i.test(removed.stderr)
        ? 'it has uncommitted changes. Commit or stash them, or use Discard changes and remove'
        : firstLine(removed.stderr),
    }
  }
  const branchNote = options.dropsBranch && wt.branch !== null ? `; ${await deleteBranchIfPushed($, root, wt.branch)}` : ''
  return { isRemoved: true, stopped, branchNote }
}

async function removeWorkspace($: EngineInterface, path: string, dropsBranch: boolean, force: boolean) {
  const found = findWorkspace(await read($, board), path)
  if (found === undefined) return
  const { repo, wt } = found
  const outcome = await removeOne($, repo.root, wt, { dropsBranch, force })
  if (!outcome.isRemoved) {
    say($, `Kept ${wt.title}: ${outcome.reason}.`)
  } else {
    const chats = `${outcome.stopped} chat${outcome.stopped === 1 ? '' : 's'}`
    const done = outcome.stopped === 0 ? `Removed ${wt.title}` : `Stopped ${chats} and removed ${wt.title}`
    say($, `${done}${outcome.branchNote}.`)
  }
  await refresh($)
}

async function cleanMerged($: EngineInterface, root: string) {
  const repo = (await read($, board))?.repos.find(one => samePath(one.root, root))
  if (repo === undefined) return
  const removed: string[] = []
  const kept: string[] = []
  for (const wt of repo.worktrees.filter(one => !one.isMain && one.pr?.state === 'MERGED')) {
    const outcome = await removeOne($, repo.root, wt, { dropsBranch: true, force: false })
    if (outcome.isRemoved) removed.push(wt.title)
    else kept.push(`${wt.title} (${outcome.reason})`)
  }
  say($, `Removed ${removed.length} merged workspace${removed.length === 1 ? '' : 's'}${kept.length > 0 ? `; kept ${kept.join(', ')}` : ''}.`)
  await refresh($)
}

async function pruneWorkspaces($: EngineInterface, root: string) {
  const { count, error } = await prune($, root)
  say($, error !== null
    ? `Could not prune: ${error}`
    : count === 0 ? 'No missing worktrees to prune.' : `Pruned ${count} missing worktree${count === 1 ? '' : 's'}.`)
  await refresh($)
}

export async function addProject($: EngineInterface, path: string) {
  const refs = await listWorktrees($, path)
  const root = refs === null ? undefined : rootOf(refs)
  if (root === undefined) return `${path} is not in a git repository.`
  const known = await load($, 'repos')
  if (!known.some(one => samePath(one, root))) await keep($, 'repos', [...known, root])
  return `Added ${lastSegment(root)} (${root}) to the worktrees pane.`
}

export async function removeProject($: EngineInterface, target: string) {
  const known = await load($, 'repos')
  const kept = known.filter(one => !samePath(one, target) && lastSegment(one).toLowerCase() !== target.toLowerCase())
  if (kept.length === known.length) return `${target} is not an added repo. Added: ${known.join(', ') || 'none'}.`
  await keep($, 'repos', kept)
  return `Removed ${target} from the worktrees pane.`
}

const PROJECT_FOLDER_LIMIT = 60

async function listProjects($: EngineInterface) {
  await update($, projects, () => ({ paths: [], isLoading: true }))
  const lastUsed = new Map<string, number>()
  const use = (folder: string, at: number) => lastUsed.set(folder, Math.max(lastUsed.get(folder) ?? 0, at))
  for (const row of await readHistory($)) if (row.project !== null) use(row.project, row.at)
  for (const agent of await listAgents($)) use(agent.cwd, agent.startedAt)

  const known = await load($, 'repos')
  const found = new Map<string, { root: string; at: number }>()
  const folders = [...lastUsed].sort((a, b) => b[1] - a[1]).slice(0, PROJECT_FOLDER_LIMIT)
  for (const [folder, at] of folders) {
    const refs = await listWorktrees($, folder)
    const root = refs === null ? undefined : rootOf(refs)
    if (root === undefined || known.some(one => samePath(one, root))) continue
    const seen = found.get(pathKey(root))
    if (seen === undefined || seen.at < at) found.set(pathKey(root), { root, at })
  }
  const paths = [...found.values()].sort((a, b) => b.at - a.at).map(one => one.root)
  await update($, projects, () => ({ paths, isLoading: false }))
}

const toggle = (list: string[], item: string) =>
  list.includes(item) ? list.filter(one => one !== item) : [...list, item]

async function toggleFold($: EngineInterface, key: string) {
  await keep($, 'folds', await update($, toggled, keys => toggle(keys, key)))
}

async function toggleOlder($: EngineInterface, path: string) {
  await update($, showingAll, paths => toggle(paths, path))
  await refresh($)
}

export async function dispatch($: EngineInterface, message: BoardMessage, surface: RenderSurface) {
  switch (message.action) {
    case 'open-chat':
      return openChat($, message.sessionId, surface)
    case 'new-chat':
      return launch($, message.path, findWorkspace(await read($, board), message.path)?.wt.title ?? 'new chat', [], surface)
    case 'toggle-fold':
      return toggleFold($, message.key)
    case 'toggle-older':
      return toggleOlder($, message.path)
    case 'rename-chat':
      return renameChat($, message.sessionId, message.title)
    case 'delete-chat':
      return deleteChat($, message.sessionId)
    case 'remove-project':
      say($, await removeProject($, message.root))
      return refresh($)
    case 'refresh':
      return refresh($, { isForced: true })
    case 'remove-workspace':
      return removeWorkspace($, message.path, message.dropBranch, message.force)
    case 'clean-merged':
      return cleanMerged($, message.root)
    case 'prune':
      return pruneWorkspaces($, message.root)
    case 'list-branches':
      return listBranches($, message.root)
    case 'new-workspace':
      return newWorkspace($, message.root, message.title, message.base, message.prompt, surface)
    case 'rename-workspace':
      return renameWorkspace($, message.path, message.title)
    case 'list-projects':
      return listProjects($)
    case 'add-project':
      say($, await addProject($, message.path))
      return refresh($)
    case 'browse':
      await openExternally($, message.url)
      return say($, `Opened ${message.url}`)
    case 'reveal':
      await openExternally($, message.path)
      return say($, `Opened ${message.path}`)
    case 'copy': {
      const copied = await $.ui.copy({ text: message.text, surface })
      return say($, copied.isCopied ? `Copied ${clip(message.text, 60)}` : `Could not copy: ${copied.reason}`)
    }
    case 'close':
      return $.ui.close({ id: PANE })
    default:
      message satisfies never
  }
}
