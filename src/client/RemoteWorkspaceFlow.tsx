// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  DIRECTORY_PATH, emptyCatalog, LOCAL_WORKSPACE_PATH, request, STATE_PATH, WORKSPACE_PATH,
} from './api.ts'
import type { CatalogState, RemoteDirectoryListing } from './api.ts'
import { button, card, dim, input, primary, primaryButton, row } from './styles.ts'
import type { Translate } from './types.ts'
import { SshHostForm } from './SshHostForm.tsx'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker.tsx'

export interface RemoteWorkspaceFlowInjected {
  t: Translate
  pickLocal: () => Promise<string | null>
}

/** Combined LOCAL and Remote SSH workspace creation flow. */
export function RemoteWorkspaceFlow(props: DirectoryFlowOwnerProps & RemoteWorkspaceFlowInjected): ReactElement | null {
  const [state, setState] = useState<CatalogState>(emptyCatalog)
  const [serverId, setServerId] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false)
  const [showAddHost, setShowAddHost] = useState(false)
  const [error, setError] = useState('')
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!props.open || wasOpen.current) {
      wasOpen.current = props.open
      return
    }
    wasOpen.current = true
    void request<CatalogState>(STATE_PATH).then(next => {
      setState(next)
      setServerId(next.servers[0]?.id ?? '')
    }, reason => { props.onError(String(reason)) })
  }, [props.open, props.onError])
  if (!props.open) return null

  const chooseLocal = async (path: string): Promise<void> => {
    const adopted = await request<{ path: string }>(LOCAL_WORKSPACE_PATH, 'POST', { path })
    props.onPicked(adopted.path)
  }
  const chooseRemote = async (): Promise<void> => {
    const created = await request<{ aliasPath: string }>(WORKSPACE_PATH, 'POST', { serverId, remotePath })
    props.onPicked(created.aliasPath)
  }

  return <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)' }} role="dialog" aria-modal="true" aria-label={props.t('addWorkspaceTitle')}>
    <div style={{ ...card, width: 'min(600px, calc(100vw - 32px))', maxHeight: '85vh', overflowY: 'auto' }}>
      <strong>{props.t('addWorkspaceTitle')}</strong>
      <button style={button} disabled={props.busy} onClick={() => { void props.pickLocal().then(path => path === null ? undefined : chooseLocal(path)).catch(reason => { setError(String(reason)) }) }}>{props.t('chooseLocalFolder')}</button>
      <div style={row}>
        <select style={input} aria-label={props.t('server')} value={serverId} onChange={event => { setServerId(event.target.value); setRemotePath(''); setShowDirectoryPicker(false) }}>
          <option value="">{props.t('selectRemoteSsh')}</option>
          {state.servers.map(server => <option key={server.id} value={server.id}>{server.label}</option>)}
        </select>
        <input style={input} aria-label={props.t('remotePath')} placeholder={props.t('remotePathPlaceholder')} value={remotePath} onChange={event => { setRemotePath(event.target.value) }} />
        <button style={button} disabled={!serverId || props.busy} onClick={() => { setShowDirectoryPicker(true) }}>{props.t('browseRemote')}</button>
      </div>
      <p style={dim}>{props.t('remotePathHelp')}</p>
      <button style={button} onClick={() => { setShowAddHost(value => !value) }}>{props.t('addSshHost')}</button>
      {showAddHost ? <SshHostForm t={props.t} configFiles={state.configFiles} onCancel={() => { setShowAddHost(false) }} onAdded={async alias => {
        const next = await request<CatalogState>(STATE_PATH)
        setState(next)
        setServerId(next.servers.find(server => server.sshTarget === alias)?.id ?? next.servers[0]?.id ?? '')
        setShowAddHost(false)
      }} /> : null}
      <WorkspaceDirectoryPicker
        t={props.t}
        open={showDirectoryPicker}
        title={props.t('selectRemoteFolder')}
        sourceKey={`remote:${serverId}`}
        initialPath={remotePath}
        list={path => request<RemoteDirectoryListing>(DIRECTORY_PATH, 'POST', { serverId, ...(path === undefined ? {} : { path }) })}
        onCancel={() => { setShowDirectoryPicker(false) }}
        onPick={path => { setRemotePath(path); setShowDirectoryPicker(false) }}
      />
      {error ? <p style={dim}>{error}</p> : null}
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} onClick={props.onCancel}>{props.t('cancel')}</button>
        <button style={primaryButton(props.busy || !serverId || !remotePath.trim())} disabled={props.busy || !serverId || !remotePath.trim()} onClick={() => { void chooseRemote().catch(reason => { setError(String(reason)) }) }}>{props.t('addWorkspace')}</button>
      </div>
    </div>
  </div>
}
