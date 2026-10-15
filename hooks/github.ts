import type { EngineInterface } from 'claude-code'

import type { PrStatus } from '../types'

type GitHubRepo = { owner: string; name: string }

const PR_TTL_MS = 120_000
const remotes = new Map<string, GitHubRepo | null>()
const prCache = new Map<string, { at: number; prs: Map<string, PrStatus | null> }>()

async function githubOf($: EngineInterface, root: string) {
  if (!remotes.has(root)) {
    const ran = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: root }).catch(() => null)
    remotes.set(root, ran?.exitCode === 0 ? parseGitHubRemote(ran.stdout) : null)
  }
  return remotes.get(root) ?? null
}

export async function prsOf($: EngineInterface, root: string, branches: string[], now: number) {
  const cached = prCache.get(root)
  const isFresh =
    cached !== undefined && now - cached.at < PR_TTL_MS && branches.every(branch => cached.prs.has(branch))
  if (isFresh) return cached.prs
  const repo = await githubOf($, root)
  if (repo === null || branches.length === 0) {
    const none = new Map(branches.map(branch => [branch, null] as const))
    prCache.set(root, { at: now, prs: none })
    return none
  }
  const ran = await $.process
    .run(['gh', 'api', 'graphql', '-f', `query=${prQuery(repo, branches)}`], { cwd: root, timeoutMs: 15_000 })
    .catch(() => null)
  const prs = ran?.exitCode === 0 ? parsePrs(ran.stdout, branches) : (cached?.prs ?? new Map())
  prCache.set(root, { at: now, prs })
  return prs
}

export const forgetPrs = () => prCache.clear()

// Branches whose name other people's forks share: a PR found by one is
// rarely the worktree's.
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk'])

export const hasOwnPr = (branch: string | null): branch is string =>
  branch !== null && !SHARED_BRANCHES.has(branch)

const parseGitHubRemote = (url: string): GitHubRepo | null => {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match?.[1] === undefined || match[2] === undefined ? null : { owner: match[1], name: match[2] }
}

const FIELDS = [
  'number url state isDraft reviewDecision',
  'comments { totalCount }',
  'reviewThreads(first: 100) { nodes { isResolved } }',
  'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }',
].join(' ')

const prQuery = (repo: GitHubRepo, branches: readonly string[]) => {
  const parts = branches.map((branch, i) =>
    `b${i}: pullRequests(headRefName: ${JSON.stringify(branch)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${FIELDS} } }`,
  )
  return `query { repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${parts.join(' ')} } }`
}

type Node = {
  number?: unknown
  url?: unknown
  state?: unknown
  isDraft?: unknown
  reviewDecision?: unknown
  comments?: { totalCount?: unknown }
  reviewThreads?: { nodes?: { isResolved?: unknown }[] }
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: unknown } | null } }[] }
}

const checksOf = (state: unknown): PrStatus['checks'] =>
  state === 'SUCCESS' ? 'passing'
    : state === 'FAILURE' || state === 'ERROR' ? 'failing'
      : state === 'PENDING' || state === 'EXPECTED' ? 'pending'
        : 'none'

const reviewOf = (decision: unknown): PrStatus['review'] =>
  decision === 'APPROVED' ? 'approved'
    : decision === 'CHANGES_REQUESTED' ? 'changes'
      : decision === 'REVIEW_REQUIRED' ? 'pending'
        : 'none'

const statusOf = (node: Node): PrStatus | null => {
  if (typeof node.number !== 'number' || typeof node.url !== 'string') return null
  const state = node.state === 'MERGED' || node.state === 'CLOSED' ? node.state : 'OPEN'
  return {
    number: node.number,
    url: node.url,
    state,
    isDraft: node.isDraft === true,
    checks: checksOf(node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.state),
    review: reviewOf(node.reviewDecision),
    threads: (node.reviewThreads?.nodes ?? []).filter(thread => thread.isResolved === false).length,
    comments: typeof node.comments?.totalCount === 'number' ? node.comments.totalCount : 0,
  }
}

const parsePrs = (json: string, branches: readonly string[]) => {
  const found = new Map<string, PrStatus | null>()
  let repository: Record<string, { nodes?: Node[] } | undefined> = {}
  try {
    repository = (JSON.parse(json) as { data?: { repository?: typeof repository } }).data?.repository ?? {}
  } catch {
    return found
  }
  branches.forEach((branch, i) => {
    const node = repository[`b${i}`]?.nodes?.[0]
    found.set(branch, node === undefined ? null : statusOf(node))
  })
  return found
}
