// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { RemoteDirectoryListing } from './api.ts'
import { button, card, dim, primary, row, singleLineInput } from './styles.ts'
import type { Translate } from './types.ts'

export interface WorkspaceDirectoryPickerProps {
  t: Translate
  open: boolean
  title: string
  sourceKey: string
  initialPath: string
  list: (path?: string) => Promise<RemoteDirectoryListing>
  onPick: (path: string) => void
  onCancel: () => void
}

/** Shared in-app local/remote directory browser. */
export function WorkspaceDirectoryPicker(props: WorkspaceDirectoryPickerProps): ReactElement | null {
  const [listing, setListing] = useState<RemoteDirectoryListing>()
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestGeneration = useRef(0)

  const browse = async (path?: string): Promise<void> => {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError('')
    try {
      const next = await props.list(path === undefined || path.trim() === '' ? undefined : path.trim())
      if (generation !== requestGeneration.current) return
      setListing(next)
      setDraft(next.path)
    } catch (reason) {
      if (generation === requestGeneration.current) setError(String(reason))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!props.open) return
    const initial = props.initialPath.trim().startsWith('/') ? props.initialPath.trim() : undefined
    void browse(initial)
    return () => { requestGeneration.current += 1 }
  }, [props.open, props.sourceKey])

  if (!props.open) return null
  return <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.42)' }} role="dialog" aria-modal="true" aria-label={props.title}>
    <div style={{ ...card, width: 'min(620px, calc(100vw - 32px))', maxHeight: 'min(720px, calc(100vh - 32px))' }}>
      <strong>{props.title}</strong>
      <div style={row}>
        <input style={{ ...singleLineInput, flex: '1 1 320px' }} aria-label={props.t('directoryPath', { title: props.title })} value={draft} onChange={event => { setDraft(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void browse(draft) }} />
        <button style={button} disabled={loading || draft.trim() === ''} onClick={() => { void browse(draft) }}>{props.t('go')}</button>
      </div>
      <div style={row}>
        <button style={button} disabled={loading || listing === undefined || listing.path === listing.home} onClick={() => { if (listing !== undefined) void browse(listing.home) }}>{props.t('home')}</button>
        <button style={button} disabled={loading || listing?.parent === undefined} onClick={() => { if (listing?.parent !== undefined) void browse(listing.parent) }}>{props.t('parent')}</button>
        <span style={dim}>{listing?.path ?? props.t('directoryLoading')}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 120, maxHeight: 360, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 6 }}>
        {listing?.entries.map(entry => <button key={entry.path} style={{ ...button, border: 0, borderRadius: 6, textAlign: 'left', background: 'transparent' }} onClick={() => { void browse(entry.path) }}>📁 {entry.name}</button>)}
        {!loading && listing?.entries.length === 0 ? <p style={{ ...dim, padding: 8 }}>{props.t('directoryEmpty')}</p> : null}
        {loading ? <p style={{ ...dim, padding: 8 }}>{props.t('directoryLoading')}</p> : null}
      </div>
      {error ? <p role="alert" style={dim}>{error}</p> : null}
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} onClick={props.onCancel}>{props.t('cancel')}</button>
        <button style={primary} disabled={loading || listing === undefined} onClick={() => { if (listing !== undefined) props.onPick(listing.path) }}>{props.t('selectCurrentFolder')}</button>
      </div>
    </div>
  </div>
}
