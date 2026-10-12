import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import RemoteDshHostClient from '../src/backend/client.ts'
import RemoteDshHostControlClient, {
  RemoteHostOperationUnsupportedError,
  type HostControlDescription,
} from '../src/backend/control.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

async function fixture(control?: HostControlDescription): Promise<RemoteDshHostControlClient> {
  const server = createServer(async (req, res) => {
    if (req.url === '/dsh-host/protocol') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        protocol: 'dsh-host', protocolVersion: 1, transport: 'http+websocket',
        rpcPath: '/api/{method}', muxEventsPath: '/api/events.mux', hostEventsPath: '/api/events.host',
        capabilities: [],
      }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      rpcId: string
      method: string
      payload: { args: Record<string, unknown> }
    }
    const value = request.method === 'control/describe'
      ? control
      : request.method === 'control/runShell'
        ? { exitCode: 0, signal: null, stdout: '/srv/project', stderr: '', timedOut: false, truncated: false }
        : request.method === 'control/setSessionMode'
          ? request.payload.args['spec']
          : request.method === 'control/commandCatalog'
            ? { commands: [{ name: 'remote-only', description: 'Remote only' }] }
          : request.method === 'control/setupProvider'
            ? { route: (request.payload.args['request'] as { route: string }).route }
        : undefined
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      type: 'server-response', rpcId: request.rpcId,
      result: value === undefined
        ? { ok: false, error: { code: 'internal', message: 'missing control method', details: {} } }
        : { ok: true, value },
    }))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  const host = new RemoteDshHostClient({
    origin: `http://127.0.0.1:${String(address.port)}`,
    requestHeaders: () => ({ 'x-dsh-host-token': 'secret' }),
    webSocketUrl: path => `ws://127.0.0.1:${String(address.port)}${path}`,
  })
  return new RemoteDshHostControlClient(host)
}

const DESCRIPTION: HostControlDescription = {
  authority: 'remote-host',
  localFallback: 'forbidden',
  operations: {
    shell: { supported: true },
    doctor: { supported: true },
    mcp: { supported: true },
    init: { supported: true },
    btw: { supported: true },
    commands: { supported: true },
    'session.mode': { supported: true },
    'session.delete': { supported: false, reason: 'no persistence deletion seam' },
    'provider.setup': { supported: true },
  },
}

describe('remote-Agent Host control client', () => {
  it('executes shell through control/runShell', async () => {
    const control = await fixture(DESCRIPTION)
    await expect(control.runShell('pwd', '/srv/project')).resolves.toMatchObject({
      exitCode: 0, stdout: '/srv/project',
    })
  })

  it('fails closed for unsupported operations', async () => {
    const control = await fixture(DESCRIPTION)
    await expect(control.deleteSession('session-1')).rejects.toThrow(/no persistence deletion seam/)
  })

  it('treats operations omitted by an older Host as unsupported', async () => {
    const { ['session.mode']: _mode, ...oldOperations } = DESCRIPTION.operations
    const control = await fixture({ ...DESCRIPTION, operations: oldOperations } as HostControlDescription)
    await expect(control.setSessionMode('session-1', {
      id: 'full', sandbox: 'danger-full-access', approval: 'never',
    })).rejects.toThrow(/not advertised by this Host version/)
  })

  it('switches session mode through the Host control plane', async () => {
    const control = await fixture(DESCRIPTION)
    await expect(control.setSessionMode('session-1', {
      id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never',
    })).resolves.toMatchObject({ id: 'full', sandbox: 'danger-full-access' })
  })

  it('reads the command catalog from the remote Host', async () => {
    const control = await fixture(DESCRIPTION)
    await expect(control.commandCatalog('session-1')).resolves.toEqual({
      commands: [{ name: 'remote-only', description: 'Remote only' }],
    })
  })

  it('commits provider configuration beside the remote Agent', async () => {
    const control = await fixture(DESCRIPTION)
    await expect(control.setupProvider({
      route: 'custom-openai', profile: { api: 'openai-responses' },
      credential: { ref: 'CUSTOM_OPENAI_API_KEY', value: 'secret' },
    })).resolves.toEqual({ route: 'custom-openai' })
  })

})
