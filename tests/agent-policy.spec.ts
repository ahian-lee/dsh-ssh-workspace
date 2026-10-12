import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import applyAgentPolicy, { installRemoteWorkspacePrompt, presentRemoteShellCall, remoteShellPresentation } from '../src/routing/agent-policy.ts'
import type { RemoteWorkspaceRoute } from '../src/routing/manager.ts'

const route = {
  kind: 'remote',
  server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
  workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/project' },
} as RemoteWorkspaceRoute

describe('remote shell presentation', () => {
  it('defers an existing Agent until both global shell tools are registered', () => {
    const globals = new Map<string, ToolDefinition>()
    let toolsChange = (): void => {}
    let bindCalls = 0
    let restricted: unknown
    const agent = {
      session: { header: { id: 'session-1', cwd: String.raw`E:\workspace` } },
      ctx: {
        tools: {
          restrict: (filter: unknown) => { restricted = filter },
          register: () => {},
        },
      },
    }
    const ctx = {
      remoteSshManager: {
        dialectFor: () => 'bash',
        bindSession: () => { bindCalls += 1; return { kind: 'local' } },
        unbindSession: () => {},
      },
      tools: { get: (name: string) => globals.get(name) },
      agents: { list: () => [agent] },
      on: (event: string, listener: (...args: never[]) => unknown) => {
        if (event === 'tools/change') toolsChange = listener as () => void
        return () => {}
      },
    }

    applyAgentPolicy(ctx as never)
    expect(bindCalls).toBe(0)
    expect(restricted).toBeUndefined()

    globals.set('bash', { name: 'bash' } as ToolDefinition)
    toolsChange()
    expect(bindCalls).toBe(0)

    globals.set('pwsh', { name: 'pwsh' } as ToolDefinition)
    toolsChange()
    expect(bindCalls).toBe(1)
    expect(restricted).toEqual({ deny: ['pwsh'] })

    toolsChange()
    expect(bindCalls).toBe(1)
  })

  it('publishes only the remote cwd to the scoped System Prompt', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'Your working directory is {{cwd}}.' })
    ctx.systemPrompt.variable('cwd', () => String.raw`C:\host-only\workspace-alias`)
    let remoteScope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => {
      remoteScope = createScope(inner, { name: 'remote-agent' })
    }, { inject: ['systemPrompt'] }))

    installRemoteWorkspacePrompt(remoteScope.ctx, route)
    const key = scopeOf(remoteScope.ctx)
    if (key === undefined) throw new Error('test scope has no scope key')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))

    expect(prompt).toContain('Your working directory is /srv/project.')
    expect(prompt).toContain('This session runs in a Remote SSH workspace.')
    expect(prompt).not.toContain('host-only')
    expect(prompt).not.toContain('workspace-alias')
    await remoteScope.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the official Bash contract and changes only its displayed cwd', () => {
    const base = defineTool({
      name: 'bash',
      description: 'Official Bash contract.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
        timeoutMs: { type: 'number' },
        workdir: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'ok',
      presentCall: args => ({
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...args.workdir === undefined ? {} : { cwd: args.workdir },
      }),
      presentResult: () => ({ card: 'terminal', output: 'ok', exitCode: 0 }),
    })
    const manager = {
      displayRemoteCwd: (_route: RemoteWorkspaceRoute, workdir?: string) => workdir ?? '/srv/project',
    }
    const wrapped = remoteShellPresentation(base, manager as never, route)

    expect(wrapped.parameters).toBe(base.parameters)
    expect(wrapped.execute).toBe(base.execute)
    expect(wrapped.output).toBe(base.output)
    expect(wrapped.presentResult).toBe(base.presentResult)
    expect(wrapped.presentCall?.({
      command: 'pnpm audit',
      description: 'Audit package dependencies for vulnerabilities',
      timeoutMs: 30_000,
      workdir: '/srv/project/app',
      run_in_background: false,
    })).toEqual({
      card: 'terminal',
      title: 'pnpm audit',
      description: 'Audit package dependencies for vulnerabilities',
      cwd: '/srv/project/app',
    })
  })

  it('replaces the internal session cwd with a logical workspace path', () => {
    const manager = {
      displayRemoteCwd: (_route: RemoteWorkspaceRoute, workdir?: string) => workdir === undefined
        ? '/Devbox > project'
        : `/Devbox > project/${workdir.split('/').at(-1)}`,
    }
    const terminal: ToolCallView = { card: 'terminal', title: 'pwd' }

    expect(presentRemoteShellCall(terminal, { workdir: '/srv/project/coffee' }, manager, route)).toEqual({
      card: 'terminal',
      title: 'pwd',
      cwd: '/Devbox > project/coffee',
    })
    expect(presentRemoteShellCall(terminal, {}, manager, route)).toEqual({
      card: 'terminal',
      title: 'pwd',
      cwd: '/Devbox > project',
    })
  })

  it('leaves non-terminal background cards unchanged', () => {
    const view: ToolCallView = { card: 'generic', title: 'sleep 10' }
    expect(presentRemoteShellCall(view, {}, { displayRemoteCwd: () => '/unused' }, route)).toBe(view)
  })
})
