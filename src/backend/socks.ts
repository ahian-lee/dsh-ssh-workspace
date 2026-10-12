// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Local TCP forwarding through the dynamic SOCKS port of one OpenSSH process. */

import { once } from 'node:events'
import { createServer, Socket, type Server } from 'node:net'

export interface SocksForward {
  server: Server
  sockets: Set<Socket>
}

/**
 * Expose one local loopback port through OpenSSH's dynamic forward. Unlike
 * `ssh -L`, the destination port is learned after the remote Host publishes
 * its endpoint, so reconnects do not depend on a fixed server-side port.
 */
export async function createSocksForward(localPort: number, socksPort: number, remotePort: number): Promise<SocksForward> {
  const sockets = new Set<Socket>()
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  }
  const server = createServer(client => {
    const socks = new Socket()
    track(client)
    track(socks)
    const fail = (): void => {
      client.destroy()
      socks.destroy()
    }
    void (async () => {
      await connectSocket(socks, socksPort, '127.0.0.1')
      await writeSocket(socks, Buffer.from([0x05, 0x01, 0x00]))
      const greeting = await readExactly(socks, 2)
      if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
        throw new Error('dsh-ssh-workspace: SSH SOCKS proxy rejected unauthenticated connection')
      }
      await writeSocket(socks, Buffer.from([
        0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1,
        (remotePort >> 8) & 0xff, remotePort & 0xff,
      ]))
      const reply = await readExactly(socks, 4)
      if (reply[0] !== 0x05 || reply[1] !== 0x00) {
        throw new Error(`dsh-ssh-workspace: SSH SOCKS proxy could not reach remote Host (code ${String(reply[1])})`)
      }
      if (reply[3] === 0x01) await readExactly(socks, 4)
      else if (reply[3] === 0x04) await readExactly(socks, 16)
      else if (reply[3] === 0x03) {
        const length = (await readExactly(socks, 1))[0]
        if (length === undefined) throw new Error('dsh-ssh-workspace: invalid SSH SOCKS address response')
        await readExactly(socks, length)
      } else {
        throw new Error('dsh-ssh-workspace: invalid SSH SOCKS address type')
      }
      await readExactly(socks, 2)
      client.pipe(socks)
      socks.pipe(client)
    })().catch(fail)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      const onListening = (): void => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(localPort, '127.0.0.1')
    })
    return { server, sockets }
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    throw error
  }
}

async function connectSocket(socket: Socket, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { socket.off('connect', onConnect); reject(error) }
    const onConnect = (): void => { socket.off('error', onError); resolve() }
    socket.once('error', onError)
    socket.once('connect', onConnect)
    socket.connect(port, host)
  })
}

async function writeSocket(socket: Socket, value: Buffer): Promise<void> {
  if (socket.destroyed || !socket.writable) throw new Error('dsh-ssh-workspace: SSH SOCKS socket closed')
  if (!socket.write(value)) await once(socket, 'drain')
}

async function readExactly(socket: Socket, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0)
  for (;;) {
    const value = socket.read(length) as Buffer | null
    if (value !== null) return value
    if (socket.destroyed || socket.readableEnded) throw new Error('dsh-ssh-workspace: SSH SOCKS socket closed during handshake')
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off('readable', onReadable)
        socket.off('error', onError)
        socket.off('end', onClosed)
        socket.off('close', onClosed)
      }
      const onReadable = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const onClosed = (): void => { cleanup(); reject(new Error('dsh-ssh-workspace: SSH SOCKS socket closed during handshake')) }
      socket.once('readable', onReadable)
      socket.once('error', onError)
      socket.once('end', onClosed)
      socket.once('close', onClosed)
    })
  }
}
