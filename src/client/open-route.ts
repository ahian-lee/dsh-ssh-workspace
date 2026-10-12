// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { Workspace } from './api.ts'

/** Select only from the path's alias or the current Session's remote world. */
export function resolveRemoteOpenWorkspace(
  workspaces: readonly Workspace[],
  path: string,
  cwd?: string,
): Workspace | undefined {
  const aliasMatch = bestMatch(workspaces, path, workspace => workspace.aliasPath, localContains)
  if (aliasMatch !== undefined) return aliasMatch
  if (cwd === undefined) return undefined
  const current = bestMatch(workspaces, cwd, workspace => workspace.aliasPath, localContains)
    ?? bestMatch(workspaces, cwd, workspace => workspace.remotePath, posixContains)
  if (current === undefined) return undefined
  return path.startsWith('/') || localContains(current.aliasPath, path) ? current : undefined
}

function bestMatch(
  workspaces: readonly Workspace[],
  path: string,
  root: (workspace: Workspace) => string,
  contains: (root: string, path: string) => boolean,
): Workspace | undefined {
  let best: Workspace | undefined
  let length = -1
  for (const workspace of workspaces) {
    const candidate = root(workspace)
    if (candidate.length > length && contains(candidate, path)) {
      best = workspace
      length = candidate.length
    }
  }
  return best
}

function localContains(root: string, path: string): boolean {
  const left = normalizeLocal(root)
  const right = normalizeLocal(path)
  return right === left || right.startsWith(`${left}/`)
}

function normalizeLocal(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function posixContains(root: string, path: string): boolean {
  const normalizedRoot = normalizePosix(root)
  const normalizedPath = normalizePosix(path)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function normalizePosix(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
