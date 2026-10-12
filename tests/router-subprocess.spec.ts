import { resolve } from 'node:path'
import { once } from 'node:events'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WorkspacePathMapper, fileUriFromPosixPath } from '../src/transport/runtime.ts'
import TransparentSubprocessRuntime, {
  DeferredAhpStdin,
  buildRemoteProcessCommand,
  buildRemoteStdinWriterCommand,
  canUseAhpSubprocess,
} from '../src/routing/subprocess.ts'
import { describe, expect, it } from 'vitest'

class FakeResourceClient {
  readonly files = new Map<string, Buffer>()
  readonly terminal = new FakeSubscription()

  async resourceWrite(params: { uri: string; data: string; encoding: string }) {
    this.files.set(params.uri, params.encoding === 'base64' ? Buffer.from(params.data, 'base64') : Buffer.from(params.data))
    return {}
  }

  async resourceRead({ uri }: { uri: string }) {
    return { data: (this.files.get(uri) ?? Buffer.alloc(0)).toString('base64'), encoding: 'base64' }
  }

  async resourceDelete({ uri }: { uri: string }) {
    this.files.delete(uri)
    return {}
  }

  async request() { return {} }
  async subscribe() { return { result: {}, subscription: this.terminal as unknown as Subscription } }
  dispatch(_channel: string, action: { type: string; data: string }) {
    if (action.type === ActionType.TerminalInput && action.data.startsWith('exec env')) {
      this.terminal.push({ type: ActionType.TerminalData, data: 'interactive-remote\r\n' })
      this.terminal.push({ type: ActionType.TerminalExited, exitCode: 9 })
    }
    return { clientSeq: 1 }
  }
}

class FakeSubscription implements AsyncIterableIterator<SubscriptionEvent> {
  private readonly events: SubscriptionEvent[] = []
  private waiter: (() => void) | undefined
  push(action: object): void {
    this.events.push({ type: 'action', params: { channel: 'ahp-terminal:/test', serverSeq: this.events.length + 1, action } } as SubscriptionEvent)
    this.waiter?.(); this.waiter = undefined
  }
  async next(): Promise<IteratorResult<SubscriptionEvent>> {
    while (this.events.length === 0) await new Promise<void>(resolvePromise => { this.waiter = resolvePromise })
    return { value: this.events.shift()!, done: false }
  }
  async return(): Promise<IteratorResult<SubscriptionEvent>> { return { value: undefined, done: true } }
  [Symbol.asyncIterator](): this { return this }
  async close(): Promise<void> {}
}

function collectedSpec(stdin: SubprocessSpawnSpec['stdio']['stdin'] = 'ignore'): SubprocessSpawnSpec {
  return {
    argv: ['C:\\tools\\rg.exe', '--version'],
    cwd: resolve('tests', 'remote-process'),
    stdio: {
      stdin,
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
    },
    graceMs: 100,
  }
}

async function setup() {
  const ctx = new Context()
  const client = new FakeResourceClient()
  const alias = resolve('tests', 'remote-process')
  const route = {
    kind: 'remote' as const,
    server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
    workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/project' },
    aliasPath: alias,
    mapper: new WorkspacePathMapper(alias, '/srv/project'),
  }
  const remote = {
    runtimeRoot: '/tmp/dsh/process-test',
    clientId: 'fake-client',
    getClient: async () => client as unknown as AhpClient,
  }
  const shell = {
    resolve(request: Record<string, unknown>) {
      return { timeoutMs: 10_000, stdoutMaxBytes: 4096, ...request }
    },
    async run(spec: { command: string; signal?: AbortSignal }) {
      if (spec.command.includes('wait-for-cancel')) {
        if (!spec.signal?.aborted) await new Promise<void>(resolvePromise => spec.signal?.addEventListener('abort', () => { resolvePromise() }, { once: true }))
        return shellResult(null, 'SIGTERM')
      }
      const output = /> '([^']+)' 2> '([^']+)'$/.exec(spec.command)
      if (output === null) throw new Error(`missing redirected outputs in ${spec.command}`)
      client.files.set(fileUriFromPosixPath(output[1]!), Buffer.from('remote-stdout\n'))
      client.files.set(fileUriFromPosixPath(output[2]!), Buffer.from('remote-stderr\n'))
      return shellResult(23, null)
    },
  }
  let sshFallbacks = 0
  const manager = {
    route: () => route,
    workspaceContext: async () => ({ remote }),
    workspaceShell: async () => shell,
    sshTransport: () => { sshFallbacks += 1; return { executable: 'ssh', args: [], multiplexed: false } },
  }
  ctx.provide('localSubprocess', { resolveExecutable: async (command: string) => command } as never)
  ctx.provide('remoteSshManager', manager as never)
  await ctx.plugin(TransparentSubprocessRuntime)
  return { ctx, client, alias, getSshFallbacks: () => sshFallbacks }
}

