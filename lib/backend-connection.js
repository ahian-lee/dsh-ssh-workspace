import { r as RemoteDshHostTunnel } from "./tunnel-BO4E7VdW.js";
//#region src/backend/connection.ts
/**
* Stable logical connection whose physical SSH process may be replaced. The
* remote Host remains a singleton; only the observation tunnel reconnects.
*/
var RemoteDshHostConnection = class RemoteDshHostConnection {
	config;
	opener;
	current;
	reconnecting;
	disposed = false;
	stopped = new AbortController();
	initialDelayMs;
	maxDelayMs;
	constructor(config, opener) {
		this.config = config;
		this.opener = opener;
		this.initialDelayMs = boundedDelay(config.reconnectInitialDelayMs, 250);
		this.maxDelayMs = Math.max(this.initialDelayMs, boundedDelay(config.reconnectMaxDelayMs, 1e4));
	}
	static async open(config, opener = RemoteDshHostTunnel.open) {
		const connection = new RemoteDshHostConnection(config, opener);
		connection.install(await opener(connection.attemptConfig()));
		return connection;
	}
	get alive() {
		return !this.disposed;
	}
	get connected() {
		return this.current?.alive === true;
	}
	get origin() {
		return this.requireCurrent().origin;
	}
	get localPort() {
		return this.requireCurrent().localPort;
	}
	get remotePort() {
		return this.requireCurrent().remotePort;
	}
	requestHeaders() {
		return this.requireCurrent().requestHeaders();
	}
	webSocketUrl(path) {
		return this.requireCurrent().webSocketUrl(path);
	}
	/** Wait for the current tunnel, sharing one retry loop across all callers. */
	async ready(signal) {
		if (this.disposed) throw new Error("dsh-ssh-workspace: Host connection is disposed");
		if (this.current?.alive === true) return this.current;
		const stale = this.current;
		this.current = void 0;
		if (stale !== void 0) stale.dispose().catch(() => void 0);
		const pending = this.reconnecting ?? this.startReconnect();
		return signal === void 0 ? pending : abortable(pending, signal);
	}
	async fetch(path, init = {}) {
		const signal = init.signal ?? void 0;
		return (await this.ready(signal)).fetch(path, init);
	}
	async describeProtocol(signal) {
		return (await this.ready(signal)).describeProtocol(signal);
	}
	/** Force a fresh physical tunnel while preserving the remote Host process. */
	async reconnect() {
		if (this.disposed) throw new Error("dsh-ssh-workspace: Host connection is disposed");
		const previous = this.current;
		this.current = void 0;
		if (previous !== void 0) await previous.dispose();
		await this.ready();
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.stopped.abort(/* @__PURE__ */ new Error("dsh-ssh-workspace: Host connection disposed"));
		const current = this.current;
		this.current = void 0;
		if (current !== void 0) await current.dispose();
		await this.reconnecting?.catch(() => void 0);
	}
	install(tunnel) {
		if (this.disposed) {
			tunnel.dispose();
			throw new Error("dsh-ssh-workspace: Host connection is disposed");
		}
		this.current = tunnel;
		tunnel.closed.then(async () => {
			if (this.current !== tunnel) return;
			this.current = void 0;
			await tunnel.dispose().catch(() => void 0);
			if (!this.disposed) this.ready().catch(() => void 0);
		});
	}
	startReconnect() {
		const task = this.reconnectLoop().finally(() => {
			if (this.reconnecting === task) this.reconnecting = void 0;
		});
		this.reconnecting = task;
		return task;
	}
	async reconnectLoop() {
		let delayMs = 0;
		for (;;) {
			if (this.disposed) throw new Error("dsh-ssh-workspace: Host connection is disposed");
			if (delayMs > 0) await delay(jitter(delayMs), this.stopped.signal);
			try {
				this.config.onProgress?.({ stage: "reconnecting" });
			} catch {}
			try {
				const tunnel = await this.opener(this.attemptConfig());
				this.install(tunnel);
				return tunnel;
			} catch (error) {
				if (this.disposed) throw error;
				delayMs = delayMs === 0 ? this.initialDelayMs : Math.min(this.maxDelayMs, delayMs * 2);
			}
		}
	}
	requireCurrent() {
		const current = this.current;
		if (current?.alive !== true) throw new Error("dsh-ssh-workspace: Host tunnel is reconnecting");
		return current;
	}
	attemptConfig() {
		return {
			...this.config,
			signal: this.stopped.signal
		};
	}
};
function boundedDelay(value, fallback) {
	if (value === void 0) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > 6e4) throw new Error("dsh-ssh-workspace: reconnect delay must be between 1 and 60000ms");
	return value;
}
function jitter(milliseconds) {
	return Math.max(1, Math.round(milliseconds * (.8 + Math.random() * .4)));
}
async function delay(milliseconds, signal) {
	if (signal.aborted) throw abortReason(signal);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
async function abortable(promise, signal) {
	if (signal.aborted) throw abortReason(signal);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
function abortReason(signal) {
	return signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("This operation was aborted");
}
//#endregion
export { RemoteDshHostConnection };
