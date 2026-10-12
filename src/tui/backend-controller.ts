// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { posix } from 'node:path'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  TuiBackendAdapter,
  TuiBackendCommandRequest,
  TuiBackendHost,
  TuiBackendProvider,
} from '@deepseek-harness-tui/dsh-tui/backends'
import type {
  TuiWorkspaceChoice,
  TuiWorkspaceCommandResult,
  TuiWorkspaceProgress,
  TuiWorkspaceTarget,
} from '@deepseek-harness-tui/dsh-tui/workspaces'
import type { RemoteDshHostClient } from '../backend/client.ts'
import type { RemoteDshHostConnection } from '../backend/connection.ts'
import type { BackendConnectionProgress, RemoteSshManager, RemoteSshServer } from '../routing/manager.ts'
import { en, zh } from '../client/locales.ts'
import { backendProgressLocaleKey } from '../backend/progress.ts'
import { discoveredSshServerId, parseSshConnectionInvocation } from '../ssh/config.ts'
import { listAvailableServers, remoteServerIdentity } from './servers.ts'
import { SwitchableChannel } from './switchable-channel.ts'

export interface RemoteTuiChannelAttachment {
  channel: object
  handleCommand?(request: TuiBackendCommandRequest): boolean
  dispose(): void | Promise<void>
}

export interface RemoteTuiChannelFactoryRequest {
  api: IApiClient
  client: RemoteDshHostClient
  server: RemoteSshServer
  workspace: WorkspaceView
  host: TuiBackendHost
}

export interface RemoteTuiChannelFactory {
  attach(request: RemoteTuiChannelFactoryRequest): Promise<RemoteTuiChannelAttachment>
}

interface BackendClient {
  server: RemoteSshServer
  connection: RemoteDshHostConnection
  client: RemoteDshHostClient
}

interface BackendTarget {
  server: RemoteSshServer
  path: string
}

/** Owns TUI backend identity independently from transparent workspace routing. */
export class RemoteSshTuiBackendController implements TuiBackendProvider {
  readonly id = 'dsh-ssh-workspace'
  private host: TuiBackendHost | undefined
  private localSurfaceChannel: object | undefined
  private switched: SwitchableChannel | undefined
  private factory: RemoteTuiChannelFactory | undefined
  private attachment: RemoteTuiChannelAttachment | undefined
  private readonly clients = new Map<string, Promise<BackendClient>>()
  private readonly targets = new Map<string, BackendTarget>()

  constructor(private readonly manager: RemoteSshManager) {}

  registerFactory(factory: RemoteTuiChannelFactory): () => void {
    if (this.factory !== undefined) throw new Error('dsh-ssh-workspace: a remote TUI channel factory is already registered')
    this.factory = factory
    return () => { if (this.factory === factory) this.factory = undefined }
  }

  attach(host: TuiBackendHost): TuiBackendAdapter {
    if (this.host !== undefined) throw new Error('dsh-ssh-workspace: dsh-tui backend was attached more than once')
    const switched = new SwitchableChannel(host.channel, {
      switchWorkspace: (delegate, target) => {
        if (isBackendTarget(target)) return this.activateTarget(target)
        return callDelegate(delegate, 'switchWorkspace', [target])
      },
    })
    this.switched = switched
    this.localSurfaceChannel = host.channel
    this.host = host
    return {
      channel: switched.proxy as never,
      handleCommand: request => this.handleCommand(request),
      dispose: () => this.detach(),
    }
  }

  private handleCommand(request: TuiBackendCommandRequest): boolean {
    if (request.name === 'disconnect') {
      void this.disconnect().then(() => {
        request.channel.notify('Disconnected from the remote DSH Host.', { timeoutMs: 3000 })
      }).catch(error => {
        request.channel.notify(error instanceof Error ? error.message : String(error), { color: 'error', timeoutMs: 8000 })
      })
      return true
    }
    if (request.name === 'connect') {
      void this.connect(request).catch(error => {
        request.channel.notify(error instanceof Error ? error.message : String(error), { color: 'error', timeoutMs: 8000 })
      })
      return true
    }
    return this.attachment?.handleCommand?.(request) ?? false
  }

