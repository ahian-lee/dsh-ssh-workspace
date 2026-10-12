import { i as discoveredSshServerId } from "./config-BN3gCBP-.js";
import { t as listAvailableServers } from "./servers-D7rAxx-9.js";
import { posix } from "node:path";
//#region src/profiles/tui.ts
const name = "dsh-ssh-workspace-tui";
const inject = ["remoteSshManager"];
/** Activate the terminal adapter only when a workspace registry is present. */
function apply(ctx) {
	ctx.inject(["tuiWorkspaces"], registerTuiProvider);
}
/** Register the SSH workspace catalog and command executor with dsh-tui. */
function registerTuiProvider(ctx) {
	const registry = ctx.get("tuiWorkspaces");
	const manager = ctx.remoteSshManager;
	const provider = {
		schemes: ["ssh"],
		list: () => manager.snapshot().workspaces.map((workspace) => targetForRoute(manager.workspace(workspace.id))),
		resolve: (uri) => resolveSshWorkspaceUri(manager, uri),
		resolvePath: (path, cwd) => resolveSshWorkspacePath(manager, path, cwd),
		describe: (cwd) => describeRemoteCwd(manager, cwd),
		rename: async (cwd, title) => {
			const route = manager.route(void 0, cwd);
			if (route.kind !== "remote") return void 0;
			return targetForRoute(await manager.renameWorkspace(route.workspace.id, title));
		},
		commands: [remoteWorkspaceCommand(manager)],
		commandShell: async (cwd) => {
			const route = manager.route(void 0, cwd);
			if (route.kind !== "remote") return void 0;
			return manager.workspaceShell(route, "bash");
		}
	};
	const dispose = registry.register(provider);
	ctx.effect(() => dispose, "Remote SSH TUI workspace provider");
	ctx.provide("remoteSshTui", {});
}
/** Interactive device and directory browser contributed as `/workspace remote`. */
function remoteWorkspaceCommand(manager) {
	return {
		name: "remote",
		aliases: ["connect"],
		description: "Choose an SSH device and remote directory",
		async run(input) {
			const servers = await listAvailableServers(manager);
			const filter = input.trim().toLowerCase();
			return {
				kind: "choices",
				title: "Remote SSH devices",
				choices: (filter.length === 0 ? servers : servers.filter((server) => `${server.label} ${server.sshTarget}`.toLowerCase().includes(filter))).map((server) => ({
					id: server.id,
					label: server.label,
					description: server.sshTarget,
					badge: "SSH",
					choose: () => remoteDirectoryChoices(manager, server)
				}))
			};
		}
	};
}
async function remoteDirectoryChoices(manager, server, requestedPath) {
	return directoryListingResult(manager, server, await manager.listRemoteDirectory(server, requestedPath));
}
function directoryListingResult(manager, server, listing) {
	const choices = [{
		id: `select:${listing.path}`,
		label: "Use this directory",
		description: listing.path,
		badge: "OPEN",
		choose: async () => ({
			kind: "target",
			target: await ensureWorkspaceTarget(manager, server, listing.path)
		}),
		input: {
			initialValue: listing.path,
			placeholder: "/absolute/remote/path",
			submit: (value) => remoteDirectoryChoices(manager, server, value)
		}
	}];
	if (listing.parent !== void 0) choices.push({
		id: `parent:${listing.parent}`,
		label: "..",
		description: listing.parent,
		choose: () => remoteDirectoryChoices(manager, server, listing.parent)
	});
	for (const entry of listing.entries) choices.push({
		id: `directory:${entry.path}`,
		label: entry.name,
		description: entry.path,
		choose: () => remoteDirectoryChoices(manager, server, entry.path)
	});
	return {
		kind: "choices",
		title: `${server.label} · ${listing.path}`,
		choices
	};
}
async function ensureWorkspaceTarget(manager, candidate, remotePath) {
	let snapshot = manager.snapshot();
	let server = snapshot.servers.find((current) => current.id === candidate.id || current.sshTarget.toLowerCase() === candidate.sshTarget.toLowerCase());
	if (server === void 0) {
		server = await manager.addServer(candidate);
		snapshot = manager.snapshot();
	}
	const normalizedPath = posix.normalize(remotePath);
	const workspace = snapshot.workspaces.find((current) => current.serverId === server.id && posix.normalize(current.remotePath) === normalizedPath);
	return targetForRoute(workspace === void 0 ? await manager.addWorkspace(server.id, normalizedPath) : manager.workspace(workspace.id));
}
/** Resolve an existing server/workspace or persist a URI-addressed target. */
async function resolveSshWorkspaceUri(manager, uri) {
	const parsed = parseSshWorkspaceUri(uri);
	if (parsed === void 0) return void 0;
	let server = findServer(manager.snapshot().servers, parsed.selector, parsed.sshTarget);
	if (server === void 0) {
		const identity = parsed.port === void 0 ? parsed.sshTarget : `${parsed.sshTarget}:${parsed.port}`;
		server = await manager.addServer({
			id: discoveredSshServerId(identity),
			label: parsed.selector,
			sshTarget: parsed.sshTarget,
			...parsed.port === void 0 ? {} : { sshArgs: ["-p", String(parsed.port)] }
		});
	}
	const current = manager.snapshot().workspaces.find((workspace) => workspace.serverId === server.id && posix.normalize(workspace.remotePath) === parsed.remotePath);
	return targetForRoute(current === void 0 ? await manager.addWorkspace(server.id, parsed.remotePath) : manager.workspace(current.id));
}
/** Resolve a POSIX path relative to the currently selected SSH workspace. */
async function resolveSshWorkspacePath(manager, path, cwd) {
	const route = manager.route(void 0, cwd);
	if (route.kind !== "remote") return void 0;
	const currentRemotePath = route.mapper.toRemotePath(cwd, route.aliasPath);
	const remotePath = posix.resolve(currentRemotePath, path);
	const current = manager.snapshot().workspaces.find((workspace) => workspace.serverId === route.server.id && posix.normalize(workspace.remotePath) === remotePath);
	return targetForRoute(current === void 0 ? await manager.addWorkspace(route.server.id, remotePath) : manager.workspace(current.id));
}
/** Parse `ssh://[user@]server[:port]/absolute/path`. */
function parseSshWorkspaceUri(uri) {
	let parsed;
	try {
		parsed = new URL(uri);
	} catch {
		return;
	}
	if (parsed.protocol !== "ssh:") return void 0;
	if (parsed.hostname.length === 0) throw new Error("SSH workspace URI requires a server");
	const host = decodeURIComponent(parsed.hostname);
	const user = decodeURIComponent(parsed.username);
	const selector = user.length === 0 ? host : `${user}@${host}`;
	const sshTarget = selector;
	const remotePath = posix.normalize(decodeURIComponent(parsed.pathname));
	if (!posix.isAbsolute(remotePath)) throw new Error("SSH workspace URI requires an absolute remote path");
	const port = parsed.port === "" ? void 0 : Number(parsed.port);
	if (port !== void 0 && (!Number.isSafeInteger(port) || port <= 0 || port > 65535)) throw new Error(`invalid SSH port: ${parsed.port}`);
	return {
		selector,
		sshTarget,
		remotePath,
		...port === void 0 ? {} : { port }
	};
}
function sshWorkspaceUri(route) {
	const path = route.workspace.remotePath.split("/").map((part, index) => index === 0 ? "" : encodeURIComponent(part)).join("/");
	return `ssh://${route.server.id}${path}`;
}
function targetForRoute(route) {
	const root = posix.normalize(route.workspace.remotePath);
	return {
		uri: sshWorkspaceUri(route),
		cwd: route.aliasPath,
		label: route.workspace.title ?? `${route.server.label} > ${posix.basename(root) || root}`,
		description: root,
		kind: "provider",
		badge: "SSH"
	};
}
function describeRemoteCwd(manager, cwd) {
	try {
		const route = manager.route(void 0, cwd);
		if (route.kind !== "remote") return void 0;
		const remotePath = route.mapper.toRemotePath(cwd, route.aliasPath);
		return {
			...targetForRoute(route),
			description: remotePath
		};
	} catch {
		return;
	}
}
function findServer(servers, selector, sshTarget) {
	const normalized = selector.toLowerCase();
	return servers.find((server) => server.id.toLowerCase() === normalized || server.label.toLowerCase() === normalized || server.sshTarget.toLowerCase() === sshTarget.toLowerCase());
}
//#endregion
export { apply, apply as default, inject, listAvailableServers, name, parseSshWorkspaceUri, remoteWorkspaceCommand, resolveSshWorkspacePath, resolveSshWorkspaceUri, sshWorkspaceUri };
