import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import RemoteSshManager from '../src/routing/manager.ts'
import { describe, expect, it } from 'vitest'

class MemorySettings extends SettingsProvider {
  private storedDocument: Record<string, unknown> = {}

  get writable(): boolean { return true }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument = { ...this.storedDocument, [namespace]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings).await()
  return ctx
}

describe('RemoteSshManager', () => {
  it('persists remote open preferences atomically with safe defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root })
      const manager = ctx.remoteSshManager
      expect(manager.snapshot()).toMatchObject({
        openFileMode: 'auto',
        openFileDownloadMaxBytes: 64 * 1024 * 1024,
      })

      const editor = resolve(root, 'Editor.exe')
      await manager.updateUserPreferences({
        sshConfigFile: resolve(root, 'ssh-config'),
        openFileMode: 'custom',
        openFileEditorPath: editor,
      })
      expect(manager.snapshot()).toMatchObject({
        sshConfigFile: resolve(root, 'ssh-config'),
        openFileMode: 'custom',
        openFileEditorPath: editor,
      })
      await manager.updateUserPreferences({ openFileMode: 'download', openFileEditorPath: '' })
      expect(manager.snapshot().openFileEditorPath).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects a remote execution world from the workspace alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const alias = resolve(root, 'project')
      const route = ctx.remoteSshManager.route('src/index.ts', alias)
      expect(route).toMatchObject({
        kind: 'remote',
        aliasPath: alias,
        server: { id: 'devbox', label: 'Devbox' },
        workspace: { id: 'project', remotePath: '/srv/project' },
      })
      expect(ctx.remoteSshManager.route(resolve(root, '..', 'local'), resolve(root, '..', 'local'))).toEqual({ kind: 'local' })
      const renamed = await ctx.remoteSshManager.renameWorkspace('project', 'Backend')
      expect(renamed.workspace.title).toBe('Backend')
      expect(ctx.remoteSshManager.snapshot().workspaces[0]?.title).toBe('Backend')
      expect(ctx.remoteSshManager.displayRemoteCwd(renamed)).toBe('/Backend')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps explicit POSIX workdirs in the session-bound remote world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      const owner = {}
      manager.bindSession('remote-session', owner, resolve(root, 'project'))

      expect(manager.sessionRoute('remote-session')).toMatchObject({
        kind: 'remote',
        workspace: { id: 'project' },
      })

      expect(manager.routeShell('/srv/project/coffee', 'remote-session')).toMatchObject({
        kind: 'remote',
        workspace: { id: 'project' },
      })
      expect(manager.route(undefined, '/srv/project/coffee')).toMatchObject({
        kind: 'remote',
        workspace: { id: 'project' },
      })

      const otherOwner = {}
      manager.unbindSession('remote-session', otherOwner)
      expect(manager.routeShell('/outside', 'remote-session')).toMatchObject({ kind: 'remote' })
      manager.unbindSession('remote-session', owner)
      expect(manager.sessionRoute('remote-session')).toBeUndefined()
      expect(manager.routeShell('/outside', 'remote-session')).toEqual({ kind: 'local' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let a remote-looking workdir escape a session-bound local world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      manager.bindSession('local-session', {}, resolve(root, '..', 'local'))
      expect(manager.sessionRoute('local-session')).toEqual({ kind: 'local' })
      expect(manager.routeShell('/srv/project', 'local-session')).toEqual({ kind: 'local' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders logical remote cwd labels without exposing the alias directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      const route = manager.workspace('project')
      expect(manager.displayRemoteCwd(route)).toBe('/Devbox > project')
      expect(manager.displayRemoteCwd(route, '/srv/project/coffee')).toBe('/Devbox > project/coffee')
      expect(manager.displayRemoteCwd(route, '/var/log')).toBe('/Devbox > remote/var/log')
      expect(manager.dialectFor(route.aliasPath)).toBe('bash')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects workspaces that refer to an absent server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await expect(ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [],
        workspaces: [{ id: 'project', serverId: 'missing', remotePath: '/srv/project' }],
      })).rejects.toThrow(/unknown server 'missing'/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tombstones removed aliases so stale sessions stay readable but cannot execute locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      const alias = resolve(root, 'project')
      await manager.removeWorkspace('project')

      expect((await stat(alias)).isDirectory()).toBe(true)
      expect(manager.snapshot().workspaces).toEqual([])
      expect(() => manager.workspace('project')).toThrow(/unknown or removed remote workspace/)
      expect(() => manager.route('README.md', alias)).toThrow(/workspace alias is no longer configured/)
      expect(() => manager.route(resolve(alias, 'README.md'))).toThrow(/workspace alias is no longer configured/)
      expect(() => manager.routeShell('/srv/project', 'stale-session')).not.toThrow()

      manager.bindSession('removed-session', {}, alias)
      expect(() => manager.routeShell('/srv/project', 'removed-session')).toThrow(/workspace alias is no longer configured/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shares one host runtime across multiple workspaces on the same server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [
          { id: 'project-a', serverId: 'devbox', remotePath: '/srv/project-a' },
          { id: 'project-b', serverId: 'devbox', remotePath: '/srv/project-b' },
        ],
      })
      const manager = ctx.remoteSshManager
      const hostCtx = new Context()
      const sharedRemote = { marker: 'shared-host-runtime' }
      let creations = 0
      ;(manager as unknown as { createHostContext(server: unknown): Promise<unknown> }).createHostContext = async () => {
        creations += 1
        return {
          ctx: hostCtx,
          remote: sharedRemote,
          key: JSON.stringify(['test-devbox', [], 'code', null]),
          server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
          transport: { executable: 'ssh', args: [], multiplexed: false },
        }
      }

      const a = await manager.workspaceContext(manager.workspace('project-a'))
      const b = await manager.workspaceContext(manager.workspace('project-b'))

      expect(creations).toBe(1)
      expect(a.remote).toBe(sharedRemote)
      expect(b.remote).toBe(sharedRemote)
      expect(a.fs).not.toBe(b.fs)

      await manager.removeWorkspace('project-a')
      const stillShared = await manager.workspaceContext(manager.workspace('project-b'))
      expect(creations).toBe(1)
      expect(stillShared.remote).toBe(sharedRemote)
      expect(() => manager.route(undefined, resolve(root, 'project-a'))).toThrow(/no longer configured/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists only remote directories from the shared AHP host connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-workspace-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [],
      })
      const manager = ctx.remoteSshManager
      const hostCtx = new Context()
      const requestedUris: string[] = []
      const remote = {
        getConnection: async () => ({
          defaultDirectory: 'file:///home/tester',
          client: {
            resourceList: async ({ uri }: { uri: string }) => {
              requestedUris.push(uri)
              return { entries: [{ name: 'projects', type: 'directory' }, { name: 'notes.txt', type: 'file' }, { name: 'archive', type: 'directory' }] }
            },
          },
        }),
      }
      ;(manager as unknown as { createHostContext(server: unknown): Promise<unknown> }).createHostContext = async server => ({
        ctx: hostCtx,
        remote,
        key: JSON.stringify(['test-devbox', [], 'code', null]),
        server,
        transport: { executable: 'ssh', args: [], multiplexed: false },
      })

      const server = manager.snapshot().servers[0]!
      await expect(manager.listRemoteDirectory(server)).resolves.toEqual({
        path: '/home/tester',
        home: '/home/tester',
        parent: '/home',
        entries: [
          { name: 'archive', path: '/home/tester/archive' },
          { name: 'projects', path: '/home/tester/projects' },
        ],
      })
      expect(requestedUris).toEqual(['file:///home/tester'])
      await expect(manager.listRemoteDirectory(server, 'relative/path')).rejects.toThrow(/absolute POSIX path/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
