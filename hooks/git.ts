import type { EngineInterface } from 'claude-code'

import { parseWorktrees } from './parse'
import type { WorktreeRef } from './parse'
import { joinPath } from './paths'
import { firstLine } from './text'

export function git($: EngineInterface, cwd: string, args: string[]) {
  return $.process
    .run(['git', ...args], { cwd, timeoutMs: 60_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
}

export async function listWorktrees($: EngineInterface, cwd?: string) {
  const ran = await $.process
    .run(['git', 'worktree', 'list', '--porcelain'], cwd === undefined ? undefined : { cwd })
    .catch(() => null)
  return ran?.exitCode === 0 ? parseWorktrees(ran.stdout) : null
}

export const rootOf = (refs: WorktreeRef[]) => (refs.find(ref => ref.isMain) ?? refs[0])?.path

// Windows holds a folder a process just left until the process is gone.
export async function removeFolder($: EngineInterface, root: string, path: string, force: boolean, tries: number) {
  for (let attempt = 1; ; attempt += 1) {
    const ran = await git($, root, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
    if (ran.exitCode === 0 || attempt >= tries || /modified or untracked/i.test(ran.stderr)) return ran
    await $.clock.sleep(1000)
  }
}

export async function deleteBranchIfPushed($: EngineInterface, root: string, branch: string) {
  const unique = await git($, root, ['rev-list', '--count', branch, '--not', '--remotes'])
  const count = Number(unique.stdout.trim())
  if (unique.exitCode !== 0 || !Number.isInteger(count)) return 'kept its branch (could not check it)'
  if (count > 0) return `kept its branch: ${count} commit${count === 1 ? '' : 's'} on no remote`
  const deleted = await git($, root, ['branch', '-D', branch])
  return deleted.exitCode === 0 ? 'deleted its branch' : `kept its branch: ${firstLine(deleted.stderr)}`
}

const BRANCH_LIMIT = 300

export async function listBranchRefs($: EngineInterface, root: string) {
  const [head, listed] = await Promise.all([
    git($, root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    git($, root, ['for-each-ref', '--sort=-committerdate', `--count=${BRANCH_LIMIT}`, '--format=%(refname)', 'refs/heads', 'refs/remotes']),
  ])
  const defaultRef = head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : null
  const refs = listed.stdout
    .split(/\r?\n/)
    .filter(ref => ref !== '' && !ref.endsWith('/HEAD'))
    .map(ref => ref.replace(/^refs\/(heads|remotes)\//, ''))
  return { defaultRef, refs: defaultRef === null ? refs : [defaultRef, ...refs.filter(ref => ref !== defaultRef)] }
}

export async function excludeWorktrees($: EngineInterface, root: string) {
  const common = await git($, root, ['rev-parse', '--git-common-dir'])
  if (common.exitCode !== 0) return
  const dir = common.stdout.trim()
  const exclude = joinPath(/^[A-Za-z]:|^[\\/]/.test(dir) ? dir : joinPath(root, dir), 'info', 'exclude')
  const read = await $.fs.read(exclude).catch(() => '')
  const text = typeof read === 'string' ? read : ''
  if (/\.claude\/worktrees/.test(text)) return
  await $.fs.write(exclude, `${text === '' ? '' : text.replace(/\n*$/, '\n')}.claude/worktrees/\n`)
}

export async function prune($: EngineInterface, root: string) {
  const ran = await git($, root, ['worktree', 'prune', '--verbose'])
  const lines = `${ran.stdout}\n${ran.stderr}`.split(/\r?\n/).filter(line => /^Removing/i.test(line.trim()))
  return ran.exitCode === 0 ? { count: lines.length, error: null } : { count: 0, error: firstLine(ran.stderr) }
}
