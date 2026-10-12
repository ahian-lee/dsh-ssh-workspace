import { c as quotePosix, o as fileUriFromPosixPath } from "./runtime-DWxYRxHs.js";
import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { ContentEncoding } from "@microsoft/agent-host-protocol";
import { SpillLocator, SpillStore } from "@deepseek-ai/dsh-spill";
//#region src/routing/spill.ts
const name = "dsh-ssh-workspace-spill";
const inject = ["localSpillStore", "remoteSshManager"];
/** Route spill artifacts with the session execution world without exposing host files. */
var TransparentSpillStore = class extends SpillStore {
	static inject = ["localSpillStore", "remoteSshManager"];
	local;
	manager;
	constructor(ctx) {
		super(ctx);
		this.local = ctx.localSpillStore;
		this.manager = ctx.remoteSshManager;
	}
	async saveText(input) {
		const route = this.manager.sessionRoute(String(input.owner.sessionId));
		if (route === void 0) throw new Error(`dsh-ssh-workspace: no execution world is bound to spill session '${String(input.owner.sessionId)}'`);
		if (route.kind === "local") return this.local.saveText(input);
		return saveRemoteSpill(this.manager, route, input);
	}
};
/** Persist one spill through the already-authorized AHP host connection. */
async function saveRemoteSpill(manager, route, input) {
	const [{ remote }, shell] = await Promise.all([manager.workspaceContext(route), manager.workspaceShell(route, "bash")]);
	const directory = remoteSpillDirectory(remote.runtimeRoot, String(input.owner.sessionId));
	const path = posix.join(directory, `${randomBytes(12).toString("hex")}-${safeSuggestedName(input.suggestedName)}`);
	const prepared = await shell.run(shell.resolve({
		command: `umask 077 && mkdir -p -m 700 -- ${quotePosix(directory)}`,
		workdir: route.aliasPath,
		timeoutMs: 3e4,
		stdoutMaxBytes: 16384,
		sandboxPolicy: {
			mode: "danger-full-access",
			workspaceRoot: route.aliasPath
		}
	}));
	if (prepared.exitCode !== 0) throw new Error(`dsh-ssh-workspace: failed to prepare remote spill directory: ${prepared.stderr.text.slice(-2048)}`);
	await (await remote.getClient()).resourceWrite({
		uri: fileUriFromPosixPath(path),
		data: input.content,
		encoding: ContentEncoding.Utf8,
		contentType: "text/plain; charset=utf-8",
		createOnly: true
	});
	return {
		locator: SpillLocator(path),
		bytes: Buffer.byteLength(input.content, "utf8"),
		retrievalHint: "Use read with offset/limit, or grep this path to search within it."
	};
}
/** Stable private directory for one session inside this process's remote runtime root. */
function remoteSpillDirectory(runtimeRoot, sessionId) {
	const owner = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return posix.join(runtimeRoot, "spills", `session-${owner}`);
}
/** Suggested names are labels only; randomness supplies identity and collision resistance. */
function safeSuggestedName(value) {
	const bounded = [...value].map((character) => /^[A-Za-z0-9._-]$/.test(character) ? character : "_").join("").slice(0, 96);
	return bounded === "" || bounded === "." || bounded === ".." ? "result.txt" : bounded;
}
//#endregion
export { TransparentSpillStore, TransparentSpillStore as default, inject, name, remoteSpillDirectory, safeSuggestedName, saveRemoteSpill };
