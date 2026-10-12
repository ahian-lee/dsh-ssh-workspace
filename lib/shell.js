import { c as quotePosix, n as WorkspacePathMapper, o as fileUriFromPosixPath } from "./runtime-DWxYRxHs.js";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import z from "@deepseek-ai/schemastery";
import { ActionType } from "@microsoft/agent-host-protocol";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
//#region src/transport/shell.ts
const UTF8 = "utf-8";
var RemoteSshShellExecutor = class extends ShellExecutor {
	static inject = ["remoteSsh"];
	static Config = z.object({
		defaultTimeoutMs: z.number().default(12e4),
		maxTimeoutMs: z.number().default(6e5),
		outputMaxBytes: z.number().default(262144),
		maxOutputMaxBytes: z.number().default(16777216),
		shellCommand: z.string().default("bash"),
		localWorkspace: z.string(),
		remoteWorkspace: z.string()
	});
	config;
	remote;
	mapper;
	processes = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		super(ctx);
		this.remote = ctx.remoteSsh;
		this.config = config;
		if (config.localWorkspace === void 0 !== (config.remoteWorkspace === void 0)) throw new Error("dsh-ssh-workspace/shell: localWorkspace and remoteWorkspace must be configured together");
		this.mapper = config.localWorkspace !== void 0 && config.remoteWorkspace !== void 0 ? new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace) : mapperOf(this.remote);
		this.validate();
		ctx.effect(() => async () => {
			for (const process of this.processes) process.kill();
			await Promise.allSettled([...this.processes].map((process) => process.done));
		}, "Remote SSH shell teardown");
	}
	resolve(request) {
		const timeoutMs = clampPositive(request.timeoutMs ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs, "timeoutMs");
		const stdoutMaxBytes = clampPositive(request.stdoutMaxBytes ?? this.config.outputMaxBytes, this.config.maxOutputMaxBytes, "stdoutMaxBytes");
		return {
			command: request.command,
			workdir: request.workdir ?? this.mapper.localWorkspace,
			timeoutMs,
			stdoutMaxBytes,
			signal: request.signal,
			stdin: request.stdin,
			env: request.env,
			dshEnv: request.dshEnv,
			sandboxPolicy: request.sandboxPolicy
		};
	}
	/** Unified handle used by Harness 0.2 foreground commands and jobs. */
	async execute(spec) {
		const process = new AhpShellProcess(this.remote, this.mapper, this.config.shellCommand, spec, this.config.outputMaxBytes, spec.onExpiry === "none" ? 0 : spec.timeoutMs);
		this.processes.add(process);
		process.done.finally(() => {
			this.processes.delete(process);
		});
		return process;
	}
	async run(spec) {
		const outcome = await executeTerminal(this.remote, this.mapper, this.config.shellCommand, spec, spec.stdoutMaxBytes, spec.timeoutMs);
		return {
			exitCode: outcome.exitCode,
			signal: outcome.signal,
			timedOut: outcome.timedOut,
			aborted: outcome.aborted,
			timeoutMs: spec.timeoutMs,
			stdout: outcome.output.collected(),
			stderr: {
				text: "",
				truncated: false
			}
		};
	}
	start(spec) {
		const process = new AhpShellProcess(this.remote, this.mapper, this.config.shellCommand, spec, this.config.outputMaxBytes);
		this.processes.add(process);
		process.done.finally(() => {
			this.processes.delete(process);
		});
		return process;
	}
	validate() {
		for (const name of [
			"defaultTimeoutMs",
			"maxTimeoutMs",
			"outputMaxBytes",
			"maxOutputMaxBytes"
		]) {
			const value = this.config[name];
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-ssh-workspace/shell: ${name} must be a positive integer`);
		}
		if (this.config.defaultTimeoutMs > this.config.maxTimeoutMs) throw new Error("dsh-ssh-workspace/shell: defaultTimeoutMs exceeds maxTimeoutMs");
		if (this.config.outputMaxBytes > this.config.maxOutputMaxBytes) throw new Error("dsh-ssh-workspace/shell: outputMaxBytes exceeds maxOutputMaxBytes");
		if (this.config.shellCommand.trim().length === 0) throw new Error("dsh-ssh-workspace/shell: shellCommand must be non-empty");
	}
};
var AhpShellProcess = class {
	status = "running";
	exitCode = null;
	signal = null;
	done;
	controller = new AbortController();
	timeoutMs;
	completion;
	output;
	constructor(remote, mapper, shellCommand, spec, outputMaxBytes, timeoutMs = 0) {
		this.timeoutMs = spec.timeoutMs;
		this.output = new TailBuffer(outputMaxBytes);
		this.completion = executeTerminal(remote, mapper, shellCommand, {
			...spec,
			signal: combineSignals(spec.signal, this.controller.signal)
		}, outputMaxBytes, timeoutMs, this.output);
		this.done = this.completion.then((outcome) => {
			this.exitCode = outcome.exitCode;
			this.signal = outcome.signal;
			this.status = outcome.signal === null ? "completed" : "killed";
		}, (error) => {
			this.output.append(`\n[dsh-ssh-workspace infrastructure error] ${errorMessage(error)}\n`);
			this.exitCode = null;
			this.signal = "SIGTERM";
			this.status = "killed";
		});
	}
	async result() {
		const outcome = await this.completion;
		return {
			exitCode: outcome.exitCode,
			signal: outcome.signal,
			timedOut: outcome.timedOut,
			aborted: outcome.aborted,
			timeoutMs: this.timeoutMs,
			stdout: outcome.output.collected(),
			stderr: {
				text: "",
				truncated: false
			},
			sandbox: {
				mode: "danger-full-access",
				denied: false
			}
		};
	}
	readOutput() {
		return this.output.readIncremental();
	}
	kill() {
		if (this.status !== "running" || this.controller.signal.aborted) return false;
		this.controller.abort(/* @__PURE__ */ new Error("background process killed"));
		return true;
	}
};
async function executeTerminal(remote, mapper, shellCommand, spec, outputMaxBytes, timeoutMs, existingOutput) {
	const output = existingOutput ?? new TailBuffer(outputMaxBytes);
	if (spec.sandboxPolicy !== void 0 && spec.sandboxPolicy.mode !== "danger-full-access") throw new Error(`dsh-ssh-workspace/shell: ${spec.sandboxPolicy.mode} cannot confine arbitrary remote commands; use danger-full-access or a separately sandboxed SSH account`);
	const client = await remote.getClient();
	const token = randomUUID();
	const terminalUri = `ahp-terminal:/${token}`;
	const commandPath = posix.join(remote.runtimeRoot, `command-${token}.sh`);
	const stdinPath = posix.join(remote.runtimeRoot, `stdin-${token}.bin`);
	const commandUri = fileUriFromPosixPath(commandPath);
	const stdinUri = fileUriFromPosixPath(stdinPath);
	const workdir = mapper.toRemotePath(spec.workdir);
	let subscription;
	let terminalCreated = false;
	let stdinCreated = false;
	let timer;
	let abortListener;
	let stopCause;
	let resolveStop;
	const stopped = new Promise((resolvePromise) => {
		resolveStop = resolvePromise;
	});
	const stop = (cause) => {
		if (stopCause !== void 0) return;
		stopCause = cause;
		resolveStop?.(cause);
	};
	try {
		if (spec.signal?.aborted) stop("abort");
		await client.resourceWrite({
			uri: commandUri,
			data: spec.command,
			encoding: UTF8,
			contentType: "text/x-shellscript"
		});
		if (spec.stdin !== void 0) {
			await client.resourceWrite({
				uri: stdinUri,
				data: Buffer.from(spec.stdin).toString("base64"),
				encoding: "base64"
			});
			stdinCreated = true;
		}
		const claim = {
			kind: "client",
			clientId: remote.clientId
		};
		await client.request("createTerminal", {
			channel: terminalUri,
			claim,
			name: "DeepSeek Harness Remote SSH",
			cwd: fileUriFromPosixPath(workdir),
			cols: 120,
			rows: 30
		});
		terminalCreated = true;
		subscription = (await client.subscribe(terminalUri)).subscription;
		if (timeoutMs > 0) timer = setTimeout(() => {
			stop("timeout");
		}, timeoutMs);
		if (spec.signal !== void 0) {
			abortListener = () => {
				stop("abort");
			};
			spec.signal.addEventListener("abort", abortListener, { once: true });
		}
		const env = mergeEnvironment(mapper, spec);
		const envArgs = Object.entries(env).map(([key, value]) => `${key}=${quotePosix(value)}`).join(" ");
		const stdinRedirect = stdinCreated ? quotePosix(stdinPath) : "/dev/null";
		const marker = new TerminalOutputCapture(token, output);
		const input = `printf '\\036DSH:${token}:BEGIN\\037'; env ${envArgs} ${quotePosix(shellCommand)} ${quotePosix(commandPath)} < ${stdinRedirect}; __dsh_status=$?; printf '\\036DSH:${token}:END:%s\\037' "$__dsh_status"; exit "$__dsh_status"\r`;
		client.dispatch(terminalUri, {
			type: ActionType.TerminalInput,
			data: input
		});
		let commandId;
		for (;;) {
			const eventOrStop = await Promise.race([subscription.next().then((result) => ({
				kind: "event",
				result
			})), stopped.then((cause) => ({
				kind: "stop",
				cause
			}))]);
			if (eventOrStop.kind === "stop") {
				await client.request("disposeTerminal", { channel: terminalUri }).catch(() => {});
				terminalCreated = false;
				return {
					exitCode: null,
					signal: "SIGTERM",
					timedOut: eventOrStop.cause === "timeout",
					aborted: eventOrStop.cause === "abort",
					output
				};
			}
			if (eventOrStop.result.done) throw new Error("Agent Host terminal subscription ended before command completion");
			const event = eventOrStop.result.value;
			if (event.type !== "action") continue;
			const action = event.params.action;
			if (action.type === ActionType.TerminalCommandExecuted && commandId === void 0) commandId = action.commandId;
			else if (action.type === ActionType.TerminalData) {
				const exitCode = marker.push(action.data);
				if (exitCode !== void 0) return {
					exitCode,
					signal: null,
					timedOut: false,
					aborted: false,
					output
				};
			} else if (action.type === ActionType.TerminalCommandFinished && action.commandId === commandId && marker.started) continue;
			else if (action.type === ActionType.TerminalCommandFinished && commandId === void 0) continue;
			else if (action.type === ActionType.TerminalCommandFinished && action.commandId === commandId) return {
				exitCode: action.exitCode ?? null,
				signal: null,
				timedOut: false,
				aborted: false,
				output
			};
			else if (action.type === ActionType.TerminalExited) {
				if (!marker.finished) throw new Error(`Agent Host terminal exited before the output marker (exit ${action.exitCode ?? "unknown"})`);
				return {
					exitCode: action.exitCode ?? null,
					signal: action.exitCode === void 0 ? "SIGTERM" : null,
					timedOut: false,
					aborted: false,
					output
				};
			}
		}
	} finally {
		if (timer !== void 0) clearTimeout(timer);
		if (abortListener !== void 0) spec.signal?.removeEventListener("abort", abortListener);
		await subscription?.close().catch(() => {});
		if (terminalCreated) await client.request("disposeTerminal", { channel: terminalUri }).catch(() => {});
		await client.resourceDelete({ uri: commandUri }).catch(() => {});
		if (stdinCreated) await client.resourceDelete({ uri: stdinUri }).catch(() => {});
	}
}
var TerminalOutputCapture = class {
	output;
	begin;
	endPrefix;
	started = false;
	finished = false;
	pending = "";
	constructor(token, output) {
		this.output = output;
		this.begin = `\x1eDSH:${token}:BEGIN\x1f`;
		this.endPrefix = `\x1eDSH:${token}:END:`;
	}
	push(data) {
		if (this.finished) return void 0;
		this.pending += data;
		if (!this.started) {
			const at = this.pending.indexOf(this.begin);
			if (at === -1) {
				this.pending = this.pending.slice(-Math.max(0, this.begin.length - 1));
				return;
			}
			this.started = true;
			this.pending = this.pending.slice(at + this.begin.length);
		}
		const end = this.pending.indexOf(this.endPrefix);
		if (end === -1) {
			const safe = Math.max(0, this.pending.length - (this.endPrefix.length - 1));
			if (safe > 0) {
				this.output.append(this.pending.slice(0, safe));
				this.pending = this.pending.slice(safe);
			}
			return;
		}
		this.output.append(this.pending.slice(0, end));
		const statusStart = end + this.endPrefix.length;
		const terminator = this.pending.indexOf("", statusStart);
		if (terminator === -1) {
			this.pending = this.pending.slice(end);
			return;
		}
		const raw = this.pending.slice(statusStart, terminator);
		if (!/^\d+$/.test(raw)) throw new Error(`Agent Host terminal emitted an invalid exit marker: ${JSON.stringify(raw)}`);
		this.finished = true;
		this.pending = "";
		return Number(raw);
	}
};
function mergeEnvironment(mapper, spec) {
	const result = {
		...spec.env ?? {},
		...spec.dshEnv ?? {}
	};
	if (result.DSH_CWD !== void 0) result.DSH_CWD = mapper.toRemotePath(result.DSH_CWD);
	for (const key of Object.keys(result)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid remote environment variable name: ${key}`);
		if (result[key]?.includes("\0")) throw new Error(`remote environment variable ${key} contains a NUL byte`);
	}
	return result;
}
var TailBuffer = class {
	maxBytes;
	tail = Buffer.alloc(0);
	tailStart = 0;
	total = 0;
	readOffset = 0;
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	append(value) {
		const chunk = Buffer.from(value);
		this.total += chunk.length;
		const combined = Buffer.concat([this.tail, chunk]);
		if (combined.length > this.maxBytes) {
			const dropped = combined.length - this.maxBytes;
			this.tail = combined.subarray(dropped);
			this.tailStart += dropped;
		} else this.tail = combined;
	}
	collected() {
		return {
			text: this.tail.toString("utf8"),
			truncated: this.tailStart > 0
		};
	}
	readIncremental() {
		const lossy = this.readOffset < this.tailStart;
		const start = Math.max(this.readOffset, this.tailStart) - this.tailStart;
		const delta = this.tail.subarray(start).toString("utf8");
		this.readOffset = this.total;
		return {
			delta,
			lossy
		};
	}
};
function clampPositive(value, max, name) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-ssh-workspace/shell: ${name} must be positive`);
	return Math.min(Math.floor(value), max);
}
function combineSignals(first, second) {
	return first === void 0 ? second : AbortSignal.any([first, second]);
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function mapperOf(remote) {
	return remote.mapper ?? remote.getMapper();
}
//#endregion
export { RemoteSshShellExecutor, RemoteSshShellExecutor as default };
