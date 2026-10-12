// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Local Web asset server and same-origin proxy over a remote dsh-host tunnel. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  RemoteDshHostConnection,
  type RemoteDshHostConnectionConfig,
} from './connection.ts'
import { DEFAULT_DSH_HOST_PORT } from './tunnel.ts'
import {
  REMOTE_BACKEND_CONTEXT_PATH,
  REMOTE_SSH_LOCAL_CONTROL_PATHS,
  type RemoteBackendContext,
} from '../backend-context.ts'

export { buildDshBackendCommand } from './install.ts'
export { RemoteDshHostTunnel } from './tunnel.ts'
export type { RemoteDshHostTunnelConfig } from './tunnel.ts'
export { RemoteDshHostConnection } from './connection.ts'
export type { RemoteDshHostConnectionConfig } from './connection.ts'

export const DEFAULT_DSH_BACKEND_PORT = DEFAULT_DSH_HOST_PORT
const COOKIE_PREFIX = 'dsh_remote_backend_'
// Use the browser's standard trustworthy loopback origin. Remote identity is
// a protocol concern and must not depend on hostname/cookie edge cases.
const REMOTE_BROWSER_HOST = 'localhost'

export interface RemoteWebProxyConfig extends RemoteDshHostConnectionConfig {
  localUiPort: number
}

export interface RemoteWebProxyAttachment {
  /** Bootstrap URL; the gateway exchanges its query token for an HttpOnly cookie. */
  url: string
  localPort: number
  remotePort: number
  dispose(): Promise<void>
}

/** Serve local Web assets and proxy the unchanged Host protocol on one origin. */
export class RemoteDshWebProxy implements RemoteWebProxyAttachment {
  readonly localPort: number
  readonly url: string

  private disposed = false

  private constructor(
    private readonly connection: RemoteDshHostConnection,
    private readonly gateway: Server,
    localPort: number,
    private readonly initialRemotePort: number,
    gatewayToken: string,
    private readonly sockets: Set<Duplex>,
    private readonly ownsTunnel: boolean,
  ) {
    this.localPort = localPort
    this.url = `http://${REMOTE_BROWSER_HOST}:${String(localPort)}/?tkn=${encodeURIComponent(gatewayToken)}`
  }

  get alive(): boolean {
    return !this.disposed && this.connection.alive && this.gateway.listening
  }

  get remotePort(): number {
    return this.connection.connected ? this.connection.remotePort : this.initialRemotePort
  }

  static async open(config: RemoteWebProxyConfig): Promise<RemoteDshWebProxy> {
    const connection = await RemoteDshHostConnection.open(config)
    try {
      return await this.attachInternal(connection, config.localUiPort, true)
    } catch (error) {
      await connection.dispose()
      throw error
    }
  }

  /** Add the browser same-origin proxy without taking ownership of the SSH tunnel. */
  static attach(connection: RemoteDshHostConnection, localUiPort: number): Promise<RemoteDshWebProxy> {
    return this.attachInternal(connection, localUiPort, false)
  }

  private static async attachInternal(
    connection: RemoteDshHostConnection,
    localUiPort: number,
    ownsTunnel: boolean,
  ): Promise<RemoteDshWebProxy> {
    const tunnel = await connection.ready()

    const gatewayToken = randomBytes(32).toString('hex')
    const cookieName = `${COOKIE_PREFIX}${gatewayToken.slice(0, 16)}`
    const sockets = new Set<Duplex>()
    const gateway = createGateway({
      localUiPort,
      resolveRemote: async () => {
        const active = await connection.ready()
        const token = active.requestHeaders()['x-dsh-host-token']
        if (token === undefined) throw new Error('dsh-ssh-workspace: Host tunnel did not provide credentials')
        return { port: active.localPort, token }
      },
      gatewayToken,
      cookieName,
      sockets,
    })
    try {
      await listenLoopback(gateway)
    } catch (error) { throw error }
    const address = gateway.address()
    if (address === null || typeof address === 'string') throw new Error('dsh-ssh-workspace: Web proxy has no TCP address')
    return new RemoteDshWebProxy(connection, gateway, address.port, tunnel.remotePort, gatewayToken, sockets, ownsTunnel)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const closed = new Promise<void>(resolve => { this.gateway.close(() => { resolve() }) })
    this.gateway.closeAllConnections()
    for (const socket of this.sockets) socket.destroy()
    await Promise.all([closed, ...(this.ownsTunnel ? [this.connection.dispose()] : [])])
  }
}

interface GatewayOptions {
  localUiPort: number
  resolveRemote(): Promise<{ port: number; token: string }>
  gatewayToken: string
  cookieName: string
  sockets: Set<Duplex>
}

