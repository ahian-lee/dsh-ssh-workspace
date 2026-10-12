// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** UI-neutral attachment to a persistent remote dsh-host over one SSH process. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createNetServer, Socket, type Server as NetServer } from 'node:net'
import {
  buildDshBackendCommand,
  encodePayloadArchive,
  loadDshHostPayload,
  type DshHostPayload,
} from './install.ts'
import { createSocksForward } from './socks.ts'

export { buildDshBackendCommand } from './install.ts'

/** Zero lets the remote Host select a collision-free loopback port. */
export const DEFAULT_DSH_HOST_PORT = 0
export const DSH_HOST_PROTOCOL_VERSION = 1

export type DshHostProgressStage =
  | 'connecting'
  | 'reconnecting'
  | 'waiting-host'
  | 'checking-host'
  | 'uploading-host'
  | 'reusing-host'
  | 'installing-host'
  | 'checking-runtime'
  | 'installing-node'
  | 'installing-pnpm'
  | 'installing-harness'
  | 'verifying-runtime'
  | 'installing-bundle'
  | 'installed'
  | 'starting-host'
  | 'ready'
  | 'failed'

export interface DshHostProgress {
  stage: DshHostProgressStage
}

export interface DshHostProtocolDescription {
  protocol: 'dsh-host'
  protocolVersion: number
  transport: 'http+websocket'
  rpcPath: string
  muxEventsPath: string
  hostEventsPath: string
  capabilities: readonly string[]
}

export interface RemoteDshHostTunnelConfig {
  sshExecutable: string
  sshArgs: string[]
  sshTarget: string
  remotePort: number
  startupTimeoutMs: number
  /** Built dsh-host package root; normally discovered from the installed dependency. */
  packageRoot?: string
  /** Receives structured stages without opening another SSH connection. */
  onProgress?: (progress: DshHostProgress) => void
  /** Cancels an in-flight SSH bootstrap without affecting the detached Host. */
  signal?: AbortSignal
}

/**
 * A transport shared by Web, TUI, and other clients. It installs or reuses the
 * Host, keeps one SSH connection alive, and exposes its HTTP/WebSocket endpoint.
 */
export class RemoteDshHostTunnel {
  readonly localPort: number
  readonly remotePort: number
  readonly origin: string
  /** Resolves whenever the underlying SSH process exits. */
  readonly closed: Promise<void>

  private disposed = false

  private constructor(
    private readonly ssh: ChildProcessWithoutNullStreams,
    private readonly forward: NetServer,
    private readonly forwardSockets: Set<Socket>,
    localPort: number,
    remotePort: number,
    private readonly token: string,
  ) {
    this.localPort = localPort
    this.remotePort = remotePort
    this.origin = `http://127.0.0.1:${String(localPort)}`
    this.closed = ssh.exitCode === null
      ? new Promise(resolve => { ssh.once('close', () => { resolve() }) })
      : Promise.resolve()
  }

  get alive(): boolean {
    return !this.disposed && this.ssh.exitCode === null && this.forward.listening
  }

  /** Headers for direct Host HTTP requests and WebSocket handshakes. */
  requestHeaders(): Readonly<Record<string, string>> {
    return { 'x-dsh-host-token': this.token }
  }

  /** Authenticated WebSocket URL for clients that cannot set handshake headers. */
  webSocketUrl(path: string): string {
    if (!path.startsWith('/')) throw new Error('dsh-ssh-workspace: Host protocol path must start with /')
    const url = new URL(path, this.origin)
    url.protocol = 'ws:'
    url.searchParams.set('tkn', this.token)
    return url.toString()
  }