  async connect(request: TuiBackendCommandRequest): Promise<boolean> {
    if (this.attachment !== undefined) {
      request.channel.notify('A remote DSH Host is already active. Use /disconnect first.', {
        color: 'warning',
        timeoutMs: 5000,
      })
      return true
    }
    const command = request.input.trim()
    const visible = command.length === 0
      ? await listAvailableServers(this.manager)
      : [serverFromSshCommand(command)]
    request.present({
      kind: 'choices',
      title: 'Remote DSH Hosts',
      choices: visible.map(server => ({
        id: server.id,
        label: server.label,
        description: server.sshTarget,
        badge: remoteServerIdentity(server),
        choose: (signal, reportProgress) => this.directoryChoices(server, undefined, signal, reportProgress),
      })),
    } satisfies TuiWorkspaceCommandResult)
    return true
  }

  async disconnect(): Promise<void> {
    const attachment = this.attachment
    this.attachment = undefined
    this.switched?.restoreLocal()
    if (attachment !== undefined) await attachment.dispose()
  }

  async dispose(): Promise<void> {
    await this.detach()
    this.clients.clear()
    this.targets.clear()
  }

  private async detach(): Promise<void> {
    await this.disconnect()
    this.switched?.dispose()
    this.switched = undefined
    this.host = undefined
    this.localSurfaceChannel = undefined
  }

  private async directoryChoices(
    server: RemoteSshServer,
    path?: string,
    signal?: AbortSignal,
    reportProgress?: (progress: TuiWorkspaceProgress) => void,
  ): Promise<TuiWorkspaceCommandResult> {
    signal?.throwIfAborted()
    const locale = this.host?.locale?.() ?? 'en'
    const unwatch = reportProgress === undefined
      ? undefined
      : this.manager.watchBackendProgress(server, progress => {
          reportProgress({ label: backendProgressLabel(progress, locale) })
        })
    let result
    try {
      const backend = await this.clientFor(server)
      reportProgress?.({ label: locale.startsWith('zh') ? zh.directoryLoading : en.directoryLoading })
      result = (await backend.client.api.host.listDirectory(
        path === undefined ? {} : { path },
        signal,
      )).result
    } finally {
      unwatch?.()
    }
    if (!result.ok) throw new Error(result.error.message)
    const listing = result.value
    const choices: TuiWorkspaceChoice[] = [{
      id: `select:${listing.path}`,
      label: 'Use this directory',
      description: listing.path,
      badge: 'OPEN',
      choose: () => ({ kind: 'target', target: this.targetFor(server, listing.path) }),
      input: {
        initialValue: listing.path,
        placeholder: '/absolute/remote/path',
        submit: (value, nextSignal, nextProgress) => this.directoryChoices(server, value, nextSignal, nextProgress),
      },
    }]
    const parent = listing.crumbs.at(-2)
    if (parent !== undefined) {
      choices.push({
        id: `parent:${parent.path}`,
        label: '..',
        description: parent.path,
        choose: (nextSignal, nextProgress) => this.directoryChoices(server, parent.path, nextSignal, nextProgress),
      })
    }
    for (const entry of listing.entries) {
      choices.push({
        id: `directory:${entry.path}`,
        label: entry.name,
        description: entry.path,
        choose: (nextSignal, nextProgress) => this.directoryChoices(server, entry.path, nextSignal, nextProgress),
      })
    }
    return { kind: 'choices', title: `${server.label} · ${listing.path}`, choices }
  }

  private targetFor(server: RemoteSshServer, path: string): TuiWorkspaceTarget {
    const normalized = posix.normalize(path)
    const uri = backendTargetUri(server.id, normalized)
    this.targets.set(uri, { server, path: normalized })
    return {
      uri,
      cwd: normalized,
      label: `${server.label} > ${posix.basename(normalized) || normalized}`,
      description: normalized,
      kind: 'provider',
      badge: remoteServerIdentity(server),
    }
  }

