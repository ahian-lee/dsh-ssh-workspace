import { n as defaultSshConfigFiles, r as discoverSshConfigHosts, t as appendSshHost } from "./config-BN3gCBP-.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, posix, resolve } from "node:path";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
//#region src/ssh/open-file.ts
const REMOTE_SSH_EXTENSIONS = /* @__PURE__ */ new Set(["ms-vscode-remote.remote-ssh", "jeanp413.open-remote-ssh"]);
const EDITORS = {
	vscode: {
		id: "vscode",
		command: "code",
		windowsLocations: (env) => compact([
			env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
			env.ProgramW6432 && resolve(env.ProgramW6432, "Microsoft VS Code", "Code.exe"),
			env.ProgramFiles && resolve(env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
			env["ProgramFiles(x86)"] && resolve(env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe")
		]),
		macLocations: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
	},
	cursor: {
		id: "cursor",
		command: "cursor",
		windowsLocations: (env) => compact([
			env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe"),
			env.ProgramW6432 && resolve(env.ProgramW6432, "Cursor", "Cursor.exe"),
			env.ProgramFiles && resolve(env.ProgramFiles, "Cursor", "Cursor.exe")
		]),
		macLocations: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"]
	},
	windsurf: {
		id: "windsurf",
		command: "windsurf",
		windowsLocations: (env) => compact([
			env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, "Programs", "Windsurf", "Windsurf.exe"),
			env.ProgramW6432 && resolve(env.ProgramW6432, "Windsurf", "Windsurf.exe"),
			env.ProgramFiles && resolve(env.ProgramFiles, "Windsurf", "Windsurf.exe")
		]),
		macLocations: ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"]
	},
	vscodium: {
		id: "vscodium",
		command: "codium",
		windowsLocations: (env) => compact([
			env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, "Programs", "VSCodium", "VSCodium.exe"),
			env.ProgramW6432 && resolve(env.ProgramW6432, "VSCodium", "VSCodium.exe"),
			env.ProgramFiles && resolve(env.ProgramFiles, "VSCodium", "VSCodium.exe")
		]),
		macLocations: ["/Applications/VSCodium.app/Contents/Resources/app/bin/codium"]
	}
};
const AUTO_ORDER = [
	"vscode",
	"cursor",
	"windsurf",
	"vscodium"
];
const editorSupport = /* @__PURE__ */ new Map();
/** Open a remote path in a native VSC Remote-SSH window, downloading only as fallback. */
async function openRemoteFile(manager, workspaceId, inputPath) {
	const route = manager.workspace(workspaceId);
	const remotePath = route.mapper.toRemotePath(inputPath, route.aliasPath);
	const config = manager.snapshot();
	let fallbackReason;
	if (config.openFileMode !== "download") {
		const candidates = await editorCandidates(config.openFileMode, config.openFileEditorPath);
		for (const candidate of candidates) {
			if (!await supportsRemoteSsh(candidate)) {
				fallbackReason = `${candidate.id} does not have a Remote SSH extension`;
				continue;
			}
			try {
				await launchEditor(candidate, route.server.sshTarget, remotePath);
				return {
					kind: "editor",
					editor: candidate.id,
					remotePath
				};
			} catch (error) {
				fallbackReason = errorMessage(error);
			}
		}
		fallbackReason ??= "no supported VS Code-compatible editor was found";
	}
	return {
		kind: "download",
		localPath: await materializeRemoteFile(manager, workspaceId, remotePath, config.openFileDownloadMaxBytes),
		remotePath,
		...fallbackReason === void 0 ? {} : { fallbackReason }
	};
}
/** VS Code-compatible CLI arguments; each value is passed without a shell. */
function editorLaunchArgs(sshTarget, remotePath) {
	if (/[/\r\n\0]/.test(sshTarget)) throw new Error("SSH Host alias contains unsupported characters");
	if (!posix.isAbsolute(remotePath)) throw new Error(`remote open path must be absolute: ${remotePath}`);
	return [
		"--remote",
		`ssh-remote+${sshTarget}`,
		"--reuse-window",
		remotePath
	];
}
/** Preserve a useful extension while preventing cache traversal and Windows device names. */
function safeDownloadedName(remotePath) {
	let name = basename(remotePath).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
	if (name.length === 0) name = "remote-file";
	const stem = name.split(".", 1)[0]?.toUpperCase();
	if (stem !== void 0 && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = `_${name}`;
	return name.slice(0, 180);
}
async function materializeRemoteFile(manager, workspaceId, remotePath, maxBytes) {
	const route = manager.workspace(workspaceId);
	const workspace = await manager.workspaceContext(route);
	const target = await workspace.fs.resolve(remotePath);
	const info = await workspace.fs.stat(target);
	if (info === void 0) throw new Error(`remote file does not exist: ${remotePath}`);
	if (info.type !== "file") throw new Error(`download fallback only supports files: ${remotePath}`);
	if (info.size !== void 0 && info.size > maxBytes) throw new Error(`remote file exceeds the download limit of ${String(maxBytes)} bytes: ${remotePath}`);
	const bytes = await workspace.fs.readBytes(target, void 0, maxBytes);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const directory = resolve(tmpdir(), "dsh-ssh-workspace", "open-file", workspaceId, digest.slice(0, 20));
	const localPath = resolve(directory, safeDownloadedName(remotePath));
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(localPath, bytes, { flag: "wx" });
	} catch (error) {
		if (!isAlreadyExists(error)) throw error;
	}
	return localPath;
}
async function editorCandidates(mode, customPath) {
	if (mode === "custom") {
		if (customPath === void 0 || !isAbsolute(customPath) || !await executableExists(customPath)) return [];
		return [await editorInvocation("custom", customPath)];
	}
	const ids = mode === "auto" ? AUTO_ORDER : [mode];
	const found = [];
	for (const id of ids) {
		const executable = await findEditorExecutable(EDITORS[id]);
		if (executable !== void 0) found.push(await editorInvocation(id, executable));
	}
	return found;
}
async function editorInvocation(id, executable) {
	if (process.platform !== "win32" || !executable.toLowerCase().endsWith(".exe")) return {
		id,
		executable,
		prefixArgs: []
	};
	const cli = await findWindowsVscCli(executable);
	if (cli === void 0) return {
		id,
		executable,
		prefixArgs: []
	};
	return {
		id,
		executable,
		prefixArgs: [cli],
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1"
		}
	};
}
/** Resolve the versioned CLI entry used by VSC application executables on Windows. */
async function findWindowsVscCli(executable) {
	const root = dirname(executable);
	const direct = resolve(root, "resources", "app", "out", "cli.js");
	if (await pathExists(direct)) return direct;
	let children;
	try {
		children = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
	} catch {
		return;
	}
	for (const child of children) {
		const candidate = resolve(root, child, "resources", "app", "out", "cli.js");
		if (await pathExists(candidate)) return candidate;
	}
}
async function findEditorExecutable(editor) {
	const pathCandidate = await findExecutableOnPath(editor.command);
	if (pathCandidate !== void 0) return pathCandidate;
	const candidates = process.platform === "win32" ? editor.windowsLocations(process.env) : process.platform === "darwin" ? editor.macLocations : [];
	for (const candidate of candidates) if (await executableExists(candidate)) return candidate;
}
async function findExecutableOnPath(command) {
	const suffixes = process.platform === "win32" ? [".exe"] : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) for (const suffix of suffixes) {
		const candidate = resolve(directory, `${command}${suffix}`);
		if (await executableExists(candidate)) return candidate;
	}
}
async function executableExists(path) {
	try {
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
async function pathExists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
async function supportsRemoteSsh(editor) {
	const key = JSON.stringify([editor.executable, editor.prefixArgs]);
	let pending = editorSupport.get(key);
	if (pending === void 0) {
		pending = capture(editor, ["--list-extensions"], 8e3).then((output) => {
			return output.split(/\r?\n/).map((value) => value.trim().toLowerCase()).filter(Boolean).some((extension) => REMOTE_SSH_EXTENSIONS.has(extension) || extension.endsWith(".remote-ssh"));
		}, () => false);
		editorSupport.set(key, pending);
	}
	return pending;
}
async function launchEditor(editor, sshTarget, remotePath) {
	const child = spawn(editor.executable, [...editor.prefixArgs, ...editorLaunchArgs(sshTarget, remotePath)], {
		detached: true,
		windowsHide: true,
		stdio: "ignore",
		...editor.env === void 0 ? {} : { env: editor.env }
	});
	await new Promise((resolvePromise, reject) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === void 0) resolvePromise();
			else reject(error);
		};
		const timer = setTimeout(() => {
			child.unref();
			finish();
		}, 1500);
		child.once("error", (error) => {
			finish(error);
		});
		child.once("close", (code) => {
			if (code === 0) finish();
			else finish(/* @__PURE__ */ new Error(`editor exited with code ${String(code)}`));
		});
	});
}
async function capture(editor, args, timeoutMs) {
	const child = spawn(editor.executable, [...editor.prefixArgs, ...args], {
		windowsHide: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		...editor.env === void 0 ? {} : { env: editor.env }
	});
	const chunks = [];
	let size = 0;
	child.stdout.on("data", (chunk) => {
		if (size >= 1048576) return;
		chunks.push(chunk.subarray(0, 1048576 - size));
		size += chunk.length;
	});
	const timer = setTimeout(() => {
		child.kill();
	}, timeoutMs);
	const code = await new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("close", resolvePromise);
	}).finally(() => {
		clearTimeout(timer);
	});
	if (code !== 0) throw new Error(`editor probe exited with code ${String(code)}`);
	return Buffer.concat(chunks).toString("utf8");
}
function compact(values) {
	return values.filter((value) => value !== void 0);
}
function isAlreadyExists(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/profiles/web.ts
const REMOTE_SSH_STATE_PATH = "/plugins/dsh-ssh-workspace/state";
const REMOTE_SSH_SERVER_PATH = "/plugins/dsh-ssh-workspace/server";
const REMOTE_SSH_SERVER_REMOVE_PATH = "/plugins/dsh-ssh-workspace/server/remove";
const REMOTE_SSH_WORKSPACE_PATH = "/plugins/dsh-ssh-workspace/workspace";
const REMOTE_SSH_WORKSPACE_REMOVE_PATH = "/plugins/dsh-ssh-workspace/workspace/remove";
const REMOTE_SSH_LOCAL_WORKSPACE_PATH = "/plugins/dsh-ssh-workspace/local-workspace";
const REMOTE_SSH_PROBE_PATH = "/plugins/dsh-ssh-workspace/probe";
const REMOTE_SSH_CONFIG_HOST_PATH = "/plugins/dsh-ssh-workspace/ssh-config/host";
const REMOTE_SSH_SETTINGS_PATH = "/plugins/dsh-ssh-workspace/settings";
const REMOTE_SSH_DIRECTORY_PATH = "/plugins/dsh-ssh-workspace/directory";
const REMOTE_SSH_OPEN_FILE_PATH = "/plugins/dsh-ssh-workspace/open-file";
const REMOTE_SSH_BACKEND_CONNECT_PATH = "/plugins/dsh-ssh-workspace/backend/connect";
const name = "dsh-ssh-workspace-web";
const inject = ["remoteSshManager"];
/** Activate the Web surface only in compositions that provide a Web host. */
function apply(ctx) {
	ctx.inject(["webServer"], registerWebRoutes);
}
/** Register same-origin catalog mutation and connection-probe endpoints. */
function registerWebRoutes(ctx) {
	const routes = [
		route(ctx, REMOTE_SSH_STATE_PATH, "GET", async (_req, res) => {
			json(res, 200, await catalogState(ctx.remoteSshManager));
		}),
		route(ctx, REMOTE_SSH_SETTINGS_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			const sshConfigFile = optionalString(body, "sshConfigFile");
			const openFileEditorPath = optionalString(body, "openFileEditorPath");
			const openFileMode = body.openFileMode === void 0 ? void 0 : parseOpenFileMode(body.openFileMode);
			await ctx.remoteSshManager.updateUserPreferences({
				...sshConfigFile === void 0 ? {} : { sshConfigFile },
				...openFileMode === void 0 ? {} : { openFileMode },
				...openFileEditorPath === void 0 ? {} : { openFileEditorPath }
			});
			const snapshot = ctx.remoteSshManager.snapshot();
			json(res, 200, {
				sshConfigFile: snapshot.sshConfigFile,
				openFileMode: snapshot.openFileMode,
				openFileEditorPath: snapshot.openFileEditorPath
			});
		}),
		route(ctx, REMOTE_SSH_DIRECTORY_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, "serverId"));
			const path = body.path;
			if (path !== void 0 && typeof path !== "string") throw new Error("path must be a string");
			json(res, 200, await ctx.remoteSshManager.listRemoteDirectory(server, path));
		}),
		route(ctx, REMOTE_SSH_OPEN_FILE_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			json(res, 200, await openRemoteFile(ctx.remoteSshManager, requiredString(body, "workspaceId"), requiredString(body, "path")));
		}),
		route(ctx, REMOTE_SSH_WORKSPACE_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, "serverId"));
			const configured = ctx.remoteSshManager.snapshot().servers.find((candidate) => candidate.id === server.id) ?? await ctx.remoteSshManager.addServer({
				id: server.id,
				label: server.label,
				sshTarget: server.sshTarget
			});
			const created = await ctx.remoteSshManager.addWorkspace(configured.id, requiredString(body, "remotePath"));
			json(res, 201, {
				id: created.workspace.id,
				aliasPath: created.aliasPath
			});
		}),
		route(ctx, REMOTE_SSH_WORKSPACE_REMOVE_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			json(res, 200, { removed: await ctx.remoteSshManager.removeWorkspace(requiredString(body, "id")) });
		}),
		route(ctx, REMOTE_SSH_LOCAL_WORKSPACE_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			json(res, 200, { path: await ctx.remoteSshManager.adoptLocalWorkspace(requiredString(body, "path")) });
		}),
		route(ctx, REMOTE_SSH_PROBE_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, "id"));
			json(res, 200, await probeServer(server.sshTarget, server.sshArgs ?? []));
		}),
		route(ctx, REMOTE_SSH_BACKEND_CONNECT_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, "id"));
			res.writeHead(200, {
				"content-type": "application/x-ndjson; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff"
			});
			res.flushHeaders();
			const send = (value) => {
				if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(value)}\n`);
			};
			const unwatch = ctx.remoteSshManager.watchBackendProgress(server, (progress) => {
				send({
					type: "progress",
					stage: progress.stage
				});
			});
			try {
				const backend = await ctx.remoteSshManager.connectWebBackend(server, ctx.webServer.port);
				send({
					type: "ready",
					url: backend.url,
					localPort: backend.localPort,
					remotePort: backend.remotePort
				});
			} catch (error) {
				send({
					type: "error",
					error: safeMessage(error)
				});
			} finally {
				unwatch();
				if (!res.destroyed && !res.writableEnded) res.end();
			}
		}),
		route(ctx, REMOTE_SSH_CONFIG_HOST_PATH, "POST", async (req, res) => {
			const body = await readJson(req);
			const configPath = resolve(requiredString(body, "configPath"));
			if (!activeConfigFiles(ctx.remoteSshManager).some((candidate) => samePath(candidate, configPath))) throw new Error("selected SSH config file is not active");
			json(res, 201, await appendSshHost(configPath, requiredString(body, "command")));
		})
	];
	ctx.effect(() => () => {
		for (const dispose of routes) dispose();
	}, "Remote SSH Web routes");
}
async function catalogState(manager) {
	const snapshot = manager.snapshot();
	const configFiles = activeConfigFiles(manager);
	const discovery = await discoverSshConfigHosts(configFiles);
	const servers = snapshot.servers.map((server) => ({
		...server,
		source: "saved"
	}));
	for (const discovered of discovery.hosts) {
		const configured = servers.find((server) => server.sshTarget === discovered.sshTarget);
		if (configured === void 0) servers.push({
			...discovered,
			source: "ssh-config"
		});
		else Object.assign(configured, {
			source: "ssh-config",
			configPath: discovered.configPath,
			...discovered.hostName === void 0 ? {} : { hostName: discovered.hostName },
			...discovered.user === void 0 ? {} : { user: discovered.user },
			...discovered.port === void 0 ? {} : { port: discovered.port }
		});
	}
	return {
		servers,
		workspaces: snapshot.workspaces.map((workspace) => ({
			...workspace,
			aliasPath: manager.workspace(workspace.id).aliasPath
		})),
		serverCount: servers.length,
		discoveredServerCount: discovery.hosts.length,
		workspaceCount: snapshot.workspaces.length,
		configFiles,
		loadedConfigFiles: discovery.files,
		configErrors: discovery.errors,
		customConfigFile: snapshot.sshConfigFile,
		openFileMode: snapshot.openFileMode,
		openFileEditorPath: snapshot.openFileEditorPath
	};
}
async function resolveAvailableServer(manager, id) {
	const server = (await catalogState(manager)).servers.find((candidate) => candidate.id === id);
	if (server === void 0) throw new Error("SSH host is no longer present in the active config");
	return server;
}
function activeConfigFiles(manager) {
	const custom = manager.snapshot().sshConfigFile;
	return custom === void 0 || custom.trim() === "" ? defaultSshConfigFiles() : [resolve(custom)];
}
function samePath(left, right) {
	return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
function route(ctx, path, method, handler) {
	return ctx.webServer.register({
		kind: "exact",
		path,
		handler: async (req, res) => {
			if (req.method !== method) return json(res, 405, { error: "method not allowed" });
			if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
			try {
				await handler(req, res);
			} catch (error) {
				if (!res.headersSent) json(res, 400, { error: safeMessage(error) });
				else if (!res.writableEnded) res.end();
			}
		}
	});
}
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > 65536) throw new Error("request body exceeds 64 KiB");
		chunks.push(bytes);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
	return value;
}
function requiredString(body, key) {
	const value = body[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`);
	return value;
}
function optionalString(body, key) {
	const value = body[key];
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}
function parseOpenFileMode(value) {
	if (value === "auto" || value === "vscode" || value === "cursor" || value === "windsurf" || value === "vscodium" || value === "custom" || value === "download") return value;
	throw new Error("openFileMode is invalid");
}
function trustedRequest(req) {
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const host = req.headers.host;
	const origin = req.headers.origin;
	if (host === void 0 || origin === void 0) return origin === void 0;
	try {
		return new URL(origin).host === new URL(`http://${host}`).host;
	} catch {
		return false;
	}
}
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).slice(0, 1e3);
}
async function probeServer(sshTarget, sshArgs) {
	const command = "printf \"hostname=%s\\n\" \"$(hostname)\"; for dsh_cmd in bash pwsh rg code; do if command -v \"$dsh_cmd\" >/dev/null 2>&1; then printf \"%s=1\\n\" \"$dsh_cmd\"; else printf \"%s=0\\n\" \"$dsh_cmd\"; fi; done";
	const child = spawn("ssh", [
		...sshArgs,
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=5",
		sshTarget,
		command
	], {
		windowsHide: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (chunk) => {
		stdout.push(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr.push(chunk);
	});
	const timer = setTimeout(() => {
		child.kill();
	}, 8e3);
	const code = await new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("close", resolvePromise);
	}).finally(() => {
		clearTimeout(timer);
	});
	const output = Buffer.concat(stdout).toString("utf8");
	if (code !== 0) return {
		reachable: false,
		error: Buffer.concat(stderr).toString("utf8").trim().slice(0, 500) || `ssh exit ${code}`
	};
	const facts = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split("=", 2)));
	return {
		reachable: true,
		...facts.hostname === void 0 ? {} : { hostname: facts.hostname },
		commands: Object.fromEntries([
			"bash",
			"pwsh",
			"rg",
			"code"
		].map((name) => [name, facts[name] === "1"]))
	};
}
//#endregion
export { REMOTE_SSH_BACKEND_CONNECT_PATH, REMOTE_SSH_CONFIG_HOST_PATH, REMOTE_SSH_DIRECTORY_PATH, REMOTE_SSH_LOCAL_WORKSPACE_PATH, REMOTE_SSH_OPEN_FILE_PATH, REMOTE_SSH_PROBE_PATH, REMOTE_SSH_SERVER_PATH, REMOTE_SSH_SERVER_REMOVE_PATH, REMOTE_SSH_SETTINGS_PATH, REMOTE_SSH_STATE_PATH, REMOTE_SSH_WORKSPACE_PATH, REMOTE_SSH_WORKSPACE_REMOVE_PATH, apply, inject, name };
