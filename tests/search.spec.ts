// Derived from Yan-Zero/dsh-remote-ssh; modified by ahian-lee. See NOTICE.
import { resolve } from 'node:path'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import type { RemoteWorkspaceRoute } from '../src/routing/manager.ts'
import { injectSearchPathHook, remoteAbsolutePath } from '../src/transport/search.ts'
import { describe, expect, it } from 'vitest'

const route: RemoteWorkspaceRoute = {
  kind: 'remote',
  server: { id: 'cloud', label: 'Cloud', sshTarget: 'cloud' },
  workspace: { id: 'root', serverId: 'cloud', remotePath: '/root' },
  aliasPath: resolve('remote-alias'),
  mapper: new WorkspacePathMapper(resolve('remote-alias'), '/root'),
}

describe('remote search parser hook', () => {
  it('injects only the parser entry and is idempotent', () => {
    const source = 'function toWorkdirRelative(path, workdir) {\n\treturn path;\n}'
    const injected = injectSearchPathHook(source)
    expect(injected).toContain('globalThis[Symbol.for("dsh-ssh-workspace.search-path-parser")]?.(path, workdir)')
    expect(injectSearchPathHook(injected)).toBe(injected)
  })

  it('injects the compact parser emitted by the tsx development loader', () => {
    const source = 'function toWorkdirRelative(path,workdir){if(!isAbsolute(path))return path}'
    expect(injectSearchPathHook(source)).toContain(
      'globalThis[Symbol.for("dsh-ssh-workspace.search-path-parser")]?.(path, workdir)',
    )
  })

  it('returns absolute POSIX paths for remote search results', () => {
    const manager = {
      route: () => route,
    } as unknown as Parameters<typeof remoteAbsolutePath>[0]

    expect(remoteAbsolutePath(manager, '/root/source/file.txt', route.aliasPath)).toBe('/root/source/file.txt')
    expect(remoteAbsolutePath(manager, '/root', route.aliasPath)).toBe('/root')
    expect(remoteAbsolutePath(manager, '/etc/hosts', route.aliasPath)).toBe('/etc/hosts')
    expect(remoteAbsolutePath(manager, 'relative/file.txt', route.aliasPath)).toBe('/root/relative/file.txt')
  })

  it('leaves local paths to the stock parser', () => {
    const manager = {
      route: () => ({ kind: 'local' as const }),
    } as unknown as Parameters<typeof remoteAbsolutePath>[0]
    expect(remoteAbsolutePath(manager, '/root/file.txt', resolve('local'))).toBeUndefined()
  })
})
