//#region src/routing/agent-policy.ts
const name = "dsh-ssh-workspace-agent-policy";
const inject = [
	"agents",
	"remoteSshManager",
	"systemPrompt",
	"tools"
];
/** Bind each live Agent to one execution world and expose only its native shell dialect. */
function apply(ctx) {
	const manager = ctx.remoteSshManager;
	const bound = /* @__PURE__ */ new WeakSet();
	const pending = /* @__PURE__ */ new Set();
	const bind = (agent) => {
		if (bound.has(agent)) return true;
		const cwd = agent.session.header.cwd;
		const dialect = manager.dialectFor(cwd);
		const hiddenDialect = dialect === "bash" ? "pwsh" : "bash";
		const base = ctx.tools.get(dialect);
		if (base === void 0 || ctx.tools.get(hiddenDialect) === void 0) {
			pending.add(agent);
			return false;
		}
		pending.delete(agent);
		const sessionId = String(agent.session.header.id);
		const route = manager.bindSession(sessionId, agent, cwd);
		try {
			if (route?.kind === "remote") installRemoteWorkspacePrompt(agent.ctx, route);
			agent.ctx.tools.restrict({ deny: [hiddenDialect] });
			if (base !== void 0 && route?.kind === "remote") agent.ctx.tools.register(remoteShellPresentation(base, manager, route));
			bound.add(agent);
			return true;
		} catch (error) {
			manager.unbindSession(sessionId, agent);
			throw error;
		}
	};
	ctx.on("agent/created", ({ agent }) => {
		bind(agent);
	});
	ctx.on("tools/change", () => {
		for (const agent of [...pending]) bind(agent);
	});
	for (const agent of ctx.agents.list()) bind(agent);
	ctx.on("agent/disposed", ({ agent }) => {
		pending.delete(agent);
		ctx.remoteSshManager.unbindSession(String(agent.session.header.id), agent);
	});
}
/** Replace the host-only Workspace alias with the remote execution cwd. */
function installRemoteWorkspacePrompt(ctx, route) {
	ctx.systemPrompt.variable("cwd", () => route.workspace.remotePath);
	ctx.systemPrompt.section({
		name: "remote-ssh:execution-world",
		order: -10,
		text: "This session runs in a Remote SSH workspace. All filesystem and shell tools operate on that remote host, using POSIX paths."
	});
}
/** Shadow only presentation; execution remains the official transparent shell tool. */
function remoteShellPresentation(base, manager, route) {
	return {
		...base,
		presentCall: (args) => presentRemoteShellCall(base.presentCall?.(args), args, manager, route)
	};
}
function presentRemoteShellCall(view, args, manager, route) {
	if (view?.card !== "terminal") return view;
	const workdir = shellWorkdir(args);
	try {
		return {
			...view,
			cwd: manager.displayRemoteCwd(route, workdir)
		};
	} catch {
		return {
			...view,
			cwd: manager.displayRemoteCwd(route)
		};
	}
}
function shellWorkdir(args) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return void 0;
	const value = args.workdir;
	return typeof value === "string" ? value : void 0;
}
//#endregion
export { apply, apply as default, inject, installRemoteWorkspacePrompt, name, presentRemoteShellCall, remoteShellPresentation };
