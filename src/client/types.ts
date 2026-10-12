// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { RemoteSshLocaleKey } from './locales.ts'

export type Translate = (key: RemoteSshLocaleKey, params?: Record<string, unknown>) => string

export interface LocalizedProps {
  t?: Translate
}

export function requireTranslate(t: Translate | undefined, surface: string): Translate {
  if (t === undefined) throw new Error(`${surface} requires its translation function`)
  return t
}
