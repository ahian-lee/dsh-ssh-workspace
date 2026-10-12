// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Client boundary for commands that must execute beside the remote Agent. */

import RemoteDshHostClient from './client.js'

export type HostControlOperation =
  | 'shell'
  | 'doctor'
  | 'mcp'
  | 'init'
  | 'btw'
  | 'commands'
  | 'session.mode'
  | 'session.delete'
  | 'provider.setup'

export type HostControlAvailability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string }

export interface HostControlDescription {
  readonly authority: 'remote-host'
  readonly localFallback: 'forbidden'
  readonly operations: Readonly<Record<HostControlOperation, HostControlAvailability>>
}

export interface HostShellResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
}

export interface HostDoctorResult {
  readonly node: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly cwd: string
  readonly sessionId?: string
  readonly sessionAttached: boolean
  readonly apiKeyConfigured: boolean
  readonly home: string
}

export interface HostMcpServer {
  readonly name: string
  readonly tools: readonly string[]
}

export interface HostCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

export type HostInitResult =
  | { readonly status: 'created'; readonly path: string }
  | { readonly status: 'exists'; readonly path: string }

export interface HostSessionModeSpec {
  readonly id: string
  readonly label?: string
  readonly plan?: boolean
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approval?: 'ask' | 'never'
}

export interface HostProviderSetupRequest {
  readonly route: string
  readonly profile: Record<string, unknown>
  readonly credential?: { readonly ref: string; readonly value: string }
}

/** Raised instead of ever attempting the corresponding operation locally. */
export class RemoteHostOperationUnsupportedError extends Error {
  constructor(readonly operation: HostControlOperation, readonly reason: string) {
    super(`Remote Host does not support ${operation}: ${reason}`)
    this.name = 'RemoteHostOperationUnsupportedError'
  }
}

/**
 * Remote-Agent mode operations. This class deliberately has no local executor,
 * filesystem, LLM, settings, or persistence fallback.
 */
export class RemoteDshHostControlClient {
  private description: Promise<HostControlDescription> | undefined

  constructor(readonly host: RemoteDshHostClient) {}

  async describe(signal?: AbortSignal): Promise<HostControlDescription> {
    signal?.throwIfAborted()
    this.description ??= this.host.invokeValue<HostControlDescription>('control', 'describe', {})
      .catch(error => { this.description = undefined; throw error })
    const description = await this.description
    signal?.throwIfAborted()
    if (description.authority !== 'remote-host' || description.localFallback !== 'forbidden') {
      throw new Error('Remote Host returned an unsafe control-plane policy')
    }
    return description
  }

  async runShell(
    command: string,
    cwd: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<HostShellResult> {
    await this.require('shell', signal)
    return this.host.invokeValue('control', 'runShell', { command, cwd, timeoutMs }, signal)
  }

  async doctor(sessionId?: string, cwd?: string, signal?: AbortSignal): Promise<HostDoctorResult> {
    await this.require('doctor', signal)
    return this.host.invokeValue('control', 'doctor', { sessionId, cwd }, signal)
  }

  async mcp(sessionId: string, signal?: AbortSignal): Promise<{ readonly servers: readonly HostMcpServer[] }> {
    await this.require('mcp', signal)
    return this.host.invokeValue('control', 'mcp', { sessionId }, signal)
  }

  async commandCatalog(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly commands: readonly HostCommandDescriptor[] }> {
    await this.require('commands', signal)
    return this.host.invokeValue('control', 'commandCatalog', { sessionId }, signal)
  }

  async init(cwd: string, content: string, signal?: AbortSignal): Promise<HostInitResult> {
    await this.require('init', signal)
    return this.host.invokeValue('control', 'init', { cwd, content }, signal)
  }

  async btw(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<{ readonly answer: string | null; readonly error?: string }> {
    await this.require('btw', signal)
    return this.host.invokeValue('control', 'btw', { sessionId, question }, signal)
  }

  async setSessionMode(
    sessionId: string,
    spec: HostSessionModeSpec,
    signal?: AbortSignal,
  ): Promise<HostSessionModeSpec> {
    await this.require('session.mode', signal)
    return this.host.invokeValue('control', 'setSessionMode', { sessionId, spec }, signal)
  }

  async deleteSession(_sessionId: string, signal?: AbortSignal): Promise<never> {
    await this.require('session.delete', signal)
    throw new Error('Remote Host advertised physical session deletion without a compatible client implementation')
  }

  /**
   * Provider setup already rides the remote core domains. The returned client
   * is the same authenticated Host client; callers use llm/settings/credentials.
   */
  async providerSetup(signal?: AbortSignal): Promise<RemoteDshHostClient> {
    await this.require('provider.setup', signal)
    return this.host
  }

  async setupProvider(request: HostProviderSetupRequest, signal?: AbortSignal): Promise<{ readonly route: string }> {
    await this.require('provider.setup', signal)
    return this.host.invokeValue('control', 'setupProvider', { request }, signal)
  }

  private async require(operation: HostControlOperation, signal?: AbortSignal): Promise<HostControlAvailability> {
    // Older Hosts legitimately omit operations added by a newer client. Treat
    // a missing advertisement as unsupported instead of dereferencing it.
    const operations = (await this.describe(signal)).operations as Partial<
      Record<HostControlOperation, HostControlAvailability>
    >
    const availability = operations[operation]
    if (availability === undefined) {
      throw new RemoteHostOperationUnsupportedError(operation, 'not advertised by this Host version')
    }
    if (!availability.supported) throw new RemoteHostOperationUnsupportedError(operation, availability.reason)
    return availability
  }
}

export default RemoteDshHostControlClient
