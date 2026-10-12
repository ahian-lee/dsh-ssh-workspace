import { i as parseProtocolDescription } from "./tunnel-BO4E7VdW.js";
import { randomUUID } from "node:crypto";
import { AbstractApiClient } from "@deepseek-ai/dsh-host-apiproxy/client";
import { hostFrameSchema, muxFrameSchema } from "@deepseek-ai/dsh-host-apiproxy/api/events.schema";
import { serverRequestSchema } from "@deepseek-ai/dsh-host-apiproxy/api/rpc.schema";
//#region src/backend/client.ts
/** UI-neutral client for the dsh-host HTTP/WebSocket protocol. */
/**
* The same client works in a terminal, daemon, test runner, or another UI.
* Core domains use Harness' typed ApiClient; extension RPC uses invoke().
*/
var RemoteDshHostClient = class extends AbstractApiClient {
	endpoint;
	api = this;
	constructor(endpoint, timeoutMs) {
		super(timeoutMs);
		this.endpoint = endpoint;
	}
	resolveBase() {
		return this.endpoint.origin;
	}
	async doFetch(input, init = {}) {
		await this.endpoint.ready?.(init.signal ?? void 0);
		const headers = new Headers(init.headers);
		for (const [name, value] of Object.entries(this.endpoint.requestHeaders())) headers.set(name, value);
		const target = new URL(`${input.pathname}${input.search}`, this.endpoint.origin);
		return globalThis.fetch(target, {
			...init,
			headers
		});
	}
	openMux(_payload, signal, onOpen) {
		return this.readWebSocket("/api/events.mux", signal, muxFrameSchema, onOpen);
	}
	openHost(_payload, signal, onOpen) {
		return this.readWebSocket("/api/events.host", signal, hostFrameSchema, onOpen);
	}
	async invoke(namespace, method, args, signal) {
		assertSegment(namespace, "namespace");
		assertSegment(method, "method");
		const rpcId = randomUUID();
		const response = await this.doFetch(new URL(`/api/${namespace}/${method}`, this.resolveBase()), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "client-request",
				rpcId,
				method: `${namespace}/${method}`,
				payload: { args }
			}),
			...signal === void 0 ? {} : { signal }
		});
		if (!response.ok) throw new Error(`dsh-host extension RPC failed with HTTP ${String(response.status)}`);
		const value = await response.json();
		if (value.type !== "server-response" || value.rpcId !== rpcId) throw new Error("dsh-host extension RPC returned an invalid response envelope");
		return value;
	}
	/** Discover the execution authority and optional Host capabilities. */
	async describeProtocol(signal) {
		const response = await this.doFetch(new URL("/dsh-host/protocol", this.resolveBase()), { ...signal === void 0 ? {} : { signal } });
		if (!response.ok) throw new Error(`dsh-host protocol discovery failed with HTTP ${String(response.status)}`);
		return parseProtocolDescription(await response.json());
	}
	/** Download the Host's canonical Session ZIP through the authenticated carrier. */
	async downloadSessionLog(sessionId, includeDescendants = true, signal) {
		const query = new URLSearchParams({
			sessionId,
			includeDescendants: String(includeDescendants)
		});
		const response = await this.doFetch(new URL(`/api/session.export?${query.toString()}`, this.resolveBase()), { ...signal === void 0 ? {} : { signal } });
		if (!response.ok) throw new Error(`dsh-host session export failed with HTTP ${String(response.status)}`);
		const disposition = response.headers.get("content-disposition") ?? "";
		const advertised = /filename="([^"]+)"/iu.exec(disposition)?.[1];
		return {
			fileName: safeDownloadName(advertised ?? `dsh-session-${sessionId}.zip`),
			data: new Uint8Array(await response.arrayBuffer())
		};
	}
	/** Invoke an extension and turn its failure envelope into a thrown error. */
	async invokeValue(namespace, method, args, signal) {
		const response = await this.invoke(namespace, method, args, signal);
		if (!response.result.ok) throw new RemoteDshHostRpcError(response.result.error.code, response.result.error.message, response.result.error.details);
		return response.result.value;
	}
	async *readWebSocket(path, signal, frameSchema, onOpen) {
		for (;;) {
			signal.throwIfAborted();
			await this.endpoint.ready?.(signal);
			try {
				yield* this.readWebSocketOnce(path, signal, frameSchema, onOpen);
			} catch (error) {
				if (signal.aborted || this.endpoint.ready === void 0) throw error;
			}
			if (this.endpoint.ready === void 0) return;
			await reconnectDelay(signal);
		}
	}
	async *readWebSocketOnce(path, signal, frameSchema, onOpen) {
		const socket = new WebSocket(this.endpoint.webSocketUrl(path));
		const inbox = [];
		let wake;
		const enqueue = (item) => {
			inbox.push(item);
			wake?.();
			wake = void 0;
		};
		const handleOpen = () => {
			onOpen?.();
		};
		const handleMessage = (event) => {
			try {
				if (typeof event.data !== "string") throw new Error("binary WebSocket frame");
				const full = serverRequestSchema.parse(JSON.parse(event.data));
				const frame = frameSchema.parse(full.payload);
				this.onEnvelope(full);
				enqueue({
					kind: "frame",
					envelope: {
						rpcId: full.rpcId,
						payload: frame
					}
				});
			} catch (error) {
				console.error(`[dsh-host] dropping malformed WebSocket frame on ${path}:`, error);
			}
		};
		const handleClose = () => {
			enqueue({ kind: "end" });
		};
		const handleError = () => {
			enqueue({
				kind: "error",
				error: /* @__PURE__ */ new Error(`dsh-host WebSocket failed on ${path}`)
			});
		};
		const handleAbort = () => {
			socket.close();
		};
		socket.addEventListener("open", handleOpen);
		socket.addEventListener("message", handleMessage);
		socket.addEventListener("close", handleClose, { once: true });
		socket.addEventListener("error", handleError, { once: true });
		signal.addEventListener("abort", handleAbort, { once: true });
		if (signal.aborted) handleAbort();
		try {
			for (;;) {
				while (inbox.length > 0) {
					const item = inbox.shift();
					if (item.kind === "end") return;
					if (item.kind === "error") throw item.error;
					yield item.envelope;
				}
				await new Promise((resolve) => {
					wake = resolve;
				});
			}
		} finally {
			signal.removeEventListener("abort", handleAbort);
			socket.removeEventListener("open", handleOpen);
			socket.removeEventListener("message", handleMessage);
			socket.removeEventListener("close", handleClose);
			socket.removeEventListener("error", handleError);
			if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
		}
	}
};
var RemoteDshHostRpcError = class extends Error {
	code;
	details;
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "RemoteDshHostRpcError";
	}
};
function assertSegment(value, label) {
	if (!/^[A-Za-z0-9_$.-]+$/.test(value)) throw new Error(`dsh-host extension ${label} is invalid`);
}
function safeDownloadName(value) {
	const name = value.replaceAll("\\", "/").split("/").at(-1)?.replace(/[^A-Za-z0-9._-]/gu, "_") ?? "";
	return name === "" || name === "." || name === ".." ? "dsh-session.zip" : name;
}
async function reconnectDelay(signal) {
	if (signal.aborted) signal.throwIfAborted();
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, 100);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("This operation was aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
export { RemoteDshHostClient, RemoteDshHostClient as default, RemoteDshHostRpcError };
