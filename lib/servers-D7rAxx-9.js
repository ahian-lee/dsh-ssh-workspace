import { n as defaultSshConfigFiles, r as discoverSshConfigHosts } from "./config-BN3gCBP-.js";
//#region src/tui/servers.ts
/** SSH Host alias or address shown by backend-neutral UIs. */
function remoteServerIdentity(server) {
	return server.sshTarget.trim() || server.label;
}
/** Banner text that identifies both the SSH server and its remote directory. */
function remoteDisplayCwd(server, remotePath) {
	return `${remoteServerIdentity(server)} · ${remotePath}`;
}
/** Merge saved servers with concrete hosts discovered from OpenSSH config. */
async function listAvailableServers(manager) {
	const snapshot = manager.snapshot();
	const discovered = await discoverSshConfigHosts(snapshot.sshConfigFile === void 0 ? defaultSshConfigFiles() : [snapshot.sshConfigFile]);
	const servers = /* @__PURE__ */ new Map();
	for (const host of discovered.hosts) servers.set(host.sshTarget.toLowerCase(), {
		id: host.id,
		label: host.label,
		sshTarget: host.sshTarget
	});
	for (const server of snapshot.servers) servers.set(server.sshTarget.toLowerCase(), server);
	return [...servers.values()].sort((left, right) => left.label.localeCompare(right.label));
}
//#endregion
export { remoteDisplayCwd as n, remoteServerIdentity as r, listAvailableServers as t };
