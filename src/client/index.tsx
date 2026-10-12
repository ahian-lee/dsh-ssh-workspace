// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Browser entry: locale registration, transparent openPath routing, and slots. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh } from './locales.ts'
import type { RemoteSshLocaleKey } from './locales.ts'
import type { RemoteDirectoryListing } from './api.ts'
import { RemoteSshPluginCard } from './RemoteSshPluginCard.tsx'
import { RemoteSshSettings } from './RemoteSshSettings.tsx'
import { RemoteWorkspaceFlow } from './RemoteWorkspaceFlow.tsx'
import type { RemoteWorkspaceFlowInjected } from './RemoteWorkspaceFlow.tsx'
import { installRemoteOpenPath } from './open-path.ts'
import { REMOTE_BACKEND_CONTEXT_PATH, type RemoteBackendContext } from '../backend-context.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote SSH settings, picker, and file-opening copy. */
    'settings.remote-ssh': RemoteSshLocaleKey
  }
}

export const name = 'dsh-ssh-workspace-client'
export const inject = ['slots', 'uiWorkspace', 'locale']

/** Register the localized settings, workspace flow, and transparent file opener. */
export async function apply(ctx: ClientContext): Promise<void> {
  const namespace = 'settings.remote-ssh'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-ssh-workspace: client copy')
  const t = ctx.locale.bind(namespace) as RemoteWorkspaceFlowInjected['t']


  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'remote-ssh', order: 16, label: () => t('nav'), inject: () => ({ t }),
  }, RemoteSshSettings))

  // Single slots support explicit priority shadowing. Keep the native provider
  // registered at its normal priority; unloading this plugin restores it.
  const flowInjected = (): RemoteWorkspaceFlowInjected => ({
    t,
    pickLocal: () => (ctx as unknown as { uiWorkspace: { pickDirectory(): Promise<string | null> } }).uiWorkspace.pickDirectory(),
  })
  for (const slot of ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'] as const) {
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, priority: -10, inject: flowInjected }, RemoteWorkspaceFlow))
  }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item', id: 'remote-ssh', order: 30, inject: () => ({ t }),
  }, RemoteSshPluginCard))
}

/** Detect the gateway before registering any local-only Remote SSH chrome. */
export async function isRemoteBackendWindow(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(REMOTE_BACKEND_CONTEXT_PATH, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const value = await response.json() as Partial<RemoteBackendContext>
    return value.attached === true && value.transport === 'ssh'
  } catch {
    return false
  }
}
