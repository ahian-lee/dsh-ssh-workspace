// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { FileSystem, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Result returned after a complete binary file is atomically published. */
export interface FsBytesWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
  bytes: number
}

/** Runtime view of a filesystem implementing the pending upstream binary-write API. */
export type BinaryWritableFileSystem = FileSystem & {
  writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsBytesWriteOutcome>
}

/** Require binary publication without falling back to a host path or subprocess. */
export function binaryWriter(fs: FileSystem): BinaryWritableFileSystem {
  if (typeof (fs as Partial<BinaryWritableFileSystem>).writeBytes !== 'function') {
    throw new Error('filesystem backend does not implement writeBytes')
  }
  return fs as BinaryWritableFileSystem
}
