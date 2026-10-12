import { resolve } from 'node:path'
import { AhpErrorCodes } from '@microsoft/agent-host-protocol'
import type { AhpClient } from '@microsoft/agent-host-protocol/client'
import { RpcError } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { RemoteSshRuntime } from '../src/transport/runtime.ts'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import RemoteSshFileSystem from '../src/transport/fs.ts'
import { describe, expect, it } from 'vitest'

interface NodeEntry { type: 'file' | 'directory'; data: string | Uint8Array; etag: string }

class FakeAhp {
  readonly nodes = new Map<string, NodeEntry>([
    ['file:///srv', { type: 'directory', data: '', etag: 'd0' }],
    ['file:///srv/project', { type: 'directory', data: '', etag: 'd1' }],
    ['file:///srv/project/readme.txt', { type: 'file', data: 'hello\n', etag: 'v1' }],
    ['file:///srv/project-b', { type: 'directory', data: '', etag: 'd2' }],
  ])
  private version = 1

  async resourceResolve({ uri }: { uri: string }) {
    const node = this.nodes.get(uri)
    if (node === undefined) throw new RpcError(AhpErrorCodes.NotFound, 'missing')
    return { uri, type: node.type, size: Buffer.byteLength(node.data), etag: node.etag }
  }

  async resourceRead({ uri }: { uri: string }) {
    const node = this.nodes.get(uri)
    if (node === undefined) throw new RpcError(AhpErrorCodes.NotFound, 'missing')
    return { data: Buffer.from(node.data).toString('base64'), encoding: 'base64' }
  }

  async resourceWrite(params: { uri: string; data: string; encoding: string; createOnly?: boolean; ifMatch?: string }) {
    const old = this.nodes.get(params.uri)
    if (params.createOnly === true && old !== undefined) throw new RpcError(AhpErrorCodes.AlreadyExists, 'exists')
    if (params.ifMatch !== undefined && old?.etag !== params.ifMatch) throw new RpcError(AhpErrorCodes.Conflict, 'stale')
    const data = params.encoding === 'base64' ? Buffer.from(params.data, 'base64') : params.data
    this.nodes.set(params.uri, { type: 'file', data, etag: `v${++this.version}` })
    return {}
  }

  async resourceList({ uri }: { uri: string }) {
    const prefix = `${uri}/`
    const entries = [...this.nodes].flatMap(([childUri, node]) => {
      if (!childUri.startsWith(prefix) || childUri.slice(prefix.length).includes('/')) return []
      return [{ name: decodeURIComponent(childUri.slice(prefix.length)), type: node.type, size: Buffer.byteLength(node.data) }]
    })
    return { entries }
  }
}

async function setup() {
  const ctx = new Context()
  const client = new FakeAhp()
  const local = resolve('tests', 'remote-alias')
  const runtime = {
    mapper: new WorkspacePathMapper(local, '/srv/project'),
    getClient: async () => client as unknown as AhpClient,
  } as unknown as RemoteSshRuntime
  ctx.provide('remoteSsh', runtime)
  await ctx.plugin(RemoteSshFileSystem, { diffBasisMaxBytes: 1024, maxReadBytes: 4096 })
  return { ctx, fs: ctx.fs as RemoteSshFileSystem, client, local }
}

describe('RemoteSshFileSystem', () => {
  it('resolves through AHP while keeping the local alias out of display paths', async () => {
    const { ctx, fs, local } = await setup()
    const target = await fs.resolve('readme.txt', { cwd: local })
    expect(String(target.targetKey)).toBe('file:///srv/project/readme.txt')
    expect(target.displayPath).toBe('/srv/project/readme.txt')
    expect(target.displayPath).not.toContain(local)
    await expect(fs.readText(target)).resolves.toBe('hello\n')
  })

  it('creates, guarded-replaces, edits, and rejects a stale version', async () => {
    const { ctx, fs, local } = await setup()
    const target = await fs.resolve('new.txt', { cwd: local })
    const created = await fs.writeText(target, 'alpha\n', { kind: 'createIfAbsent' })
    expect(created.operation).toBe('create')
    const replaced = await fs.writeText(target, 'beta\n', { kind: 'replaceIfVersion', version: created.version })
    expect(replaced.operation).toBe('update')
    await expect(fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: FsVersion('stale') }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    const edited = await fs.editText(target, { oldString: 'beta', newString: 'gamma', replaceAll: false }, { version: replaced.version })
    expect(edited.after).toBe('gamma\n')
    await expect(fs.readText(target)).resolves.toBe('gamma\n')
  })

  it('publishes exact binary bytes through AHP base64 transport', async () => {
    const { fs, client, local } = await setup()
    const content = Uint8Array.from([0x00, 0xff, 0x42])
    const target = await fs.resolve('asset.bin', { cwd: local })
    const outcome = await fs.writeBytes(target, content, { kind: 'createIfAbsent' })

    expect(outcome).toMatchObject({ operation: 'create', bytes: content.byteLength })
    expect(client.nodes.get('file:///srv/project/asset.bin')?.data).toEqual(Buffer.from(content))
  })

  it('enforces read-only mutation policy before issuing AHP writes', async () => {
    const { ctx, fs, client, local } = await setup()
    const target = await fs.resolve('readme.txt', { cwd: local })
    await expect(fs.writeText(target, 'blocked', undefined, undefined, {
      mode: 'read-only', workspaceRoot: local,
    })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.writeBytes(target, Uint8Array.from([0xff]), undefined, undefined, {
      mode: 'read-only', workspaceRoot: local,
    })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(client.nodes.get('file:///srv/project/readme.txt')?.data).toBe('hello\n')
  })

  it('allows cross-workspace writes only under danger-full-access', async () => {
    const { ctx, fs, local } = await setup()
    const allowed = await fs.resolve('/srv/project-b/full-access.txt', { cwd: local })
    await expect(fs.writeText(allowed, 'shared host\n', { kind: 'createIfAbsent' }, undefined, {
      mode: 'danger-full-access', workspaceRoot: local,
    })).resolves.toMatchObject({ operation: 'create' })

    const denied = await fs.resolve('/srv/project-b/workspace-write.txt', { cwd: local })
    await expect(fs.writeText(denied, 'blocked\n', { kind: 'createIfAbsent' }, undefined, {
      mode: 'workspace-write', workspaceRoot: local,
    })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await ctx.fiber.dispose()
  })
})
