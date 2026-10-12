// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-harness-tui/dsh-tui/backends'
import { RemoteSshTuiBackendController } from '../tui/backend-controller.ts'
import { RemoteHostTuiChannelFactory } from '../tui/remote-channel.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSshTuiBackend: RemoteSshTuiBackendController
  }
}

export const name = 'dsh-ssh-workspace-tui-backend'
export const inject = ['remoteSshManager']

/** Observe dsh-tui's optional registry without making it a profile dependency. */
export function apply(ctx: Context): void {
  ctx.inject(['tuiBackends'], registerTuiBackend)
}

/** Register the Remote Host adapter through dsh-tui's public backend seam. */
function registerTuiBackend(ctx: Context): void {
  const controller = new RemoteSshTuiBackendController(ctx.remoteSshManager)
  const unregisterFactory = controller.registerFactory(new RemoteHostTuiChannelFactory())
  const unregisterProvider = ctx.tuiBackends.register(controller)
  ctx.provide('remoteSshTuiBackend', controller)
  ctx.effect(() => () => {
    unregisterProvider()
    unregisterFactory()
    void controller.dispose()
  }, 'Remote SSH dsh-tui backend adapter')
}

export default apply
