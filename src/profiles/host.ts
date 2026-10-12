// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { Context } from '@deepseek-ai/cordis'

/** Stable root entry whose package manifest contributes the browser module. */
export const name = 'dsh-ssh-workspace-host'

/** Node-side no-op; runtime capabilities are mounted through explicit subpath rows. */
export function apply(_ctx: Context): void {}
