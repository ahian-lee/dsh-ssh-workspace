import { c as quotePosix, o as fileUriFromPosixPath } from "./runtime-DWxYRxHs.js";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { ActionType } from "@microsoft/agent-host-protocol";
import { PassThrough, Writable } from "node:stream";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
//#region src/routing/subprocess.ts
/** Subprocess router that selects the host from `spec.cwd`, never tool identity. */
var TransparentSubprocessRuntime = class extends SubprocessRuntime {
	static inject = ["localSubprocess", "remoteSshManager"];
	local;
	manager;
	remoteHandles = /* @__PURE__ */ new Set();
	remoteTerminals = /* @__PURE__ */ new Set();
	constructor(ctx) {
		super(ctx);
		this.local = ctx.localSubprocess;
		this.manager = ctx.remoteSshManager;
		ctx.effect(() => async () => {
			for (const handle of this.remoteHandles) handle.terminate();
			await Promise.allSettled([...this.remoteHandles].map((handle) => handle.done));
			await Promise.allSettled([...this.remoteTerminals].map((terminal) => terminal.terminate()));
		}, "Remote SSH subprocess teardown");
	}
	resolveExecutable(command, env, signal) {
		return this.local.resolveExecutable(command, env, signal);
	}
	spawn(spec) {
		const route = this.manager.route(void 0, spec.cwd);
		if (route.kind === "local") return this.local.spawn(spec);
		const handle = new RemoteAhpProcessHandle(route, this.manager.workspaceContext(route), this.manager.workspaceShell(route, "bash"), spec);
		this.remoteHandles.add(handle);
		handle.done.finally(() => {
			this.remoteHandles.delete(handle);
		}).catch(() => {});
		return handle;
	}
	async spawnTerminal(spec) {
		const route = this.manager.route(void 0, spec.cwd);
		if (route.kind === "local") return this.local.spawnTerminal(spec);
		const handle = await RemoteAhpTerminalHandle.create(route, await this.manager.workspaceContext(route), spec);
		this.remoteTerminals.add(handle);
		handle.done.finally(() => {
			this.remoteTerminals.delete(handle);
		}).catch(() => {});
		return handle;
	}
};
/** All ordinary remote subprocess modes stay on the persistent AHP host. */
function canUseAhpSubprocess(_spec) {
	return true;
}
/**
* Subprocess over the persistent host AHP connection. A short-lived remote
* PTY launches the exact argv while stdout/stderr are redirected to separate
* Resource files. Live stdin is streamed through a second AHP Terminal into a
* remote FIFO, so no per-command SSH transport exists.
*/
var RemoteAhpProcessHandle = class {
	route;
	workspace;
	shell;
	spec;
	pid = -1;
	stdin;
	stdout;
	stderr;
	collected;
	done;
	controller = new AbortController();
	stdoutSink;
	stderrSink;
	stdinPipe;
	settled = false;
	constructor(route, workspace, shell, spec) {
		this.route = route;
		this.workspace = workspace;
		this.shell = shell;
		this.spec = spec;
		this.stdoutSink = new RemoteOutputSink(spec.stdio.stdout, process.stdout);
		this.stderrSink = new RemoteOutputSink(spec.stdio.stderr, process.stderr);
		this.stdout = this.stdoutSink.stream;
		this.stderr = this.stderrSink.stream;
		this.stdinPipe = spec.stdio.stdin === "pipe" ? new DeferredAhpStdin() : void 0;
		this.stdin = this.stdinPipe;
		this.collected = {
			...this.stdoutSink.reader === void 0 ? {} : { stdout: this.stdoutSink.reader },
			...this.stderrSink.reader === void 0 ? {} : { stderr: this.stderrSink.reader }
		};
		if (spec.signal !== void 0) {
			if (spec.signal.aborted) this.controller.abort(spec.signal.reason);
			else spec.signal.addEventListener("abort", () => {
				this.controller.abort(spec.signal?.reason);
			}, { once: true });
		}
		this.done = this.execute().catch((error) => {
			this.stdinPipe?.fail(error);
			throw error;
		}).finally(() => {
			this.settled = true;
			this.stdoutSink.end();
			this.stderrSink.end();
		});
	}
	terminate() {
		if (!this.settled) this.controller.abort(/* @__PURE__ */ new Error("remote subprocess terminated"));
	}
	async waitForExit(signal) {
		if (signal?.aborted) return false;
		return Promise.race([this.done.then(() => true, () => true), signal === void 0 ? new Promise(() => {}) : new Promise((resolvePromise) => {
			signal.addEventListener("abort", () => {
				resolvePromise(false);
			}, { once: true });
		})]);
	}
	async execute() {
		const stdinMode = this.spec.stdio.stdin;
		const [{ remote }, shell] = await Promise.all([this.workspace, this.shell]);
		const client = await remote.getClient();
		const token = randomUUID();
		const stdoutPath = `${remote.runtimeRoot}/process-${token}.stdout`;
		const stderrPath = `${remote.runtimeRoot}/process-${token}.stderr`;
		const stdinPath = `${remote.runtimeRoot}/process-${token}.stdin`;
		const fifoPath = `${remote.runtimeRoot}/process-${token}.fifo`;
		const stdoutUri = fileUriFromPosixPath(stdoutPath);
		const stderrUri = fileUriFromPosixPath(stderrPath);
		const stdinUri = fileUriFromPosixPath(stdinPath);
		const fifoUri = fileUriFromPosixPath(fifoPath);
		const empty = {
			data: "",
			encoding: "base64"
		};
		let writer;
		let completed = false;
		let run;
		try {
			await Promise.all([
				client.resourceWrite({
					uri: stdoutUri,
					...empty
				}),
				client.resourceWrite({
					uri: stderrUri,
					...empty
				}),
				stdinMode === "ignore" || stdinMode === "pipe" ? Promise.resolve() : client.resourceWrite({
					uri: stdinUri,
					data: Buffer.from(stdinMode.data).toString("base64"),
					encoding: "base64"
				})
			]);
			if (stdinMode === "pipe") {
				const prepared = await shell.run(shell.resolve({
					command: `rm -f -- ${quotePosix(fifoPath)} && mkfifo -- ${quotePosix(fifoPath)}`,
					workdir: this.spec.cwd,
					signal: this.controller.signal,
					sandboxPolicy: {
						mode: "danger-full-access",
						workspaceRoot: this.route.aliasPath
					}
				}));
				if (prepared.exitCode !== 0) {
					if (this.controller.signal.aborted) return {
						exitCode: null,
						signal: prepared.signal ?? "SIGTERM"
					};
					throw new Error(`dsh-ssh-workspace: failed to create remote stdin FIFO (exit ${prepared.exitCode ?? prepared.signal})`);
				}
			}
			const inputPath = stdinMode === "ignore" ? "/dev/null" : stdinMode === "pipe" ? fifoPath : stdinPath;
			const command = buildRemoteProcessCommand(remoteExecutable(this.spec.argv[0] ?? "") === "rg" && this.route.server.remoteRgCommand ? [this.route.server.remoteRgCommand, ...this.spec.argv.slice(1)] : this.spec.argv, this.spec.env, inputPath, stdoutPath, stderrPath);
			const resolved = shell.resolve({
				command,
				workdir: this.spec.cwd,
				signal: this.controller.signal,
				sandboxPolicy: {
					mode: "danger-full-access",
					workspaceRoot: this.route.aliasPath
				}
			});
			run = shell.run(resolved).finally(() => {
				completed = true;
			});
			if (stdinMode === "pipe") {
				const endMarker = `__DSH_STDIN_EOF_${randomUUID().replaceAll("-", "")}__`;
				writer = await RemoteAhpTerminalHandle.create(this.route, await this.workspace, {
					argv: [
						"bash",
						"-c",
						buildRemoteStdinWriterCommand(fifoPath, endMarker)
					],
					cwd: this.spec.cwd,
					rows: 24,
					cols: 80,
					graceMs: this.spec.graceMs,
					signal: this.controller.signal
				});
				writer.output.resume();
				this.stdinPipe?.bind(writer, endMarker);
			}
			while (!completed) {
				await this.poll(client, stdoutUri, stderrUri);
				await delay(40);
			}
			const result = await run;
			await this.poll(client, stdoutUri, stderrUri);
			return {
				exitCode: result.exitCode,
				signal: result.signal
			};
		} catch (error) {
			this.stdinPipe?.fail(error);
			this.controller.abort(error);
			await run?.catch(() => {});
			throw error;
		} finally {
			if (writer !== void 0) await writer.terminate();
			this.stdinPipe?.finishRemote();
			await Promise.allSettled([
				client.resourceDelete({
					uri: stdoutUri,
					recursive: false
				}),
				client.resourceDelete({
					uri: stderrUri,
					recursive: false
				}),
				...stdinMode === "ignore" || stdinMode === "pipe" ? [] : [client.resourceDelete({
					uri: stdinUri,
					recursive: false
				})],
				...stdinMode === "pipe" ? [client.resourceDelete({
					uri: fifoUri,
					recursive: false
				})] : []
			]);
		}
	}
	async poll(client, stdoutUri, stderrUri) {
		const [stdout, stderr] = await Promise.all([readRemoteOutput(client, stdoutUri), readRemoteOutput(client, stderrUri)]);
		this.stdoutSink.update(stdout);
		this.stderrSink.update(stderr);
	}
};
/** Interactive terminal over the same persistent AHP host connection. */
var RemoteAhpTerminalHandle = class RemoteAhpTerminalHandle {
	client;
	channel;
	subscription;
	pid = -1;
	output = new PassThrough();
	done;
	stopping;
	stopped = new Promise((resolvePromise) => {
		this.stopping = resolvePromise;
	});
	terminating;
	constructor(client, channel, subscription) {
		this.client = client;
		this.channel = channel;
		this.subscription = subscription;
		this.done = this.pump();
	}
	static async create(route, workspace, spec) {
		if (spec.signal?.aborted) throw spec.signal.reason ?? /* @__PURE__ */ new Error("remote terminal allocation aborted");
		const client = await workspace.remote.getClient();
		const channel = `ahp-terminal:/${randomUUID()}`;
		const claim = {
			kind: "client",
			clientId: workspace.remote.clientId
		};
		await client.request("createTerminal", {
			channel,
			claim,
			name: "DeepSeek Harness Remote SSH subprocess",
			cwd: fileUriFromPosixPath(route.mapper.toRemotePath(spec.cwd)),
			cols: spec.cols,
			rows: spec.rows
		});
		try {
			const subscribed = await client.subscribe(channel);
			const handle = new RemoteAhpTerminalHandle(client, channel, subscribed.subscription);
			if (spec.signal?.aborted) {
				await handle.terminate();
				throw spec.signal.reason ?? /* @__PURE__ */ new Error("remote terminal allocation aborted");
			}
			if (spec.signal !== void 0) {
				const onAbort = () => {
					handle.terminate();
				};
				spec.signal.addEventListener("abort", onAbort, { once: true });
				handle.done.finally(() => {
					spec.signal?.removeEventListener("abort", onAbort);
				}).catch(() => {});
			}
			client.dispatch(channel, {
				type: ActionType.TerminalInput,
				data: `${buildRemoteInteractiveCommand(spec.argv, spec.env)}\r`
			});
			return handle;
		} catch (error) {
			await client.request("disposeTerminal", { channel }).catch(() => {});
			throw error;
		}
	}
	async write(data) {
		this.client.dispatch(this.channel, {
			type: ActionType.TerminalInput,
			data
		});
	}
	async inspectForeground() {}
	async signalForeground(signal) {
		if (signal === "SIGINT") {
			await this.write("");
			return -1;
		}
		if (signal === "SIGTSTP") {
			await this.write("");
			return -1;
		}
		throw new Error(`dsh-ssh-workspace: AHP PTY cannot address a foreground process group for ${signal}`);
	}
	terminate() {
		this.terminating ??= (async () => {
			await this.client.request("disposeTerminal", { channel: this.channel }).catch(() => {});
			this.stopping?.("SIGTERM");
			await this.done.catch(() => {});
		})();
		return this.terminating;
	}
	async pump() {
		try {
			for (;;) {
				const next = await Promise.race([this.subscription.next().then((result) => ({
					kind: "event",
					result
				})), this.stopped.then((signal) => ({
					kind: "stopped",
					signal
				}))]);
				if (next.kind === "stopped") return {
					exitCode: null,
					signal: next.signal
				};
				if (next.result.done) throw new Error("dsh-ssh-workspace: AHP terminal subscription ended before terminal exit");
				const event = next.result.value;
				if (event.type !== "action") continue;
				const action = event.params.action;
				if (action.type === ActionType.TerminalData) this.output.write(action.data);
				else if (action.type === ActionType.TerminalExited) return {
					exitCode: action.exitCode ?? null,
					signal: action.exitCode === void 0 ? "SIGTERM" : null
				};
			}
		} finally {
			this.output.end();
			await this.subscription.close().catch(() => {});
			await this.client.request("disposeTerminal", { channel: this.channel }).catch(() => {});
		}
	}
};
/** Writable exposed synchronously while its remote AHP input pump boots. */
var DeferredAhpStdin = class extends Writable {
	binding;
	resolveBinding;
	rejectBinding;
	bound = false;
	remoteFinished = false;
	constructor() {
		super();
		this.binding = new Promise((resolvePromise, reject) => {
			this.resolveBinding = resolvePromise;
			this.rejectBinding = reject;
		});
		this.on("error", () => {});
	}
	bind(terminal, endMarker) {
		if (this.bound || this.remoteFinished) return;
		this.bound = true;
		this.resolveBinding({
			terminal,
			endMarker
		});
	}
	fail(reason) {
		if (!this.bound) {
			this.remoteFinished = true;
			this.rejectBinding(reason);
		}
		if (!this.destroyed) this.destroy(reason instanceof Error ? reason : new Error(String(reason)));
	}
	finishRemote() {
		this.remoteFinished = true;
		if (!this.bound) this.rejectBinding(/* @__PURE__ */ new Error("dsh-ssh-workspace: remote stdin pump ended before startup"));
	}
	_write(chunk, encoding, callback) {
		this.sendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)).then(() => callback(), callback);
	}
	_final(callback) {
		(async () => {
			const { terminal, endMarker } = await this.binding;
			await terminal.write(`${endMarker}\n`);
			const outcome = await terminal.done;
			if (outcome.exitCode !== 0) throw new Error(`dsh-ssh-workspace: stdin pump failed (exit ${outcome.exitCode ?? outcome.signal})`);
		})().then(() => callback(), callback);
	}
	async sendChunk(chunk) {
		if (this.remoteFinished) throw new Error("dsh-ssh-workspace: remote stdin is already closed");
		const { terminal } = await this.binding;
		await terminal.write(`${chunk.toString("base64")}\n`);
	}
};
var TailOutputReader = class {
	maxBytes;
	tail = Buffer.alloc(0);
	tailStart = 0;
	total = 0;
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	append(chunk) {
		this.total += chunk.length;
		const combined = Buffer.concat([this.tail, chunk]);
		if (combined.length <= this.maxBytes) {
			this.tail = combined;
			return;
		}
		const dropped = combined.length - this.maxBytes;
		this.tail = combined.subarray(dropped);
		this.tailStart += dropped;
	}
	readFrom(fromByte) {
		const lossy = fromByte < this.tailStart;
		const start = Math.max(fromByte, this.tailStart) - this.tailStart;
		return {
			text: this.tail.subarray(start).toString("utf8"),
			nextOffset: this.total,
			lossy
		};
	}
};
var RemoteOutputSink = class {
	inherited;
	stream;
	reader;
	offset = 0;
	constructor(mode, inherited) {
		this.inherited = inherited;
		this.stream = mode === "pipe" ? new PassThrough() : void 0;
		this.reader = typeof mode === "object" ? new TailOutputReader(mode.maxBytes) : void 0;
	}
	update(content) {
		if (content.length < this.offset) this.offset = 0;
		if (content.length === this.offset) return;
		const delta = content.subarray(this.offset);
		this.offset = content.length;
		if (this.stream !== void 0) this.stream.write(delta);
		else if (this.reader !== void 0) this.reader.append(delta);
		else this.inherited.write(delta);
	}
	end() {
		this.stream?.end();
	}
};
const BASE64 = "base64";
async function readRemoteOutput(client, uri) {
	const result = await client.resourceRead({
		uri,
		encoding: BASE64
	});
	return result.encoding === BASE64 ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
}
function buildRemoteProcessCommand(argv, env, stdinPath, stdoutPath, stderrPath) {
	const executable = argv[0];
	if (executable === void 0 || executable.length === 0) throw new Error("dsh-ssh-workspace: subprocess argv must contain a program");
	const envArgs = [];
	for (const [key, value] of Object.entries(env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`dsh-ssh-workspace: invalid environment variable '${key}'`);
		if (value === void 0) envArgs.push("-u", key);
		else envArgs.push(`${key}=${value}`);
	}
	const remoteArgv = [remoteExecutable(executable), ...argv.slice(1)];
	return `exec env ${envArgs.map(quotePosix).join(" ")} ${remoteArgv.map(quotePosix).join(" ")} < ${quotePosix(stdinPath)} > ${quotePosix(stdoutPath)} 2> ${quotePosix(stderrPath)}`;
}
function buildRemoteInteractiveCommand(argv, env) {
	const executable = argv[0];
	if (executable === void 0 || executable.length === 0) throw new Error("dsh-ssh-workspace: terminal argv must contain a program");
	const envArgs = [];
	for (const [key, value] of Object.entries(env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`dsh-ssh-workspace: invalid environment variable '${key}'`);
		envArgs.push(`${key}=${value}`);
	}
	const remoteArgv = [remoteExecutable(executable), ...argv.slice(1)];
	return `exec env ${envArgs.map(quotePosix).join(" ")} ${remoteArgv.map(quotePosix).join(" ")}`;
}
/** Decode newline-delimited base64 records until the unguessable EOF marker. */
function buildRemoteStdinWriterCommand(fifoPath, endMarker) {
	return `while IFS= read -r line; do [ "$line" = ${quotePosix(endMarker)} ] && break; printf '%s' "$line" | base64 -d; done > ${quotePosix(fifoPath)}`;
}
async function delay(ms) {
	await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function remoteExecutable(executable) {
	if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(executable)) return executable;
	return win32.basename(executable).replace(/\.exe$/i, "");
}
//#endregion
export { DeferredAhpStdin, TransparentSubprocessRuntime, TransparentSubprocessRuntime as default, buildRemoteInteractiveCommand, buildRemoteProcessCommand, buildRemoteStdinWriterCommand, canUseAhpSubprocess };
