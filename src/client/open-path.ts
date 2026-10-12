// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { OPEN_FILE_PATH, request, STATE_PATH } from './api.ts'
import type { CatalogState } from './api.ts'
import { resolveRemoteOpenWorkspace } from './open-route.ts'

interface RemoteOpenResponse {
  kind: 'editor' | 'download'
  localPath?: string
}

/** Transparently route chat/tool file links through the owning remote Workspace. */
export function installRemoteOpenPath(ctx: ClientContext): void {
  const workspaces = ctx.workspaces
  const previous = workspaces.openPath
  const routed = async (path: string): Promise<void> => {
    const state = await request<CatalogState>(STATE_PATH)
    const sessions = ctx.sessions.list.getSnapshot()
    const current = sessions.current
    const cwd = current === undefined ? undefined : sessions.byId[current]?.cwd
    const workspace = resolveRemoteOpenWorkspace(state.workspaces, path, cwd)
    if (workspace === undefined) return previous.call(workspaces, path)

    const result = await request<RemoteOpenResponse>(OPEN_FILE_PATH, 'POST', {
      workspaceId: workspace.id,
      path,
    })
    if (result.kind === 'editor') return
    if (result.localPath === undefined) throw new Error('remote download did not return a local path')
    await previous.call(workspaces, result.localPath)
  }
  workspaces.openPath = routed
  ctx.effect(() => () => {
    if (workspaces.openPath === routed) workspaces.openPath = previous
  }, 'dsh-ssh-workspace: openPath router')
}
