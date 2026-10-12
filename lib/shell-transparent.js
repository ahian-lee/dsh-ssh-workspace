import z from "@deepseek-ai/schemastery";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
//#region src/routing/shell.ts
const PWSH_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";
/** Syntax-specific shell provider over the cwd-routed subprocess service. */
var TransparentShellExecutor = class extends ShellExecutor {
	static inject = [
		"subprocess",
		"remoteSshManager",
		"localShell",
		"sandboxPolicy"
	];
	static Config = z.object({
		dialect: z.union([
			"bash",
			"pwsh",
			"auto"
		]).required(),
		cwd: z.string(),
		timeoutMs: z.number().default(12e4),
		maxTimeoutMs: z.number().default(6e5),
		maxOutputBytes: z.number().default(64e3),
		maxSpillBytes: z.number().default(67108864),
		graceMs: z.number().default(3e3),
		executable: z.string()
	});
	config;
	manager;
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		this.manager = ctx.remoteSshManager;
		for (const name of [
			"timeoutMs",
			"maxTimeoutMs",
			"maxOutputBytes",
			"maxSpillBytes",
			"graceMs"
		]) {
			const value = this.config[name];
			if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-ssh-workspace/shell-transparent: ${name} must be positive`);
		}
	}
	/** Remote and local routing is explicitly unconfined at the process layer. */
	get sandboxMode() {
		return this.ctx.localShell.sandboxMode;
	}
	resolve(request) {
		if (this.manager.routeShell(request.workdir ?? process.cwd(), request.dshEnv?.DSH_SESSION_ID).kind === "local") return this.ctx.localShell.resolve(request);
		const timeoutMs = Math.min(Math.floor(request.timeoutMs ?? this.config.timeoutMs), this.config.maxTimeoutMs);
		const stdoutMaxBytes = Math.floor(request.stdoutMaxBytes ?? this.config.maxOutputBytes);
		if (timeoutMs <= 0 || stdoutMaxBytes <= 0) throw new Error("dsh-ssh-workspace/shell-transparent: timeout and output limits must be positive");
		return {
			command: request.command,
			workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
			timeoutMs,
			stdoutMaxBytes,
			signal: request.signal,
			stdin: request.stdin,
			env: request.env,
			dshEnv: request.dshEnv,
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
			onExpiry: request.onExpiry ?? "kill"
		};
	}
	/** Current Harness execution seam; local calls retain the shipped sandbox provider. */
	async execute(spec) {
		const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID);
		if (route.kind === "local") return this.ctx.localShell.execute(spec);
		assertUnconfined(spec);
		return (await this.manager.workspaceShell(route, this.config.dialect === "auto" ? this.manager.dialectFor(spec.workdir) : this.config.dialect)).execute(spec);
	}
	async run(spec) {
		const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID);
		if (route.kind === "local") return this.ctx.localShell.run(spec);
		assertUnconfined(spec);
		if (route.kind === "remote") return {
			...await (await this.manager.workspaceShell(route, this.config.dialect === "auto" ? this.manager.dialectFor(spec.workdir) : this.config.dialect)).run(spec),
			sandbox: {
				mode: "danger-full-access",
				denied: false
			}
		};
		const controller = new AbortController();
		let cause;
		const abort = () => {
			if (cause !== void 0) return;
			cause = "abort";
			controller.abort(spec.signal?.reason);
		};
		if (spec.signal?.aborted) abort();
		else spec.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			if (cause !== void 0) return;
			cause = "timeout";
			controller.abort(/* @__PURE__ */ new Error("shell timeout"));
		}, spec.timeoutMs);
		try {
			const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, controller.signal));
			const outcome = await handle.done;
			const collected = requireCollected(handle);
			return {
				...outcome,
				timedOut: cause === "timeout",
				aborted: cause === "abort",
				timeoutMs: spec.timeoutMs,
				stdout: finalOutput(collected.stdout),
				stderr: finalOutput(collected.stderr),
				sandbox: {
					mode: "danger-full-access",
					denied: false
				}
			};
		} finally {
			clearTimeout(timer);
			spec.signal?.removeEventListener("abort", abort);
		}
	}
	start(spec) {
		const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID);
		if (route.kind === "local") return this.ctx.localShell.start(spec);
		assertUnconfined(spec);
		if (route.kind === "remote") return new DeferredShellProcess(this.manager.workspaceShell(route, this.config.dialect === "auto" ? this.manager.dialectFor(spec.workdir) : this.config.dialect), spec);
		const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, this.config.maxOutputBytes, spec.signal));
		const collected = requireCollected(handle);
		let stdoutOffset = 0;
		let stderrOffset = 0;
		let spawnFailure;
		const processHandle = {
			status: "running",
			exitCode: null,
			signal: null,
			sandbox: {
				mode: "danger-full-access",
				denied: false
			},
			done: handle.done.then((outcome) => {
				processHandle.exitCode = outcome.exitCode;
				processHandle.signal = outcome.signal;
				processHandle.status = outcome.signal === null ? "completed" : "killed";
			}, (error) => {
				processHandle.status = "killed";
				processHandle.signal = "SIGTERM";
				spawnFailure = `spawn failed: ${String(error)}`;
			}),
			readOutput: () => {
				const stdout = collected.stdout.readFrom(stdoutOffset);
				const stderr = collected.stderr.readFrom(stderrOffset);
				stdoutOffset = stdout.nextOffset;
				stderrOffset = stderr.nextOffset;
				const error = stderr.text || spawnFailure || "";
				spawnFailure = void 0;
				return {
					delta: stdout.text + (error.length === 0 ? "" : `${stdout.text.length > 0 && !stdout.text.endsWith("\n") ? "\n" : ""}[stderr]\n${error}`),
					lossy: stdout.lossy || stderr.lossy,
					...stdout.spillPath === void 0 ? {} : { stdoutSpillPath: stdout.spillPath },
					...stderr.spillPath === void 0 ? {} : { stderrSpillPath: stderr.spillPath }
				};
			},
			kill: () => {
				if (processHandle.status !== "running") return false;
				processHandle.status = "killed";
				handle.terminate();
				return true;
			}
		};
		return processHandle;
	}
	spawnSpec(spec, stdoutMaxBytes, signal) {
		const collect = (maxBytes) => ({
			maxBytes,
			spill: { maxBytes: this.config.maxSpillBytes }
		});
		return {
			argv: this.argv(spec.command),
			cwd: spec.workdir,
			stdio: {
				stdin: spec.stdin === void 0 ? "ignore" : { data: spec.stdin },
				stdout: collect(stdoutMaxBytes),
				stderr: collect(this.config.maxOutputBytes)
			},
			graceMs: this.config.graceMs,
			signal,
			env: {
				NO_COLOR: "1",
				PAGER: "cat",
				GIT_PAGER: "cat",
				...spec.env,
				...spec.dshEnv
			}
		};
	}
	argv(command) {
		if (this.config.dialect === "bash") return [
			this.config.executable ?? "bash",
			"-c",
			command
		];
		return [
			this.config.executable ?? "pwsh",
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			PWSH_PREAMBLE + command
		];
	}
};
var DeferredShellProcess = class {
	status = "running";
	exitCode = null;
	signal = null;
	sandbox = {
		mode: "danger-full-access",
		denied: false
	};
	done;
	inner;
	cancelled = false;
	startupError = "";
	constructor(shell, spec) {
		this.done = shell.then(async (executor) => {
			if (this.cancelled) return;
			this.inner = executor.start(spec);
			await this.inner.done;
			this.status = this.inner.status;
			this.exitCode = this.inner.exitCode;
			this.signal = this.inner.signal;
		}, (error) => {
			this.status = "killed";
			this.signal = "SIGTERM";
			this.startupError = `[dsh-ssh-workspace infrastructure error] ${String(error)}\n`;
		});
	}
	readOutput() {
		if (this.inner !== void 0) return this.inner.readOutput();
		const delta = this.startupError;
		this.startupError = "";
		return {
			delta,
			lossy: false
		};
	}
	kill() {
		if (this.status !== "running") return false;
		this.status = "killed";
		this.cancelled = true;
		return this.inner?.kill() ?? true;
	}
};
function assertUnconfined(spec) {
	if (spec.sandboxPolicy !== void 0 && spec.sandboxPolicy.mode !== "danger-full-access") throw new Error(`dsh-ssh-workspace: transparent shell cannot enforce ${spec.sandboxPolicy.mode} across SSH; select danger-full-access or confine the SSH account`);
}
function requireCollected(handle) {
	const { stdout, stderr } = handle.collected;
	if (stdout === void 0 || stderr === void 0) throw new Error("dsh-ssh-workspace: subprocess dropped requested collected output");
	return {
		stdout,
		stderr
	};
}
function finalOutput(reader) {
	const value = reader.readFrom(0);
	return {
		text: value.text,
		truncated: value.lossy,
		...value.spillPath === void 0 ? {} : { spillPath: value.spillPath }
	};
}
//#endregion
export { TransparentShellExecutor, TransparentShellExecutor as default };
