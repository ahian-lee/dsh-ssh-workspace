import { binaryWriter } from "./binary-fs.js";
import { posix } from "node:path";
import { FileSystem, FsTargetKey } from "@deepseek-ai/dsh-fs";
//#region src/routing/fs.ts
const PREFIX = "dsh-ssh-workspace:";
/** Filesystem router that keeps ordinary fs tools unchanged across execution worlds. */
var TransparentFileSystem = class extends FileSystem {
	static inject = ["localFs", "remoteSshManager"];
	local;
	manager;
	constructor(ctx) {
		super(ctx);
		this.local = ctx.localFs;
		this.manager = ctx.remoteSshManager;
	}
	get sandboxMode() {
		return this.local.sandboxMode;
	}
	async resolve(path, opts) {
		const route = this.manager.route(path, opts?.cwd);
		if (route.kind === "local") return this.local.resolve(path, opts);
		return wrapTarget(route, await (await this.manager.workspaceContext(route)).fs.resolve(path, opts));
	}
	processPath(target) {
		return decodeTarget(target) === void 0 ? this.local.processPath(target) : target.displayPath;
	}
	fileUrl(target) {
		const decoded = decodeTarget(target);
		if (decoded === void 0) return this.local.fileUrl(target);
		const route = this.manager.workspace(decoded.workspaceId);
		return `dsh-ssh-workspace://${encodeURIComponent(route.server.id)}/${encodeURIComponent(route.workspace.id)}/${encodeURIComponent(decoded.targetKey)}`;
	}
	contains(parent, child) {
		const parentRemote = decodeTarget(parent);
		const childRemote = decodeTarget(child);
		if (parentRemote === void 0 || childRemote === void 0) return parentRemote === void 0 && childRemote === void 0 && this.local.contains(parent, child);
		if (parentRemote.workspaceId !== childRemote.workspaceId) return false;
		const route = this.manager.workspace(parentRemote.workspaceId);
		const parentPath = route.mapper.toRemotePath(parent.displayPath);
		const childPath = route.mapper.toRemotePath(child.displayPath);
		const rel = posix.relative(parentPath, childPath);
		return rel === "" || rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
	}
	async stat(target, signal) {
		const backend = await this.backend(target);
		return backend.fs.stat(backend.target, signal);
	}
	async lstat(path, opts, signal) {
		const route = this.manager.route(path, opts?.cwd);
		if (route.kind === "local") return this.local.lstat(path, opts, signal);
		return (await this.manager.workspaceContext(route)).fs.lstat(path, opts, signal);
	}
	async readText(target, signal) {
		const backend = await this.backend(target);
		return backend.fs.readText(backend.target, signal);
	}
	async streamText(target, signal) {
		const backend = await this.backend(target);
		return backend.fs.streamText(backend.target, signal);
	}
	async readBytes(target, signal, maxBytes) {
		const backend = await this.backend(target);
		return backend.fs.readBytes(backend.target, signal, maxBytes);
	}
	async listDir(target, signal) {
		const decoded = decodeTarget(target);
		if (decoded === void 0) return this.local.listDir(target, signal);
		const route = this.manager.workspace(decoded.workspaceId);
		return (await (await this.manager.workspaceContext(route)).fs.listDir(unwrapTarget(target, decoded), signal)).map((entry) => ({
			...entry,
			target: wrapTarget(route, entry.target)
		}));
	}
	async writeText(target, content, expected, signal, sandboxPolicy) {
		const backend = await this.backend(target);
		return backend.fs.writeText(backend.target, content, expected, signal, sandboxPolicy);
	}
	async writeBytes(target, content, expected, signal, sandboxPolicy) {
		const backend = await this.backend(target);
		return binaryWriter(backend.fs).writeBytes(backend.target, content, expected, signal, sandboxPolicy);
	}
	async editText(target, edit, expected, signal, sandboxPolicy) {
		const backend = await this.backend(target);
		return backend.fs.editText(backend.target, edit, expected, signal, sandboxPolicy);
	}
	async backend(target) {
		const decoded = decodeTarget(target);
		if (decoded === void 0) return {
			fs: this.local,
			target
		};
		const route = this.manager.workspace(decoded.workspaceId);
		return {
			fs: (await this.manager.workspaceContext(route)).fs,
			target: unwrapTarget(target, decoded)
		};
	}
};
function wrapTarget(route, target) {
	const envelope = {
		workspaceId: route.workspace.id,
		targetKey: String(target.targetKey)
	};
	return {
		targetKey: FsTargetKey(PREFIX + Buffer.from(JSON.stringify(envelope)).toString("base64url")),
		displayPath: target.displayPath
	};
}
function decodeTarget(target) {
	const key = String(target.targetKey);
	if (!key.startsWith(PREFIX)) return void 0;
	try {
		const value = JSON.parse(Buffer.from(key.slice(18), "base64url").toString("utf8"));
		if (typeof value.workspaceId !== "string" || typeof value.targetKey !== "string") throw new Error("invalid fields");
		return value;
	} catch (error) {
		throw new Error(`dsh-ssh-workspace: invalid remote filesystem target '${key}'`, { cause: error });
	}
}
function unwrapTarget(target, decoded) {
	return {
		targetKey: FsTargetKey(decoded.targetKey),
		displayPath: target.displayPath
	};
}
//#endregion
export { TransparentFileSystem, TransparentFileSystem as default };
