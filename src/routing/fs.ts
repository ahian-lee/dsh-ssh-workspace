// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { FileSystem, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { binaryWriter } from '../transport/binary-fs.ts'
import type { FsBytesWriteOutcome } from '../transport/binary-fs.ts'

interface RemoteTargetEnvelope {
  workspaceId: string
  targetKey: string
}

const PREFIX = 'dsh-ssh-workspace:'

/** Filesystem router that keeps ordinary fs tools unchanged across execution worlds. */
export class TransparentFileSystem extends FileSystem {
  static inject = ['localFs', 'remoteSshManager']

  private readonly local: FileSystem
  private readonly manager: RemoteSshManager

  constructor(ctx: Context) {
    super(ctx)
    this.local = ctx.localFs
    this.manager = ctx.remoteSshManager
  }

  override get sandboxMode() { return this.local.sandboxMode }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const route = this.manager.route(path, opts?.cwd)
    if (route.kind === 'local') return this.local.resolve(path, opts)
    const remote = await this.manager.workspaceContext(route)
    return wrapTarget(route, await remote.fs.resolve(path, opts))
  }

  override processPath(target: FsTarget): string {
    const decoded = decodeTarget(target)
    return decoded === undefined ? this.local.processPath(target) : target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return this.local.fileUrl(target)
    const route = this.manager.workspace(decoded.workspaceId)
    return `dsh-ssh-workspace://${encodeURIComponent(route.server.id)}/${encodeURIComponent(route.workspace.id)}/${encodeURIComponent(decoded.targetKey)}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentRemote = decodeTarget(parent)
    const childRemote = decodeTarget(child)
    if (parentRemote === undefined || childRemote === undefined) {
      return parentRemote === undefined && childRemote === undefined && this.local.contains(parent, child)
    }
    if (parentRemote.workspaceId !== childRemote.workspaceId) return false
    const route = this.manager.workspace(parentRemote.workspaceId)
    const parentPath = route.mapper.toRemotePath(parent.displayPath)
    const childPath = route.mapper.toRemotePath(child.displayPath)
    const rel = posix.relative(parentPath, childPath)
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const backend = await this.backend(target)
    return backend.fs.stat(backend.target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const route = this.manager.route(path, opts?.cwd)
    if (route.kind === 'local') return this.local.lstat(path, opts, signal)
    return (await this.manager.workspaceContext(route)).fs.lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const backend = await this.backend(target)
    return backend.fs.readText(backend.target, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const backend = await this.backend(target)
    return backend.fs.streamText(backend.target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const backend = await this.backend(target)
    return backend.fs.readBytes(backend.target, signal, maxBytes)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return this.local.listDir(target, signal)
    const route = this.manager.workspace(decoded.workspaceId)
    const remote = await this.manager.workspaceContext(route)
    const entries = await remote.fs.listDir(unwrapTarget(target, decoded), signal)
    return entries.map(entry => ({ ...entry, target: wrapTarget(route, entry.target) }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const backend = await this.backend(target)
    return backend.fs.writeText(backend.target, content, expected, signal, sandboxPolicy)
  }

  async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsBytesWriteOutcome> {
    const backend = await this.backend(target)
    return binaryWriter(backend.fs).writeBytes(backend.target, content, expected, signal, sandboxPolicy)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const backend = await this.backend(target)
    return backend.fs.editText(backend.target, edit, expected, signal, sandboxPolicy)
  }

  private async backend(target: FsTarget): Promise<{ fs: FileSystem; target: FsTarget }> {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return { fs: this.local, target }
    const route = this.manager.workspace(decoded.workspaceId)
    const remote = await this.manager.workspaceContext(route)
    return { fs: remote.fs, target: unwrapTarget(target, decoded) }
  }
}

function wrapTarget(route: RemoteWorkspaceRoute, target: FsTarget): FsTarget {
  const envelope: RemoteTargetEnvelope = { workspaceId: route.workspace.id, targetKey: String(target.targetKey) }
  return {
    targetKey: FsTargetKey(PREFIX + Buffer.from(JSON.stringify(envelope)).toString('base64url')),
    displayPath: target.displayPath,
  }
}

function decodeTarget(target: FsTarget): RemoteTargetEnvelope | undefined {
  const key = String(target.targetKey)
  if (!key.startsWith(PREFIX)) return undefined
  try {
    const value = JSON.parse(Buffer.from(key.slice(PREFIX.length), 'base64url').toString('utf8')) as Partial<RemoteTargetEnvelope>
    if (typeof value.workspaceId !== 'string' || typeof value.targetKey !== 'string') throw new Error('invalid fields')
    return value as RemoteTargetEnvelope
  } catch (error) {
    throw new Error(`dsh-ssh-workspace: invalid remote filesystem target '${key}'`, { cause: error })
  }
}

function unwrapTarget(target: FsTarget, decoded: RemoteTargetEnvelope): FsTarget {
  return { targetKey: FsTargetKey(decoded.targetKey), displayPath: target.displayPath }
}

export default TransparentFileSystem
