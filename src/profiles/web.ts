// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { RemoteOpenFileMode, RemoteSshManager, RemoteSshServer } from '../routing/manager.ts'
import { openRemoteFile } from '../ssh/open-file.ts'
import { appendSshHost, defaultSshConfigFiles, discoverSshConfigHosts } from '../ssh/config.ts'

export const REMOTE_SSH_STATE_PATH = '/plugins/dsh-ssh-workspace/state'
export const REMOTE_SSH_SERVER_PATH = '/plugins/dsh-ssh-workspace/server'
export const REMOTE_SSH_SERVER_REMOVE_PATH = '/plugins/dsh-ssh-workspace/server/remove'
export const REMOTE_SSH_WORKSPACE_PATH = '/plugins/dsh-ssh-workspace/workspace'
export const REMOTE_SSH_WORKSPACE_REMOVE_PATH = '/plugins/dsh-ssh-workspace/workspace/remove'
export const REMOTE_SSH_LOCAL_WORKSPACE_PATH = '/plugins/dsh-ssh-workspace/local-workspace'
export const REMOTE_SSH_PROBE_PATH = '/plugins/dsh-ssh-workspace/probe'
export const REMOTE_SSH_CONFIG_HOST_PATH = '/plugins/dsh-ssh-workspace/ssh-config/host'
export const REMOTE_SSH_SETTINGS_PATH = '/plugins/dsh-ssh-workspace/settings'
export const REMOTE_SSH_DIRECTORY_PATH = '/plugins/dsh-ssh-workspace/directory'
export const REMOTE_SSH_OPEN_FILE_PATH = '/plugins/dsh-ssh-workspace/open-file'
export const REMOTE_SSH_BACKEND_CONNECT_PATH = '/plugins/dsh-ssh-workspace/backend/connect'

export const name = 'dsh-ssh-workspace-web'
export const inject = ['remoteSshManager']

/** Activate the Web surface only in compositions that provide a Web host. */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], registerWebRoutes)
}

