// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Reconnecting, UI-neutral ownership of a persistent remote dsh-host attachment. */

import type { DshHostEndpoint } from './client.ts'
import {
  RemoteDshHostTunnel,
  type DshHostProtocolDescription,
  type RemoteDshHostTunnelConfig,
} from './tunnel.ts'

export interface DshHostTransport extends DshHostEndpoint {
  readonly alive: boolean
  readonly localPort: number
  readonly remotePort: number
  readonly closed: Promise<void>
  fetch(path: string, init?: RequestInit): Promise<Response>
  describeProtocol(signal?: AbortSignal): Promise<DshHostProtocolDescription>
  dispose(): Promise<void>
}

export type DshHostTunnelOpener = (config: RemoteDshHostTunnelConfig) => Promise<DshHostTransport>

export interface RemoteDshHostConnectionConfig extends RemoteDshHostTunnelConfig {
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
}

/**
 * Stable logical connection whose physical SSH process may be replaced. The
 * remote Host remains a singleton; only the observation tunnel reconnects.
 */
export class RemoteDshHostConnection implements DshHostEndpoint {
  private current: DshHostTransport | undefined
  private reconnecting: Promise<DshHostTransport> | undefined
  private disposed = false
  private readonly stopped = new AbortController()
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number

  private constructor(
    private readonly config: RemoteDshHostConnectionConfig,
    private readonly opener: DshHostTunnelOpener,
  ) {
    this.initialDelayMs = boundedDelay(config.reconnectInitialDelayMs, 250)
    this.maxDelayMs = Math.max(this.initialDelayMs, boundedDelay(config.reconnectMaxDelayMs, 10_000))
  }

  static async open(
    config: RemoteDshHostConnectionConfig,
    opener: DshHostTunnelOpener = RemoteDshHostTunnel.open,
  ): Promise<RemoteDshHostConnection> {
    const connection = new RemoteDshHostConnection(config, opener)
    connection.install(await opener(connection.attemptConfig()))
    return connection
  }

  get alive(): boolean {
    return !this.disposed
  }

  get connected(): boolean {
    return this.current?.alive === true
  }

  get origin(): string {
    return this.requireCurrent().origin
  }

  get localPort(): number {
    return this.requireCurrent().localPort
  }

  get remotePort(): number {
    return this.requireCurrent().remotePort
  }

  requestHeaders(): Readonly<Record<string, string>> {
    return this.requireCurrent().requestHeaders()
  }

  webSocketUrl(path: string): string {
    return this.requireCurrent().webSocketUrl(path)
  }

  /** Wait for the current tunnel, sharing one retry loop across all callers. */
  async ready(signal?: AbortSignal): Promise<DshHostTransport> {
    if (this.disposed) throw new Error('dsh-ssh-workspace: Host connection is disposed')
    if (this.current?.alive === true) return this.current
    const stale = this.current
    this.current = undefined
    if (stale !== undefined) void stale.dispose().catch(() => undefined)
    const pending = this.reconnecting ?? this.startReconnect()
    return signal === undefined ? pending : abortable(pending, signal)
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? undefined
    const tunnel = await this.ready(signal)
    return tunnel.fetch(path, init)
  }

  async describeProtocol(signal?: AbortSignal): Promise<DshHostProtocolDescription> {
    return (await this.ready(signal)).describeProtocol(signal)
  }

  /** Force a fresh physical tunnel while preserving the remote Host process. */
  async reconnect(): Promise<void> {
    if (this.disposed) throw new Error('dsh-ssh-workspace: Host connection is disposed')
    const previous = this.current
    this.current = undefined
    if (previous !== undefined) await previous.dispose()
    await this.ready()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopped.abort(new Error('dsh-ssh-workspace: Host connection disposed'))
    const current = this.current
    this.current = undefined
    if (current !== undefined) await current.dispose()
    await this.reconnecting?.catch(() => undefined)
  }

  private install(tunnel: DshHostTransport): void {
    if (this.disposed) {
      void tunnel.dispose()
      throw new Error('dsh-ssh-workspace: Host connection is disposed')
    }
    this.current = tunnel
    void tunnel.closed.then(async () => {
      if (this.current !== tunnel) return
      this.current = undefined
      await tunnel.dispose().catch(() => undefined)
      if (!this.disposed) void this.ready().catch(() => undefined)
    })
  }

  private startReconnect(): Promise<DshHostTransport> {
    const task = this.reconnectLoop().finally(() => {
      if (this.reconnecting === task) this.reconnecting = undefined
    })
    this.reconnecting = task
    return task
  }

  private async reconnectLoop(): Promise<DshHostTransport> {
    let delayMs = 0
    for (;;) {
      if (this.disposed) throw new Error('dsh-ssh-workspace: Host connection is disposed')
      if (delayMs > 0) await delay(jitter(delayMs), this.stopped.signal)
      try { this.config.onProgress?.({ stage: 'reconnecting' }) } catch {}
      try {
        const tunnel = await this.opener(this.attemptConfig())
        this.install(tunnel)
        return tunnel
      } catch (error) {
        if (this.disposed) throw error
        delayMs = delayMs === 0 ? this.initialDelayMs : Math.min(this.maxDelayMs, delayMs * 2)
      }
    }
  }

  private requireCurrent(): DshHostTransport {
    const current = this.current
    if (current?.alive !== true) throw new Error('dsh-ssh-workspace: Host tunnel is reconnecting')
    return current
  }

  private attemptConfig(): RemoteDshHostTunnelConfig {
    return { ...this.config, signal: this.stopped.signal }
  }
}

function boundedDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error('dsh-ssh-workspace: reconnect delay must be between 1 and 60000ms')
  }
  return value
}

function jitter(milliseconds: number): number {
  return Math.max(1, Math.round(milliseconds * (0.8 + Math.random() * 0.4)))
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    const onAbort = (): void => { clearTimeout(timer); reject(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('This operation was aborted')
}
