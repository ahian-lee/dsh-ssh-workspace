// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { posix } from 'node:path'
import type { ContentEncoding, ResourceResolveResult } from '@microsoft/agent-host-protocol'
import { AhpErrorCodes } from '@microsoft/agent-host-protocol'
import { RpcError } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { FsBytesWriteOutcome } from './binary-fs.ts'
import type { RemoteSshRuntime } from './runtime.ts'
import { fileUriFromPosixPath, posixPathFromFileUri, WorkspacePathMapper } from './runtime.ts'

export interface Config {
  diffBasisMaxBytes?: number
  maxReadBytes?: number
  localWorkspace?: string
  remoteWorkspace?: string
}

interface ResolvedConfig extends Config {
  diffBasisMaxBytes: number
  maxReadBytes: number
}

interface Probe {
  resolved: ResourceResolveResult
  version: ReturnType<typeof FsVersion>
}

const BASE64 = 'base64' as ContentEncoding
const UTF8 = 'utf-8' as ContentEncoding

export class RemoteSshFileSystem extends FileSystem {
  static inject = ['remoteSsh']
  static Config: z<Config> = z.object({
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
    maxReadBytes: z.number().default(64 * 1024 * 1024),
    localWorkspace: z.string(),
    remoteWorkspace: z.string(),
  })

