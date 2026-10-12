// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import type { RemoteSshManager, RemoteSshServer } from '../routing/manager.ts'
import { defaultSshConfigFiles, discoverSshConfigHosts } from '../ssh/config.ts'

/** SSH Host alias or address shown by backend-neutral UIs. */
export function remoteServerIdentity(server: Pick<RemoteSshServer, 'label' | 'sshTarget'>): string {
  return server.sshTarget.trim() || server.label
}

/** Banner text that identifies both the SSH server and its remote directory. */
export function remoteDisplayCwd(
  server: Pick<RemoteSshServer, 'label' | 'sshTarget'>,
  remotePath: string,
): string {
  return `${remoteServerIdentity(server)} · ${remotePath}`
}

/** Merge saved servers with concrete hosts discovered from OpenSSH config. */
export async function listAvailableServers(manager: RemoteSshManager): Promise<RemoteSshServer[]> {
  const snapshot = manager.snapshot()
  const discovered = await discoverSshConfigHosts(
    snapshot.sshConfigFile === undefined ? defaultSshConfigFiles() : [snapshot.sshConfigFile],
  )
  const servers = new Map<string, RemoteSshServer>()
  for (const host of discovered.hosts) {
    servers.set(host.sshTarget.toLowerCase(), {
      id: host.id,
      label: host.label,
      sshTarget: host.sshTarget,
    })
  }
  for (const server of snapshot.servers) servers.set(server.sshTarget.toLowerCase(), server)
  return [...servers.values()].sort((left, right) => left.label.localeCompare(right.label))
}
