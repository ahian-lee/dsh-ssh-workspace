// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    localShell: ShellExecutor
    localFs: FileSystem
    localSpillStore: SpillStore
    localSubprocess: SubprocessRuntime
  }
}

/** Capture isolated local providers under names the root routers can consume. */
export const name = 'remote-ssh-local-bridge'
export const inject = ['fs', 'subprocess', 'spillStore', 'shell']

/** Publish isolated local providers without changing their implementation. */
export function apply(ctx: Context): void {
  ctx.provide('localShell', ctx.shell)
  ctx.provide('localFs', ctx.fs)
  ctx.provide('localSpillStore', ctx.spillStore)
  ctx.provide('localSubprocess', ctx.subprocess)
}
