import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendSshHost, discoverSshConfigHosts, parseSshConnectionCommand, parseSshConnectionInvocation } from '../src/ssh/config.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('OpenSSH config discovery', () => {
  it('expands Includes and lists only concrete Host aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-config-'))
    roots.push(root)
    const included = join(root, 'included.conf')
    const config = join(root, 'config')
    await writeFile(included, [
      'Host devbox',
      '  HostName 192.0.2.10',
      '  User developer',
      '  Port 2222',
      'Host *',
      '  ServerAliveInterval 30',
    ].join('\n'))
    await writeFile(config, [
      'Include "included.conf"',
      'Host 构建机 ignored-* !blocked',
      '  HostName 198.51.100.20 # comment',
      '  User builder',
    ].join('\n'))

    const result = await discoverSshConfigHosts([config])
    expect(result.errors).toEqual([])
    expect(result.files).toEqual([config, included])
    expect(result.hosts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'devbox', hostName: '192.0.2.10', user: 'developer', port: 2222, configPath: included }),
      expect.objectContaining({ label: '构建机', hostName: '198.51.100.20', user: 'builder', configPath: config }),
    ]))
    expect(result.hosts.map(host => host.label)).not.toContain('ignored-*')
    expect(result.hosts.map(host => host.label)).not.toContain('blocked')
  })

  it('parses and appends a VS Code-style SSH connection command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-config-'))
    roots.push(root)
    const config = join(root, 'config')
    await writeFile(config, 'Host Existing\n  HostName existing.example\n')

    expect(parseSshConnectionCommand('ssh -i "C:/Keys/My Key.pem" -p 2200 yan@laptop.example')).toEqual({
      alias: 'laptop.example', hostName: 'laptop.example', user: 'yan', port: 2200, identityFile: 'C:/Keys/My Key.pem',
    })
    await appendSshHost(config, 'ssh -i "C:/Keys/My Key.pem" -p 2200 yan@laptop.example')
    const text = await readFile(config, 'utf8')
    expect(text).toContain('Host laptop.example')
    expect(text).toContain('  User yan')
    expect(text).toContain('  Port 2200')
    expect(text).toContain('  IdentityFile "C:/Keys/My Key.pem"')
    await expect(appendSshHost(config, 'ssh laptop.example')).rejects.toThrow(/already exists/)
  })

  it('rejects commands that could inject config lines or unsupported options', () => {
    expect(() => parseSshConnectionCommand('ssh host\nProxyCommand evil')).toThrow(/one line/)
    expect(() => parseSshConnectionCommand('ssh -F other-config host')).toThrow(/unsupported/)
  })

  it('preserves standard connection options for an immediate Backend connection', () => {
    expect(parseSshConnectionInvocation('ssh -F custom.conf -J jump.example -o BatchMode=yes user@host.example')).toEqual({
      executable: 'ssh',
      sshArgs: ['-F', 'custom.conf', '-J', 'jump.example', '-o', 'BatchMode=yes'],
      sshTarget: 'user@host.example',
    })
    expect(() => parseSshConnectionInvocation('ssh -L 3000:localhost:3000 host.example')).toThrow(/unsupported/)
    expect(() => parseSshConnectionInvocation('ssh host.example whoami')).toThrow(/remote command/)
  })
})
