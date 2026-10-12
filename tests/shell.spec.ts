import { resolve } from 'node:path'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteSshRuntime } from '../src/transport/runtime.ts'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import RemoteSshShellExecutor from '../src/transport/shell.ts'
import { describe, expect, it } from 'vitest'

class FakeSubscription implements AsyncIterableIterator<SubscriptionEvent> {
  private readonly events: SubscriptionEvent[] = []
  push(action: object): void {
    this.events.push({ type: 'action', params: { channel: 'ahp-terminal:/test', serverSeq: this.events.length + 1, action } } as SubscriptionEvent)
  }
  async next(): Promise<IteratorResult<SubscriptionEvent>> {
    while (this.events.length === 0) await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    return { value: this.events.shift()!, done: false }
  }
  async return(): Promise<IteratorResult<SubscriptionEvent>> { return { value: undefined, done: true } }
  [Symbol.asyncIterator](): this { return this }
  async close(): Promise<void> {}
}

class FakeTerminalAhp {
  readonly subscription = new FakeSubscription()
  readonly writes: string[] = []
  disposed = false

  async resourceWrite({ uri }: { uri: string }) { this.writes.push(uri); return {} }
  async resourceDelete() { return {} }
  async request(method: string) {
    if (method === 'disposeTerminal') this.disposed = true
    return {}
  }
  async subscribe() {
    return { result: { snapshot: { resource: 'ahp-terminal:/test', state: {} } }, subscription: this.subscription as unknown as Subscription }
  }
  dispatch(_channel: string, action: { data: string }) {
    const token = /DSH:([0-9a-f-]+):BEGIN/.exec(action.data)?.[1]
    if (token === undefined) throw new Error('missing output marker')
    this.subscription.push({ type: ActionType.TerminalData, data: `echoed input\r\n\x1eDSH:${token}:BE` })
    this.subscription.push({ type: ActionType.TerminalData, data: `GIN\x1fremote-output\r\n\x1eDSH:${token}:END:` })
    this.subscription.push({ type: ActionType.TerminalData, data: '7\x1ftrailing prompt' })
    this.subscription.push({ type: ActionType.TerminalExited, exitCode: 7 })
    return { clientSeq: 1 }
  }
}

async function setup() {
  const ctx = new Context()
  const client = new FakeTerminalAhp()
  const local = resolve('tests', 'shell-alias')
  const runtime = {
    mapper: new WorkspacePathMapper(local, '/srv/project'),
    runtimeRoot: '/tmp/dsh/test',
    clientId: 'test-client',
    getClient: async () => client as unknown as AhpClient,
  } as unknown as RemoteSshRuntime
  ctx.provide('remoteSsh', runtime)
  await ctx.plugin(RemoteSshShellExecutor, {
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 2000,
    outputMaxBytes: 1024,
    maxOutputMaxBytes: 4096,
    shellCommand: 'bash',
  })
  return { ctx, client, local }
}

describe('RemoteSshShellExecutor', () => {
  it('projects AHP terminal command actions into a ShellRunResult', async () => {
    const { ctx, client, local } = await setup()
    const result = await ctx.shell.run(ctx.shell.resolve({
      command: 'printf remote-output',
      workdir: local,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
    }))
    expect(result).toMatchObject({ exitCode: 7, signal: null, timedOut: false, aborted: false })
    expect(result.stdout).toEqual({ text: 'remote-output\r\n', truncated: false })
    expect(result.stderr).toEqual({ text: '', truncated: false })
    expect(client.writes).toHaveLength(1)
    expect(client.disposed).toBe(true)
  })

  it('exposes one current Harness execution handle with a foreground result', async () => {
    const { ctx, local } = await setup()
    const execution = await (ctx.shell as RemoteSshShellExecutor).execute(ctx.shell.resolve({ command: 'pwd', workdir: local, sandboxPolicy: {mode:'danger-full-access',workspaceRoot:local} }))
    const result = await execution.result()
    await execution.done
    expect(result.exitCode).toBe(7)
    expect(result.stdout.text).toBe('remote-output\r\n')
    expect(execution.status).toBe('completed')
    await ctx.fiber.dispose()
  })

  it('rejects restrictive modes rather than pretending a remote shell is confined', async () => {
    const { ctx, local } = await setup()
    await expect(ctx.shell.run(ctx.shell.resolve({
      command: 'true',
      workdir: local,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: local },
    }))).rejects.toThrow(/cannot confine arbitrary remote commands/)
  })
})