  /** Make an authenticated request over the forwarded Host protocol. */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/')) throw new Error('dsh-ssh-workspace: Host protocol path must start with /')
    const headers = new Headers(init.headers)
    headers.set('x-dsh-host-token', this.token)
    return globalThis.fetch(`${this.origin}${path}`, { ...init, headers })
  }

  /** Read and validate the Host's UI-neutral carrier contract. */
  async describeProtocol(signal?: AbortSignal): Promise<DshHostProtocolDescription> {
    const response = await this.fetch('/dsh-host/protocol', signal === undefined ? {} : { signal })
    if (!response.ok) throw new Error(`dsh-ssh-workspace: Host protocol discovery failed with HTTP ${String(response.status)}`)
    return parseProtocolDescription(await response.json())
  }

  static async open(config: RemoteDshHostTunnelConfig): Promise<RemoteDshHostTunnel> {
    config.signal?.throwIfAborted()
    emitProgress(config.onProgress, 'connecting')
    const payload = loadDshHostPayload(config.packageRoot)
    const ports = await reservePorts(2)
    const localPort = ports[0]
    const socksPort = ports[1]
    if (localPort === undefined || socksPort === undefined) throw new Error('dsh-ssh-workspace: could not reserve tunnel ports')
    const ssh = spawn(config.sshExecutable, [
      ...config.sshArgs,
      '-T',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-D', `127.0.0.1:${String(socksPort)}`,
      config.sshTarget,
      buildDshBackendCommand(config.remotePort),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const abort = (): void => { ssh.kill() }
    config.signal?.addEventListener('abort', abort, { once: true })

    let tunnel: RemoteDshHostTunnel | undefined
    try {
      const ready = await installAndWaitForHost(ssh, payload, config.startupTimeoutMs, config.onProgress)
      await waitForPort(socksPort, ssh, 15_000)
      const { server: forward, sockets } = await createSocksForward(localPort, socksPort, ready.remotePort)
      tunnel = new RemoteDshHostTunnel(ssh, forward, sockets, localPort, ready.remotePort, ready.token)
      await tunnel.describeProtocol()
      emitProgress(config.onProgress, 'ready')
      return tunnel
    } catch (error) {
      if (tunnel !== undefined) await tunnel.dispose()
      else ssh.kill()
      throw error
    } finally {
      config.signal?.removeEventListener('abort', abort)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const forwardClosed = new Promise<void>(resolve => { this.forward.close(() => { resolve() }) })
    for (const socket of this.forwardSockets) socket.destroy()
    try { this.ssh.stdin.end('stop\n') } catch {}
    if (!await waitForChildClose(this.ssh, 2_000)) this.ssh.kill()
    await forwardClosed
  }
}

export function parseProtocolDescription(value: unknown): DshHostProtocolDescription {
  if (!isRecord(value)
    || value.protocol !== 'dsh-host'
    || value.protocolVersion !== DSH_HOST_PROTOCOL_VERSION
    || value.transport !== 'http+websocket'
    || value.rpcPath !== '/api/{method}'
    || typeof value.muxEventsPath !== 'string'
    || typeof value.hostEventsPath !== 'string'
    || !Array.isArray(value.capabilities)
    || value.capabilities.some(capability => typeof capability !== 'string')) {
    throw new Error('dsh-ssh-workspace: remote Host uses an incompatible protocol')
  }
  return value as unknown as DshHostProtocolDescription
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface DshHostReady { remotePort: number; token: string }

async function installAndWaitForHost(
  child: ChildProcessWithoutNullStreams,
  payload: DshHostPayload,
  timeoutMs: number,
  onProgress?: (progress: DshHostProgress) => void,
): Promise<DshHostReady> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let state: 'decision' | 'sending' | 'ready' = 'decision'
    const reportedStages = new Set<string>()
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
      operation()
    }
    const fail = (error: unknown): void => {
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
    const inspect = (): void => {
      if (settled) return
      for (const match of stdout.matchAll(/(?:^|\n)DSH_(?:REMOTE_BACKEND|HOST)_PROGRESS ([a-z-]+)(?=\r?\n|$)/g)) {
        const stage = match[1]
        if (stage !== undefined && isProgressStage(stage) && !reportedStages.has(stage)) {
          reportedStages.add(stage)
          emitProgress(onProgress, stage)
        }
      }
      if (state === 'decision') {
        if (/(?:^|\n)DSH_REMOTE_BACKEND_PAYLOAD CURRENT(?:\r?\n|$)/.test(stdout)) {
          state = 'ready'
        } else if (/(?:^|\n)DSH_REMOTE_BACKEND_PAYLOAD REQUIRED(?:\r?\n|$)/.test(stdout)) {
          state = 'sending'
          emitProgress(onProgress, 'uploading-host')
          void writePayload(child, payload).then(() => {
            if (settled) return
            state = 'ready'
            inspect()
          }, fail)
          return
        }
      }
      if (state !== 'ready') return
      const match = /(?:^|\n)DSH_REMOTE_BACKEND_READY ([0-9]{1,5}) ([0-9a-fA-F]{64})(?:\r?\n|$)/.exec(stdout)
      const remotePort = Number(match?.[1])
      const token = match?.[2]
      if (token !== undefined && Number.isSafeInteger(remotePort) && remotePort >= 1 && remotePort <= 65535) {
        finish(() => { resolve({ remotePort, token }) })
      }
    }
    const onStdout = (chunk: Buffer): void => {
      stdout = (stdout + chunk.toString('utf8')).slice(-1024 * 1024)
      inspect()
    }
    const onStderr = (chunk: Buffer): void => { stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024) }
    const onError = (error: Error): void => { fail(error) }
    const onClose = (code: number | null): void => {
      finish(() => { reject(new Error(`dsh-ssh-workspace: Host SSH exited ${String(code)} before readiness${stderr.trim() ? `\n${stderr.trim()}` : ''}`)) })
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    const timer = setTimeout(() => {
      finish(() => { reject(new Error(`dsh-ssh-workspace: Host startup timed out after ${String(timeoutMs)}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`)) })
    }, timeoutMs)
    void writeStdin(child, `DSH_REMOTE_BACKEND_ATTACH ${payload.hash}\n`).catch(fail)
  })
}

