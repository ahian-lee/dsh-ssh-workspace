// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { request, SETTINGS_PATH, STATE_PATH } from './api.ts'
import type { CatalogState, OpenFileMode } from './api.ts'
import { button, dim, primary, row, singleLineInput } from './styles.ts'
import { requireTranslate } from './types.ts'
import type { LocalizedProps } from './types.ts'

/** Settings > Plugins card for SSH discovery and remote file opening. */
export function RemoteSshPluginCard({ t: optionalT }: LocalizedProps): ReactElement {
  const t = requireTranslate(optionalT, 'Remote SSH plugin settings')
  const [current, setCurrent] = useState('')
  const [draft, setDraft] = useState('')
  const [currentMode, setCurrentMode] = useState<OpenFileMode>('auto')
  const [mode, setMode] = useState<OpenFileMode>('auto')
  const [currentEditorPath, setCurrentEditorPath] = useState('')
  const [editorPath, setEditorPath] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void request<CatalogState>(STATE_PATH).then(state => {
      const value = state.customConfigFile ?? ''
      const editor = state.openFileEditorPath ?? ''
      setCurrent(value)
      setDraft(value)
      setCurrentMode(state.openFileMode)
      setMode(state.openFileMode)
      setCurrentEditorPath(editor)
      setEditorPath(editor)
      setLoading(false)
    }, () => { setFailed(true); setLoading(false) })
  }, [])

  const absolute = (value: string) => /^(?:[A-Za-z]:[\\/]|\/)/.test(value)
  const invalid = draft.trim() !== '' && !absolute(draft.trim())
  const invalidEditor = mode === 'custom' && !absolute(editorPath.trim())
  const dirty = draft !== current || mode !== currentMode || editorPath !== currentEditorPath

  const save = async (): Promise<void> => {
    setSaving(true)
    setFailed(false)
    try {
      const result = await request<{
        sshConfigFile?: string
        openFileMode: OpenFileMode
        openFileEditorPath?: string
      }>(SETTINGS_PATH, 'POST', {
        sshConfigFile: draft.trim(),
        openFileMode: mode,
        openFileEditorPath: editorPath.trim(),
      })
      const value = result.sshConfigFile ?? ''
      const editor = result.openFileEditorPath ?? ''
      setCurrent(value)
      setDraft(value)
      setCurrentMode(result.openFileMode)
      setMode(result.openFileMode)
      setCurrentEditorPath(editor)
      setEditorPath(editor)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return <li style={{ listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, overflow: 'hidden' }}>
    <button type="button" style={{ ...button, width: '100%', border: 0, borderRadius: 0, padding: 14, textAlign: 'left' }} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
      <b>Remote SSH</b><span style={{ display: 'block', ...dim }}>{t('pluginSummary')}</span>
    </button>
    {open ? <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label htmlFor="plugin-remote-ssh-config"><b>{t('sshConfigLabel')}</b></label>
      <input id="plugin-remote-ssh-config" style={singleLineInput} placeholder={t('sshConfigPlaceholder')} value={draft} disabled={loading || saving} onChange={event => { setDraft(event.target.value); setFailed(false) }} />
      <p style={dim}>{t('sshConfigHelp')}</p>
      {invalid ? <p role="alert" style={dim}>{t('absolutePathRequired')}</p> : null}

      <label htmlFor="plugin-remote-ssh-open-file"><b>{t('openFileLabel')}</b></label>
      <select id="plugin-remote-ssh-open-file" style={singleLineInput} value={mode} disabled={loading || saving} onChange={event => { setMode(event.target.value as OpenFileMode); setFailed(false) }}>
        <option value="auto">{t('openFileAuto')}</option>
        <option value="vscode">{t('openFileVscode')}</option>
        <option value="cursor">{t('openFileCursor')}</option>
        <option value="windsurf">{t('openFileWindsurf')}</option>
        <option value="vscodium">{t('openFileVscodium')}</option>
        <option value="custom">{t('openFileCustom')}</option>
        <option value="download">{t('openFileDownload')}</option>
      </select>
      {mode === 'custom' ? <>
        <label htmlFor="plugin-remote-ssh-editor"><b>{t('customEditorLabel')}</b></label>
        <input id="plugin-remote-ssh-editor" style={singleLineInput} placeholder={t('customEditorPlaceholder')} value={editorPath} disabled={loading || saving} onChange={event => { setEditorPath(event.target.value); setFailed(false) }} />
        {invalidEditor ? <p role="alert" style={dim}>{t('absolutePathRequired')}</p> : null}
      </> : null}
      <p style={dim}>{t('openFileHelp')}</p>

      {failed ? <p role="alert" style={dim}>{t('saveFailed')}</p> : null}
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} disabled={!dirty || saving} onClick={() => { setDraft(current); setMode(currentMode); setEditorPath(currentEditorPath); setFailed(false) }}>{t('discard')}</button>
        <button style={primary} disabled={!dirty || invalid || invalidEditor || loading || saving} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</button>
      </div>
    </div> : null}
  </li>
}
