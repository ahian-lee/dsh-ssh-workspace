import { n as WorkspacePathMapper, o as fileUriFromPosixPath, s as posixPathFromFileUri, t as RemoteSshRuntime } from "./runtime-DWxYRxHs.js";
import { RemoteSshFileSystem } from "./fs.js";
import { RemoteSshShellExecutor } from "./shell.js";
import { RemoteDshHostConnection } from "./backend-connection.js";
import { n as RemoteDshWebProxy, t as DEFAULT_DSH_BACKEND_PORT } from "./web-DI_lISRQ.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
//#region src/routing/manager.ts
const SETTINGS_NAMESPACE = "remote-ssh";
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const serverSchema = z.object({
	id: z.string().required(),
	label: z.string().required(),
	sshTarget: z.string().required(),
	sshArgs: z.array(z.string()),
	remoteCodeCommand: z.string(),
	remoteRgCommand: z.string(),
	sshExecutable: z.string(),
	backendPort: z.number()
});
const workspaceSchema = z.object({
	id: z.string().required(),
	serverId: z.string().required(),
	remotePath: z.string().required(),
	aliasPath: z.string(),
	title: z.string()
});
/**
* Owns the durable host/workspace catalog and lazy remote workspace contexts.
* An alias that was once remote remains a remote tombstone after removal, so
* stale sessions fail closed instead of silently running on the local host.
*/
var RemoteSshManager = class RemoteSshManager extends Service {
	static inject = ["settings"];
	static Config = z.object({
		aliasRoot: z.string().default(resolve(process.env.DSH_HOME ?? resolve(process.env.USERPROFILE ?? ".", ".dsh"), "remote-ssh", "workspaces")),
		sshConfigFile: z.string(),
		servers: z.array(serverSchema).default([]),
		workspaces: z.array(workspaceSchema).default([]),
		openFileMode: z.union([
			"auto",
			"vscode",
			"cursor",
			"windsurf",
			"vscodium",
			"custom",
			"download"
		]).default("auto"),
		openFileEditorPath: z.string(),
		openFileDownloadMaxBytes: z.number().default(67108864),
		startupTimeoutMs: z.number().default(6e5),
		requestTimeoutMs: z.number().default(3e4)
	});
	entry;
	current;
	settings;
	routes = /* @__PURE__ */ new Map();
	routeByWorkspaceId = /* @__PURE__ */ new Map();
	remoteAliases = /* @__PURE__ */ new Set();
	contexts = /* @__PURE__ */ new Map();
	shellContexts = /* @__PURE__ */ new Map();
	hosts = /* @__PURE__ */ new Map();
	backendTunnels = /* @__PURE__ */ new Map();
	webProxies = /* @__PURE__ */ new Map();
	backendProgress = /* @__PURE__ */ new Map();
	backendProgressListeners = /* @__PURE__ */ new Map();
	sessionWorlds = /* @__PURE__ */ new Map();
	workspaceRegistry;
	refreshTail = Promise.resolve();
	initialRefresh;
	constructor(ctx, config) {
		super(ctx, "remoteSshManager");
		this.entry = config;
		this.current = this.entry;
		this.validate(this.entry);
		const initialEntry = this.entry;
		const settingsPath = join(dirname(initialEntry.aliasRoot), "config.json");
		const modernSettings = typeof ctx.settings.register !== "function";
		this.initialRefresh = modernSettings ? (async () => {
			let next = initialEntry;
			try {
				next = RemoteSshManager.Config({
					...initialEntry,
					...JSON.parse(await readFile(settingsPath, "utf8"))
				});
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			this.validate(next);
			await this.queueRefresh(next);
		})() : this.queueRefresh(this.entry);
		ctx.inject(["workspaceRegistry"], (workspaceCtx) => {
			this.workspaceRegistry = workspaceCtx.workspaceRegistry;
			this.registerAllWorkspaces().catch((error) => {
				this.ctx.logger.error(error);
			});
			workspaceCtx.effect(() => () => {
				if (this.workspaceRegistry === workspaceCtx.workspaceRegistry) this.workspaceRegistry = void 0;
			}, "Remote SSH workspace registry attachment");
		});
		if (modernSettings) this.settings = { replace: async (next) => {
			await this.initialRefresh;
			this.validate(next);
			await mkdir(dirname(settingsPath), { recursive: true });
			const temporary = `${settingsPath}.${randomUUID()}.tmp`;
			await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
			await rename(temporary, settingsPath);
			await this.queueRefresh(next);
		} };
		else {
			const scope = ctx.settings.register(SETTINGS_NAMESPACE, RemoteSshManager.Config, {
				base: this.entry,
				applies: "live",
				validate: (value) => {
					this.validate(value);
				}
			});
			this.settings = scope;
			this.queueRefresh(scope.get());
			const unwatch = scope.watch((next) => this.queueRefresh(next));
			ctx.effect(() => () => {
				unwatch();
				if (this.settings === scope) this.settings = void 0;
			}, "Remote SSH settings watch");
		}
		ctx.effect(() => async () => {
			await this.refreshTail;
			const contexts = await Promise.allSettled(this.contexts.values());
			await Promise.allSettled(contexts.flatMap((result) => result.status === "fulfilled" ? [result.value.ctx.fiber.dispose()] : []));
			this.contexts.clear();
			const shells = await Promise.allSettled(this.shellContexts.values());
			await Promise.allSettled(shells.flatMap((result) => result.status === "fulfilled" ? [result.value.ctx.fiber.dispose()] : []));
			this.shellContexts.clear();
			const hosts = await Promise.allSettled(this.hosts.values());
			await Promise.allSettled(hosts.flatMap((result) => result.status === "fulfilled" ? [this.disposeHost(result.value)] : []));
			this.hosts.clear();
			const proxies = await Promise.allSettled(this.webProxies.values());
			await Promise.allSettled(proxies.flatMap((result) => result.status === "fulfilled" ? [result.value.dispose()] : []));
			this.webProxies.clear();
			const tunnels = await Promise.allSettled(this.backendTunnels.values());
			await Promise.allSettled(tunnels.flatMap((result) => result.status === "fulfilled" ? [result.value.dispose()] : []));
			this.backendTunnels.clear();
			this.backendProgressListeners.clear();
		}, "Remote SSH workspace context teardown");
	}
	/** Wait until the composition-layer catalog has published its aliases. */
	async [Service.init]() {
		await this.initialRefresh;
	}
	/** Current detached catalog snapshot. */
	snapshot() {
		return structuredClone(this.current);
	}
	/** Select one custom OpenSSH config, or restore the platform defaults. */
	async setSshConfigFile(path) {
		await this.updateUserPreferences({ sshConfigFile: path ?? "" });
	}
	/** Update the native remote editor preference and its download fallback limit. */
	async setOpenFileSettings(input) {
		await this.updateUserPreferences({
			openFileMode: input.mode,
			openFileEditorPath: input.editorPath ?? ""
		});
	}
	/** Atomically update user-facing plugin preferences. Empty paths clear overrides. */
	async updateUserPreferences(input) {
		const next = this.snapshot();
		if (input.sshConfigFile !== void 0) {
			if (input.sshConfigFile.trim() === "") delete next.sshConfigFile;
			else next.sshConfigFile = input.sshConfigFile.trim();
		}
		if (input.openFileMode !== void 0) next.openFileMode = input.openFileMode;
		if (input.openFileEditorPath !== void 0) {
			if (input.openFileEditorPath.trim() === "") delete next.openFileEditorPath;
			else next.openFileEditorPath = input.openFileEditorPath.trim();
		}
		this.validate(next);
		await this.replaceSettings(next);
	}
	/** Browse directories through the server's shared AHP filesystem connection. */
	async listRemoteDirectory(server, requestedPath) {
		const connection = await (await this.hostContext(server)).remote.getConnection();
		const home = connection.defaultDirectory === void 0 ? "/" : posixPathFromFileUri(String(connection.defaultDirectory));
		const path = posix.normalize(requestedPath?.trim() || home);
		if (!posix.isAbsolute(path)) throw new Error("remote directory path must be an absolute POSIX path");
		const listed = await connection.client.resourceList({ uri: fileUriFromPosixPath(path) });
		return {
			path,
			home,
			...path === "/" ? {} : { parent: posix.dirname(path) },
			entries: listed.entries.filter((entry) => entry.type === "directory").sort((left, right) => left.name.localeCompare(right.name)).map((entry) => ({
				name: entry.name,
				path: posix.join(path, entry.name)
			}))
		};
	}
	/** Create a server entry through the settings provider. */
	async addServer(input) {
		const server = {
			...input,
			id: input.id ?? randomUUID()
		};
		const next = this.snapshot();
		next.servers.push(server);
		this.validate(next);
		await this.replaceSettings(next);
		return server;
	}
	/** Create and register one remote workspace alias. */
	async addWorkspace(serverId, remotePath) {
		const workspace = {
			id: randomUUID(),
			serverId,
			remotePath
		};
		const next = this.snapshot();
		next.workspaces.push(workspace);
		this.validate(next);
		await this.replaceSettings(next);
		await this.refreshTail;
		const route = this.routeByWorkspaceId.get(workspace.id);
		if (route === void 0) throw new Error(`remote workspace '${workspace.id}' was not published`);
		return route;
	}
	/** Rename one remote workspace without changing its execution route. */
	async renameWorkspace(id, title) {
		const normalizedTitle = title.trim();
		if (normalizedTitle.length === 0) throw new Error("remote workspace title must not be empty");
		const next = this.snapshot();
		const workspace = next.workspaces.find((candidate) => candidate.id === id);
		if (workspace === void 0) throw new Error(`dsh-ssh-workspace: unknown remote workspace '${id}'`);
		workspace.title = normalizedTitle;
		this.validate(next);
		await this.replaceSettings(next);
		const route = this.routeByWorkspaceId.get(id);
		if (route === void 0) throw new Error(`remote workspace '${id}' was not published`);
		return route;
	}
	/** Remove execution routing while retaining alias, Workspace, and Session history. */
	async removeWorkspace(id) {
		const next = this.snapshot();
		const before = next.workspaces.length;
		next.workspaces = next.workspaces.filter((workspace) => workspace.id !== id);
		if (next.workspaces.length === before) return false;
		await this.replaceSettings(next);
		return true;
	}
	/** Remove one server and tombstone all of its workspace execution routes. */
	async removeServer(id) {
		const next = this.snapshot();
		const before = next.servers.length;
		next.servers = next.servers.filter((server) => server.id !== id);
		if (next.servers.length === before) return false;
		next.workspaces = next.workspaces.filter((workspace) => workspace.serverId !== id);
		await this.replaceSettings(next);
		return true;
	}
	/** Pre-register a local directory with the stable LOCAL display prefix. */
	async adoptLocalWorkspace(path) {
		const registry = this.workspaceRegistry;
		if (registry === void 0) throw new Error("dsh-ssh-workspace: workspace registry is unavailable");
		const absolute = resolve(path);
		const title = `LOCAL > ${basename(absolute)}`;
		const workspace = await registry.create(absolute, title);
		if (workspace.title !== title) await workspace.setTitle(title);
		return workspace.path;
	}
	/** Resolve a tool path/cwd into the only execution world allowed to handle it. */
	route(path, cwd) {
		const cwdRoute = cwd === void 0 ? void 0 : this.findAlias(cwd);
		if (cwdRoute !== void 0) return cwdRoute;
		if (cwd !== void 0 && this.wasRemoteAlias(cwd)) throw new Error(`dsh-ssh-workspace: workspace alias is no longer configured: ${cwd}`);
		if (path !== void 0 && isAbsolute(path)) {
			const pathRoute = this.findAlias(path);
			if (pathRoute !== void 0) return pathRoute;
			if (this.wasRemoteAlias(path)) throw new Error(`dsh-ssh-workspace: workspace alias is no longer configured: ${path}`);
		}
		const remotePathRoute = cwd === void 0 ? void 0 : this.findRemotePath(cwd);
		if (remotePathRoute !== void 0) return remotePathRoute;
		const absoluteRemotePathRoute = path === void 0 ? void 0 : this.findRemotePath(path);
		if (absoluteRemotePathRoute !== void 0) return absoluteRemotePathRoute;
		return { kind: "local" };
	}
	/** Pin shell dispatch to the session workspace, regardless of an explicit tool workdir. */
	bindSession(sessionId, owner, cwd) {
		if (cwd !== void 0 && this.wasRemoteAlias(cwd)) {
			const route = this.findAlias(cwd);
			if (route !== void 0) {
				this.sessionWorlds.set(sessionId, {
					owner,
					workspaceId: route.workspace.id
				});
				return route;
			}
			this.sessionWorlds.set(sessionId, {
				owner,
				workspaceId: null,
				removedAlias: cwd
			});
			return;
		}
		const route = cwd === void 0 ? { kind: "local" } : this.route(void 0, cwd);
		this.sessionWorlds.set(sessionId, {
			owner,
			workspaceId: route.kind === "remote" ? route.workspace.id : null
		});
		return route;
	}
	/** Release only the binding owned by this exact live Agent. */
	unbindSession(sessionId, owner) {
		if (this.sessionWorlds.get(sessionId)?.owner === owner) this.sessionWorlds.delete(sessionId);
	}
	/** Resolve the execution world bound to a live session without consulting path text. */
	sessionRoute(sessionId) {
		const bound = this.sessionWorlds.get(sessionId);
		if (bound === void 0) return void 0;
		if (bound.removedAlias !== void 0) throw new Error(`dsh-ssh-workspace: workspace alias is no longer configured: ${bound.removedAlias}`);
		return bound.workspaceId === null ? { kind: "local" } : this.workspace(bound.workspaceId);
	}
	/** Resolve shell calls using their durable session world before considering workdir text. */
	routeShell(workdir, sessionId) {
		const bound = sessionId === void 0 ? void 0 : this.sessionRoute(sessionId);
		if (bound !== void 0) return bound;
		return this.route(void 0, workdir);
	}
	/** Model-facing shell dialect for a workspace cwd. Remote workspaces are POSIX today. */
	dialectFor(cwd) {
		if (cwd !== void 0 && (this.findAlias(cwd) !== void 0 || this.wasRemoteAlias(cwd) || this.findRemotePath(cwd) !== void 0)) return "bash";
		return process.platform === "win32" ? "pwsh" : "bash";
	}
	/** Presentation-only logical cwd that never exposes the local UUID alias. */
	displayRemoteCwd(route, workdir) {
		const remotePath = workdir === void 0 || workdir.trim() === "" ? route.workspace.remotePath : route.mapper.toRemotePath(workdir, route.aliasPath);
		const normalized = posix.normalize(remotePath);
		const workspaceRoot = posix.normalize(route.workspace.remotePath);
		const relativePath = posix.relative(workspaceRoot, normalized);
		const workspaceTitle = route.workspace.title ?? `${route.server.label} > ${posix.basename(workspaceRoot) || workspaceRoot}`;
		if (relativePath === "" || relativePath !== ".." && !relativePath.startsWith("../") && !posix.isAbsolute(relativePath)) return posix.join("/", workspaceTitle, relativePath);
		return posix.join("/", `${route.server.label} > remote`, normalized);
	}
	/** Lookup a published route by its durable workspace id. */
	workspace(id) {
		const route = this.routeByWorkspaceId.get(id);
		if (route === void 0) throw new Error(`dsh-ssh-workspace: unknown or removed remote workspace '${id}'`);
		return route;
	}
	/** Lazily boot the AHP filesystem context for one remote workspace. */
	async workspaceContext(route) {
		let pending = this.contexts.get(route.workspace.id);
		if (pending === void 0) {
			pending = this.createWorkspaceContext(route);
			this.contexts.set(route.workspace.id, pending);
			pending.catch(() => {
				if (this.contexts.get(route.workspace.id) === pending) this.contexts.delete(route.workspace.id);
			});
		}
		return pending;
	}
	/** Resolve the SSH executable/options shared by all channels for this host. */
	sshTransport(route) {
		return this.transportFor(route.server);
	}
	/** Open the UI-neutral Host protocol over one persistent SSH forward. */
	async connectBackend(server) {
		const key = backendRuntimeKey(server);
		let pending = this.backendTunnels.get(key);
		if (pending !== void 0) {
			const existing = await pending.catch(() => void 0);
			if (existing?.alive === true) {
				if (!existing.connected) {
					this.publishBackendProgress(server, { stage: "reconnecting" });
					await existing.ready();
				}
				this.publishBackendProgress(server, { stage: "ready" });
				return existing;
			}
			if (existing !== void 0) await existing.dispose();
			this.backendTunnels.delete(key);
		}
		const transport = this.transportFor(server);
		this.publishBackendProgress(server, { stage: "connecting" });
		pending = RemoteDshHostConnection.open({
			sshExecutable: transport.executable,
			sshArgs: transport.args,
			sshTarget: server.sshTarget,
			remotePort: server.backendPort ?? DEFAULT_DSH_BACKEND_PORT,
			startupTimeoutMs: this.current.startupTimeoutMs,
			onProgress: (progress) => {
				this.publishBackendProgress(server, progress);
			}
		});
		pending = pending.then((tunnel) => {
			this.publishBackendProgress(server, { stage: "ready" });
			return tunnel;
		}, (error) => {
			this.publishBackendProgress(server, {
				stage: "failed",
				error: (error instanceof Error ? error.message : String(error)).slice(0, 1e3)
			});
			throw error;
		});
		this.backendTunnels.set(key, pending);
		pending.catch(() => {
			if (this.backendTunnels.get(key) === pending) this.backendTunnels.delete(key);
		});
		return pending;
	}
	/** Observe one Host installation/attachment without requiring the Host to exist yet. */
	watchBackendProgress(server, listener) {
		const key = backendRuntimeKey(server);
		let listeners = this.backendProgressListeners.get(key);
		if (listeners === void 0) {
			listeners = /* @__PURE__ */ new Set();
			this.backendProgressListeners.set(key, listeners);
		}
		listeners.add(listener);
		const current = this.backendProgress.get(key);
		if (current !== void 0) listener(current);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.backendProgressListeners.delete(key);
		};
	}
	publishBackendProgress(server, progress) {
		const key = backendRuntimeKey(server);
		this.backendProgress.set(key, progress);
		for (const listener of this.backendProgressListeners.get(key) ?? []) try {
			listener(progress);
		} catch {}
	}
	/** Open a typed, UI-neutral client on the shared Host tunnel. */
	async connectBackendClient(server) {
		const { RemoteDshHostClient } = await import("./backend-client.js");
		return new RemoteDshHostClient(await this.connectBackend(server), this.current.requestTimeoutMs);
	}
	/** Serve the local Web assets while proxying the unchanged Host protocol. */
	async connectWebBackend(server, localUiPort) {
		const key = webBackendRuntimeKey(server, localUiPort);
		let pending = this.webProxies.get(key);
		if (pending !== void 0) {
			const existing = await pending.catch(() => void 0);
			if (existing?.alive === true) return existing;
			if (existing !== void 0) await existing.dispose();
			this.webProxies.delete(key);
		}
		const tunnel = await this.connectBackend(server);
		pending = RemoteDshWebProxy.attach(tunnel, localUiPort);
		this.webProxies.set(key, pending);
		pending.catch(() => {
			if (this.webProxies.get(key) === pending) this.webProxies.delete(key);
		});
		return pending;
	}
	/** AHP-backed shell view sharing the host runtime but retaining workspace path mapping. */
	async workspaceShell(route, dialect) {
		const key = `${route.workspace.id}:${dialect}`;
		let pending = this.shellContexts.get(key);
		if (pending === void 0) {
			pending = this.createWorkspaceShellContext(route, dialect);
			this.shellContexts.set(key, pending);
			pending.catch(() => {
				if (this.shellContexts.get(key) === pending) this.shellContexts.delete(key);
			});
		}
		return (await pending).shell;
	}
	queueRefresh(config) {
		const run = this.refreshTail.then(() => this.publish(config));
		this.refreshTail = run.then(() => {}, () => {});
		return run;
	}
	async publish(config) {
		this.validate(config);
		await mkdir(resolve(tmpdir(), "dsh-ssh"), { recursive: true });
		const servers = new Map(config.servers.map((server) => [server.id, server]));
		const nextRoutes = /* @__PURE__ */ new Map();
		const nextById = /* @__PURE__ */ new Map();
		for (const workspace of config.workspaces) {
			const server = servers.get(workspace.serverId);
			const aliasPath = resolve(workspace.aliasPath ?? resolve(config.aliasRoot, workspace.id));
			await mkdir(aliasPath, { recursive: true });
			const canonicalAlias = resolve(aliasPath);
			const route = {
				kind: "remote",
				server,
				workspace,
				aliasPath: canonicalAlias,
				mapper: new WorkspacePathMapper(canonicalAlias, workspace.remotePath)
			};
			nextRoutes.set(normalizeLocal(canonicalAlias), route);
			nextById.set(workspace.id, route);
			this.remoteAliases.add(normalizeLocal(canonicalAlias));
		}
		for (const [id, pending] of this.contexts) {
			const previous = this.routeByWorkspaceId.get(id);
			const next = nextById.get(id);
			if (previous === void 0 || next === void 0 || routeRuntimeKey(previous) !== routeRuntimeKey(next)) {
				const settled = await Promise.resolve(pending).catch(() => void 0);
				if (settled !== void 0) await settled.ctx.fiber.dispose();
				this.contexts.delete(id);
			}
		}
		for (const [key, pending] of this.shellContexts) {
			const id = key.slice(0, key.lastIndexOf(":"));
			const previous = this.routeByWorkspaceId.get(id);
			const next = nextById.get(id);
			if (previous === void 0 || next === void 0 || routeRuntimeKey(previous) !== routeRuntimeKey(next)) {
				const settled = await Promise.resolve(pending).catch(() => void 0);
				if (settled !== void 0) await settled.ctx.fiber.dispose();
				this.shellContexts.delete(key);
			}
		}
		for (const [id, pending] of this.hosts) {
			const next = servers.get(id);
			const settled = await Promise.resolve(pending).catch(() => void 0);
			if (next === void 0 || settled === void 0 || settled.key !== serverRuntimeKey(next)) {
				if (settled !== void 0) await this.disposeHost(settled);
				this.hosts.delete(id);
			}
		}
		for (const [key, pending] of this.webProxies) {
			const [serverId, expectedRuntimeKey] = JSON.parse(key);
			const next = servers.get(serverId);
			if (next === void 0 || serverRuntimeKey(next) !== expectedRuntimeKey) {
				const settled = await Promise.resolve(pending).catch(() => void 0);
				if (settled !== void 0) await settled.dispose();
				this.webProxies.delete(key);
			}
		}
		for (const [key, pending] of this.backendTunnels) {
			const [serverId, expectedRuntimeKey] = JSON.parse(key);
			const next = servers.get(serverId);
			if (next === void 0 || serverRuntimeKey(next) !== expectedRuntimeKey) {
				const settled = await Promise.resolve(pending).catch(() => void 0);
				if (settled !== void 0) await settled.dispose();
				this.backendTunnels.delete(key);
			}
		}
		this.routes.clear();
		this.routeByWorkspaceId.clear();
		for (const [key, value] of nextRoutes) this.routes.set(key, value);
		for (const [key, value] of nextById) this.routeByWorkspaceId.set(key, value);
		this.current = structuredClone(config);
		await this.registerAllWorkspaces();
	}
	async registerAllWorkspaces() {
		const registry = this.workspaceRegistry;
		if (registry === void 0) return;
		for (const route of this.routeByWorkspaceId.values()) {
			const title = route.workspace.title ?? `${route.server.label} > ${posix.basename(route.workspace.remotePath) || route.workspace.remotePath}`;
			const workspace = await registry.create(route.aliasPath, title);
			if (workspace.title !== title) await workspace.setTitle(title);
		}
	}
	findAlias(path) {
		const absolute = normalizeLocal(resolve(path));
		let best;
		for (const [alias, route] of this.routes) {
			if (!isContained(alias, absolute)) continue;
			if (best === void 0 || alias.length > normalizeLocal(best.aliasPath).length) best = route;
		}
		return best;
	}
	findRemotePath(path) {
		if (!posix.isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) return void 0;
		const normalized = posix.normalize(path);
		let best;
		let bestLength = -1;
		for (const route of this.routeByWorkspaceId.values()) {
			const root = posix.normalize(route.workspace.remotePath);
			const rel = posix.relative(root, normalized);
			if (rel !== "" && (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel))) continue;
			if (root.length > bestLength) {
				best = route;
				bestLength = root.length;
			} else if (root.length === bestLength && best?.workspace.id !== route.workspace.id) throw new Error(`dsh-ssh-workspace: remote path matches multiple workspaces: ${path}`);
		}
		return best;
	}
	wasRemoteAlias(path) {
		const absolute = normalizeLocal(resolve(path));
		return [...this.remoteAliases].some((alias) => isContained(alias, absolute));
	}
	async createWorkspaceContext(route) {
		const host = await this.hostContext(route.server);
		const child = new Context();
		try {
			child.provide("remoteSsh", host.remote);
			await child.plugin(RemoteSshFileSystem, {
				remoteWorkspace: route.workspace.remotePath,
				localWorkspace: route.aliasPath
			});
			return {
				ctx: child,
				fs: child.fs,
				remote: host.remote
			};
		} catch (error) {
			await child.fiber.dispose().catch(() => {});
			throw error;
		}
	}
	async hostContext(server) {
		let pending = this.hosts.get(server.id);
		if (pending === void 0) {
			pending = this.createHostContext(server);
			this.hosts.set(server.id, pending);
			pending.catch(() => {
				if (this.hosts.get(server.id) === pending) this.hosts.delete(server.id);
			});
		}
		return pending;
	}
	async createWorkspaceShellContext(route, dialect) {
		const host = await this.hostContext(route.server);
		const child = new Context();
		try {
			child.provide("remoteSsh", host.remote);
			await child.plugin(RemoteSshShellExecutor, {
				localWorkspace: route.aliasPath,
				remoteWorkspace: route.workspace.remotePath,
				shellCommand: dialect
			});
			return {
				ctx: child,
				shell: child.shell,
				remote: host.remote
			};
		} catch (error) {
			await child.fiber.dispose().catch(() => {});
			throw error;
		}
	}
	async createHostContext(server) {
		const child = new Context();
		const transport = this.transportFor(server);
		try {
			await child.plugin(RemoteSshRuntime, {
				sshTarget: server.sshTarget,
				sshExecutable: transport.executable,
				sshArgs: transport.args,
				remoteCodeCommand: server.remoteCodeCommand ?? "code",
				remoteAccessRoot: "/",
				startupTimeoutMs: this.current.startupTimeoutMs,
				requestTimeoutMs: this.current.requestTimeoutMs
			});
			return {
				ctx: child,
				remote: child.remoteSsh,
				key: serverRuntimeKey(server),
				server,
				transport
			};
		} catch (error) {
			await child.fiber.dispose().catch(() => {});
			throw error;
		}
	}
	transportFor(server) {
		let executable = server.sshExecutable ?? "ssh";
		let multiplexed = process.platform !== "win32";
		if (process.platform === "win32") multiplexed = false;
		const args = [...server.sshArgs ?? []];
		if (multiplexed) {
			const digest = createHash("sha256").update(`${process.pid}:${serverRuntimeKey(server)}`).digest("hex").slice(0, 16);
			const controlPath = resolve(tmpdir(), "dsh-ssh", digest).replaceAll("\\", "/");
			args.push("-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", `ControlPath=${controlPath}`);
		}
		return {
			executable,
			args,
			multiplexed
		};
	}
	async disposeHost(host) {
		await host.ctx.fiber.dispose();
		if (!host.transport.multiplexed) return;
		await closeControlMaster(host.transport, host.server.sshTarget);
	}
	async replaceSettings(next) {
		if (this.settings === void 0) throw new Error("dsh-ssh-workspace: settings service is unavailable");
		await this.settings.replace(next);
		await this.refreshTail;
	}
	validate(config) {
		if (!isAbsolute(config.aliasRoot)) throw new Error("dsh-ssh-workspace: aliasRoot must be an absolute local path");
		if (config.sshConfigFile !== void 0 && !isAbsolute(config.sshConfigFile)) throw new Error("dsh-ssh-workspace: sshConfigFile must be an absolute path");
		if (config.openFileEditorPath !== void 0 && !isAbsolute(config.openFileEditorPath)) throw new Error("dsh-ssh-workspace: openFileEditorPath must be an absolute path");
		if (config.openFileMode === "custom" && config.openFileEditorPath === void 0) throw new Error("dsh-ssh-workspace: custom openFileMode requires openFileEditorPath");
		if (!Number.isSafeInteger(config.openFileDownloadMaxBytes) || config.openFileDownloadMaxBytes <= 0) throw new Error("dsh-ssh-workspace: openFileDownloadMaxBytes must be a positive integer");
		if (!Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs <= 0) throw new Error("dsh-ssh-workspace: startupTimeoutMs must be a positive integer");
		if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) throw new Error("dsh-ssh-workspace: requestTimeoutMs must be a positive integer");
		const serverIds = /* @__PURE__ */ new Set();
		for (const server of config.servers) {
			if (!ID_PATTERN.test(server.id) || serverIds.has(server.id)) throw new Error(`dsh-ssh-workspace: invalid or duplicate server id '${server.id}'`);
			if (server.label.trim().length === 0 || server.sshTarget.trim().length === 0) throw new Error(`dsh-ssh-workspace: server '${server.id}' requires label and sshTarget`);
			if (server.sshExecutable !== void 0 && server.sshExecutable.trim().length === 0) throw new Error(`dsh-ssh-workspace: server '${server.id}' sshExecutable must be non-empty`);
			if (server.backendPort !== void 0 && (!Number.isSafeInteger(server.backendPort) || server.backendPort < 0 || server.backendPort > 65535)) throw new Error(`dsh-ssh-workspace: server '${server.id}' backendPort must be between 0 and 65535`);
			serverIds.add(server.id);
		}
		const workspaceIds = /* @__PURE__ */ new Set();
		const aliases = /* @__PURE__ */ new Set();
		for (const workspace of config.workspaces) {
			if (!ID_PATTERN.test(workspace.id) || workspaceIds.has(workspace.id)) throw new Error(`dsh-ssh-workspace: invalid or duplicate workspace id '${workspace.id}'`);
			if (!serverIds.has(workspace.serverId)) throw new Error(`dsh-ssh-workspace: workspace '${workspace.id}' refers to unknown server '${workspace.serverId}'`);
			if (!posix.isAbsolute(workspace.remotePath)) throw new Error(`dsh-ssh-workspace: workspace '${workspace.id}' remotePath must be an absolute POSIX path`);
			if (workspace.title !== void 0 && workspace.title.trim().length === 0) throw new Error(`dsh-ssh-workspace: workspace '${workspace.id}' title must be non-empty`);
			const alias = normalizeLocal(resolve(workspace.aliasPath ?? resolve(config.aliasRoot, workspace.id)));
			if (aliases.has(alias)) throw new Error(`dsh-ssh-workspace: duplicate workspace alias '${alias}'`);
			aliases.add(alias);
			workspaceIds.add(workspace.id);
		}
	}
};
function serverRuntimeKey(server) {
	return JSON.stringify([
		server.sshTarget,
		server.sshArgs ?? [],
		server.remoteCodeCommand ?? "code",
		server.sshExecutable ?? null,
		server.backendPort ?? DEFAULT_DSH_BACKEND_PORT
	]);
}
function backendRuntimeKey(server) {
	return JSON.stringify([server.id, serverRuntimeKey(server)]);
}
function webBackendRuntimeKey(server, localUiPort) {
	return JSON.stringify([
		server.id,
		serverRuntimeKey(server),
		localUiPort
	]);
}
function routeRuntimeKey(route) {
	return JSON.stringify([
		serverRuntimeKey(route.server),
		route.workspace.remotePath,
		normalizeLocal(route.aliasPath)
	]);
}
async function closeControlMaster(transport, target) {
	await new Promise((resolvePromise) => {
		const child = spawn(transport.executable, [
			...transport.args,
			"-O",
			"exit",
			target
		], {
			windowsHide: true,
			stdio: "ignore"
		});
		const timer = setTimeout(() => {
			child.kill();
			resolvePromise();
		}, 3e3);
		child.once("error", () => {
			clearTimeout(timer);
			resolvePromise();
		});
		child.once("close", () => {
			clearTimeout(timer);
			resolvePromise();
		});
	});
}
function normalizeLocal(path) {
	return process.platform === "win32" ? path.toLowerCase() : path;
}
function isContained(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
//#endregion
export { RemoteSshManager, RemoteSshManager as default };