function createGateway(options: GatewayOptions): Server {
  const server = createServer((req, res) => {
    if (exchangeToken(req, res, options.gatewayToken, options.cookieName)) return
    if (!cookieMatches(req, options.gatewayToken, options.cookieName)) return unauthorized(res)
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
    if (pathname === REMOTE_BACKEND_CONTEXT_PATH) return backendContext(res)
    if (REMOTE_SSH_LOCAL_CONTROL_PATHS.has(pathname)) return localRemoteSshUnavailable(res)
    void proxyTarget(req, options).then(
      target => { proxyHttp(req, res, target) },
      () => { unavailable(res) },
    )
  })
  server.on('upgrade', (req, socket, head) => {
    if (!cookieMatches(req, options.gatewayToken, options.cookieName)) { socket.destroy(); return }
    options.sockets.add(socket)
    socket.once('close', () => { options.sockets.delete(socket) })
    void proxyTarget(req, options).then(
      target => { proxyUpgrade(req, socket, head, target, options.sockets) },
      () => { socket.destroy() },
    )
  })
  return server
}

async function proxyTarget(req: IncomingMessage, options: GatewayOptions): Promise<{ port: number; remote: boolean; token?: string }> {
  const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
  const remote = pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/dsh-host' || pathname.startsWith('/dsh-host/')
  if (!remote) return { port: options.localUiPort, remote: false }
  const target = await options.resolveRemote()
  return { port: target.port, remote: true, token: target.token }
}

function proxyHeaders(req: IncomingMessage, port: number, remote: boolean, remoteToken: string): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${String(port)}` }
  delete headers.cookie
  delete headers['proxy-connection']
  delete headers['x-dsh-host-token']
  if (remote) headers['x-dsh-host-token'] = remoteToken
  return headers
}

/** @deprecated Use RemoteWebProxyConfig. */
export type RemoteBackendConfig = RemoteWebProxyConfig
/** @deprecated Use RemoteWebProxyAttachment. */
export type RemoteBackendAttachment = RemoteWebProxyAttachment
/** @deprecated Use RemoteDshWebProxy. */
export { RemoteDshWebProxy as RemoteDshBackend }

function proxyHttp(req: IncomingMessage, res: ServerResponse, target: { port: number; remote: boolean; token?: string }): void {
  const upstream = httpRequest({
    host: '127.0.0.1', port: target.port, method: req.method, path: req.url,
    headers: proxyHeaders(req, target.port, target.remote, target.token ?? ''),
  }, response => {
    const headers = { ...response.headers }
    delete headers['set-cookie']
    res.writeHead(response.statusCode ?? 502, headers)
    response.pipe(res)
  })
  upstream.once('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('remote backend unavailable')
  })
  req.pipe(upstream)
}

function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: { port: number; remote: boolean; token?: string },
  sockets: Set<Duplex>,
): void {
  const upstream = httpRequest({
    host: '127.0.0.1', port: target.port, method: req.method, path: req.url,
    headers: proxyHeaders(req, target.port, target.remote, target.token ?? ''),
  })
  upstream.once('upgrade', response => {
    const upstreamSocket = response.socket as Socket
    sockets.add(upstreamSocket)
    upstreamSocket.once('close', () => { sockets.delete(upstreamSocket) })
    socket.write(`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}\r\n`)
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
    }
    socket.write('\r\n')
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  upstream.once('response', response => {
    socket.end(`HTTP/1.1 ${String(response.statusCode ?? 502)} ${response.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`)
  })
  upstream.once('error', () => { socket.destroy() })
  upstream.end()
}

function exchangeToken(req: IncomingMessage, res: ServerResponse, expected: string, cookieName: string): boolean {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const supplied = url.searchParams.get('tkn')
  if (supplied === null) return false
  if (!safeEqual(expected, supplied)) { unauthorized(res); return true }
  url.searchParams.delete('tkn')
  const location = `${url.pathname}${url.search}${url.hash}`
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    // The launcher page normally lives at 127.0.0.1 while this trustworthy
    // gateway uses localhost. Chromium therefore marks the bootstrap redirect
    // chain cross-site; Lax permits that top-level GET while still excluding
    // cross-site subresource/API requests.
    'set-cookie': `${cookieName}=${expected}; HttpOnly; SameSite=Lax; Path=/`,
  })
  res.end()
  return true
}

function cookieMatches(req: IncomingMessage, expected: string, cookieName: string): boolean {
  const cookies = (req.headers.cookie ?? '').split(';')
  const value = cookies.map(cookie => cookie.trim().split('=', 2)).find(([name]) => name === cookieName)?.[1]
  return safeEqual(expected, value)
}

function safeEqual(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('unauthorized')
}

function backendContext(res: ServerResponse): void {
  const body: RemoteBackendContext = { attached: true, transport: 'ssh' }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function localRemoteSshUnavailable(res: ServerResponse): void {
  res.writeHead(409, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ error: 'Remote SSH controls are unavailable inside a remote Backend window.' }))
}

function unavailable(res: ServerResponse): void {
  if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
  res.end('remote backend reconnecting')
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}
