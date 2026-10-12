import { describe, expect, it } from 'vitest'
import {
  RemoteDshHostConnection,
  type DshHostTransport,
  type DshHostTunnelOpener,
} from '../src/backend/connection.ts'

class FakeTunnel implements DshHostTransport {
  alive = true
  readonly origin: string
  readonly closed: Promise<void>
  private close!: () => void

  constructor(readonly localPort: number, readonly remotePort: number) {
    this.origin = `http://127.0.0.1:${String(localPort)}`
    this.closed = new Promise(resolve => { this.close = resolve })
  }

  requestHeaders(): Readonly<Record<string, string>> { return { 'x-dsh-host-token': `token-${String(this.remotePort)}` } }
  webSocketUrl(path: string): string { return `ws://127.0.0.1:${String(this.localPort)}${path}` }
  fetch(): Promise<Response> { return Promise.resolve(new Response('{}')) }
  describeProtocol() {
    return Promise.resolve({
      protocol: 'dsh-host' as const,
      protocolVersion: 1,
      transport: 'http+websocket' as const,
      rpcPath: '/api/{method}' as const,
      muxEventsPath: '/api/events.mux',
      hostEventsPath: '/api/events.host',
      capabilities: [],
    })
  }

  drop(): void {
    this.alive = false
    this.close()
  }

  async dispose(): Promise<void> { this.drop() }
}

const config = {
  sshExecutable: 'ssh', sshArgs: [], sshTarget: 'fixture', remotePort: 0,
  startupTimeoutMs: 1_000, reconnectInitialDelayMs: 1, reconnectMaxDelayMs: 2,
}

describe('reconnecting Host connection', () => {
  it('replaces only the physical tunnel after an unexpected disconnect', async () => {
    const first = new FakeTunnel(41001, 42001)
    const second = new FakeTunnel(41002, 42001)
    let calls = 0
    const stages: string[] = []
    const opener: DshHostTunnelOpener = async () => (++calls === 1 ? first : second)
    const connection = await RemoteDshHostConnection.open({
      ...config,
      onProgress: progress => { stages.push(progress.stage) },
    }, opener)

    first.drop()
    await expect.poll(() => calls).toBe(2)
    expect(await connection.ready()).toBe(second)
    expect(connection.localPort).toBe(41002)
    expect(connection.remotePort).toBe(42001)
    expect(stages).toContain('reconnecting')
    await connection.dispose()
  })

  it('shares one retry loop between concurrent callers', async () => {
    const first = new FakeTunnel(41001, 42001)
    const replacement = new FakeTunnel(41003, 42001)
    let calls = 0
    const opener: DshHostTunnelOpener = async () => {
      calls += 1
      if (calls === 1) return first
      if (calls === 2) throw new Error('temporary network failure')
      return replacement
    }
    const connection = await RemoteDshHostConnection.open(config, opener)

    first.drop()
    const [left, right] = await Promise.all([connection.ready(), connection.ready()])
    expect(left).toBe(replacement)
    expect(right).toBe(replacement)
    expect(calls).toBe(3)
    await connection.dispose()
  })

  it('cancels an in-flight reconnect during disposal', async () => {
    const first = new FakeTunnel(41001, 42001)
    let calls = 0
    const opener: DshHostTunnelOpener = async attempt => {
      calls += 1
      if (calls === 1) return first
      return new Promise((_resolve, reject) => {
        const signal = attempt.signal
        if (signal === undefined) throw new Error('reconnect attempt has no lifecycle signal')
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
    }
    const connection = await RemoteDshHostConnection.open(config, opener)
    first.drop()
    const pending = connection.ready()
    await expect.poll(() => calls).toBe(2)

    await connection.dispose()
    await expect(pending).rejects.toThrow(/disposed/i)
  })
})
