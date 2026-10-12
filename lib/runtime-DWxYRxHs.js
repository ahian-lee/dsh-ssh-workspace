import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AhpErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
/** Single source of truth for every initialize handshake and diagnostic. */
const DSH_AHP_PROTOCOL_VERSIONS = Object.freeze([.../* @__PURE__ */ new Set([...["0.8.0"], ...SUPPORTED_PROTOCOL_VERSIONS])]);
/** Extract a negotiated-version rejection without coupling callers to RPC internals. */
function ahpProtocolMismatch(error, offeredVersions = DSH_AHP_PROTOCOL_VERSIONS) {
	if (!(error instanceof RpcError) || error.code !== AhpErrorCodes.UnsupportedProtocolVersion) return void 0;
	const data = typeof error.data === "object" && error.data !== null ? error.data : void 0;
	return {
		offeredVersions,
		serverVersions: Array.isArray(data?.supportedVersions) ? data.supportedVersions.filter((value) => typeof value === "string") : []
	};
}
function formatAhpProtocolMismatch(mismatch) {
	return `client offered [${mismatch.offeredVersions.join(", ") || "none"}], Agent Host accepts [${mismatch.serverVersions.join(", ") || "unknown"}]`;
}
//#endregion
//#region src/transport/runtime.ts
function quotePosix(value) {
	if (value.includes("\0")) throw new Error("remote command arguments cannot contain NUL bytes");
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
/** Build the POSIX bootstrap that resolves the VS Code CLI and starts Agent Host. */
function buildRemoteAgentHostCommand(remoteCodeCommand) {
	return [
		`dsh_code=${quotePosix(remoteCodeCommand)}`,
		"if [ \"$dsh_code\" = code ] && ! command -v \"$dsh_code\" >/dev/null 2>&1 && [ -x \"$HOME/.dsh-ssh-workspace/cli/bin/code\" ]; then dsh_code=\"$HOME/.dsh-ssh-workspace/cli/bin/code\"; fi",
		"if ! command -v \"$dsh_code\" >/dev/null 2>&1; then printf 'dsh-ssh-workspace: VS Code CLI not found: %s\\n' \"$dsh_code\" >&2; exit 127; fi",
		"exec \"$dsh_code\" agent host --host 127.0.0.1 --port 0 --idle-timeout 60 --server-data-dir \"$HOME/.dsh-ssh-workspace/server\" --cli-data-dir \"$HOME/.dsh-ssh-workspace/cli\" --verbose"
	].join("\n");
}
/** List installed VS Code Server entrypoints newest-first for compatibility probing. */
function buildListEmbeddedAgentHostsCommand() {
	return "find \"$HOME/.vscode-server/cli/servers\" -type f -path '*/server/bin/code-server' -perm -u+x -printf '%T@ %p\\n' 2>/dev/null | sort -nr | cut -d ' ' -f 2-";
}
/** Build the fallback bootstrap for a VS Code Server installation left by Remote - SSH. */
function buildEmbeddedAgentHostCommand(codeServerPath, instanceId = "default") {
	if (!/^[a-zA-Z0-9._-]+$/.test(instanceId)) throw new Error(`invalid embedded Agent Host instance id: ${instanceId}`);
	return [
		codeServerPath === void 0 ? `dsh_code_server=$(${buildListEmbeddedAgentHostsCommand()} | head -n 1)` : `dsh_code_server=${quotePosix(codeServerPath)}`,
		"if [ -z \"$dsh_code_server\" ]; then printf 'dsh-ssh-workspace: no usable code agent host or VS Code Server code-server found\\n' >&2; exit 127; fi",
		`exec "$dsh_code_server" --host 127.0.0.1 --port 0 --agent-host-port 0 --accept-server-license-terms --server-data-dir "$HOME/.dsh-ssh-workspace/server-embedded/${instanceId}" --log info`
	].join("\n");
}
function fileUriFromPosixPath(path) {
	if (!posix.isAbsolute(path)) throw new Error(`remote path must be absolute: ${path}`);
	return `file://${path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}
function posixPathFromFileUri(uri) {
	const parsed = new URL(uri);
	if (parsed.protocol !== "file:" || parsed.hostname !== "" && parsed.hostname !== "localhost") throw new Error(`expected a local file URI from Agent Host, received ${uri}`);
	const path = decodeURIComponent(parsed.pathname);
	if (!posix.isAbsolute(path)) throw new Error(`Agent Host returned a non-absolute file URI: ${uri}`);
	return posix.normalize(path);
}
var WorkspacePathMapper = class {
	localWorkspace;
	remoteWorkspace;
	constructor(localWorkspace, remoteWorkspace) {
		this.localWorkspace = resolve(localWorkspace);
		this.remoteWorkspace = posix.normalize(remoteWorkspace);
		if (!isAbsolute(this.localWorkspace)) throw new Error("localWorkspace must be an absolute local path");
		if (!posix.isAbsolute(this.remoteWorkspace)) throw new Error(`remoteWorkspace must be an absolute POSIX path: ${remoteWorkspace}`);
	}
	toRemotePath(input, cwd) {
		if (input.trim().length === 0) throw new Error("path must be a non-empty string");
		if (input.startsWith("file:")) return posixPathFromFileUri(input);
		if (isAbsolute(input)) {
			const rel = relative(this.localWorkspace, resolve(input));
			if (rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return posix.resolve(this.remoteWorkspace, rel.split(sep).join("/"));
			if (input.startsWith("/")) return posix.normalize(input);
			throw new Error(`local path is outside the Remote SSH workspace alias: ${input}`);
		}
		if (input.startsWith("/")) return posix.normalize(input);
		const base = cwd === void 0 ? this.remoteWorkspace : this.toRemotePath(cwd);
		return posix.resolve(base, input.replaceAll("\\", "/"));
	}
};
var RemoteSshRuntime = class extends Service {
	static Config = z.object({
		sshTarget: z.string().required(),
		remoteWorkspace: z.string(),
		localWorkspace: z.string(),
		remoteAccessRoot: z.string(),
		sshExecutable: z.string().default("ssh"),
		sshArgs: z.array(z.string()).default([]),
		remoteCodeCommand: z.string().default("code"),
		remoteRuntimeRoot: z.string().default("/tmp/dsh-ssh-workspace"),
		startupTimeoutMs: z.number().default(6e5),
		requestTimeoutMs: z.number().default(3e4),
		protocolVersions: z.array(z.string()).default([...DSH_AHP_PROTOCOL_VERSIONS]),
		directUrl: z.string()
	});
	mapper;
	config;
	clientId = `dsh-ssh-workspace-${randomUUID()}`;
	runtimeRoot;
	remoteAccessRoot;
	ready;
	tunnel;
	embeddedAgentHost;
	disposed = false;
	constructor(ctx, config) {
		super(ctx, "remoteSsh");
		this.config = config;
		if (config.localWorkspace === void 0 !== (config.remoteWorkspace === void 0)) throw new Error("dsh-ssh-workspace: localWorkspace and remoteWorkspace must be configured together");
		this.mapper = config.localWorkspace === void 0 || config.remoteWorkspace === void 0 ? void 0 : new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace);
		this.remoteAccessRoot = posix.normalize(config.remoteAccessRoot ?? config.remoteWorkspace ?? "/");
		this.runtimeRoot = posix.join(this.config.remoteRuntimeRoot, this.clientId);
		this.validate();
		if (this.mapper !== void 0) mkdirSync(this.mapper.localWorkspace, { recursive: true });
		this.ready = this.open();
		this.ready.catch(() => {});
		ctx.effect(() => async () => {
			this.disposed = true;
			try {
				await (await this.ready).client.shutdown();
			} catch {} finally {
				this.tunnel?.kill();
				this.embeddedAgentHost?.kill();
			}
		}, "Remote SSH AHP teardown");
	}
	async getConnection() {
		if (this.disposed) throw new Error("Remote SSH service is disposing");
		const connection = await this.ready;
		if (this.disposed) throw new Error("Remote SSH service is disposing");
		return connection;
	}
	async getClient() {
		return (await this.getConnection()).client;
	}
	/** Workspace mapper for the legacy single-workspace providers. */
	getMapper() {
		if (this.mapper === void 0) throw new Error("dsh-ssh-workspace: this shared host runtime has no default workspace mapper");
		return this.mapper;
	}
	validate() {
		const { sshTarget, sshExecutable, remoteCodeCommand, remoteRuntimeRoot, startupTimeoutMs, requestTimeoutMs, protocolVersions } = this.config;
		if (sshTarget.trim().length === 0 && this.config.directUrl === void 0) throw new Error("dsh-ssh-workspace: sshTarget must be non-empty");
		if (sshExecutable.trim().length === 0) throw new Error("dsh-ssh-workspace: sshExecutable must be non-empty");
		if (remoteCodeCommand.trim().length === 0) throw new Error("dsh-ssh-workspace: remoteCodeCommand must be non-empty");
		if (!posix.isAbsolute(remoteRuntimeRoot)) throw new Error("dsh-ssh-workspace: remoteRuntimeRoot must be an absolute POSIX path");
		if (!posix.isAbsolute(this.remoteAccessRoot)) throw new Error("dsh-ssh-workspace: remoteAccessRoot must be an absolute POSIX path");
		if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) throw new Error("dsh-ssh-workspace: startupTimeoutMs must be a positive integer");
		if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("dsh-ssh-workspace: requestTimeoutMs must be a positive integer");
		if (protocolVersions.length === 0 || protocolVersions.some((version) => version.trim().length === 0)) throw new Error("dsh-ssh-workspace: protocolVersions must contain non-empty versions");
	}
	async open() {
		if (this.config.directUrl !== void 0) return this.connectEndpoint(this.config.directUrl);
		return this.openOverSsh();
	}
	async connectEndpoint(url) {
		const transport = await WebSocketTransport.connect(url);
		const client = new AhpClient(transport, { requestTimeoutMs: this.config.requestTimeoutMs });
		client.connect();
		try {
			const initialized = await client.initialize({
				clientId: this.clientId,
				protocolVersions: this.config.protocolVersions,
				initialSubscriptions: ["ahp-root://"]
			});
			const remoteUri = fileUriFromPosixPath(this.remoteAccessRoot);
			await client.resourceRequest({
				uri: remoteUri,
				read: true,
				write: true
			});
			const runtimeUri = fileUriFromPosixPath(this.runtimeRoot);
			await client.resourceRequest({
				uri: fileUriFromPosixPath(this.config.remoteRuntimeRoot),
				read: true,
				write: true
			});
			await client.resourceMkdir({ uri: runtimeUri });
			return {
				client,
				protocolVersion: initialized.protocolVersion,
				...initialized.defaultDirectory !== void 0 ? { defaultDirectory: initialized.defaultDirectory } : {}
			};
		} catch (error) {
			await client.shutdown().catch(() => {});
			throw error;
		}
	}
	async openOverSsh() {
		const diagnostics = [];
		const startupCommand = buildRemoteAgentHostCommand(this.config.remoteCodeCommand);
		let startup;
		try {
			startup = await runCaptured(this.config.sshExecutable, [
				...this.config.sshArgs,
				"-T",
				this.config.sshTarget,
				startupCommand
			], this.config.startupTimeoutMs);
		} catch (error) {
			if (this.config.remoteCodeCommand !== "code") throw error;
			diagnostics.push(`standalone CLI: ${errorMessage(error)}`);
			startup = {
				exitCode: null,
				stdout: "",
				stderr: ""
			};
		}
		const clean = stripAnsi(`${startup.stdout}\n${startup.stderr}`);
		const endpoint = /ws:\/\/(?:localhost|127\.0\.0\.1):(\d+)\?tkn=([^\s]+)/.exec(clean);
		if (endpoint?.[1] !== void 0 && endpoint[2] !== void 0) try {
			const url = await this.openTunnel(Number(endpoint[1]), endpoint[2]);
			return await this.connectEndpoint(url);
		} catch (error) {
			this.resetSshAttempt();
			diagnostics.push(`standalone CLI: ${connectionDiagnostic(error, this.config.protocolVersions)}`);
			if (this.config.remoteCodeCommand !== "code") throw new Error(`dsh-ssh-workspace: configured VS Code Agent Host failed\n${diagnostics.at(-1)}`, { cause: error });
		}
		else if (clean.trim().length > 0) diagnostics.push(`standalone CLI (ssh exit ${startup.exitCode ?? "unknown"}): ${tailDiagnostic(clean)}`);
		if (this.config.remoteCodeCommand !== "code") throw new Error(`dsh-ssh-workspace: remote VS Code Agent Host failed to start (ssh exit ${startup.exitCode})\n${clean}`);
		const candidates = await this.listEmbeddedAgentHosts();
		for (const [index, codeServerPath] of candidates.entries()) try {
			const url = await this.startEmbeddedAgentHost(codeServerPath, index);
			return await this.connectEndpoint(url);
		} catch (error) {
			this.resetSshAttempt();
			diagnostics.push(`embedded ${codeServerPath}: ${connectionDiagnostic(error, this.config.protocolVersions)}`);
		}
		if (candidates.length === 0) diagnostics.push("embedded VS Code Server: no installed code-server found");
		throw new Error(`dsh-ssh-workspace: no compatible VS Code Agent Host found\n${diagnostics.join("\n")}`);
	}
	async listEmbeddedAgentHosts() {
		const result = await runCaptured(this.config.sshExecutable, [
			...this.config.sshArgs,
			"-T",
			this.config.sshTarget,
			buildListEmbeddedAgentHostsCommand()
		], Math.min(this.config.startupTimeoutMs, 3e4));
		if (result.exitCode !== 0) return [];
		return [...new Set(result.stdout.split(/\r?\n/u).map((path) => path.trim()).filter(Boolean))];
	}
	async startEmbeddedAgentHost(codeServerPath, attempt) {
		const instanceId = `${this.clientId}-${attempt}`;
		const child = spawn(this.config.sshExecutable, [
			...this.config.sshArgs,
			"-T",
			this.config.sshTarget,
			buildEmbeddedAgentHostCommand(codeServerPath, instanceId)
		], {
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.embeddedAgentHost = child;
		let remotePort;
		try {
			remotePort = await waitForAgentHostPort(child, this.config.startupTimeoutMs);
		} catch (error) {
			child.kill();
			throw error;
		}
		const tokenResult = await runCaptured(this.config.sshExecutable, [
			...this.config.sshArgs,
			"-T",
			this.config.sshTarget,
			`cat "$HOME/.dsh-ssh-workspace/server-embedded/${instanceId}/data/token"`
		], Math.min(this.config.startupTimeoutMs, 3e4));
		const token = tokenResult.stdout.trim();
		if (tokenResult.exitCode !== 0 || token.length === 0 || /\s/.test(token)) {
			child.kill();
			throw new Error(`dsh-ssh-workspace: could not read the embedded Agent Host connection token\n${tokenResult.stderr}`);
		}
		return this.openTunnel(remotePort, token);
	}
	async openTunnel(remotePort, token) {
		const localPort = await reservePort();
		const tunnel = spawn(this.config.sshExecutable, [
			...this.config.sshArgs,
			"-T",
			"-N",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			"-L",
			`127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
			this.config.sshTarget
		], {
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.tunnel = tunnel;
		await waitForPort(localPort, tunnel, 15e3);
		return `ws://127.0.0.1:${localPort}?tkn=${encodeURIComponent(token)}`;
	}
	resetSshAttempt() {
		this.tunnel?.kill();
		this.tunnel = void 0;
		this.embeddedAgentHost?.kill();
		this.embeddedAgentHost = void 0;
	}
};
async function runCaptured(command, args, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		const stdout = [];
		const stderr = [];
		let size = 0;
		const append = (bucket, chunk) => {
			size += chunk.length;
			if (size > 4194304) {
				child.kill();
				reject(/* @__PURE__ */ new Error("dsh-ssh-workspace: SSH startup output exceeded 4 MiB"));
				return;
			}
			bucket.push(chunk);
		};
		child.stdout.on("data", (chunk) => {
			append(stdout, chunk);
		});
		child.stderr.on("data", (chunk) => {
			append(stderr, chunk);
		});
		child.once("error", reject);
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error(`dsh-ssh-workspace: SSH startup timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			resolvePromise({
				exitCode,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8")
			});
		});
	});
}
async function waitForAgentHostPort(child, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		let output = "";
		let settled = false;
		const finish = (operation) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			operation();
		};
		const append = (chunk) => {
			output += chunk.toString("utf8");
			if (Buffer.byteLength(output, "utf8") > 4194304) {
				finish(() => reject(/* @__PURE__ */ new Error("embedded Agent Host startup output exceeded 4 MiB")));
				return;
			}
			const match = /Agent host server listening on (?:localhost|127\.0\.0\.1):(\d+)/.exec(stripAnsi(output));
			if (match?.[1] !== void 0) finish(() => resolvePromise(Number(match[1])));
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => {
			finish(() => reject(error));
		});
		child.once("close", (code) => {
			finish(() => reject(/* @__PURE__ */ new Error(`embedded Agent Host SSH process exited with code ${code}\n${stripAnsi(output)}`)));
		});
		const timer = setTimeout(() => {
			finish(() => reject(/* @__PURE__ */ new Error(`embedded Agent Host startup timed out after ${timeoutMs}ms\n${stripAnsi(output)}`)));
		}, timeoutMs);
	});
}
function stripAnsi(value) {
	return value.replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function tailDiagnostic(value, maxLength = 2e3) {
	const clean = stripAnsi(value).trim();
	return clean.length <= maxLength ? clean : `…${clean.slice(-maxLength)}`;
}
function connectionDiagnostic(error, offeredVersions) {
	const mismatch = ahpProtocolMismatch(error, offeredVersions);
	return mismatch === void 0 ? tailDiagnostic(errorMessage(error)) : `AHP protocol mismatch: ${formatAhpProtocolMismatch(mismatch)}`;
}
async function reservePort() {
	const server = createServer();
	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(/* @__PURE__ */ new Error("dsh-ssh-workspace: failed to reserve a TCP port"));
				return;
			}
			const port = address.port;
			server.close((error) => error === void 0 ? resolvePromise(port) : reject(error));
		});
	});
}
async function waitForPort(port, child, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`dsh-ssh-workspace: SSH tunnel exited with code ${child.exitCode}`);
		if (await new Promise((resolvePromise) => {
			const socket = createConnection({
				host: "127.0.0.1",
				port
			});
			socket.once("connect", () => {
				socket.destroy();
				resolvePromise(true);
			});
			socket.once("error", () => {
				socket.destroy();
				resolvePromise(false);
			});
		})) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	child.kill();
	throw new Error(`dsh-ssh-workspace: SSH tunnel did not open port ${port} within ${timeoutMs}ms`);
}
//#endregion
export { buildRemoteAgentHostCommand as a, quotePosix as c, buildListEmbeddedAgentHostsCommand as i, WorkspacePathMapper as n, fileUriFromPosixPath as o, buildEmbeddedAgentHostCommand as r, posixPathFromFileUri as s, RemoteSshRuntime as t };
