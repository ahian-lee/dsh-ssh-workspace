// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { CSSProperties } from 'react'

export const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }
export const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
export const row: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
export const input: CSSProperties = { minWidth: 180, flex: '1 1 180px', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
export const singleLineInput: CSSProperties = { ...input, minWidth: 0, width: 520, maxWidth: '100%', height: 36, flex: '0 0 auto', boxSizing: 'border-box' }
export const button: CSSProperties = { padding: '7px 13px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
export const primary: CSSProperties = { ...button, borderColor: '#2563eb', background: '#2563eb', color: 'white' }
export const dim: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 14 }

export const primaryButton = (disabled: boolean): CSSProperties => ({ ...primary, ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}) })
