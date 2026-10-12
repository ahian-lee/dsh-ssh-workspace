//#region src/backend/control.ts
/** Raised instead of ever attempting the corresponding operation locally. */
var RemoteHostOperationUnsupportedError = class extends Error {
	operation;
	reason;
	constructor(operation, reason) {
		super(`Remote Host does not support ${operation}: ${reason}`);
		this.operation = operation;
		this.reason = reason;
		this.name = "RemoteHostOperationUnsupportedError";
	}
};
/**
* Remote-Agent mode operations. This class deliberately has no local executor,
* filesystem, LLM, settings, or persistence fallback.
*/
var RemoteDshHostControlClient = class {
	host;
	description;
	constructor(host) {
		this.host = host;
	}
	async describe(signal) {
		signal?.throwIfAborted();
		this.description ??= this.host.invokeValue("control", "describe", {}).catch((error) => {
			this.description = void 0;
			throw error;
		});
		const description = await this.description;
		signal?.throwIfAborted();
		if (description.authority !== "remote-host" || description.localFallback !== "forbidden") throw new Error("Remote Host returned an unsafe control-plane policy");
		return description;
	}
	async runShell(command, cwd, timeoutMs, signal) {
		await this.require("shell", signal);
		return this.host.invokeValue("control", "runShell", {
			command,
			cwd,
			timeoutMs
		}, signal);
	}
	async doctor(sessionId, cwd, signal) {
		await this.require("doctor", signal);
		return this.host.invokeValue("control", "doctor", {
			sessionId,
			cwd
		}, signal);
	}
	async mcp(sessionId, signal) {
		await this.require("mcp", signal);
		return this.host.invokeValue("control", "mcp", { sessionId }, signal);
	}
	async commandCatalog(sessionId, signal) {
		await this.require("commands", signal);
		return this.host.invokeValue("control", "commandCatalog", { sessionId }, signal);
	}
	async init(cwd, content, signal) {
		await this.require("init", signal);
		return this.host.invokeValue("control", "init", {
			cwd,
			content
		}, signal);
	}
	async btw(sessionId, question, signal) {
		await this.require("btw", signal);
		return this.host.invokeValue("control", "btw", {
			sessionId,
			question
		}, signal);
	}
	async setSessionMode(sessionId, spec, signal) {
		await this.require("session.mode", signal);
		return this.host.invokeValue("control", "setSessionMode", {
			sessionId,
			spec
		}, signal);
	}
	async deleteSession(_sessionId, signal) {
		await this.require("session.delete", signal);
		throw new Error("Remote Host advertised physical session deletion without a compatible client implementation");
	}
	/**
	* Provider setup already rides the remote core domains. The returned client
	* is the same authenticated Host client; callers use llm/settings/credentials.
	*/
	async providerSetup(signal) {
		await this.require("provider.setup", signal);
		return this.host;
	}
	async setupProvider(request, signal) {
		await this.require("provider.setup", signal);
		return this.host.invokeValue("control", "setupProvider", { request }, signal);
	}
	async require(operation, signal) {
		const availability = (await this.describe(signal)).operations[operation];
		if (availability === void 0) throw new RemoteHostOperationUnsupportedError(operation, "not advertised by this Host version");
		if (!availability.supported) throw new RemoteHostOperationUnsupportedError(operation, availability.reason);
		return availability;
	}
};
//#endregion
export { RemoteDshHostControlClient, RemoteDshHostControlClient as default, RemoteHostOperationUnsupportedError };
