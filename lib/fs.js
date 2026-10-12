import { n as WorkspacePathMapper, o as fileUriFromPosixPath, s as posixPathFromFileUri } from "./runtime-DWxYRxHs.js";
import { posix } from "node:path";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import z from "@deepseek-ai/schemastery";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
//#region src/transport/fs.ts
const BASE64 = "base64";
const UTF8 = "utf-8";
var RemoteSshFileSystem = class extends FileSystem {
	static inject = ["remoteSsh"];
	static Config = z.object({
		diffBasisMaxBytes: z.number().default(10485760),
		maxReadBytes: z.number().default(67108864),
		localWorkspace: z.string(),
		remoteWorkspace: z.string()
	});
	config;
	remote;
	mapper;
	locks = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx);
		this.remote = ctx.remoteSsh;
		this.config = config;
		if (config.localWorkspace === void 0 !== (config.remoteWorkspace === void 0)) throw new Error("dsh-ssh-workspace/fs: localWorkspace and remoteWorkspace must be configured together");
		this.mapper = config.localWorkspace !== void 0 && config.remoteWorkspace !== void 0 ? new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace) : requireRuntimeMapper(this.remote);
		for (const [name, value] of Object.entries({
			diffBasisMaxBytes: this.config.diffBasisMaxBytes,
			maxReadBytes: this.config.maxReadBytes
		})) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-ssh-workspace/fs: ${name} must be a positive integer`);
	}
	async resolve(path, opts) {
		throwIfAborted(opts?.signal, "resolve");
		let candidate;
		try {
			candidate = this.mapper.toRemotePath(path, opts?.cwd);
		} catch (error) {
			throw new FsError(errorMessage(error), "FS_NOT_FOUND", { cause: error });
		}
		const missing = [];
		let cursor = candidate;
		for (;;) {
			throwIfAborted(opts?.signal, "resolve");
			try {
				const resolved = await this.resolveUri(fileUriFromPosixPath(cursor), true);
				const canonical = posixPathFromFileUri(resolved.uri);
				const remotePath = missing.reduceRight((base, part) => posix.join(base, part), canonical);
				return this.target(remotePath);
			} catch (error) {
				if (!isNotFound(error)) throw mapFsError("resolve", candidate, error);
				const parent = posix.dirname(cursor);
				if (parent === cursor) throw mapFsError("resolve", candidate, error);
				missing.push(posix.basename(cursor));
				cursor = parent;
			}
		}
	}
	processPath(target) {
		return posixPathFromFileUri(String(target.targetKey));
	}
	fileUrl(target) {
		return String(target.targetKey);
	}
	contains(parent, child) {
		const rel = posix.relative(this.processPath(parent), this.processPath(child));
		return rel === "" || rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
	}
	async stat(target, signal) {
		throwIfAborted(signal, "stat");
		const probe = await this.probe(target, true);
		throwIfAborted(signal, "stat");
		if (probe === void 0) return void 0;
		return {
			version: probe.version,
			type: resourceType(probe.resolved.type),
			...probe.resolved.size !== void 0 ? { size: probe.resolved.size } : {}
		};
	}
	async lstat(path, opts, signal) {
		throwIfAborted(signal, "lstat");
		let remotePath;
		try {
			remotePath = this.mapper.toRemotePath(path, opts?.cwd);
		} catch (error) {
			throw new FsError(errorMessage(error), "FS_NOT_FOUND", { cause: error });
		}
		try {
			const resolved = await this.resolveUri(fileUriFromPosixPath(remotePath), false);
			throwIfAborted(signal, "lstat");
			return {
				version: versionOf(resolved),
				type: resolved.type === "symlink" ? "symlink" : resourceType(resolved.type),
				...resolved.size !== void 0 ? { size: resolved.size } : {}
			};
		} catch (error) {
			if (isNotFound(error)) return void 0;
			throw mapFsError("lstat", remotePath, error);
		}
	}
	async readText(target, signal) {
		return decodeText(await this.readBytes(target, signal, this.config.maxReadBytes), target.displayPath);
	}
	async streamText(target, signal) {
		const text = await this.readText(target, signal);
		return (async function* () {
			let offset = 0;
			while (offset < text.length) {
				throwIfAborted(signal, "read");
				let end = Math.min(text.length, offset + 65536);
				if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
				yield text.slice(offset, end);
				offset = end;
			}
		})();
	}
	async readBytes(target, signal, maxBytes) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FsError("maxBytes must be a non-negative integer", "FS_TOO_LARGE");
		throwIfAborted(signal, "read");
		const info = await this.stat(target, signal);
		if (info === void 0) throw new FsError(`cannot read "${target.displayPath}": file not found`, "FS_NOT_FOUND");
		if (info.type !== "file") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
		if (info.size !== void 0 && info.size > maxBytes) throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, "FS_TOO_LARGE");
		try {
			const result = await (await this.remote.getClient()).resourceRead({
				uri: this.fileUrl(target),
				encoding: BASE64
			});
			throwIfAborted(signal, "read");
			const bytes = result.encoding === BASE64 ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
			if (bytes.length > maxBytes) throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, "FS_TOO_LARGE");
			return bytes;
		} catch (error) {
			if (error instanceof FsError) throw error;
			throw mapFsError("read", target.displayPath, error);
		}
	}
	async listDir(target, signal) {
		throwIfAborted(signal, "list");
		try {
			const listed = await (await this.remote.getClient()).resourceList({ uri: this.fileUrl(target) });
			const entries = [];
			for (const entry of listed.entries.sort((a, b) => a.name.localeCompare(b.name))) {
				throwIfAborted(signal, "list");
				const child = await this.resolve(posix.join(this.processPath(target), entry.name), signal === void 0 ? void 0 : { signal });
				const info = await this.stat(child, signal);
				entries.push({
					name: entry.name,
					type: info?.type ?? entry.type,
					target: child,
					...info?.version !== void 0 ? { version: info.version } : {},
					...info?.size !== void 0 ? { size: info.size } : {}
				});
			}
			return entries;
		} catch (error) {
			if (error instanceof FsError) throw error;
			throw mapFsError("list", target.displayPath, error);
		}
	}
	async writeText(target, content, expected, signal, sandboxPolicy) {
		assertMutationAllowed(this.mapper, target, sandboxPolicy);
		return this.withLock(String(target.targetKey), async () => {
			throwIfAborted(signal, "write");
			const existing = await this.probe(target, true);
			if (existing !== void 0 && resourceType(existing.resolved.type) !== "file") throw new FsError(`cannot write "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			if (expected?.kind === "replaceIfVersion") {
				if (existing === void 0 || existing.version !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			} else if (expected?.kind === "createIfAbsent" && existing !== void 0) throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
			let before = null;
			if (existing !== void 0 && (existing.resolved.size ?? this.config.diffBasisMaxBytes) < this.config.diffBasisMaxBytes && Buffer.byteLength(content, "utf8") < this.config.diffBasisMaxBytes) try {
				before = normalizeLineEndings(await this.readText(target, signal));
			} catch {
				before = null;
			}
			try {
				await (await this.remote.getClient()).resourceWrite({
					uri: this.fileUrl(target),
					data: content,
					encoding: UTF8,
					contentType: "text/plain; charset=utf-8",
					...expected?.kind === "createIfAbsent" ? { createOnly: true } : {},
					...expected?.kind === "replaceIfVersion" && existing?.resolved.etag !== void 0 ? { ifMatch: existing.resolved.etag } : {}
				});
			} catch (error) {
				if (error instanceof RpcError && error.code === AhpErrorCodes.AlreadyExists) throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED", { cause: error });
				throw mapFsError("write", target.displayPath, error);
			}
			throwIfAborted(signal, "write");
			const after = await this.probe(target, true);
			if (after === void 0) throw new FsError(`write did not publish "${target.displayPath}"`, "FS_IO_ERROR");
			return {
				operation: existing === void 0 ? "create" : "update",
				version: after.version,
				before,
				after: normalizeLineEndings(content)
			};
		});
	}
	async writeBytes(target, content, expected, signal, sandboxPolicy) {
		assertMutationAllowed(this.mapper, target, sandboxPolicy);
		return this.withLock(String(target.targetKey), async () => {
			throwIfAborted(signal, "write");
			const existing = await this.probe(target, true);
			if (existing !== void 0 && resourceType(existing.resolved.type) !== "file") throw new FsError(`cannot write "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			if (expected?.kind === "replaceIfVersion") {
				if (existing === void 0 || existing.version !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			} else if (expected?.kind === "createIfAbsent" && existing !== void 0) throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
			try {
				await (await this.remote.getClient()).resourceWrite({
					uri: this.fileUrl(target),
					data: Buffer.from(content).toString("base64"),
					encoding: BASE64,
					contentType: "application/octet-stream",
					...expected?.kind === "createIfAbsent" ? { createOnly: true } : {},
					...expected?.kind === "replaceIfVersion" && existing?.resolved.etag !== void 0 ? { ifMatch: existing.resolved.etag } : {}
				});
			} catch (error) {
				if (error instanceof RpcError && error.code === AhpErrorCodes.AlreadyExists) throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED", { cause: error });
				throw mapFsError("write", target.displayPath, error);
			}
			throwIfAborted(signal, "write");
			const after = await this.probe(target, true);
			if (after === void 0) throw new FsError(`write did not publish "${target.displayPath}"`, "FS_IO_ERROR");
			return {
				operation: existing === void 0 ? "create" : "update",
				version: after.version,
				bytes: content.byteLength
			};
		});
	}
	async editText(target, edit, expected, signal, sandboxPolicy) {
		assertMutationAllowed(this.mapper, target, sandboxPolicy);
		return this.withLock(String(target.targetKey), async () => {
			throwIfAborted(signal, "edit");
			const existing = await this.probe(target, true);
			if (existing === void 0 || expected !== void 0 && existing.version !== expected.version) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			if (resourceType(existing.resolved.type) !== "file") throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			const stored = await this.readText(target, signal);
			const before = normalizeLineEndings(stored);
			const oldString = normalizeLineEndings(edit.oldString);
			if (oldString.length === 0) throw new FsError("old_string must be non-empty", "FS_EDIT_NOT_FOUND");
			const count = countOccurrences(before, oldString);
			if (count === 0) throw new FsError(`old_string was not found in "${target.displayPath}"`, "FS_EDIT_NOT_FOUND");
			if (!edit.replaceAll && count !== 1) throw new FsError(`old_string appears ${count} times in "${target.displayPath}"`, "FS_AMBIGUOUS_EDIT");
			const normalizedAfter = edit.replaceAll ? before.split(oldString).join(normalizeLineEndings(edit.newString)) : before.replace(oldString, normalizeLineEndings(edit.newString));
			const afterStorage = usesCrlf(stored) ? normalizedAfter.replaceAll("\n", "\r\n") : normalizedAfter;
			try {
				await (await this.remote.getClient()).resourceWrite({
					uri: this.fileUrl(target),
					data: afterStorage,
					encoding: UTF8,
					contentType: "text/plain; charset=utf-8",
					...existing.resolved.etag !== void 0 ? { ifMatch: existing.resolved.etag } : {}
				});
			} catch (error) {
				throw mapFsError("edit", target.displayPath, error);
			}
			throwIfAborted(signal, "edit");
			const afterProbe = await this.probe(target, true);
			if (afterProbe === void 0) throw new FsError(`edit did not publish "${target.displayPath}"`, "FS_IO_ERROR");
			return {
				version: afterProbe.version,
				before,
				after: normalizedAfter
			};
		});
	}
	target(remotePath) {
		const uri = fileUriFromPosixPath(remotePath);
		return {
			targetKey: FsTargetKey(uri),
			displayPath: posix.normalize(remotePath)
		};
	}
	async resolveUri(uri, followSymlinks) {
		return (await this.remote.getClient()).resourceResolve({
			uri,
			followSymlinks
		});
	}
	async probe(target, followSymlinks) {
		try {
			const resolved = await this.resolveUri(this.fileUrl(target), followSymlinks);
			return {
				resolved,
				version: versionOf(resolved)
			};
		} catch (error) {
			if (isNotFound(error)) return void 0;
			throw mapFsError("stat", target.displayPath, error);
		}
	}
	async withLock(key, operation) {
		const run = (this.locks.get(key) ?? Promise.resolve()).then(operation, operation);
		const tail = run.then(() => void 0, () => void 0);
		this.locks.set(key, tail);
		try {
			return await run;
		} finally {
			if (this.locks.get(key) === tail) this.locks.delete(key);
		}
	}
};
function assertMutationAllowed(mapper, target, policy) {
	if (policy === void 0 || policy.mode === "danger-full-access") return;
	if (policy.mode === "read-only") throw new FsError(`remote mutation denied for \"${target.displayPath}\" by read-only mode`, "FS_SANDBOX_DENIED");
	const workspace = mapper.toRemotePath(policy.workspaceRoot);
	const path = posixPathFromFileUri(String(target.targetKey));
	const rel = posix.relative(workspace, path);
	if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) throw new FsError(`remote mutation denied outside workspace: \"${target.displayPath}\"`, "FS_SANDBOX_DENIED");
}
function requireRuntimeMapper(remote) {
	if (remote.mapper !== void 0) return remote.mapper;
	try {
		return remote.getMapper();
	} catch (error) {
		throw new Error("dsh-ssh-workspace/fs: a workspace mapping is required when the shared host runtime has no default mapper", { cause: error });
	}
}
function versionOf(result) {
	return FsVersion(result.etag ?? JSON.stringify([
		result.uri,
		result.type,
		result.size,
		result.mtime,
		result.ctime
	]));
}
function resourceType(type) {
	if (type === "file") return "file";
	if (type === "directory") return "directory";
	return "other";
}
function isNotFound(error) {
	return error instanceof RpcError && error.code === AhpErrorCodes.NotFound;
}
function mapFsError(operation, path, error) {
	if (error instanceof FsError) return error;
	if (error instanceof RpcError) {
		if (error.code === AhpErrorCodes.NotFound) return new FsError(`${operation} failed for "${path}": not found`, "FS_NOT_FOUND", { cause: error });
		if (error.code === AhpErrorCodes.PermissionDenied) return new FsError(`${operation} denied for "${path}"`, "FS_PERMISSION_DENIED", { cause: error });
		if (error.code === AhpErrorCodes.Conflict) return new FsError(`${operation} failed for "${path}": file changed`, "FS_STALE_VERSION", { cause: error });
	}
	return new FsError(`${operation} failed for "${path}": ${errorMessage(error)}`, "FS_IO_ERROR", { cause: error });
}
function throwIfAborted(signal, operation) {
	if (signal?.aborted) throw new FsError(`${operation} aborted`, "FS_ABORTED", { cause: signal.reason });
}
function decodeText(bytes, path) {
	if (bytes.includes(0)) throw new FsError(`cannot read "${path}": file contains NUL bytes`, "FS_NOT_TEXT");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new FsError(`cannot read "${path}": file is not valid UTF-8`, "FS_NOT_TEXT", { cause: error });
	}
}
function normalizeLineEndings(value) {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
function usesCrlf(value) {
	return value.includes("\r\n") && !value.replaceAll("\r\n", "").includes("\n");
}
function countOccurrences(haystack, needle) {
	let count = 0;
	let offset = 0;
	while ((offset = haystack.indexOf(needle, offset)) !== -1) {
		count += 1;
		offset += needle.length;
	}
	return count;
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { RemoteSshFileSystem, RemoteSshFileSystem as default };