  private async activateTarget(target: TuiWorkspaceTarget): Promise<boolean> {
    const host = this.host
    const switched = this.switched
    const factory = this.factory
    const selection = this.targets.get(target.uri)
    if (host === undefined || switched === undefined) throw new Error('dsh-ssh-workspace: TUI backend is not attached')
    if (selection === undefined) throw new Error('dsh-ssh-workspace: unknown remote Host workspace target')
    if (factory === undefined) throw new Error('dsh-ssh-workspace: remote TUI channel factory is not installed')

    const backend = await this.clientFor(selection.server)
    const workspaceResult = (await backend.client.api.workspace.create({ path: selection.path })).result
    if (!workspaceResult.ok) throw new Error(workspaceResult.error.message)
    const next = await factory.attach({
      api: backend.client.api,
      client: backend.client,
      server: selection.server,
      workspace: workspaceResult.value.workspace,
      host: { ...host, channel: switched.localChannel as never },
    })
    const previous = this.attachment
    this.attachment = next
    switched.switchTo(next.channel)
    if (previous !== undefined) await previous.dispose()
    return true
  }

  private clientFor(server: RemoteSshServer): Promise<BackendClient> {
    const key = `${server.sshTarget}\0${(server.sshArgs ?? []).join('\0')}\0${String(server.backendPort ?? 0)}`
    let pending = this.clients.get(key)
    if (pending !== undefined) return pending
    pending = this.openClient(server)
    this.clients.set(key, pending)
    void pending.catch(() => { if (this.clients.get(key) === pending) this.clients.delete(key) })
    return pending
  }

  private async openClient(server: RemoteSshServer): Promise<BackendClient> {
    const connection = await this.manager.connectBackend(server)
    await connection.describeProtocol()
    const client = await this.manager.connectBackendClient(server)
    const description = (await client.api.host.describe({})).result
    if (!description.ok) throw new Error(description.error.message)
    return { server, connection, client }
  }
}

/** Convert a familiar `ssh ...` command into an ephemeral Backend target. */
export function serverFromSshCommand(command: string): RemoteSshServer {
  const parsed = parseSshConnectionInvocation(command)
  return {
    id: discoveredSshServerId(JSON.stringify([parsed.executable, parsed.sshTarget, parsed.sshArgs])),
    label: parsed.sshTarget,
    sshTarget: parsed.sshTarget,
    ...(parsed.sshArgs.length === 0 ? {} : { sshArgs: parsed.sshArgs }),
    ...(parsed.executable === 'ssh' ? {} : { sshExecutable: parsed.executable }),
  }
}

function backendTargetUri(serverId: string, path: string): string {
  const encodedPath = path.split('/').map((part, index) => index === 0 ? '' : encodeURIComponent(part)).join('/')
  return `dsh-host+ssh://${encodeURIComponent(serverId)}${encodedPath}`
}

function isBackendTarget(value: unknown): value is TuiWorkspaceTarget {
  return typeof value === 'object' && value !== null
    && typeof (value as { uri?: unknown }).uri === 'string'
    && (value as { uri: string }).uri.startsWith('dsh-host+ssh://')
}

/** Same Host stages as the Web progress surface, localized for the TUI. */
export function backendProgressLabel(progress: BackendConnectionProgress, locale: string): string {
  const copy = locale.startsWith('zh') ? zh : en
  if (progress.stage === 'failed') return progress.error ?? copy.probeFailure.replace('{error}', copy.unknownError)
  return copy[backendProgressLocaleKey(progress.stage)]
}

function callDelegate(
  delegate: Record<PropertyKey, unknown>,
  method: string,
  args: unknown[],
): unknown {
  const member = Reflect.get(delegate, method, delegate)
  if (typeof member !== 'function') throw new TypeError(`channel member ${method} is not callable`)
  return Reflect.apply(member, delegate, args)
}
