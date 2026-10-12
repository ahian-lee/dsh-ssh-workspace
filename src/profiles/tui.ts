// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  TuiWorkspaceChoice,
  TuiWorkspaceCommand,
  TuiWorkspaceCommandResult,
  TuiWorkspaceProvider,
  TuiWorkspaceRuntime,
  TuiWorkspaceTarget,
} from '@deepseek-harness-tui/dsh-tui/workspaces'
import type { RemoteDirectoryListing, RemoteSshManager, RemoteSshServer, RemoteWorkspaceRoute } from '../routing/manager.ts'
import { discoveredSshServerId } from '../ssh/config.ts'
import { listAvailableServers } from '../tui/servers.ts'

export { listAvailableServers } from '../tui/servers.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSshTui: object
  }
}

export interface ParsedSshWorkspaceUri {
  selector: string
  sshTarget: string
  remotePath: string
  port?: number
}

export const name = 'dsh-ssh-workspace-tui'
export const inject = ['remoteSshManager']

/** Activate the terminal adapter only when a workspace registry is present. */
export function apply(ctx: Context): void {
  ctx.inject(['tuiWorkspaces'], registerTuiProvider)
}

/** Register the SSH workspace catalog and command executor with dsh-tui. */
function registerTuiProvider(ctx: Context): void {
  const registry = ctx.get('tuiWorkspaces') as TuiWorkspaceRuntime
  const manager = ctx.remoteSshManager
  const provider: TuiWorkspaceProvider = {
    schemes: ['ssh'],
    list: () => manager.snapshot().workspaces.map(workspace => targetForRoute(manager.workspace(workspace.id))),
    resolve: uri => resolveSshWorkspaceUri(manager, uri),
    resolvePath: (path, cwd) => resolveSshWorkspacePath(manager, path, cwd),
    describe: cwd => describeRemoteCwd(manager, cwd),
    rename: async (cwd, title) => {
      const route = manager.route(undefined, cwd)
      if (route.kind !== 'remote') return undefined
      return targetForRoute(await manager.renameWorkspace(route.workspace.id, title))
    },
    commands: [remoteWorkspaceCommand(manager)],
    commandShell: async cwd => {
      const route = manager.route(undefined, cwd)
      if (route.kind !== 'remote') return undefined
      return manager.workspaceShell(route, 'bash')
    },
  }
  const dispose = registry.register(provider)
  ctx.effect(() => dispose, 'Remote SSH TUI workspace provider')
  ctx.provide('remoteSshTui', {})
}

/** Interactive device and directory browser contributed as `/workspace remote`. */
export function remoteWorkspaceCommand(manager: RemoteSshManager): TuiWorkspaceCommand {
  return {
    name: 'remote',
    aliases: ['connect'],
    description: 'Choose an SSH device and remote directory',
    async run(input) {
      const servers = await listAvailableServers(manager)
      const filter = input.trim().toLowerCase()
      const visible = filter.length === 0
        ? servers
        : servers.filter(server => `${server.label} ${server.sshTarget}`.toLowerCase().includes(filter))
      return {
        kind: 'choices',
        title: 'Remote SSH devices',
        choices: visible.map(server => ({
          id: server.id,
          label: server.label,
          description: server.sshTarget,
          badge: 'SSH',
          choose: () => remoteDirectoryChoices(manager, server),
        })),
      }
    },
  }
}

async function remoteDirectoryChoices(
  manager: RemoteSshManager,
  server: RemoteSshServer,
  requestedPath?: string,
): Promise<TuiWorkspaceCommandResult> {
  const listing = await manager.listRemoteDirectory(server, requestedPath)
  return directoryListingResult(manager, server, listing)
}

function directoryListingResult(
  manager: RemoteSshManager,
  server: RemoteSshServer,
  listing: RemoteDirectoryListing,
): TuiWorkspaceCommandResult {
  const choices: TuiWorkspaceChoice[] = [{
    id: `select:${listing.path}`,
    label: 'Use this directory',
    description: listing.path,
    badge: 'OPEN',
    choose: async () => ({ kind: 'target', target: await ensureWorkspaceTarget(manager, server, listing.path) }),
    input: {
      initialValue: listing.path,
      placeholder: '/absolute/remote/path',
      submit: value => remoteDirectoryChoices(manager, server, value),
    },
  }]
  if (listing.parent !== undefined) {
    choices.push({
      id: `parent:${listing.parent}`,
      label: '..',
      description: listing.parent,
      choose: () => remoteDirectoryChoices(manager, server, listing.parent),
    })
  }
  for (const entry of listing.entries) {
    choices.push({
      id: `directory:${entry.path}`,
      label: entry.name,
      description: entry.path,
      choose: () => remoteDirectoryChoices(manager, server, entry.path),
    })
  }
  return { kind: 'choices', title: `${server.label} · ${listing.path}`, choices }
}