function emitProgress(listener: ((progress: DshHostProgress) => void) | undefined, stage: DshHostProgressStage): void {
  try { listener?.({ stage }) } catch {}
}

function isProgressStage(value: string): value is DshHostProgressStage {
  return value === 'connecting' || value === 'reconnecting' || value === 'waiting-host' || value === 'checking-host' || value === 'uploading-host'
    || value === 'reusing-host' || value === 'installing-host' || value === 'checking-runtime'
    || value === 'installing-node' || value === 'installing-pnpm' || value === 'installing-harness'
    || value === 'verifying-runtime' || value === 'installing-bundle' || value === 'installed'
    || value === 'starting-host' || value === 'ready'
    || value === 'failed'
}

async function writePayload(child: ChildProcessWithoutNullStreams, payload: DshHostPayload): Promise<void> {
  await writeStdin(child, encodePayloadArchive(payload))
}

async function writeStdin(child: ChildProcessWithoutNullStreams, value: string): Promise<void> {
  if (child.stdin.destroyed || !child.stdin.writable) throw new Error('dsh-ssh-workspace: Host SSH stdin closed during installation')
  if (!child.stdin.write(value)) await once(child.stdin, 'drain')
}

async function reservePorts(count: number): Promise<number[]> {
  const servers: NetServer[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createNetServer()
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
    }
    return servers.map(server => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('could not reserve a TCP port')
      return address.port
    })
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => { resolve() }) })))
  }
}

async function waitForPort(port: number, child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dsh-ssh-workspace: Host SSH exited ${String(child.exitCode)} before the tunnel opened`)
    const connected = await new Promise<boolean>(resolve => {
      const socket = new Socket()
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true) })
    })
    if (connected) return
    if (Date.now() >= deadline) throw new Error(`dsh-ssh-workspace: Host tunnel did not open within ${String(timeoutMs)}ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('close', onClose); resolve(false) }, timeoutMs)
    const onClose = (): void => { clearTimeout(timer); resolve(true) }
    child.once('close', onClose)
  })
}
