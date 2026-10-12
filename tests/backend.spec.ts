import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDshBackendCommand, DEFAULT_DSH_BACKEND_PORT } from '../src/backend/web.ts'
import { DEFAULT_DSH_HOST_PORT } from '../src/backend/tunnel.ts'
import { encodePayloadArchive, loadDshHostPayload } from '../src/backend/install.ts'
import { parseProtocolDescription } from '../src/backend/tunnel.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-host-payload-'))
  roots.push(root)
  mkdirSync(join(root, 'lib'))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-host', version: '1.2.3' }))
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: host\n')
  writeFileSync(join(root, 'scripts', 'install.sh'), '#!/bin/sh\nset -eu\n')
  for (const file of ['index.js', 'server.js', 'startup.js']) writeFileSync(join(root, 'lib', file), `export const file = ${JSON.stringify(file)}\n`)
  return root
}

describe('full Backend SSH bootstrap', () => {
  it('keeps the compatibility port name aligned with the UI-neutral tunnel', () => {
    expect(DEFAULT_DSH_BACKEND_PORT).toBe(DEFAULT_DSH_HOST_PORT)
  })

  it('installs or reuses the stable Host without VS Code or AHP', () => {
    const command = buildDshBackendCommand(DEFAULT_DSH_BACKEND_PORT)
    expect(command).toContain(`--instance dsh-ssh-workspace --port ${String(DEFAULT_DSH_BACKEND_PORT)}`)
    expect(command).toContain('DSH_REMOTE_BACKEND_PAYLOAD REQUIRED')
    expect(command).toContain('DSH_REMOTE_BACKEND_PROGRESS checking-host')
    expect(command).toContain('DSH_REMOTE_BACKEND_PROGRESS waiting-host')
    expect(command).toContain('DSH_REMOTE_BACKEND_PROGRESS starting-host')
    expect(command).toContain('install.lock')
    expect(command).toContain('DSH_HOST_START=0')
    expect(command).toContain('DSH_REMOTE_BACKEND_READY')
    expect(command).toContain('while IFS= read -r dsh_control')
    expect(command).not.toMatch(/vscode|code-server|agent-host|AHP/i)
  })

  it('rejects ports that cannot be forwarded', () => {
    expect(() => buildDshBackendCommand(-1)).toThrow(/invalid Backend port/)
    expect(() => buildDshBackendCommand(65536)).toThrow(/invalid Backend port/)
  })

  it('builds a deterministic, self-contained package payload', () => {
    const root = hostFixture()
    const first = loadDshHostPayload(root)
    const second = loadDshHostPayload(root)
    expect(first).toMatchObject({ version: '1.2.3', root })
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.hash).toBe(first.hash)
    expect(first.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'package.json', 'cordis.patch.yml', 'scripts/install.sh',
      'lib/index.js', 'lib/server.js', 'lib/startup.js',
    ]))
    expect(encodePayloadArchive(first)).toMatch(/^DSH_REMOTE_BACKEND_ARCHIVE [A-Za-z0-9+/=]+\n$/)
  })

  it('accepts only the Host protocol version carried by this client', () => {
    expect(parseProtocolDescription({
      protocol: 'dsh-host', protocolVersion: 1, transport: 'http+websocket',
      rpcPath: '/api/{method}', muxEventsPath: '/api/events.mux', hostEventsPath: '/api/events.host',
      capabilities: ['dsh.host.rpc.v1'],
    })).toMatchObject({ protocolVersion: 1 })
    expect(() => parseProtocolDescription({
      protocol: 'dsh-host', protocolVersion: 2, transport: 'http+websocket',
      rpcPath: '/api/{method}', muxEventsPath: '/api/events.mux', hostEventsPath: '/api/events.host', capabilities: [],
    })).toThrow(/incompatible protocol/)
  })
})
