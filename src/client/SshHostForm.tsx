// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { CONFIG_HOST_PATH, request } from './api.ts'
import { button, card, primary, row, singleLineInput } from './styles.ts'
import type { Translate } from './types.ts'

/** Add an OpenSSH host without leaving the workspace creation flow. */
export function SshHostForm({ t, configFiles, onAdded, onCancel }: {
  t: Translate
  configFiles: string[]
  onAdded: (alias: string) => void | Promise<void>
  onCancel: () => void
}): ReactElement {
  const [command, setCommand] = useState('')
  const [configPath, setConfigPath] = useState(configFiles[0] ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const added = await request<{ alias: string }>(CONFIG_HOST_PATH, 'POST', { command: command.trim(), configPath })
      await onAdded(added.alias)
    } catch (reason) { setError(String(reason)) }
    finally { setSaving(false) }
  }
  return <div style={{ ...card, padding: 12 }}>
    <label><strong>{t('sshCommand')}</strong>
      <input style={singleLineInput} aria-label={t('sshCommand')} placeholder="ssh user@hostname -p 22" value={command} disabled={saving} onChange={event => { setCommand(event.target.value) }} />
    </label>
    <label><strong>{t('chooseSshConfig')}</strong>
      <select style={singleLineInput} aria-label={t('chooseSshConfig')} value={configPath} disabled={saving} onChange={event => { setConfigPath(event.target.value) }}>
        {configFiles.map(path => <option key={path} value={path}>{path}</option>)}
      </select>
    </label>
    {error ? <p role="alert">{error}</p> : null}
    <div style={{ ...row, justifyContent: 'flex-end' }}>
      <button type="button" style={button} disabled={saving} onClick={onCancel}>{t('cancel')}</button>
      <button type="button" style={primary} disabled={saving || !command.trim() || !configPath} onClick={() => { void submit() }}>{saving ? t('saving') : t('add')}</button>
    </div>
  </div>
}
