import { once } from 'node:events'
import { createServer, Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocksForward } from '../src/backend/socks.ts'

const servers: Server[] = []
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve() })
  })))
})

describe('dynamic SSH SOCKS forwarding', () => {
  it('connects a local socket to a discovered remote port', async () => {
    const target = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      socket.on('data', data => { socket.write(data.toString('utf8').toUpperCase()) })
    })
    const targetPort = await listen(target)

    const socks = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      void (async () => {
        expect([...await readExactly(socket, 3)]).toEqual([5, 1, 0])
        socket.write(Buffer.from([5, 0]))
        const request = await readExactly(socket, 10)
        expect([...request.subarray(0, 8)]).toEqual([5, 1, 0, 1, 127, 0, 0, 1])
        expect(request.readUInt16BE(8)).toBe(targetPort)
        const upstream = new Socket()
        sockets.add(upstream)
        upstream.once('close', () => { sockets.delete(upstream) })
        upstream.connect(targetPort, '127.0.0.1')
        await once(upstream, 'connect')
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        socket.pipe(upstream)
        upstream.pipe(socket)
      })()
    })
    const socksPort = await listen(socks)
    const forward = await createSocksForward(0, socksPort, targetPort)
    servers.push(forward.server)
    for (const socket of forward.sockets) sockets.add(socket)
    const address = forward.server.address()
    if (address === null || typeof address === 'string') throw new Error('forward did not bind')

    const client = new Socket()
    sockets.add(client)
    client.once('close', () => { sockets.delete(client) })
    client.connect(address.port, '127.0.0.1')
    await once(client, 'connect')
    client.write('hello')
    const [response] = await once(client, 'data') as [Buffer]
    expect(response.toString('utf8')).toBe('HELLO')
  })
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return address.port
}

async function readExactly(socket: Socket, length: number): Promise<Buffer> {
  for (;;) {
    const data = socket.read(length) as Buffer | null
    if (data !== null) return data
    await once(socket, 'readable')
  }
}
