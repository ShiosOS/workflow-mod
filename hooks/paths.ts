const isDrivePath = (path: string) => /^[A-Za-z]:[\\/]/.test(path)

export const toNativePath = (path: string) =>
  isDrivePath(path) ? path.replace(/\//g, '\\') : path

export type PathKey = string & { readonly __brand: 'PathKey' }

export const pathKey = (path: string) => {
  const bare = toNativePath(path).replace(/[\\/]+$/, '')
  return (isDrivePath(path) ? bare.toLowerCase() : bare) as PathKey
}

export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b)

export const isInside = (child: string, parent: string) => {
  const c = pathKey(child)
  const p = pathKey(parent)
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`)
}

export const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

export const joinPath = (base: string, ...parts: string[]) => {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

// The folder name Claude Code keeps a directory's transcripts under in
// ~/.claude/projects.
export const projectDirName = (path: string) =>
  toNativePath(path).replace(/[^a-zA-Z0-9]/g, '-')