  readonly config: ResolvedConfig
  private readonly remote: RemoteSshRuntime
  private readonly mapper: WorkspacePathMapper
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.remote = ctx.remoteSsh
    this.config = config as ResolvedConfig
    if ((config.localWorkspace === undefined) !== (config.remoteWorkspace === undefined)) {
      throw new Error('dsh-ssh-workspace/fs: localWorkspace and remoteWorkspace must be configured together')
    }
    this.mapper = config.localWorkspace !== undefined && config.remoteWorkspace !== undefined
      ? new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace)
      : requireRuntimeMapper(this.remote)
    for (const [name, value] of Object.entries({ diffBasisMaxBytes: this.config.diffBasisMaxBytes, maxReadBytes: this.config.maxReadBytes })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`dsh-ssh-workspace/fs: ${name} must be a positive integer`)
      }
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    throwIfAborted(opts?.signal, 'resolve')
    let candidate: string
    try {
      candidate = this.mapper.toRemotePath(path, opts?.cwd)
    } catch (error: unknown) {
      throw new FsError(errorMessage(error), 'FS_NOT_FOUND', { cause: error })
    }
    const missing: string[] = []
    let cursor = candidate
    for (;;) {
      throwIfAborted(opts?.signal, 'resolve')
      try {
        const resolved = await this.resolveUri(fileUriFromPosixPath(cursor), true)
        const canonical = posixPathFromFileUri(resolved.uri)
        const remotePath = missing.reduceRight((base, part) => posix.join(base, part), canonical)
        return this.target(remotePath)
      } catch (error: unknown) {
        if (!isNotFound(error)) throw mapFsError('resolve', candidate, error)
        const parent = posix.dirname(cursor)
        if (parent === cursor) throw mapFsError('resolve', candidate, error)
        missing.push(posix.basename(cursor))
        cursor = parent
      }
    }
  }

  override processPath(target: FsTarget): string {
    return posixPathFromFileUri(String(target.targetKey))
  }

  override fileUrl(target: FsTarget): string {
    return String(target.targetKey)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = posix.relative(this.processPath(parent), this.processPath(child))
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    throwIfAborted(signal, 'stat')
    const probe = await this.probe(target, true)
    throwIfAborted(signal, 'stat')
    if (probe === undefined) return undefined
    return {
      version: probe.version,
      type: resourceType(probe.resolved.type),
      ...(probe.resolved.size !== undefined ? { size: probe.resolved.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    throwIfAborted(signal, 'lstat')
    let remotePath: string
    try {
      remotePath = this.mapper.toRemotePath(path, opts?.cwd)
    } catch (error: unknown) {
      throw new FsError(errorMessage(error), 'FS_NOT_FOUND', { cause: error })
    }
    try {
      const resolved = await this.resolveUri(fileUriFromPosixPath(remotePath), false)
      throwIfAborted(signal, 'lstat')
      return {
        version: versionOf(resolved),
        type: resolved.type === 'symlink' ? 'symlink' : resourceType(resolved.type),
        ...(resolved.size !== undefined ? { size: resolved.size } : {}),
      }
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapFsError('lstat', remotePath, error)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readBytes(target, signal, this.config.maxReadBytes)
    return decodeText(bytes, target.displayPath)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return (async function* (): AsyncIterable<string> {
      let offset = 0
      while (offset < text.length) {
        throwIfAborted(signal, 'read')
        let end = Math.min(text.length, offset + 64 * 1024)
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1
        yield text.slice(offset, end)
        offset = end
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FsError('maxBytes must be a non-negative integer', 'FS_TOO_LARGE')
    throwIfAborted(signal, 'read')
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": file not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    }
    try {
      const client = await this.remote.getClient()
      const result = await client.resourceRead({ uri: this.fileUrl(target), encoding: BASE64 })
      throwIfAborted(signal, 'read')
      const bytes = result.encoding === BASE64
        ? Buffer.from(result.data, 'base64')
        : Buffer.from(result.data, 'utf8')
      if (bytes.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return bytes
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw mapFsError('read', target.displayPath, error)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    throwIfAborted(signal, 'list')
    try {
      const client = await this.remote.getClient()
      const listed = await client.resourceList({ uri: this.fileUrl(target) })
      const entries: FsDirEntry[] = []
      for (const entry of listed.entries.sort((a, b) => a.name.localeCompare(b.name))) {
        throwIfAborted(signal, 'list')
        const child = await this.resolve(posix.join(this.processPath(target), entry.name), signal === undefined ? undefined : { signal })
        const info = await this.stat(child, signal)
        entries.push({
          name: entry.name,
          type: info?.type ?? entry.type,
          target: child,
          ...(info?.version !== undefined ? { version: info.version } : {}),
          ...(info?.size !== undefined ? { size: info.size } : {}),
        })
      }
      return entries
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw mapFsError('list', target.displayPath, error)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    assertMutationAllowed(this.mapper, target, sandboxPolicy)
    return this.withLock(String(target.targetKey), async () => {
      throwIfAborted(signal, 'write')
      const existing = await this.probe(target, true)
      if (existing !== undefined && resourceType(existing.resolved.type) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined || existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      let before: string | null = null
      if (existing !== undefined
        && (existing.resolved.size ?? this.config.diffBasisMaxBytes) < this.config.diffBasisMaxBytes
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes) {
        try { before = normalizeLineEndings(await this.readText(target, signal)) } catch { before = null }
      }
      try {
        const client = await this.remote.getClient()
        await client.resourceWrite({
          uri: this.fileUrl(target),
          data: content,
          encoding: UTF8,
          contentType: 'text/plain; charset=utf-8',
          ...(expected?.kind === 'createIfAbsent' ? { createOnly: true } : {}),
          ...(expected?.kind === 'replaceIfVersion' && existing?.resolved.etag !== undefined
            ? { ifMatch: existing.resolved.etag }
            : {}),
        })
      } catch (error: unknown) {
        if (error instanceof RpcError && error.code === AhpErrorCodes.AlreadyExists) {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED', { cause: error })
        }
        throw mapFsError('write', target.displayPath, error)
      }
      throwIfAborted(signal, 'write')
      const after = await this.probe(target, true)
      if (after === undefined) throw new FsError(`write did not publish "${target.displayPath}"`, 'FS_IO_ERROR')
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: after.version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsBytesWriteOutcome> {
    assertMutationAllowed(this.mapper, target, sandboxPolicy)
    return this.withLock(String(target.targetKey), async () => {
      throwIfAborted(signal, 'write')
      const existing = await this.probe(target, true)
      if (existing !== undefined && resourceType(existing.resolved.type) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined || existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      try {
        const client = await this.remote.getClient()
        await client.resourceWrite({
          uri: this.fileUrl(target),
          data: Buffer.from(content).toString('base64'),
          encoding: BASE64,
          contentType: 'application/octet-stream',
          ...(expected?.kind === 'createIfAbsent' ? { createOnly: true } : {}),
          ...(expected?.kind === 'replaceIfVersion' && existing?.resolved.etag !== undefined
            ? { ifMatch: existing.resolved.etag }
            : {}),
        })
      } catch (error: unknown) {
        if (error instanceof RpcError && error.code === AhpErrorCodes.AlreadyExists) {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED', { cause: error })
        }
        throw mapFsError('write', target.displayPath, error)
      }
      throwIfAborted(signal, 'write')
      const after = await this.probe(target, true)
      if (after === undefined) throw new FsError(`write did not publish "${target.displayPath}"`, 'FS_IO_ERROR')
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: after.version,
        bytes: content.byteLength,
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    assertMutationAllowed(this.mapper, target, sandboxPolicy)
    return this.withLock(String(target.targetKey), async () => {
      throwIfAborted(signal, 'edit')
      const existing = await this.probe(target, true)
      if (existing === undefined || (expected !== undefined && existing.version !== expected.version)) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (resourceType(existing.resolved.type) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      const stored = await this.readText(target, signal)
      const before = normalizeLineEndings(stored)
      const oldString = normalizeLineEndings(edit.oldString)
      if (oldString.length === 0) throw new FsError('old_string must be non-empty', 'FS_EDIT_NOT_FOUND')
      const count = countOccurrences(before, oldString)
      if (count === 0) throw new FsError(`old_string was not found in "${target.displayPath}"`, 'FS_EDIT_NOT_FOUND')
      if (!edit.replaceAll && count !== 1) {
        throw new FsError(`old_string appears ${count} times in "${target.displayPath}"`, 'FS_AMBIGUOUS_EDIT')
      }
      const normalizedAfter = edit.replaceAll
        ? before.split(oldString).join(normalizeLineEndings(edit.newString))
        : before.replace(oldString, normalizeLineEndings(edit.newString))
      const afterStorage = usesCrlf(stored) ? normalizedAfter.replaceAll('\n', '\r\n') : normalizedAfter
      try {
        const client = await this.remote.getClient()
        await client.resourceWrite({
          uri: this.fileUrl(target),
          data: afterStorage,
          encoding: UTF8,
          contentType: 'text/plain; charset=utf-8',
          ...(existing.resolved.etag !== undefined ? { ifMatch: existing.resolved.etag } : {}),
        })
      } catch (error: unknown) {
        throw mapFsError('edit', target.displayPath, error)
      }
      throwIfAborted(signal, 'edit')
      const afterProbe = await this.probe(target, true)
      if (afterProbe === undefined) throw new FsError(`edit did not publish "${target.displayPath}"`, 'FS_IO_ERROR')
      return { version: afterProbe.version, before, after: normalizedAfter }
    })
  }

  private target(remotePath: string): FsTarget {
    const uri = fileUriFromPosixPath(remotePath)
    return {
      targetKey: FsTargetKey(uri),
      displayPath: posix.normalize(remotePath),
    }
  }

  private async resolveUri(uri: string, followSymlinks: boolean): Promise<ResourceResolveResult> {
    const client = await this.remote.getClient()
    return client.resourceResolve({ uri, followSymlinks })
  }

  private async probe(target: FsTarget, followSymlinks: boolean): Promise<Probe | undefined> {
    try {
      const resolved = await this.resolveUri(this.fileUrl(target), followSymlinks)
      return { resolved, version: versionOf(resolved) }
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapFsError('stat', target.displayPath, error)
    }
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(key, tail)
    try { return await run } finally { if (this.locks.get(key) === tail) this.locks.delete(key) }
  }
}

function assertMutationAllowed(mapper: WorkspacePathMapper, target: FsTarget, policy: SandboxExecutionPolicy | undefined): void {
  if (policy === undefined || policy.mode === 'danger-full-access') return
  if (policy.mode === 'read-only') {
    throw new FsError(`remote mutation denied for \"${target.displayPath}\" by read-only mode`, 'FS_SANDBOX_DENIED')
  }
  const workspace = mapper.toRemotePath(policy.workspaceRoot)
  const path = posixPathFromFileUri(String(target.targetKey))
  const rel = posix.relative(workspace, path)
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) {
    throw new FsError(`remote mutation denied outside workspace: \"${target.displayPath}\"`, 'FS_SANDBOX_DENIED')
  }
}

function requireRuntimeMapper(remote: RemoteSshRuntime): WorkspacePathMapper {
  if (remote.mapper !== undefined) return remote.mapper
  try { return remote.getMapper() } catch (error: unknown) {
    throw new Error('dsh-ssh-workspace/fs: a workspace mapping is required when the shared host runtime has no default mapper', { cause: error })
  }
}

function versionOf(result: ResourceResolveResult): ReturnType<typeof FsVersion> {
  return FsVersion(result.etag ?? JSON.stringify([result.uri, result.type, result.size, result.mtime, result.ctime]))
}

function resourceType(type: ResourceResolveResult['type']): 'file' | 'directory' | 'other' {
  if (type === 'file') return 'file'
  if (type === 'directory') return 'directory'
  return 'other'
}

function isNotFound(error: unknown): boolean {
  return error instanceof RpcError && error.code === AhpErrorCodes.NotFound
}

function mapFsError(operation: string, path: string, error: unknown): FsError {
  if (error instanceof FsError) return error
  if (error instanceof RpcError) {
    if (error.code === AhpErrorCodes.NotFound) return new FsError(`${operation} failed for "${path}": not found`, 'FS_NOT_FOUND', { cause: error })
    if (error.code === AhpErrorCodes.PermissionDenied) return new FsError(`${operation} denied for "${path}"`, 'FS_PERMISSION_DENIED', { cause: error })
    if (error.code === AhpErrorCodes.Conflict) return new FsError(`${operation} failed for "${path}": file changed`, 'FS_STALE_VERSION', { cause: error })
  }
  return new FsError(`${operation} failed for "${path}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: signal.reason })
}

function decodeText(bytes: Uint8Array, path: string): string {
  if (bytes.includes(0)) throw new FsError(`cannot read "${path}": file contains NUL bytes`, 'FS_NOT_TEXT')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error: unknown) {
    throw new FsError(`cannot read "${path}": file is not valid UTF-8`, 'FS_NOT_TEXT', { cause: error })
  }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function usesCrlf(value: string): boolean {
  return value.includes('\r\n') && !value.replaceAll('\r\n', '').includes('\n')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let offset = 0
  while ((offset = haystack.indexOf(needle, offset)) !== -1) { count += 1; offset += needle.length }
  return count
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default RemoteSshFileSystem
