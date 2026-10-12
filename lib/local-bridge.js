//#region src/routing/local-bridge.ts
/** Capture isolated local providers under names the root routers can consume. */
const name = "remote-ssh-local-bridge";
const inject = [
	"fs",
	"subprocess",
	"spillStore",
	"shell"
];
/** Publish isolated local providers without changing their implementation. */
function apply(ctx) {
	ctx.provide("localShell", ctx.shell);
	ctx.provide("localFs", ctx.fs);
	ctx.provide("localSpillStore", ctx.spillStore);
	ctx.provide("localSubprocess", ctx.subprocess);
}
//#endregion
export { apply, inject, name };
