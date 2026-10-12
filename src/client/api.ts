// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
export const STATE_PATH = '/plugins/dsh-ssh-workspace/state'
export const WORKSPACE_PATH = '/plugins/dsh-ssh-workspace/workspace'
export const WORKSPACE_REMOVE_PATH = '/plugins/dsh-ssh-workspace/workspace/remove'
export const LOCAL_WORKSPACE_PATH = '/plugins/dsh-ssh-workspace/local-workspace'
export const PROBE_PATH = '/plugins/dsh-ssh-workspace/probe'
export const CONFIG_HOST_PATH = '/plugins/dsh-ssh-workspace/ssh-config/host'
export const SETTINGS_PATH = '/plugins/dsh-ssh-workspace/settings'
export const DIRECTORY_PATH = '/plugins/dsh-ssh-workspace/directory'
export const OPEN_FILE_PATH = '/plugins/dsh-ssh-workspace/open-file'
export const BACKEND_CONNECT_PATH = '/plugins/dsh-ssh-workspace/backend/connect'

export type BackendConnectEvent =
  | { type: 'progress'; stage: string }
  | { type: 'ready'; url: string; localPort: number; remotePort: number }
  | { type: 'error'; error: string }

export type OpenFileMode = 'auto' | 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'custom' | 'download'

export interface Server {
  id: string
  label: string
  sshTarget: string
  source: 'ssh-config' | 'saved'
  configPath?: string
  hostName?: string
  user?: string
  port?: number
}

export interface Workspace {
  id: string
  serverId: string
  remotePath: string
  aliasPath: string
}

export interface RemoteDirectoryListing {
  path: string
  home: string
  parent?: string
  entries: Array<{ name: string; path: string }>
}

export interface CatalogState {
  servers: Server[]
  workspaces: Workspace[]
  serverCount: number
  discoveredServerCount: number
  workspaceCount: number
  configFiles: string[]
  loadedConfigFiles: string[]
  configErrors: string[]
  customConfigFile?: string
  openFileMode: OpenFileMode
  openFileEditorPath?: string
}

export const emptyCatalog: CatalogState = {
  servers: [],
  workspaces: [],
  serverCount: 0,
  discoveredServerCount: 0,
  workspaceCount: 0,
  configFiles: [],
  loadedConfigFiles: [],
  configErrors: [],
  openFileMode: 'auto',
}

export async function request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value
      ? String(value.error)
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

/** Read newline-delimited progress from a long-running local plugin route. */
export async function* requestStream<T>(path: string, body: unknown): AsyncGenerator<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        if (line !== '') yield JSON.parse(line) as T
      }
      if (done) break
    }
    if (buffer.trim() !== '') yield JSON.parse(buffer) as T
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
