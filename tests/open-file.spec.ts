// Derived from Yan-Zero/dsh-remote-ssh; modified by ahian-lee. See NOTICE.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import type { RemoteSshManager, RemoteWorkspaceRoute } from '../src/routing/manager.ts'
import { editorLaunchArgs, findWindowsVscCli, openRemoteFile, safeDownloadedName } from '../src/ssh/open-file.ts'
import { resolveRemoteOpenWorkspace } from '../src/client/open-route.ts'
import type { Workspace } from '../src/client/api.ts'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('remote file opening', () => {
  it('builds the standard VSC Remote SSH CLI contract without a shell', () => {
    expect(editorLaunchArgs('test-host', '/srv/project/a b.txt')).toEqual([
      '--remote', 'ssh-remote+test-host', '--reuse-window', '/srv/project/a b.txt',
    ])
    expect(() => editorLaunchArgs('bad/host', '/srv/project/a.txt')).toThrow(/Host alias/)
    expect(() => editorLaunchArgs('test-host', 'relative.txt')).toThrow(/absolute/)
  })

  it('resolves the versioned Windows CLI entry instead of launching the GUI executable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'dsh-vsc-cli-'))
    cleanup.push(root)
    const executable = resolve(root, 'Code.exe')
    const cli = resolve(root, 'commit-id', 'resources', 'app', 'out', 'cli.js')
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, '')
    await expect(findWindowsVscCli(executable)).resolves.toBe(cli)
  })

  it('downloads exact bytes when native Remote SSH opening is unavailable by policy', async () => {
    const workspaceId = 'workspace-open-test'
    cleanup.push(resolve(tmpdir(), 'dsh-ssh-workspace', 'open-file', workspaceId))
    const bytes = Uint8Array.from([0x00, 0xff, 0x42])
    const route = {
      kind: 'remote',
      server: { id: 'server', label: 'Server', sshTarget: 'test-host' },
      workspace: { id: workspaceId, serverId: 'server', remotePath: '/srv/project' },
      aliasPath: 'C:\\aliases\\project',
      mapper: new WorkspacePathMapper('C:\\aliases\\project', '/srv/project'),
    } satisfies RemoteWorkspaceRoute
    const target = { targetKey: 'file:///srv/project/image.bin', displayPath: '/srv/project/image.bin' }
    const manager = {
      workspace: vi.fn(() => route),
      snapshot: vi.fn(() => ({ openFileMode: 'download', openFileDownloadMaxBytes: 1024 })),
      workspaceContext: vi.fn(async () => ({
        fs: {
          resolve: vi.fn(async () => target),
          stat: vi.fn(async () => ({ type: 'file', size: bytes.byteLength })),
          readBytes: vi.fn(async () => bytes),
        },
      })),
    } as unknown as RemoteSshManager

    const result = await openRemoteFile(manager, workspaceId, '/srv/project/image.bin')
    expect(result).toMatchObject({ kind: 'download', remotePath: '/srv/project/image.bin' })
    expect(result.localPath).toBeDefined()
    await expect(readFile(result.localPath!)).resolves.toEqual(Buffer.from(bytes))
  })

  it('routes an alias or the current remote Session without guessing another host', () => {
    const laptop: Workspace = { id: 'laptop', serverId: 'laptop', remotePath: '/home/yan/project', aliasPath: 'C:\\aliases\\laptop' }
    const cloud: Workspace = { id: 'cloud', serverId: 'cloud', remotePath: '/srv/project', aliasPath: 'C:\\aliases\\cloud' }
    const workspaces = [laptop, cloud]

    expect(resolveRemoteOpenWorkspace(workspaces, 'C:\\aliases\\laptop\\a.txt')).toBe(laptop)
    expect(resolveRemoteOpenWorkspace(workspaces, '/etc/hosts', 'C:\\aliases\\laptop')).toBe(laptop)
    expect(resolveRemoteOpenWorkspace(workspaces, '/srv/project/a.txt', 'C:\\local')).toBeUndefined()
  })

  it('keeps downloaded basenames safe and recognizable', () => {
    expect(safeDownloadedName('/tmp/report.pdf')).toBe('report.pdf')
    expect(safeDownloadedName('/tmp/CON.txt')).toBe('_CON.txt')
    expect(safeDownloadedName('/tmp/a:b?.txt')).toBe('a_b_.txt')
  })
})
