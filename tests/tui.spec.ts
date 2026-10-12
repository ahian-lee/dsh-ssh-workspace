import { describe, expect, it } from 'vitest'
import { parseSshWorkspaceUri, remoteWorkspaceCommand, resolveSshWorkspacePath, sshWorkspaceUri } from '../src/profiles/tui.ts'
import type { RemoteWorkspaceRoute } from '../src/routing/manager.ts'

describe('TUI workspace URIs', () => {
  it('parses configured-server and direct SSH targets', () => {
    expect(parseSshWorkspaceUri('ssh://devbox/srv/project')).toEqual({
      selector: 'devbox',
      sshTarget: 'devbox',
      remotePath: '/srv/project',
    })
    expect(parseSshWorkspaceUri('ssh://alice@example.com:2222/home/alice/code')).toEqual({
      selector: 'alice@example.com',
      sshTarget: 'alice@example.com',
      remotePath: '/home/alice/code',
      port: 2222,
    })
  })

  it('rejects non-SSH and rootless targets', () => {
    expect(parseSshWorkspaceUri('file:///tmp/project')).toBeUndefined()
    expect(() => parseSshWorkspaceUri('ssh:///srv/project')).toThrow(/requires a server/)
  })

  it('renders a stable URI from a configured route', () => {
    const route = {
      kind: 'remote',
      server: { id: 'devbox', label: 'Devbox', sshTarget: 'devbox' },
      workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/my project' },
    } as RemoteWorkspaceRoute
    expect(sshWorkspaceUri(route)).toBe('ssh://devbox/srv/my%20project')
  })

  it('resolves relative paths in the current remote path space', async () => {
    const route = {
      kind: 'remote',
      aliasPath: String.raw`E:\aliases\project`,
      server: { id: 'devbox', label: 'Devbox', sshTarget: 'devbox' },
      workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/project' },
      mapper: { toRemotePath: () => '/srv/project/packages/app' },
    } as unknown as RemoteWorkspaceRoute
    const nextRoute = {
      ...route,
      workspace: { id: 'packages', serverId: 'devbox', remotePath: '/srv/project/packages' },
    } as RemoteWorkspaceRoute
    const added: Array<[string, string]> = []
    const manager = {
      route: () => route,
      snapshot: () => ({ workspaces: [] }),
      addWorkspace: async (serverId: string, remotePath: string) => {
        added.push([serverId, remotePath])
        return nextRoute
      },
      workspace: () => nextRoute,
    }

    const target = await resolveSshWorkspacePath(
      manager as never,
      '..',
      String.raw`E:\aliases\project\packages\app`,
    )

    expect(added).toEqual([['devbox', '/srv/project/packages']])
    expect(target).toMatchObject({ cwd: route.aliasPath, description: '/srv/project/packages' })
  })

  it('offers device and directory choices before creating a workspace', async () => {
    const server = { id: 'picker-devbox', label: 'Picker Devbox', sshTarget: 'picker-devbox' }
    const route = {
      kind: 'remote',
      aliasPath: String.raw`E:\aliases\picked`,
      server,
      workspace: { id: 'picked', serverId: server.id, remotePath: '/home/dev/code' },
    } as RemoteWorkspaceRoute
    const added: Array<[string, string]> = []
    const manager = {
      snapshot: () => ({ servers: [server], workspaces: [] }),
      listRemoteDirectory: async (_server: unknown, path?: string) => ({
        path: path ?? '/home/dev',
        home: '/home/dev',
        parent: '/home',
        entries: [{ name: 'code', path: '/home/dev/code' }],
      }),
      addWorkspace: async (serverId: string, remotePath: string) => {
        added.push([serverId, remotePath])
        return route
      },
    }

    const devices = await remoteWorkspaceCommand(manager as never).run('picker-devbox', { cwd: process.cwd() })
    expect(devices).toMatchObject({ kind: 'choices', title: 'Remote SSH devices' })
    if (devices.kind !== 'choices') throw new Error('expected device choices')
    const directories = await devices.choices[0]?.choose()
    expect(directories).toMatchObject({ kind: 'choices', title: 'Picker Devbox · /home/dev' })
    if (directories?.kind !== 'choices') throw new Error('expected directory choices')
    expect(directories.choices[0]?.input).toMatchObject({
      initialValue: '/home/dev',
      placeholder: '/absolute/remote/path',
    })
    const typed = await directories.choices[0]?.input?.submit('/opt/project')
    expect(typed).toMatchObject({ kind: 'choices', title: 'Picker Devbox · /opt/project' })
    const child = await directories.choices.find(choice => choice.id === 'directory:/home/dev/code')?.choose()
    if (child?.kind !== 'choices') throw new Error('expected child directory choices')
    const selected = await child.choices[0]?.choose()
    expect(selected).toMatchObject({ kind: 'target', target: { cwd: route.aliasPath } })
    expect(added).toEqual([[server.id, '/home/dev/code']])
  })
})
