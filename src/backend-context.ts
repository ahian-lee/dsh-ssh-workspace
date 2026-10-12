// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Same-origin signal exposed only by a Web window attached to a remote Host. */
export const REMOTE_BACKEND_CONTEXT_PATH = '/dsh-ssh-workspace/backend-context'

/**
 * Local control-plane endpoints hidden inside a remote Backend window. Keep
 * this exact: the browser bundle may itself be served below `/plugins/`.
 */
export const REMOTE_SSH_LOCAL_CONTROL_PATHS = new Set([
  '/plugins/dsh-ssh-workspace/state',
  '/plugins/dsh-ssh-workspace/workspace',
  '/plugins/dsh-ssh-workspace/workspace/remove',
  '/plugins/dsh-ssh-workspace/local-workspace',
  '/plugins/dsh-ssh-workspace/probe',
  '/plugins/dsh-ssh-workspace/ssh-config/host',
  '/plugins/dsh-ssh-workspace/settings',
  '/plugins/dsh-ssh-workspace/directory',
  '/plugins/dsh-ssh-workspace/open-file',
  '/plugins/dsh-ssh-workspace/backend/connect',
])

export interface RemoteBackendContext {
  attached: true
  transport: 'ssh'
}
