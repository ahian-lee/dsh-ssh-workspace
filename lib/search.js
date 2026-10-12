import { registerHooks } from "node:module";
import { posix } from "node:path";
//#region src/transport/search.ts
const SEARCH_PACKAGE = "@deepseek-ai/dsh-tool-fs-search";
const HOOK_SYMBOL_NAME = "dsh-ssh-workspace.search-path-parser";
const HOOK_SYMBOL = Symbol.for(HOOK_SYMBOL_NAME);
const FUNCTION_START = /function toWorkdirRelative\(path,\s*workdir\)\s*\{/;
const FUNCTION_HOOK = `\n\tconst remotePath = globalThis[Symbol.for(${JSON.stringify(HOOK_SYMBOL_NAME)})]?.(path, workdir);\n\tif (remotePath !== void 0) return remotePath;`;
const name = "dsh-ssh-workspace-search";
const inject = ["remoteSshManager", "loader"];
/** Inject one remote-aware branch into the stock parser before its module loads. */
function apply(ctx) {
	const target = globalThis;
	const previous = target[HOOK_SYMBOL];
	const hook = (path, workdir) => remoteAbsolutePath(ctx.remoteSshManager, path, workdir);
	target[HOOK_SYMBOL] = hook;
	const moduleHooks = registerHooks({ load(url, context, nextLoad) {
		const loaded = nextLoad(url, context);
		if (!isSearchParserModule(url) || loaded.source === void 0) return loaded;
		return {
			...loaded,
			source: injectSearchPathHook(sourceText(loaded.source))
		};
	} });
	for (const url of ctx.loader.internal?.loadCache.keys() ?? []) {
		if (!isSearchPackageModule(url)) continue;
		ctx.loader.internal?.loadCache.delete(url);
	}
	ctx.provide("remoteSshSearchHook", {});
	ctx.effect(() => () => {
		moduleHooks.deregister();
		if (target[HOOK_SYMBOL] !== hook) return;
		if (previous === void 0) delete target[HOOK_SYMBOL];
		else target[HOOK_SYMBOL] = previous;
	}, "Remote SSH search parser hook");
}
/** Source transform is deliberately one insertion at the stock path parser entry. */
function injectSearchPathHook(source) {
	if (source.includes(HOOK_SYMBOL_NAME)) return source;
	if (!FUNCTION_START.test(source)) throw new Error("dsh-ssh-workspace: stock search path parser signature changed");
	return source.replace(FUNCTION_START, (match) => match + FUNCTION_HOOK);
}
/** Return an absolute POSIX path for remote results; leave local paths to stock behavior. */
function remoteAbsolutePath(manager, path, workdir) {
	const route = manager.route(void 0, workdir);
	if (route.kind !== "remote") return void 0;
	const remoteWorkdir = route.mapper.toRemotePath(workdir, route.aliasPath);
	return posix.resolve(remoteWorkdir, path);
}
function sourceText(source) {
	if (typeof source === "string") return source;
	if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
	return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
}
function normalizedModuleUrl(url) {
	const decoded = decodeURIComponent(url).replaceAll("\\", "/");
	const query = decoded.indexOf("?");
	return query === -1 ? decoded : decoded.slice(0, query);
}
function isSearchParserModule(url) {
	const decoded = normalizedModuleUrl(url);
	return decoded.endsWith(`/${SEARCH_PACKAGE}/lib/index.js`) || decoded.endsWith("/packages/fs/tool-fs-search/lib/index.js") || decoded.endsWith("/packages/fs/tool-fs-search/src/search-core.ts");
}
function isSearchPackageModule(url) {
	const decoded = normalizedModuleUrl(url);
	return decoded.includes(`/${SEARCH_PACKAGE}/`) || decoded.includes("/packages/fs/tool-fs-search/");
}
//#endregion
export { apply, apply as default, inject, injectSearchPathHook, name, remoteAbsolutePath };