async function ensureWorkspaceTarget(
  manager: RemoteSshManager,
  candidate: RemoteSshServer,
  remotePath: string,
): Promise<TuiWorkspaceTarget> {
  let snapshot = manager.snapshot()
  let server = snapshot.servers.find(current =>
    current.id === candidate.id || current.sshTarget.toLowerCase() === candidate.sshTarget.toLowerCase())
  if (server === undefined) {
    server = await manager.addServer(candidate)
    snapshot = manager.snapshot()
  }
  const normalizedPath = posix.normalize(remotePath)
  const workspace = snapshot.workspaces.find(current =>
    current.serverId === server.id && posix.normalize(current.remotePath) === normalizedPath)
  const route = workspace === undefined
    ? await manager.addWorkspace(server.id, normalizedPath)
    : manager.workspace(workspace.id)
  return targetForRoute(route)
}

/** Resolve an existing server/workspace or persist a URI-addressed target. */
export async function resolveSshWorkspaceUri(
  manager: RemoteSshManager,
  uri: string,
): Promise<TuiWorkspaceTarget | undefined> {
  const parsed = parseSshWorkspaceUri(uri)
  if (parsed === undefined) return undefined
  const snapshot = manager.snapshot()
  let server = findServer(snapshot.servers, parsed.selector, parsed.sshTarget)
  if (server === undefined) {
    const identity = parsed.port === undefined ? parsed.sshTarget : `${parsed.sshTarget}:${parsed.port}`
    server = await manager.addServer({
      id: discoveredSshServerId(identity),
      label: parsed.selector,
      sshTarget: parsed.sshTarget,
      ...(parsed.port === undefined ? {} : { sshArgs: ['-p', String(parsed.port)] }),
    })
  }
  const current = manager.snapshot().workspaces.find(workspace =>
    workspace.serverId === server.id && posix.normalize(workspace.remotePath) === parsed.remotePath)
  const route = current === undefined
    ? await manager.addWorkspace(server.id, parsed.remotePath)
    : manager.workspace(current.id)
  return targetForRoute(route)
}

/** Resolve a POSIX path relative to the currently selected SSH workspace. */
export async function resolveSshWorkspacePath(
  manager: RemoteSshManager,
  path: string,
  cwd: string,
): Promise<TuiWorkspaceTarget | undefined> {
  const route = manager.route(undefined, cwd)
  if (route.kind !== 'remote') return undefined
  const currentRemotePath = route.mapper.toRemotePath(cwd, route.aliasPath)
  const remotePath = posix.resolve(currentRemotePath, path)
  const current = manager.snapshot().workspaces.find(workspace =>
    workspace.serverId === route.server.id && posix.normalize(workspace.remotePath) === remotePath)
  const targetRoute = current === undefined
    ? await manager.addWorkspace(route.server.id, remotePath)
    : manager.workspace(current.id)
  return targetForRoute(targetRoute)
}

/** Parse `ssh://[user@]server[:port]/absolute/path`. */
export function parseSshWorkspaceUri(uri: string): ParsedSshWorkspaceUri | undefined {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'ssh:') return undefined
  if (parsed.hostname.length === 0) throw new Error('SSH workspace URI requires a server')
  const host = decodeURIComponent(parsed.hostname)
  const user = decodeURIComponent(parsed.username)
  const selector = user.length === 0 ? host : `${user}@${host}`
  const sshTarget = selector
  const remotePath = posix.normalize(decodeURIComponent(parsed.pathname))
  if (!posix.isAbsolute(remotePath)) throw new Error('SSH workspace URI requires an absolute remote path')
  const port = parsed.port === '' ? undefined : Number(parsed.port)
  if (port !== undefined && (!Number.isSafeInteger(port) || port <= 0 || port > 65535)) {
    throw new Error(`invalid SSH port: ${parsed.port}`)
  }
  return {
    selector,
    sshTarget,
    remotePath,
    ...(port === undefined ? {} : { port }),
  }
}

export function sshWorkspaceUri(route: RemoteWorkspaceRoute): string {
  const path = route.workspace.remotePath
    .split('/')
    .map((part, index) => index === 0 ? '' : encodeURIComponent(part))
    .join('/')
  return `ssh://${route.server.id}${path}`
}

function targetForRoute(route: RemoteWorkspaceRoute): TuiWorkspaceTarget {
  const root = posix.normalize(route.workspace.remotePath)
  return {
    uri: sshWorkspaceUri(route),
    cwd: route.aliasPath,
    label: route.workspace.title ?? `${route.server.label} > ${posix.basename(root) || root}`,
    description: root,
    kind: 'provider',
    badge: 'SSH',
  }
}

function describeRemoteCwd(manager: RemoteSshManager, cwd: string): TuiWorkspaceTarget | undefined {
  try {
    const route = manager.route(undefined, cwd)
    if (route.kind !== 'remote') return undefined
    const remotePath = route.mapper.toRemotePath(cwd, route.aliasPath)
    return { ...targetForRoute(route), description: remotePath }
  } catch {
    return undefined
  }
}

function findServer(
  servers: readonly RemoteSshServer[],
  selector: string,
  sshTarget: string,
): RemoteSshServer | undefined {
  const normalized = selector.toLowerCase()
  return servers.find(server =>
    server.id.toLowerCase() === normalized
    || server.label.toLowerCase() === normalized
    || server.sshTarget.toLowerCase() === sshTarget.toLowerCase())
}

export default apply
