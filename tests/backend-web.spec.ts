import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RemoteDshHostConnection,
  type DshHostTransport,
  type DshHostTunnelOpener,
} from '../src/backend/connection.ts'
import { RemoteDshWebProxy } from '../src/backend/web.ts'
import { REMOTE_BACKEND_CONTEXT_PATH } from '../src/backend-context.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

class HttpTunnel implements DshHostTransport {
  alive = true
  readonly origin: string
  readonly closed: Promise<void>
  private close!: () => void

  constructor(readonly localPort: number, readonly remotePort: number, private readonly token: string) {
    this.origin = `http://127.0.0.1:${String(localPort)}`
    this.closed = new Promise(resolve => { this.close = resolve })
  }

  requestHeaders(): Readonly<Record<string, string>> { return { 'x-dsh-host-token': this.token } }
  webSocketUrl(path: string): string { return `ws://127.0.0.1:${String(this.localPort)}${path}` }
  fetch(path: string, init?: RequestInit): Promise<Response> { return globalThis.fetch(`${this.origin}${path}`, init) }
  async describeProtocol(): Promise<never> { throw new Error('not used by this fixture') }
  drop(): void { this.alive = false; this.close() }
  async dispose(): Promise<void> { this.drop() }
}

describe('reconnecting Web adapter', () => {
  it('keeps one trustworthy loopback URL while its SSH tunnel is replaced', async () => {
    const firstPort = await hostServer('first', 'token-first')
    const secondPort = await hostServer('second', 'token-second')
    const localUiPort = await uiServer()
    const first = new HttpTunnel(firstPort, 43001, 'token-first')
    const second = new HttpTunnel(secondPort, 43001, 'token-second')
    let calls = 0
    const opener: DshHostTunnelOpener = async () => (++calls === 1 ? first : second)
    const connection = await RemoteDshHostConnection.open({
      sshExecutable: 'ssh', sshArgs: [], sshTarget: 'fixture', remotePort: 0,
      startupTimeoutMs: 1_000, reconnectInitialDelayMs: 1, reconnectMaxDelayMs: 2,
    }, opener)
    const proxy = await RemoteDshWebProxy.attach(connection, localUiPort)
    const exchange = await fetch(proxy.url, { redirect: 'manual' })
    expect(exchange.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Path=/')
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('gateway did not issue a cookie')
    const endpoint = new URL('/api/ping', proxy.url)

    await expect(fetch(new URL(REMOTE_BACKEND_CONTEXT_PATH, proxy.url), { headers: { cookie } }).then(response => response.json()))
      .resolves.toEqual({ attached: true, transport: 'ssh' })
    const nestedControls = await fetch(new URL('/plugins/dsh-ssh-workspace/state', proxy.url), { headers: { cookie } })
    expect(nestedControls.status).toBe(409)
    await expect(fetch(new URL('/plugins/dsh-ssh-workspace/client.js', proxy.url), { headers: { cookie } }).then(response => response.text()))
      .resolves.toBe('local-ui')

    await expect(fetch(endpoint, { headers: { cookie } }).then(response => response.text())).resolves.toBe('first')
    first.drop()
    await expect.poll(() => calls).toBe(2)
    await expect(fetch(endpoint, { headers: { cookie } }).then(response => response.text())).resolves.toBe('second')
    expect(new URL(proxy.url)).toMatchObject({
      protocol: 'http:',
      hostname: 'localhost',
      port: String(proxy.localPort),
    })

    await proxy.dispose()
    await connection.dispose()
  })
})

async function hostServer(label: string, token: string): Promise<number> {
  const server = createServer((req, res) => {
    if (req.headers['x-dsh-host-token'] !== token) { res.writeHead(401); res.end(); return }
    res.end(label)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
  return address.port
}

async function uiServer(): Promise<number> {
  const server = createServer((_req, res) => { res.end('local-ui') })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('UI fixture did not bind')
  return address.port
}