function shellResult(exitCode: number | null, signal: NodeJS.Signals | null) {
  return {
    exitCode, signal, timedOut: false, aborted: signal !== null, timeoutMs: 10_000,
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
  }
}

describe('AHP transparent subprocess', () => {
  it('builds a quoted remote argv without retaining a Windows executable path', () => {
    const command = buildRemoteProcessCommand(
      ['C:\\tools\\rg.exe', "a'b"], { SAFE: 'x y' }, '/tmp/in', '/tmp/out', '/tmp/err',
    )
    expect(command).toContain("'rg' 'a'\"'\"'b'")
    expect(command).toContain("'SAFE=x y'")
    expect(command).not.toContain('C:\\tools')
  })

  it('uses the persistent AHP host and preserves separate collected outputs', async () => {
    const { ctx, getSshFallbacks } = await setup()
    try {
      const handle = ctx.subprocess.spawn(collectedSpec())
      await expect(handle.done).resolves.toEqual({ exitCode: 23, signal: null })
      expect(handle.collected.stdout?.readFrom(0).text).toBe('remote-stdout\n')
      expect(handle.collected.stderr?.readFrom(0).text).toBe('remote-stderr\n')
      expect(getSshFallbacks()).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('propagates termination through the AHP shell signal', async () => {
    const { ctx, getSshFallbacks } = await setup()
    try {
      const spec = collectedSpec()
      spec.argv = ['wait-for-cancel']
      const handle = ctx.subprocess.spawn(spec)
      handle.terminate()
      await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
      expect(getSshFallbacks()).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps every stdin mode on the persistent AHP path', () => {
    expect(canUseAhpSubprocess(collectedSpec('ignore'))).toBe(true)
    expect(canUseAhpSubprocess(collectedSpec({ data: 'fixed stdin' }))).toBe(true)
    expect(canUseAhpSubprocess(collectedSpec('pipe'))).toBe(true)
  })

  it('streams ordered binary chunks and an EOF marker through the AHP stdin pump', async () => {
    const writes: string[] = []
    const terminal = {
      write: async (data: string) => { writes.push(data) },
      done: Promise.resolve({ exitCode: 0, signal: null }),
    }
    const stdin = new DeferredAhpStdin()
    stdin.bind(terminal as never, 'EOF-MARKER')
    stdin.write(Buffer.from([0, 1, 255]))
    stdin.end('汉字')
    await once(stdin, 'finish')
    expect(writes).toEqual([
      `${Buffer.from([0, 1, 255]).toString('base64')}\n`,
      `${Buffer.from('汉字').toString('base64')}\n`,
      'EOF-MARKER\n',
    ])
    expect(buildRemoteStdinWriterCommand("/tmp/a'b.fifo", "end'marker")).toContain("'/tmp/a'\"'\"'b.fifo'")
  })

  it('allocates interactive terminals through AHP without an SSH process', async () => {
    const { ctx, alias, getSshFallbacks } = await setup()
    try {
      const terminal = await ctx.subprocess.spawnTerminal({
        argv: ['bash', '-i'], cwd: alias, rows: 30, cols: 100, graceMs: 100,
      })
      const chunks: Buffer[] = []
      terminal.output.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      await expect(terminal.done).resolves.toEqual({ exitCode: 9, signal: null })
      expect(Buffer.concat(chunks).toString()).toBe('interactive-remote\r\n')
      expect(getSshFallbacks()).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
