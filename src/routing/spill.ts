// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { ContentEncoding } from '@microsoft/agent-host-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { fileUriFromPosixPath, quotePosix } from '../transport/runtime.ts'

export const name = 'dsh-ssh-workspace-spill'
export const inject = ['localSpillStore', 'remoteSshManager']

/** Route spill artifacts with the session execution world without exposing host files. */
export class TransparentSpillStore extends SpillStore {
  static inject = ['localSpillStore', 'remoteSshManager']

  private readonly local: SpillStore
  private readonly manager: RemoteSshManager

  constructor(ctx: Context) {
    super(ctx)
    this.local = ctx.localSpillStore
    this.manager = ctx.remoteSshManager
  }

  override async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const route = this.manager.sessionRoute(String(input.owner.sessionId))
    if (route === undefined) {
      throw new Error(`dsh-ssh-workspace: no execution world is bound to spill session '${String(input.owner.sessionId)}'`)
    }
    if (route.kind === 'local') return this.local.saveText(input)
    return saveRemoteSpill(this.manager, route, input)
  }
}

/** Persist one spill through the already-authorized AHP host connection. */
export async function saveRemoteSpill(
  manager: Pick<RemoteSshManager, 'workspaceContext' | 'workspaceShell'>,
  route: RemoteWorkspaceRoute,
  input: SaveTextSpill,
): Promise<SpillRef> {
  const [{ remote }, shell] = await Promise.all([
    manager.workspaceContext(route),
    manager.workspaceShell(route, 'bash'),
  ])
  const directory = remoteSpillDirectory(remote.runtimeRoot, String(input.owner.sessionId))
  const path = posix.join(directory, `${randomBytes(12).toString('hex')}-${safeSuggestedName(input.suggestedName)}`)
  const prepared = await shell.run(shell.resolve({
    command: `umask 077 && mkdir -p -m 700 -- ${quotePosix(directory)}`,
    workdir: route.aliasPath,
    timeoutMs: 30_000,
    stdoutMaxBytes: 16 * 1024,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: route.aliasPath },
  }))
  if (prepared.exitCode !== 0) {
    throw new Error(`dsh-ssh-workspace: failed to prepare remote spill directory: ${prepared.stderr.text.slice(-2048)}`)
  }

  const client = await remote.getClient()
  await client.resourceWrite({
    uri: fileUriFromPosixPath(path),
    data: input.content,
    encoding: ContentEncoding.Utf8,
    contentType: 'text/plain; charset=utf-8',
    createOnly: true,
  })
  return {
    locator: SpillLocator(path),
    bytes: Buffer.byteLength(input.content, 'utf8'),
    retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
  }
}

/** Stable private directory for one session inside this process's remote runtime root. */
export function remoteSpillDirectory(runtimeRoot: string, sessionId: string): string {
  const owner = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return posix.join(runtimeRoot, 'spills', `session-${owner}`)
}

/** Suggested names are labels only; randomness supplies identity and collision resistance. */
export function safeSuggestedName(value: string): string {
  const safe = [...value].map(character => /^[A-Za-z0-9._-]$/.test(character) ? character : '_').join('')
  const bounded = safe.slice(0, 96)
  return bounded === '' || bounded === '.' || bounded === '..' ? 'result.txt' : bounded
}

export default TransparentSpillStore
