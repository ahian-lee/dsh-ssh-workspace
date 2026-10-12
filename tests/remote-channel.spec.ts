import { describe, expect, it, vi } from 'vitest'
import { RemoteHostChannel } from '../src/tui/remote-channel.ts'

describe('remote Host TUI channel', () => {
  it('hydrates history, follows live events, and sends staged images to the Host', async () => {
    const mux = stream<any>()
    const host = stream<any>()
    const prompt = vi.fn(async (_payload: unknown) => ok({ accepted: true }))
    const respond = vi.fn(async () => ({ accepted: true }))
    const api = {
      sessions: {
        history: vi.fn(async () => ok({
          events: [
            history(event('turn/start', 0, { turn: 1 })),
            history(event('user/message', 1, {
              id: 'runtime-context', role: 'user',
              content: [{ type: 'text', text: 'Current runtime context. Internal only.' }],
              source: { kind: 'plugin', plugin: 'system-prompt' },
            })),
            history(event('user/message', 2, {
              id: 'message-1', role: 'user', content: [{ type: 'text', text: 'hello remote' }], source: { kind: 'user' },
            })),
            history(event('assistant/message', 3, {
              turn: 1, step: 1,
              message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'hello local' }] },
              usage: { inputTokens: 4, outputTokens: 2 },
            })),
            history(event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })),
          ],
          hasMore: false,
        })),
        models: vi.fn(async () => ok({
          current: { provider: 'fixture', model: 'fixture-model' }, routable: true, groups: [], failures: [],
        })),
        list: vi.fn(async () => ok({ items: [{
          sessionId: 'session-1', updatedAt: 1, running: false, blank: false, cwd: '/srv/project',
          projections: { asOfSeq: 4, values: { title: 'Remote fixture' } },
        }] })),
        prompt,
        cancel: vi.fn(async () => ok({ accepted: true })),
        updateQueue: vi.fn(async () => ok({ accepted: true })),
      },
      workspace: {
        list: vi.fn(async () => ok({ items: [workspace()] })),
      },
      events: {
        mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => mux.iterate(signal, onOpen),
        host: (_payload: unknown, signal: AbortSignal) => host.iterate(signal),
      },
      respond,
    }
    const approvalStore = { park: vi.fn(async () => 'allowed-once' as const) }
    const questionStore = { ask: vi.fn(async () => ({ answers: [{ id: 'choice', selected: ['yes'] }] })) }
    const invokeValue = vi.fn(async (_namespace: string, method: string, args?: Record<string, unknown>) => {
      if (method === 'describe') return {
        authority: 'remote-host', localFallback: 'forbidden',
        operations: {
          shell: { supported: true }, doctor: { supported: true }, mcp: { supported: true },
          init: { supported: true }, btw: { supported: true },
          commands: { supported: true },
          'session.mode': { supported: true },
          'session.delete': { supported: false, reason: 'unsupported' }, 'provider.setup': { supported: true },
        },
      }
      if (method === 'runShell') return { exitCode: 0, signal: null, stdout: '/srv/project\n', stderr: '', timedOut: false, truncated: false }
      if (method === 'doctor') return {
        node: 'v22.0.0', platform: 'linux', arch: 'x64', cwd: '/srv/project', sessionId: 'session-1',
        sessionAttached: true, apiKeyConfigured: true, home: '/home/fixture',
      }
      if (method === 'mcp') return { servers: [{ name: 'fixture', tools: ['lookup'] }] }
      if (method === 'commandCatalog') return {
        commands: [{ name: 'remote-only', description: 'Run on the remote Host' }],
      }
      if (method === 'init') return { status: 'created', path: '/srv/project/AGENTS.md' }
      if (method === 'btw') return { answer: 'remote side answer' }
      if (method === 'setSessionMode') return args?.['spec']
      throw new Error(`unexpected extension RPC: ${method}`)
    })
    const client = {
      api,
      invokeValue,
    }
    const channel = new RemoteHostChannel(
      client as never,
      server(),
      workspace(),
      'session-1' as never,
      {
        channel: localChannel() as never,
        requestApproval: approvalStore.park,
        askQuestions: questionStore.ask,
        locale: () => 'en',
        sessionModes: [
          { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
          { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
        ],
      },
    )

    await channel.open()
    expect(channel.cwd).toBe('/srv/project')
    expect(channel.displayCwd).toBe('192.0.2.10 · /srv/project')
    expect(channel.commandList).toContainEqual(expect.objectContaining({ name: 'disconnect' }))
    expect(channel.commandList).toContainEqual(expect.objectContaining({ name: 'connect', hidden: true }))
    expect(channel.commandList).toContainEqual(expect.objectContaining({ name: 'remote-only', external: true }))
    expect(channel.commandList).not.toContainEqual(expect.objectContaining({ name: 'codex' }))
    expect(channel.commandCompletions('/disc')).toContainEqual(expect.objectContaining({
      commandLine: '/disconnect',
      replacement: '/disconnect ',
    }))
    expect(channel.commandCompletions('/conn')).toEqual([])
    expect(channel.commandCompletions('/workspace rem')).toEqual([])
    await expect(channel.listWorkspaces()).resolves.toContainEqual(expect.objectContaining({
      badge: '192.0.2.10',
      cwd: '/srv/project',
    }))
    expect(channel.sessionTitle).toBe('Remote fixture')
    expect(channel.rows.map(row => [row.kind, row.text])).toEqual([
      ['user', 'hello remote'],
      ['assistant', 'hello local'],
    ])
    expect(channel.tokens).toEqual({ input: 4, output: 2 })

    mux.push({ rpcId: 'tool-call', payload: {
      type: 'session/event', sessionId: 'session-1',
      event: event('tool/call', 5, { turn: 2, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }),
      view: { for: 'call', view: { card: 'terminal', title: 'pwd' } },
    } })
    mux.push({ rpcId: 'tool-result', payload: {
      type: 'session/event', sessionId: 'session-1',
      event: event('tool/result', 6, {
        turn: 2, step: 1, message: { role: 'tool', callId: 'call-1', content: [{ type: 'text', text: '/srv/project' }] },
      }),
      view: { for: 'result', view: { card: 'terminal', output: '/srv/project' } },
    } })
    await expect.poll(() => channel.rows.find(row => row.tool?.callId === 'call-1')?.tool?.status).toBe('ok')

    mux.push({ rpcId: 'approval-rpc', payload: {
      type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'bash', callId: 'call-1',
    } })
    mux.push({ rpcId: 'question-rpc', payload: {
      type: 'question/requested', sessionId: 'session-1', questions: [{
        id: 'choice', question: 'Continue?', header: 'Continue', options: [{ label: 'yes', description: 'Continue' }], multiSelect: false,
      }],
    } })
    await expect.poll(() => respond.mock.calls.length).toBe(2)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ rpcId: 'approval-rpc' }))
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ rpcId: 'question-rpc' }))

    const token = await channel.stageImage({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'shot.png' })
    channel.submit(`inspect ${token}`)
    await expect.poll(() => prompt.mock.calls.length).toBe(1)
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1', mode: 'queue',
      content: [
        { type: 'text', text: 'inspect [Image #1]' },
        { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'shot.png' },
      ],
    })

    const onText = vi.fn()
    await expect(channel.sideQuestion('side?', { onText })).resolves.toEqual({ answer: 'remote side answer' })
    expect(onText).toHaveBeenCalledWith('remote side answer')
    expect(channel.handleBackendCommand({ name: 'mcp' } as never)).toBe(true)
    expect(channel.handleBackendCommand({ name: 'doctor' } as never)).toBe(true)
    expect(channel.handleBackendCommand({ name: 'init' } as never)).toBe(true)
    expect(channel.handleBackendCommand({ name: 'unknown' } as never)).toBe(false)
    await expect.poll(() => invokeValue.mock.calls.filter(call => ['mcp', 'doctor', 'init'].includes(call[1] ?? '')).length).toBe(3)
    expect(channel.rows.some(row => row.kind === 'local' && row.text === '/mcp')).toBe(true)
    expect(channel.rows.some(row => row.kind === 'local' && row.text === '/doctor')).toBe(true)

    await channel.cycleMode()
    expect(channel.mode).toMatchObject({ id: 'full', sandbox: 'danger-full-access' })

    channel.submit('!pwd')
    await expect.poll(() => channel.rows.some(row => row.kind === 'local' && row.text === '!pwd')).toBe(true)
    expect(channel.rows.some(row => row.kind === 'local-output' && row.text === '/srv/project')).toBe(true)
    expect(invokeValue.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([
      'describe', 'btw', 'mcp', 'doctor', 'init', 'runShell',
    ]))

    await channel.dispose()
  })

  it('loads older Host history pages into the same Channel', async () => {
    const mux = stream<any>()
    const host = stream<any>()
    const historyCall = vi.fn(async (payload: { beforeSeq?: number }) => ok(payload.beforeSeq === undefined
      ? {
          events: [
            history(event('user/message', 4, {
              id: 'new-user', role: 'user', content: [{ type: 'text', text: 'new question' }], source: { kind: 'user' },
            })),
            history(event('assistant/message', 5, {
              turn: 2, step: 1,
              message: { id: 'new-assistant', role: 'assistant', content: [{ type: 'text', text: 'new answer' }] },
              usage: { inputTokens: 2, outputTokens: 2 },
            })),
          ],
          hasMore: true,
        }
      : {
          events: [
            history(event('user/message', 0, {
              id: 'old-user', role: 'user', content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' },
            })),
            history(event('assistant/message', 1, {
              turn: 1, step: 1,
              message: { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
              usage: { inputTokens: 1, outputTokens: 1 },
            })),
          ],
          hasMore: false,
        }))
    const client = {
      api: {
        sessions: {
          history: historyCall,
          models: vi.fn(async () => ok({ current: { provider: 'fixture', model: 'model' }, groups: [], failures: [] })),
          list: vi.fn(async () => ok({ items: [] })),
        },
        events: {
          mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => mux.iterate(signal, onOpen),
          host: (_payload: unknown, signal: AbortSignal) => host.iterate(signal),
        },
      },
      invokeValue: vi.fn(async (_namespace: string, method: string) => {
        if (method === 'describe') return {
          authority: 'remote-host', localFallback: 'forbidden', operations: {},
        }
        throw new Error(`unexpected extension RPC: ${method}`)
      }),
    }
    const channel = new RemoteHostChannel(client as never, server(), workspace(), 'session-1' as never, {
      channel: localChannel() as never,
      requestApproval: vi.fn(),
      askQuestions: vi.fn(),
      locale: () => 'en',
      sessionModes: [{ id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' }],
    } as never)

    await channel.open()
    expect(channel.hasOlder).toBe(true)
    expect(channel.rows.map(row => row.text)).toEqual(['new question', 'new answer'])
    channel.rows.push({ id: 999, kind: 'local', text: '/doctor' })
    await expect(channel.loadOlder()).resolves.toBe(2)
    expect(historyCall).toHaveBeenLastCalledWith(expect.objectContaining({ beforeSeq: 4, maxMessages: 200 }), expect.any(AbortSignal))
    expect(channel.rows.map(row => row.text)).toEqual(['old question', 'old answer', 'new question', 'new answer', '/doctor'])
    expect(channel.hasOlder).toBe(false)
    await channel.dispose()
  })

  it('keeps !command output when the mux-open resync finishes afterward', async () => {
    const mux = stream<any>()
    const host = stream<any>()
    const reconnectHistory = deferred<ReturnType<typeof ok<{ events: never[]; hasMore: false }>>>()
    const historyCall = vi.fn(async () => historyCall.mock.calls.length === 1
      ? ok({ events: [], hasMore: false })
      : reconnectHistory.promise)
    const client = {
      api: {
        sessions: {
          history: historyCall,
          models: vi.fn(async () => ok({ current: { provider: 'fixture', model: 'model' }, groups: [], failures: [] })),
          list: vi.fn(async () => ok({ items: [] })),
        },
        events: {
          mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => mux.iterate(signal, onOpen),
          host: (_payload: unknown, signal: AbortSignal) => host.iterate(signal),
        },
      },
      invokeValue: vi.fn(async (_namespace: string, method: string) => method === 'describe'
        ? {
            authority: 'remote-host', localFallback: 'forbidden',
            operations: { shell: { supported: true } },
          }
        : { exitCode: 0, signal: null, stdout: 'remote-user\n', stderr: '', timedOut: false, truncated: false }),
    }
    const channel = new RemoteHostChannel(client as never, server(), workspace(), 'session-1' as never, {
      channel: localChannel() as never,
      requestApproval: vi.fn(),
      askQuestions: vi.fn(),
      locale: () => 'en',
      sessionModes: [{ id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' }],
    })

    await channel.open()
    await expect.poll(() => historyCall.mock.calls.length).toBe(2)
    channel.submit('!whoami')
    await expect.poll(() => channel.rows.some(row => row.kind === 'local-output' && row.text === 'remote-user')).toBe(true)
    const versionBeforeResync = channel.version
    reconnectHistory.resolve(ok({ events: [], hasMore: false }))
    await expect.poll(() => channel.version).toBeGreaterThan(versionBeforeResync)
    expect(channel.rows.map(row => [row.kind, row.text])).toEqual([
      ['local', '!whoami'],
      ['local-output', 'remote-user'],
    ])
    await channel.dispose()
  })
})

function workspace() {
  return {
    workspaceId: 'workspace-1', path: '/srv/project', title: 'project', sessionIds: [],
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  } as never
}

function server() {
  return { id: 'fixture-host', label: 'Laptop', sshTarget: '192.0.2.10' }
}

function localChannel() {
  return {
    commandList: [
      { name: 'help', description: 'Show help' },
      { name: 'connect', description: 'Connect to a remote machine' },
      { name: 'workspace', description: 'Manage workspaces' },
      { name: 'codex', description: 'Local Codex account', external: true },
    ],
    activityEnabled: true, contextBarEnabled: true,
    commandCompletions: (input: string) => {
      if (input.startsWith('/cod')) return [{ name: 'codex', description: 'Local Codex account', external: true, replacement: '/codex ', commandLine: '/codex' }]
      if (input.startsWith('/conn')) return [{ name: 'connect', description: 'Connect', replacement: '/connect ', commandLine: '/connect' }]
      if (input.startsWith('/workspace rem')) return [{ name: 'workspace remote', description: 'Remote workspace', replacement: '/workspace remote ', commandLine: '/workspace remote' }]
      return []
    },
  } as Record<PropertyKey, unknown>
}

function event(type: string, seq: number, data: unknown) {
  return { type, seq, time: seq + 1, data } as never
}

function history(value: never) {
  return { event: value }
}

function ok<T>(value: T) {
  return { rpcId: 'fixture', result: { ok: true as const, value } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function stream<T>() {
  const values: T[] = []
  let wake: (() => void) | undefined
  return {
    push(value: T) { values.push(value); wake?.(); wake = undefined },
    async *iterate(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<T> {
      onOpen?.()
      while (!signal.aborted) {
        if (values.length > 0) {
          yield values.shift() as T
          continue
        }
        await new Promise<void>(resolve => {
          wake = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    },
  }
}
