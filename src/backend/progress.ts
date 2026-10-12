// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { RemoteSshLocaleKey } from '../client/locales.ts'

/** One source of truth for Host bootstrap stage copy across Web and TUI. */
export function backendProgressLocaleKey(stage: string): RemoteSshLocaleKey {
  switch (stage) {
    case 'waiting-host': return 'backendWaiting'
    case 'connecting': return 'backendConnecting'
    case 'reconnecting': return 'backendReconnecting'
    case 'checking-host':
    case 'checking-runtime':
    case 'installing-host': return 'backendChecking'
    case 'uploading-host': return 'backendUploading'
    case 'reusing-host': return 'backendReusing'
    case 'installing-node': return 'backendInstallingNode'
    case 'installing-pnpm': return 'backendInstallingPnpm'
    case 'installing-harness': return 'backendInstallingHarness'
    case 'verifying-runtime': return 'backendVerifyingRuntime'
    case 'installing-bundle': return 'backendInstallingBundle'
    case 'installed':
    case 'starting-host': return 'backendStarting'
    case 'ready': return 'backendReady'
    default: return 'backendConnecting'
  }
}
