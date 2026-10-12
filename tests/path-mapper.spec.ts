import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WorkspacePathMapper,
  buildEmbeddedAgentHostCommand,
  buildListEmbeddedAgentHostsCommand,
  buildRemoteAgentHostCommand,
  fileUriFromPosixPath,
  posixPathFromFileUri,
  quotePosix,
} from '../src/transport/runtime.ts'

describe('WorkspacePathMapper', () => {
  it('maps the local alias and relative paths into one remote workspace', () => {
    const local = resolve('tests', 'alias')
    const mapper = new WorkspacePathMapper(local, '/srv/project')
    expect(mapper.toRemotePath(local)).toBe('/srv/project')
    expect(mapper.toRemotePath(resolve(local, 'src', 'main.ts'))).toBe('/srv/project/src/main.ts')
    expect(mapper.toRemotePath('src\\main.ts', local)).toBe('/srv/project/src/main.ts')
    expect(mapper.toRemotePath('/var/log')).toBe('/var/log')
    if (process.platform === 'win32') {
      expect(() => mapper.toRemotePath(resolve(local, '..', 'outside.txt'))).toThrow(/outside/)
    }
  })

  it('round-trips POSIX file URIs without treating reserved characters as syntax', () => {
    const path = '/srv/a project/hash#name.ts'
    expect(posixPathFromFileUri(fileUriFromPosixPath(path))).toBe(path)
  })

  it('quotes opaque values for the remote POSIX bootstrap shell', () => {
    expect(quotePosix("a'b")).toBe("'a'\"'\"'b'")
    expect(() => quotePosix('a\0b')).toThrow(/NUL/)
  })

  it('keeps the standalone and embedded VS Code Agent Host bootstraps distinct', () => {
    const command = buildRemoteAgentHostCommand('code')
    expect(command).not.toContain('remote-cli/code')
    expect(command).toContain('$HOME/.dsh-ssh-workspace/cli/bin/code')
    expect(command).toContain('--idle-timeout 60')
    expect(command).toContain('exec "$dsh_code" agent host')
    const embedded = buildEmbeddedAgentHostCommand()
    expect(embedded).toContain('$HOME/.vscode-server/cli/servers')
    expect(embedded).toContain('server/bin/code-server')
    expect(embedded).toContain('--agent-host-port 0')
    expect(buildListEmbeddedAgentHostsCommand()).toContain("sort -nr")
    expect(buildEmbeddedAgentHostCommand('/opt/vscode server/bin/code-server', 'attempt-1')).toContain("'/opt/vscode server/bin/code-server'")
  })
})
