import { describe, expect, it, vi } from 'vitest'
import type { TuiBackendCommandRequest, TuiBackendHost } from '@deepseek-harness-tui/dsh-tui/backends'
import { RemoteSshTuiBackendController, serverFromSshCommand } from '../src/tui/backend-controller.ts'

describe('TUI remote Host control plane', () => {
  it('selects a Host directory, switches the stable channel, and restores local on disconnect', async () => {
    const server = { id: 'control-plane-fixture', label: 'Control Plane Fixture', sshTarget: 'control-plane-fixture' }
    const workspace = {
      workspaceId: 'workspace-1',
      path: '/srv/project',
      title: 'project',
      sessionIds: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    const api = {
      host: {
        describe: vi.fn(async () => ({ rpcId: 'describe', result: { ok: true, value: {
          version: 'fixture', cwd: '/srv', attachedSessions: 0, canOpenPath: false,
        } } })),
        listDirectory: vi.fn(async () => ({ rpcId: 'list', result: { ok: true, value: {
          path: '/srv/project', home: '/home/fixture',
          crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'srv', path: '/srv', hidden: false }, { name: 'project', path: '/srv/project', hidden: false }],
          entries: [{ name: 'src', path: '/srv/project/src', hidden: false }], truncated: false,
        } } })),
      },
      workspace: {
        create: vi.fn(async () => ({ rpcId: 'workspace', result: { ok: true, value: { workspace, created: true } } })),
      },
    }
    const manager = {
      snapshot: () => ({
        servers: [server], workspaces: [], sshConfigFile: String.raw`E:\missing-control-plane-ssh-config`,
      }),
      connectBackend: vi.fn(async () => ({ describeProtocol: async () => ({ protocol: 'dsh-host' }) })),
      connectBackendClient: vi.fn(async () => ({ api })),
      watchBackendProgress: vi.fn((_server: unknown, listener: (progress: { stage: string }) => void) => {
        listener({ stage: 'connecting' })
        listener({ stage: 'uploading-host' })
        return vi.fn()
      }),
    }
    const controller = new RemoteSshTuiBackendController(manager as never)
    const local = channel('local')
    const remote = channel('remote')
    const adapter = controller.attach({
      channel: local,
      askQuestions: vi.fn(),
      requestApproval: vi.fn(),
      locale: () => 'zh',
      sessionModes: [],
    } as unknown as TuiBackendHost)
    const disposeRemote = vi.fn()
    const attach = vi.fn(async () => ({ channel: remote, dispose: disposeRemote }))
    controller.registerFactory({ attach })
    let presented: any
    const request = {
      channel: adapter.channel,
      name: 'connect',
      input: '',
      present: (result: unknown) => { presented = result },
    } as TuiBackendCommandRequest

    await expect(controller.connect(request)).resolves.toBe(true)
    expect(presented).toMatchObject({ kind: 'choices', title: 'Remote DSH Hosts' })
    const progress: string[] = []
    const directories = await presented.choices[0].choose(undefined, (item: { label: string }) => { progress.push(item.label) })
    expect(directories).toMatchObject({ kind: 'choices', title: 'Control Plane Fixture · /srv/project' })
    expect(progress).toEqual(['正在连接 Host…', '正在上传 Host…', '正在读取目录…'])
    const selected = await directories.choices[0].choose()
    expect(selected).toMatchObject({
      kind: 'target',
      target: { badge: 'control-plane-fixture', cwd: '/srv/project' },
    })

    const proxy = adapter.channel as unknown as ReturnType<typeof channel>
    await expect(proxy.switchWorkspace(selected.target)).resolves.toBe(true)
    expect(proxy.agentId).toBe('remote')
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ server, workspace }))

    expect((adapter.handleCommand as (request: TuiBackendCommandRequest) => boolean)({
      ...request,
      name: 'disconnect',
      input: '',
    })).toBe(true)
    await expect.poll(() => proxy.agentId).toBe('local')

    expect(disposeRemote).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('accepts an ordinary ssh command without persisting another server', () => {
    expect(serverFromSshCommand('ssh -i "C:/Keys/My Key.pem" -p 2200 yan@host.example')).toMatchObject({
      label: 'yan@host.example',
      sshTarget: 'yan@host.example',
      sshArgs: ['-i', 'C:/Keys/My Key.pem', '-p', '2200'],
    })
    expect(() => serverFromSshCommand('host.example')).toThrow(/must start with ssh/)
  })
})

function channel(agentId: string) {
  return {
    agentId,
    subscribe: () => () => {},
    switchWorkspace: async (_target: unknown) => false,
    pushLocal: () => {},
    notify: () => {},
  }
}