/** Register same-origin catalog mutation and connection-probe endpoints. */
function registerWebRoutes(ctx: Context): void {
  const routes = [
    route(ctx, REMOTE_SSH_STATE_PATH, 'GET', async (_req, res) => {
      json(res, 200, await catalogState(ctx.remoteSshManager))
    }),
    route(ctx, REMOTE_SSH_SETTINGS_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const sshConfigFile = optionalString(body, 'sshConfigFile')
      const openFileEditorPath = optionalString(body, 'openFileEditorPath')
      const openFileMode = body.openFileMode === undefined ? undefined : parseOpenFileMode(body.openFileMode)
      await ctx.remoteSshManager.updateUserPreferences({
        ...(sshConfigFile === undefined ? {} : { sshConfigFile }),
        ...(openFileMode === undefined ? {} : { openFileMode }),
        ...(openFileEditorPath === undefined ? {} : { openFileEditorPath }),
      })
      const snapshot = ctx.remoteSshManager.snapshot()
      json(res, 200, {
        sshConfigFile: snapshot.sshConfigFile,
        openFileMode: snapshot.openFileMode,
        openFileEditorPath: snapshot.openFileEditorPath,
      })
    }),
    route(ctx, REMOTE_SSH_DIRECTORY_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'serverId'))
      const path = body.path
      if (path !== undefined && typeof path !== 'string') throw new Error('path must be a string')
      json(res, 200, await ctx.remoteSshManager.listRemoteDirectory(server, path as string | undefined))
    }),
    route(ctx, REMOTE_SSH_OPEN_FILE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, await openRemoteFile(
        ctx.remoteSshManager,
        requiredString(body, 'workspaceId'),
        requiredString(body, 'path'),
      ))
    }),
    route(ctx, REMOTE_SSH_WORKSPACE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'serverId'))
      const configured = ctx.remoteSshManager.snapshot().servers.find(candidate => candidate.id === server.id)
        ?? await ctx.remoteSshManager.addServer({ id: server.id, label: server.label, sshTarget: server.sshTarget })
      const created = await ctx.remoteSshManager.addWorkspace(configured.id, requiredString(body, 'remotePath'))
      json(res, 201, { id: created.workspace.id, aliasPath: created.aliasPath })
    }),
    route(ctx, REMOTE_SSH_WORKSPACE_REMOVE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, { removed: await ctx.remoteSshManager.removeWorkspace(requiredString(body, 'id')) })
    }),
    route(ctx, REMOTE_SSH_LOCAL_WORKSPACE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, { path: await ctx.remoteSshManager.adoptLocalWorkspace(requiredString(body, 'path')) })
    }),
    route(ctx, REMOTE_SSH_PROBE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'id'))
      json(res, 200, await probeServer(server.sshTarget, server.sshArgs ?? []))
    }),
    route(ctx, REMOTE_SSH_BACKEND_CONNECT_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'id'))
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.flushHeaders()
      const send = (value: unknown): void => {
        if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(value)}\n`)
      }
      const unwatch = ctx.remoteSshManager.watchBackendProgress(server, progress => {
        send({ type: 'progress', stage: progress.stage })
      })
      try {
        const backend = await ctx.remoteSshManager.connectWebBackend(server, ctx.webServer.port)
        send({ type: 'ready', url: backend.url, localPort: backend.localPort, remotePort: backend.remotePort })
      } catch (error) {
        send({ type: 'error', error: safeMessage(error) })
      } finally {
        unwatch()
        if (!res.destroyed && !res.writableEnded) res.end()
      }
    }),
    route(ctx, REMOTE_SSH_CONFIG_HOST_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const configPath = resolve(requiredString(body, 'configPath'))
      const allowed = activeConfigFiles(ctx.remoteSshManager)
      if (!allowed.some(candidate => samePath(candidate, configPath))) throw new Error('selected SSH config file is not active')
      json(res, 201, await appendSshHost(configPath, requiredString(body, 'command')))
    }),
  ]
  ctx.effect(() => () => { for (const dispose of routes) dispose() }, 'Remote SSH Web routes')
}

interface AvailableServer extends RemoteSshServer {
  source: 'ssh-config' | 'saved'
  configPath?: string
  hostName?: string
  user?: string
  port?: number
}

async function catalogState(manager: RemoteSshManager) {
  const snapshot = manager.snapshot()
  const configFiles = activeConfigFiles(manager)
  const discovery = await discoverSshConfigHosts(configFiles)
  const servers: AvailableServer[] = snapshot.servers.map(server => ({ ...server, source: 'saved' }))
  for (const discovered of discovery.hosts) {
    const configured = servers.find(server => server.sshTarget === discovered.sshTarget)
    if (configured === undefined) servers.push({ ...discovered, source: 'ssh-config' })
    else Object.assign(configured, {
      source: 'ssh-config' as const,
      configPath: discovered.configPath,
      ...(discovered.hostName === undefined ? {} : { hostName: discovered.hostName }),
      ...(discovered.user === undefined ? {} : { user: discovered.user }),
      ...(discovered.port === undefined ? {} : { port: discovered.port }),
    })
  }
  return {
    servers,
    workspaces: snapshot.workspaces.map(workspace => ({ ...workspace, aliasPath: manager.workspace(workspace.id).aliasPath })),
    serverCount: servers.length,
    discoveredServerCount: discovery.hosts.length,
    workspaceCount: snapshot.workspaces.length,
    configFiles,
    loadedConfigFiles: discovery.files,
    configErrors: discovery.errors,
    customConfigFile: snapshot.sshConfigFile,
    openFileMode: snapshot.openFileMode,
    openFileEditorPath: snapshot.openFileEditorPath,
  }
}

async function resolveAvailableServer(manager: RemoteSshManager, id: string): Promise<RemoteSshServer> {
  const state = await catalogState(manager)
  const server = state.servers.find(candidate => candidate.id === id)
  if (server === undefined) throw new Error('SSH host is no longer present in the active config')
  return server
}

function activeConfigFiles(manager: RemoteSshManager): string[] {
  const custom = manager.snapshot().sshConfigFile
  return custom === undefined || custom.trim() === '' ? defaultSshConfigFiles() : [resolve(custom)]
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}

function route(
  ctx: Context,
  path: string,
  method: string,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): () => void {
  return ctx.webServer.register({
    kind: 'exact', path,
    handler: async (req, res) => {
      if (req.method !== method) return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        await handler(req, res)
      } catch (error: unknown) {
        if (!res.headersSent) json(res, 400, { error: safeMessage(error) })
        else if (!res.writableEnded) res.end()
      }
    },
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new Error('request body exceeds 64 KiB')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function parseOpenFileMode(value: unknown): RemoteOpenFileMode {
  if (value === 'auto' || value === 'vscode' || value === 'cursor' || value === 'windsurf'
    || value === 'vscodium' || value === 'custom' || value === 'download') return value
  throw new Error('openFileMode is invalid')
}

function trustedRequest(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  const origin = req.headers.origin
  if (host === undefined || origin === undefined) return origin === undefined
  try { return new URL(origin).host === new URL(`http://${host}`).host } catch { return false }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

async function probeServer(sshTarget: string, sshArgs: string[]): Promise<{
  reachable: boolean
  hostname?: string
  commands?: Record<string, boolean>
  error?: string
}> {
  const command = 'printf "hostname=%s\\n" "$(hostname)"; for dsh_cmd in bash pwsh rg code; do if command -v "$dsh_cmd" >/dev/null 2>&1; then printf "%s=1\\n" "$dsh_cmd"; else printf "%s=0\\n" "$dsh_cmd"; fi; done'
  const child = spawn('ssh', [...sshArgs, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshTarget, command], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
  const timer = setTimeout(() => { child.kill() }, 8_000)
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  }).finally(() => { clearTimeout(timer) })
  const output = Buffer.concat(stdout).toString('utf8')
  if (code !== 0) return { reachable: false, error: Buffer.concat(stderr).toString('utf8').trim().slice(0, 500) || `ssh exit ${code}` }
  const facts = Object.fromEntries(output.trim().split(/\r?\n/).map(line => line.split('=', 2) as [string, string]))
  return {
    reachable: true,
    ...(facts.hostname === undefined ? {} : { hostname: facts.hostname }),
    commands: Object.fromEntries(['bash', 'pwsh', 'rg', 'code'].map(name => [name, facts[name] === '1'])),
  }
}
