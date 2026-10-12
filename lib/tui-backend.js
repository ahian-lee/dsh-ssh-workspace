import { RemoteDshHostControlClient, RemoteHostOperationUnsupportedError } from "./backend-control.js";
import { a as parseSshConnectionInvocation, i as discoveredSshServerId } from "./config-BN3gCBP-.js";
import { n as remoteDisplayCwd, r as remoteServerIdentity, t as listAvailableServers } from "./servers-D7rAxx-9.js";
import { join, posix } from "node:path";
import { writeFile } from "node:fs/promises";
//#region src/client/locales.ts
/** English copy for Remote SSH settings and workspace flows. */
const en = {
	nav: "Remote SSH",
	pluginSummary: "OpenSSH host discovery and remote workspaces.",
	sshConfigLabel: "Custom SSH config file",
	sshConfigPlaceholder: "Leave blank to use the user and system defaults",
	sshConfigHelp: "When set, hosts are discovered only from this file and its Includes.",
	absolutePathRequired: "Enter an absolute file path.",
	saveFailed: "Could not save. Check the path and settings permissions.",
	discard: "Discard",
	save: "Save",
	saving: "Saving…",
	openFileLabel: "Open remote files with",
	openFileAuto: "Auto-detect VSC editor (recommended)",
	openFileVscode: "Visual Studio Code",
	openFileCursor: "Cursor",
	openFileWindsurf: "Windsurf",
	openFileVscodium: "VSCodium",
	openFileCustom: "Custom VSC-compatible editor",
	openFileDownload: "Always download and open locally",
	openFileHelp: "If no compatible editor is available, the file is downloaded and opened locally.",
	customEditorLabel: "Editor executable",
	customEditorPlaceholder: "Absolute path to the editor executable",
	directoryPath: "{title} path",
	go: "Go",
	home: "Home",
	parent: "Up",
	directoryLoading: "Loading directory…",
	directoryEmpty: "This directory has no subdirectories.",
	cancel: "Cancel",
	selectCurrentFolder: "Select current folder",
	title: "Remote SSH",
	summary: "Discovered {servers} SSH hosts; {workspaces} remote workspaces.",
	servers: "Servers",
	savedServer: "Saved by a remote workspace",
	test: "Test",
	openBackend: "Open Backend in Web",
	backendOpened: "Backend opened in a new window.",
	popupBlocked: "Allow pop-ups to open the Backend.",
	backendConnecting: "Connecting to Host…",
	backendReconnecting: "Reconnecting to Host…",
	backendChecking: "Checking Host…",
	backendWaiting: "Waiting for another Host update…",
	backendUploading: "Uploading Host…",
	backendReusing: "Reusing installed Host…",
	backendInstallingNode: "Installing Node.js…",
	backendInstallingPnpm: "Installing pnpm…",
	backendInstallingHarness: "Installing DeepSeek Harness…",
	backendVerifyingRuntime: "Verifying runtime…",
	backendInstallingBundle: "Installing Host bundle…",
	backendStarting: "Starting Host…",
	backendReady: "Host is ready.",
	noHosts: "No concrete Host entries were found in the active SSH configuration.",
	addSshHost: "Add new SSH host…",
	refresh: "Refresh",
	sshCommand: "SSH connection command",
	chooseSshConfig: "Choose the SSH config file to update",
	customConfigAction: "Settings · Specify custom config file",
	add: "Add",
	hostAdded: "The SSH host was written to the config file.",
	configReloaded: "SSH configuration reloaded.",
	customConfigGuidance: "Set an absolute “Custom SSH config file” path in Settings > Plugins > Remote SSH.",
	probeSuccess: "Connected: {hostname}; {commands}",
	probeFailure: "Connection failed: {error}",
	unknownError: "Unknown error",
	remoteWorkspaces: "Remote workspaces",
	removeMapping: "Remove execution mapping",
	server: "Server",
	remotePath: "Remote path",
	remotePathHelp: "Enter an absolute remote directory or browse to select one. Example text is not a selected path.",
	browseRemote: "Browse remote…",
	addWorkspace: "Add workspace",
	selectRemoteFolder: "Select remote folder",
	tombstoneHelp: "Removing a mapping does not delete its Workspace or Session logs.",
	addWorkspaceTitle: "Add workspace",
	chooseLocalFolder: "LOCAL · Choose local folder…",
	selectLocalFolder: "Select local folder",
	selectRemoteSsh: "Select Remote SSH",
	remotePathPlaceholder: "Absolute remote path, for example /srv/project"
};
/** Chinese copy for Remote SSH settings and workspace flows. */
const zh = {
	nav: "Remote SSH",
	pluginSummary: "OpenSSH 主机发现与远端工作区。",
	sshConfigLabel: "自定义 SSH 配置文件",
	sshConfigPlaceholder: "留空以使用用户和系统默认配置",
	sshConfigHelp: "设置后仅从该文件及其 Include 中发现主机。",
	absolutePathRequired: "请输入绝对文件路径。",
	saveFailed: "保存失败，请检查路径和设置写权限。",
	discard: "放弃",
	save: "保存",
	saving: "保存中…",
	openFileLabel: "远端文件打开方式",
	openFileAuto: "自动检测 VSC 编辑器（推荐）",
	openFileVscode: "Visual Studio Code",
	openFileCursor: "Cursor",
	openFileWindsurf: "Windsurf",
	openFileVscodium: "VSCodium",
	openFileCustom: "自定义 VSC 兼容编辑器",
	openFileDownload: "总是下载后在本机打开",
	openFileHelp: "找不到可用编辑器时，将下载文件并在本机打开。",
	customEditorLabel: "编辑器可执行文件",
	customEditorPlaceholder: "编辑器可执行文件的绝对路径",
	directoryPath: "{title}路径",
	go: "转到",
	home: "主目录",
	parent: "上一级",
	directoryLoading: "正在读取目录…",
	directoryEmpty: "此目录没有子目录。",
	cancel: "取消",
	selectCurrentFolder: "选择当前文件夹",
	title: "Remote SSH",
	summary: "SSH 配置中发现 {servers} 台主机，远端工作区 {workspaces} 个。",
	servers: "服务器",
	savedServer: "已被远端工作区保存",
	test: "测试",
	openBackend: "在 Web 中打开 Backend",
	backendOpened: "Backend 已在新窗口中打开。",
	popupBlocked: "请允许弹出窗口以打开 Backend。",
	backendConnecting: "正在连接 Host…",
	backendReconnecting: "正在重新连接 Host…",
	backendChecking: "正在检查 Host…",
	backendWaiting: "正在等待另一个 Host 更新…",
	backendUploading: "正在上传 Host…",
	backendReusing: "正在复用已安装的 Host…",
	backendInstallingNode: "正在安装 Node.js…",
	backendInstallingPnpm: "正在安装 pnpm…",
	backendInstallingHarness: "正在安装 DeepSeek Harness…",
	backendVerifyingRuntime: "正在验证运行时…",
	backendInstallingBundle: "正在安装 Host bundle…",
	backendStarting: "正在启动 Host…",
	backendReady: "Host 已就绪。",
	noHosts: "活动 SSH 配置中没有具体的 Host。",
	addSshHost: "添加新 SSH 主机…",
	refresh: "刷新",
	sshCommand: "SSH 连接命令",
	chooseSshConfig: "选择要更新的 SSH 配置文件",
	customConfigAction: "设置 · 指定自定义配置文件",
	add: "添加",
	hostAdded: "SSH 主机已写入配置文件。",
	configReloaded: "已重新读取 SSH 配置。",
	customConfigGuidance: "请在“设置 > 插件 > Remote SSH”中填写“自定义 SSH 配置文件”的绝对路径。",
	probeSuccess: "连接成功：{hostname}；{commands}",
	probeFailure: "连接失败：{error}",
	unknownError: "未知错误",
	remoteWorkspaces: "远端工作区",
	removeMapping: "移除执行映射",
	server: "服务器",
	remotePath: "远端路径",
	remotePathHelp: "请填写远端目录的绝对路径，或点击“浏览远端”选择。输入框中的示例不代表已选择路径。",
	browseRemote: "浏览远端…",
	addWorkspace: "添加工作区",
	selectRemoteFolder: "选择远端文件夹",
	tombstoneHelp: "移除映射不会删除 Workspace 或会话日志。",
	addWorkspaceTitle: "添加工作区",
	chooseLocalFolder: "LOCAL · 选择本机文件夹…",
	selectLocalFolder: "选择本机文件夹",
	selectRemoteSsh: "选择 Remote SSH",
	remotePathPlaceholder: "远端绝对路径，例如 /srv/project"
};
//#endregion
//#region src/backend/progress.ts
/** One source of truth for Host bootstrap stage copy across Web and TUI. */
function backendProgressLocaleKey(stage) {
	switch (stage) {
		case "waiting-host": return "backendWaiting";
		case "connecting": return "backendConnecting";
		case "reconnecting": return "backendReconnecting";
		case "checking-host":
		case "checking-runtime":
		case "installing-host": return "backendChecking";
		case "uploading-host": return "backendUploading";
		case "reusing-host": return "backendReusing";
		case "installing-node": return "backendInstallingNode";
		case "installing-pnpm": return "backendInstallingPnpm";
		case "installing-harness": return "backendInstallingHarness";
		case "verifying-runtime": return "backendVerifyingRuntime";
		case "installing-bundle": return "backendInstallingBundle";
		case "installed":
		case "starting-host": return "backendStarting";
		case "ready": return "backendReady";
		default: return "backendConnecting";
	}
}
//#endregion
//#region src/tui/switchable-channel.ts
/**
* Identity-stable proxy for React/useSyncExternalStore consumers. Switching
* the delegate rebinds subscriptions and emits one invalidation without
* remounting the terminal UI.
*/
var SwitchableChannel = class {
	proxy;
	delegate;
	local;
	overrides;
	listeners = /* @__PURE__ */ new Set();
	unsubscribeDelegate;
	methodCache = /* @__PURE__ */ new Map();
	constructor(local, overrides = {}) {
		this.local = local;
		this.delegate = this.local;
		this.overrides = overrides;
		const subscribe = (listener) => this.subscribe(listener);
		this.proxy = new Proxy({}, {
			get: (_target, property) => {
				if (property === "subscribe") return subscribe;
				const override = typeof property === "string" ? this.overrides[property] : void 0;
				if (override !== void 0) {
					let cached = this.methodCache.get(property);
					if (cached === void 0) {
						cached = (...args) => override(this.delegate, ...args);
						this.methodCache.set(property, cached);
					}
					return cached;
				}
				const value = Reflect.get(this.delegate, property, this.delegate);
				if (typeof value !== "function") return value;
				let cached = this.methodCache.get(property);
				if (cached === void 0) {
					cached = (...args) => {
						const current = Reflect.get(this.delegate, property, this.delegate);
						if (typeof current !== "function") throw new TypeError(`channel member ${String(property)} is not callable`);
						return Reflect.apply(current, this.delegate, args);
					};
					this.methodCache.set(property, cached);
				}
				return cached;
			},
			set: (_target, property, value) => Reflect.set(this.delegate, property, value, this.delegate),
			has: (_target, property) => property === "subscribe" || Reflect.has(this.delegate, property),
			ownKeys: () => Reflect.ownKeys(this.delegate),
			getOwnPropertyDescriptor: (_target, property) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(this.delegate, property);
				return descriptor === void 0 ? void 0 : {
					...descriptor,
					configurable: true
				};
			}
		});
	}
	get current() {
		return this.delegate;
	}
	get localChannel() {
		return this.local;
	}
	switchTo(channel) {
		const next = channel;
		if (next === this.delegate) return;
		this.unsubscribeDelegate?.();
		this.unsubscribeDelegate = void 0;
		this.delegate = next;
		this.methodCache.clear();
		this.bindDelegate();
		this.emit();
	}
	restoreLocal() {
		this.switchTo(this.local);
	}
	dispose() {
		this.unsubscribeDelegate?.();
		this.unsubscribeDelegate = void 0;
		this.listeners.clear();
		this.methodCache.clear();
	}
	subscribe(listener) {
		this.listeners.add(listener);
		this.bindDelegate();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.unsubscribeDelegate?.();
				this.unsubscribeDelegate = void 0;
			}
		};
	}
	bindDelegate() {
		if (this.unsubscribeDelegate !== void 0 || this.listeners.size === 0) return;
		const subscribe = Reflect.get(this.delegate, "subscribe", this.delegate);
		if (typeof subscribe !== "function") return;
		const dispose = Reflect.apply(subscribe, this.delegate, [() => this.emit()]);
		if (typeof dispose === "function") this.unsubscribeDelegate = dispose;
	}
	emit() {
		for (const listener of this.listeners) listener();
	}
};
//#endregion
//#region src/tui/backend-controller.ts
/** Owns TUI backend identity independently from transparent workspace routing. */
var RemoteSshTuiBackendController = class {
	manager;
	id = "dsh-ssh-workspace";
	host;
	localSurfaceChannel;
	switched;
	factory;
	attachment;
	clients = /* @__PURE__ */ new Map();
	targets = /* @__PURE__ */ new Map();
	constructor(manager) {
		this.manager = manager;
	}
	registerFactory(factory) {
		if (this.factory !== void 0) throw new Error("dsh-ssh-workspace: a remote TUI channel factory is already registered");
		this.factory = factory;
		return () => {
			if (this.factory === factory) this.factory = void 0;
		};
	}
	attach(host) {
		if (this.host !== void 0) throw new Error("dsh-ssh-workspace: dsh-tui backend was attached more than once");
		const switched = new SwitchableChannel(host.channel, { switchWorkspace: (delegate, target) => {
			if (isBackendTarget(target)) return this.activateTarget(target);
			return callDelegate(delegate, "switchWorkspace", [target]);
		} });
		this.switched = switched;
		this.localSurfaceChannel = host.channel;
		this.host = host;
		return {
			channel: switched.proxy,
			handleCommand: (request) => this.handleCommand(request),
			dispose: () => this.detach()
		};
	}
	handleCommand(request) {
		if (request.name === "disconnect") {
			this.disconnect().then(() => {
				request.channel.notify("Disconnected from the remote DSH Host.", { timeoutMs: 3e3 });
			}).catch((error) => {
				request.channel.notify(error instanceof Error ? error.message : String(error), {
					color: "error",
					timeoutMs: 8e3
				});
			});
			return true;
		}
		if (request.name === "connect") {
			this.connect(request).catch((error) => {
				request.channel.notify(error instanceof Error ? error.message : String(error), {
					color: "error",
					timeoutMs: 8e3
				});
			});
			return true;
		}
		return this.attachment?.handleCommand?.(request) ?? false;
	}
	async connect(request) {
		if (this.attachment !== void 0) {
			request.channel.notify("A remote DSH Host is already active. Use /disconnect first.", {
				color: "warning",
				timeoutMs: 5e3
			});
			return true;
		}
		const command = request.input.trim();
		const visible = command.length === 0 ? await listAvailableServers(this.manager) : [serverFromSshCommand(command)];
		request.present({
			kind: "choices",
			title: "Remote DSH Hosts",
			choices: visible.map((server) => ({
				id: server.id,
				label: server.label,
				description: server.sshTarget,
				badge: remoteServerIdentity(server),
				choose: (signal, reportProgress) => this.directoryChoices(server, void 0, signal, reportProgress)
			}))
		});
		return true;
	}
	async disconnect() {
		const attachment = this.attachment;
		this.attachment = void 0;
		this.switched?.restoreLocal();
		if (attachment !== void 0) await attachment.dispose();
	}
	async dispose() {
		await this.detach();
		this.clients.clear();
		this.targets.clear();
	}
	async detach() {
		await this.disconnect();
		this.switched?.dispose();
		this.switched = void 0;
		this.host = void 0;
		this.localSurfaceChannel = void 0;
	}
	async directoryChoices(server, path, signal, reportProgress) {
		signal?.throwIfAborted();
		const locale = this.host?.locale?.() ?? "en";
		const unwatch = reportProgress === void 0 ? void 0 : this.manager.watchBackendProgress(server, (progress) => {
			reportProgress({ label: backendProgressLabel(progress, locale) });
		});
		let result;
		try {
			const backend = await this.clientFor(server);
			reportProgress?.({ label: locale.startsWith("zh") ? zh.directoryLoading : en.directoryLoading });
			result = (await backend.client.api.host.listDirectory(path === void 0 ? {} : { path }, signal)).result;
		} finally {
			unwatch?.();
		}
		if (!result.ok) throw new Error(result.error.message);
		const listing = result.value;
		const choices = [{
			id: `select:${listing.path}`,
			label: "Use this directory",
			description: listing.path,
			badge: "OPEN",
			choose: () => ({
				kind: "target",
				target: this.targetFor(server, listing.path)
			}),
			input: {
				initialValue: listing.path,
				placeholder: "/absolute/remote/path",
				submit: (value, nextSignal, nextProgress) => this.directoryChoices(server, value, nextSignal, nextProgress)
			}
		}];
		const parent = listing.crumbs.at(-2);
		if (parent !== void 0) choices.push({
			id: `parent:${parent.path}`,
			label: "..",
			description: parent.path,
			choose: (nextSignal, nextProgress) => this.directoryChoices(server, parent.path, nextSignal, nextProgress)
		});
		for (const entry of listing.entries) choices.push({
			id: `directory:${entry.path}`,
			label: entry.name,
			description: entry.path,
			choose: (nextSignal, nextProgress) => this.directoryChoices(server, entry.path, nextSignal, nextProgress)
		});
		return {
			kind: "choices",
			title: `${server.label} · ${listing.path}`,
			choices
		};
	}
	targetFor(server, path) {
		const normalized = posix.normalize(path);
		const uri = backendTargetUri(server.id, normalized);
		this.targets.set(uri, {
			server,
			path: normalized
		});
		return {
			uri,
			cwd: normalized,
			label: `${server.label} > ${posix.basename(normalized) || normalized}`,
			description: normalized,
			kind: "provider",
			badge: remoteServerIdentity(server)
		};
	}
	async activateTarget(target) {
		const host = this.host;
		const switched = this.switched;
		const factory = this.factory;
		const selection = this.targets.get(target.uri);
		if (host === void 0 || switched === void 0) throw new Error("dsh-ssh-workspace: TUI backend is not attached");
		if (selection === void 0) throw new Error("dsh-ssh-workspace: unknown remote Host workspace target");
		if (factory === void 0) throw new Error("dsh-ssh-workspace: remote TUI channel factory is not installed");
		const backend = await this.clientFor(selection.server);
		const workspaceResult = (await backend.client.api.workspace.create({ path: selection.path })).result;
		if (!workspaceResult.ok) throw new Error(workspaceResult.error.message);
		const next = await factory.attach({
			api: backend.client.api,
			client: backend.client,
			server: selection.server,
			workspace: workspaceResult.value.workspace,
			host: {
				...host,
				channel: switched.localChannel
			}
		});
		const previous = this.attachment;
		this.attachment = next;
		switched.switchTo(next.channel);
		if (previous !== void 0) await previous.dispose();
		return true;
	}
	clientFor(server) {
		const key = `${server.sshTarget}\0${(server.sshArgs ?? []).join("\0")}\0${String(server.backendPort ?? 0)}`;
		let pending = this.clients.get(key);
		if (pending !== void 0) return pending;
		pending = this.openClient(server);
		this.clients.set(key, pending);
		pending.catch(() => {
			if (this.clients.get(key) === pending) this.clients.delete(key);
		});
		return pending;
	}
	async openClient(server) {
		const connection = await this.manager.connectBackend(server);
		await connection.describeProtocol();
		const client = await this.manager.connectBackendClient(server);
		const description = (await client.api.host.describe({})).result;
		if (!description.ok) throw new Error(description.error.message);
		return {
			server,
			connection,
			client
		};
	}
};
/** Convert a familiar `ssh ...` command into an ephemeral Backend target. */
function serverFromSshCommand(command) {
	const parsed = parseSshConnectionInvocation(command);
	return {
		id: discoveredSshServerId(JSON.stringify([
			parsed.executable,
			parsed.sshTarget,
			parsed.sshArgs
		])),
		label: parsed.sshTarget,
		sshTarget: parsed.sshTarget,
		...parsed.sshArgs.length === 0 ? {} : { sshArgs: parsed.sshArgs },
		...parsed.executable === "ssh" ? {} : { sshExecutable: parsed.executable }
	};
}
function backendTargetUri(serverId, path) {
	const encodedPath = path.split("/").map((part, index) => index === 0 ? "" : encodeURIComponent(part)).join("/");
	return `dsh-host+ssh://${encodeURIComponent(serverId)}${encodedPath}`;
}
function isBackendTarget(value) {
	return typeof value === "object" && value !== null && typeof value.uri === "string" && value.uri.startsWith("dsh-host+ssh://");
}
/** Same Host stages as the Web progress surface, localized for the TUI. */
function backendProgressLabel(progress, locale) {
	const copy = locale.startsWith("zh") ? zh : en;
	if (progress.stage === "failed") return progress.error ?? copy.probeFailure.replace("{error}", copy.unknownError);
	return copy[backendProgressLocaleKey(progress.stage)];
}
function callDelegate(delegate, method, args) {
	const member = Reflect.get(delegate, method, delegate);
	if (typeof member !== "function") throw new TypeError(`channel member ${method} is not callable`);
	return Reflect.apply(member, delegate, args);
}
//#endregion
//#region src/tui/remote-channel.ts
/** Creates one Host-owned session Channel after the control plane selects a workspace. */
var RemoteHostTuiChannelFactory = class {
	async attach(request) {
		const created = (await request.api.sessions.create({ workspaceId: request.workspace.workspaceId })).result;
		if (!created.ok) throw new Error(created.error.message);
		const channel = new RemoteHostChannel(request.client, request.server, request.workspace, created.value.sessionId, request.host, created.value.agentPreset);
		await channel.open();
		return {
			channel,
			handleCommand: (request) => channel.handleBackendCommand(request),
			dispose: () => channel.dispose()
		};
	}
};
/** Host-protocol implementation of dsh-tui's public Channel contract. */
var RemoteHostChannel = class {
	server;
	ui;
	version = 0;
	rows = [];
	status = "starting";
	sessionTitle;
	agentId;
	model = "";
	provider = "";
	tokens = {
		input: 0,
		output: 0
	};
	cwd;
	displayCwd;
	gitBranch;
	working = false;
	spinnerMode = "thinking";
	responseChars = 0;
	activeToolCount = 0;
	turnStart = 0;
	lastUserText = "";
	notifications = [];
	contextWindow;
	reasoningEffort;
	lastUsage;
	tps;
	tpsSamples = [];
	workingActivity = void 0;
	activityFrames;
	activityEnabled;
	contextBarEnabled;
	goal = void 0;
	todos = [];
	loadedContext = void 0;
	pending = [];
	contextSegments = {
		system: 0,
		prompt: 0,
		assistant: 0,
		thinking: 0,
		tools: 0
	};
	mode = {
		id: "default",
		label: "Default"
	};
	modeIndex = 0;
	hasOlder = false;
	agentPreset;
	listeners = /* @__PURE__ */ new Set();
	api;
	control;
	abort = new AbortController();
	events = [];
	views = /* @__PURE__ */ new Map();
	projections = /* @__PURE__ */ new Map();
	approvalControllers = /* @__PURE__ */ new Map();
	questionControllers = /* @__PURE__ */ new Map();
	stagedImages = /* @__PURE__ */ new Map();
	sessionModes;
	remoteCommands = [];
	notificationSeq = 0;
	imageSeq = 0;
	streamStarted = false;
	muxTask;
	hostTask;
	syncing = false;
	historyLoading;
	bufferedEvents = [];
	lastSeq = -1;
	workspace;
	sessionId;
	constructor(client, server, workspace, sessionId, ui, agentPreset) {
		this.server = server;
		this.ui = ui;
		this.api = client.api;
		this.control = new RemoteDshHostControlClient(client);
		this.workspace = workspace;
		this.sessionId = sessionId;
		this.agentId = String(sessionId);
		this.cwd = workspace.path;
		this.displayCwd = remoteDisplayCwd(server, workspace.path);
		this.sessionTitle = posix.basename(workspace.path) || workspace.title;
		this.agentPreset = agentPreset;
		this.sessionModes = ui.sessionModes?.length > 0 ? ui.sessionModes : [
			{
				id: "default",
				plan: false,
				sandbox: "workspace-write",
				approval: "ask"
			},
			{
				id: "plan",
				plan: true,
				sandbox: "read-only",
				approval: "ask"
			},
			{
				id: "full",
				plan: false,
				sandbox: "danger-full-access",
				approval: "never"
			}
		];
		this.mode = this.sessionModes[0];
		const local = ui.channel;
		this.activityFrames = stringValue(local.activityFrames);
		this.activityEnabled = local.activityEnabled !== false;
		this.contextBarEnabled = local.contextBarEnabled !== false;
	}
	get commandList() {
		const commands = this.localUiCommands();
		const names = new Set(commands.map((command) => command.name));
		const remote = this.remoteCommands.filter((command) => !names.has(command.name));
		return [
			...commands,
			...remote,
			DISCONNECT_COMMAND
		];
	}
	async open() {
		await this.loadSession(this.sessionId);
		this.startStreams();
		this.status = this.working ? "running" : "idle";
		this.emit();
	}
	subscribe = (listener) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	commandCompletions(input) {
		const localRoots = new Set(this.localUiCommands().map((command) => command.name));
		const completions = this.callLocalArray("commandCompletions", [input]).filter((completion) => localRoots.has(completion.name.split(" ", 1)[0] ?? "") && !isLocalOnlyCompletion(completion.commandLine));
		const body = input.startsWith("/") ? input.slice(1) : "";
		const remote = input.startsWith("/") && !/[\t ]/u.test(body) ? this.remoteCommands.flatMap((command) => command.name.startsWith(body.toLowerCase()) ? [{
			...command,
			replacement: `/${command.name} `,
			commandLine: `/${command.name}`
		}] : []) : [];
		if (!input.startsWith("/") || !DISCONNECT_COMMAND.name.startsWith(input.slice(1).trim().toLowerCase())) return [...completions, ...remote];
		if (completions.some((completion) => completion.commandLine === "/disconnect")) return completions;
		return [
			...completions,
			...remote,
			{
				...DISCONNECT_COMMAND,
				replacement: "/disconnect ",
				commandLine: "/disconnect"
			}
		];
	}
	localUiCommands() {
		return arrayValue(this.ui.channel.commandList).filter((command) => command.external !== true && command.skill !== true && command.name !== DISCONNECT_COMMAND.name).map((command) => command.name === "connect" ? {
			...command,
			hidden: true
		} : command);
	}
	async loadRemoteCommands() {
		try {
			const catalog = await this.control.commandCatalog(String(this.sessionId), this.abort.signal);
			this.remoteCommands = catalog.commands.map((command) => ({
				name: command.name,
				description: command.description,
				external: true
			}));
		} catch (error) {
			if (!(error instanceof RemoteHostOperationUnsupportedError)) throw error;
			this.remoteCommands = [];
		}
	}
	async runExternalCommand(name, rawInput) {
		const line = `/${name}${rawInput.trim().length === 0 ? "" : ` ${rawInput.trim()}`}`;
		const result = (await this.api.sessions.prompt({
			sessionId: this.sessionId,
			mode: "queue",
			content: [{
				type: "text",
				text: line
			}]
		})).result;
		if (!result.ok) {
			if (result.error.code === "unknown-command") return void 0;
			throw new Error(result.error.message);
		}
		return result.value.command?.text ?? "";
	}
	async sideQuestion(question, options) {
		const result = await this.control.btw(String(this.sessionId), question, options?.signal);
		if (result.answer !== null) options?.onText?.(result.answer);
		return result;
	}
	handleBackendCommand(request) {
		if (request.name !== "doctor" && request.name !== "mcp" && request.name !== "init") return false;
		this.runBackendCommand(request.name).catch((error) => {
			this.notify(errorMessage(error), {
				color: "error",
				timeoutMs: 8e3
			});
		});
		return true;
	}
	async stageImage(input) {
		const token = `[Image #${String(++this.imageSeq)}]`;
		this.stagedImages.set(token, {
			mediaType: input.mediaType,
			data: Buffer.from(input.data).toString("base64"),
			...input.name === void 0 ? {} : { name: input.name }
		});
		return token;
	}
	submit(text) {
		this.send(text, "queue");
	}
	steer(text) {
		this.send(text, "steer");
	}
	removePending(id) {
		const found = this.pending.some((item) => item.id === id);
		if (found) this.updateQueue(id, { kind: "remove" });
		return found;
	}
	cancel() {
		this.api.sessions.cancel({ sessionId: this.sessionId }).then((response) => {
			if (!response.result.ok) this.notify(response.result.error.message, { color: "error" });
		}).catch((error) => this.notify(errorMessage(error), { color: "error" }));
	}
	interruptAndDeliver(texts) {
		if (texts.length === 0) return 0;
		this.api.sessions.cancel({ sessionId: this.sessionId }).then(async () => {
			for (const text of texts) await this.send(text, "queue");
		}).catch((error) => this.notify(errorMessage(error), { color: "error" }));
		return texts.length;
	}
	async rewindTo(row) {
		if (row.seq === void 0) return null;
		const forked = (await this.api.sessions.fork({
			sessionId: this.sessionId,
			atSeq: row.seq
		})).result;
		if (!forked.ok) {
			this.notify(forked.error.message, { color: "error" });
			return null;
		}
		await this.loadSession(forked.value.sessionId);
		return row.text;
	}
	async resumeTo(sessionId) {
		try {
			await this.loadSession(sessionId);
			return true;
		} catch (error) {
			this.notify(errorMessage(error), { color: "error" });
			return false;
		}
	}
	async newSession() {
		const created = (await this.api.sessions.create({ workspaceId: this.workspace.workspaceId })).result;
		if (!created.ok) {
			this.notify(created.error.message, { color: "error" });
			return false;
		}
		this.agentPreset = created.value.agentPreset;
		await this.loadSession(created.value.sessionId);
		return true;
	}
	async listWorkspaces() {
		const result = (await this.api.workspace.list({})).result;
		if (!result.ok) throw new Error(result.error.message);
		return result.value.items.map((workspace) => workspaceTarget(workspace, this.server));
	}
	async resolveWorkspace(reference) {
		const result = (await this.api.workspace.list({})).result;
		if (!result.ok) throw new Error(result.error.message);
		const workspace = result.value.items.find((item) => item.workspaceId === reference || item.path === reference);
		return workspace === void 0 ? void 0 : workspaceTarget(workspace, this.server);
	}
	async switchWorkspace(target) {
		const path = recordString(target, "cwd");
		if (path === void 0) return false;
		const workspaceResult = (await this.api.workspace.create({ path })).result;
		if (!workspaceResult.ok) {
			this.notify(workspaceResult.error.message, { color: "error" });
			return false;
		}
		this.workspace = workspaceResult.value.workspace;
		this.cwd = this.workspace.path;
		this.displayCwd = remoteDisplayCwd(this.server, this.workspace.path);
		return this.newSession();
	}
	async renameWorkspace(title) {
		const result = (await this.api.workspace.rename({
			workspaceId: this.workspace.workspaceId,
			title
		})).result;
		if (!result.ok) {
			this.notify(result.error.message, { color: "error" });
			return false;
		}
		this.workspace = result.value.workspace;
		this.emit();
		return true;
	}
	workspaceCommands() {
		return [];
	}
	async runWorkspaceCommand() {}
	async switchModel(provider, model) {
		const result = (await this.api.sessions.selectModel({
			sessionId: this.sessionId,
			provider,
			model
		})).result;
		if (!result.ok) {
			this.notify(result.error.message, { color: "error" });
			return false;
		}
		this.provider = result.value.selected.provider;
		this.model = result.value.selected.model;
		this.reasoningEffort = result.value.selected.reasoningEffort;
		this.emit();
		return true;
	}
	async listEfforts() {
		const models = (await this.api.sessions.models({ sessionId: this.sessionId })).result;
		if (!models.ok) return {
			efforts: [],
			defaultEffort: void 0
		};
		const current = models.value.current;
		const model = models.value.groups.find((group) => group.id === current.provider)?.models.find((item) => item.id === current.model);
		return {
			efforts: model?.reasoning?.efforts ?? [],
			defaultEffort: model?.reasoning?.defaultEffort
		};
	}
	async setEffort(id) {
		const result = (await this.api.sessions.selectModel({
			sessionId: this.sessionId,
			provider: this.provider,
			model: this.model,
			reasoningEffort: id
		})).result;
		if (!result.ok) return false;
		this.reasoningEffort = result.value.selected.reasoningEffort;
		this.emit();
		return true;
	}
	async cycleMode() {
		const nextIndex = (this.modeIndex + 1) % this.sessionModes.length;
		const next = this.sessionModes[nextIndex];
		try {
			this.mode = await this.control.setSessionMode(String(this.sessionId), next, this.abort.signal);
			this.modeIndex = nextIndex;
			this.emit();
		} catch (error) {
			this.notify(errorMessage(error), {
				color: "error",
				timeoutMs: 8e3
			});
		}
	}
	async listPresets() {
		const result = (await this.api.agentPresets.list({})).result;
		if (!result.ok) return [];
		return result.value.presets.map((item) => ({
			id: item.id,
			...item.name === void 0 ? {} : { name: item.name },
			...item.description === void 0 ? {} : { description: item.description },
			...item.broken === void 0 ? {} : { broken: item.broken },
			isDefault: item.isDefault
		}));
	}
	async switchPreset(presetId) {
		const result = (await this.api.agentPresets.select({
			sessionId: this.sessionId,
			agentPreset: presetId
		})).result;
		if (!result.ok) {
			this.notify(result.error.message, { color: "error" });
			return false;
		}
		this.agentPreset = presetId;
		this.emit();
		return true;
	}
	clear() {
		this.rows = [];
		this.emit();
	}
	loadOlder() {
		if (!this.hasOlder) return Promise.resolve(0);
		this.historyLoading ??= this.loadOlderPage().finally(() => {
			this.historyLoading = void 0;
		});
		return this.historyLoading;
	}
	notify(text, options) {
		const item = {
			id: ++this.notificationSeq,
			text,
			timeoutMs: options?.timeoutMs ?? 4e3,
			...options?.color === void 0 ? {} : { color: options.color }
		};
		this.notifications = [...this.notifications, item];
		this.emit();
		if (item.timeoutMs > 0) setTimeout(() => {
			this.notifications = this.notifications.filter((candidate) => candidate !== item);
			this.emit();
		}, item.timeoutMs).unref?.();
	}
	setActivityFrames(name) {
		this.activityFrames = name;
		this.emit();
		return true;
	}
	async listModels() {
		const result = (await this.api.sessions.models({ sessionId: this.sessionId })).result;
		if (!result.ok) return [];
		return result.value.groups.flatMap((group) => group.models.map((model) => ({
			provider: group.id,
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description }
		})));
	}
	providerSetup() {
		return {
			listCatalogProviders: async () => {
				const result = (await this.api.llm.providers({})).result;
				if (!result.ok) throw new Error(result.error.message);
				return result.value.providers.filter((provider) => provider.settingsNs === "llm-pi-ai" && provider.declared !== true).map((provider) => ({
					provider: provider.provider,
					displayName: provider.displayName
				}));
			},
			routeExists: async (route) => {
				const namespace = await this.piAiSettings();
				const providers = isRecord(namespace.value) ? namespace.value["providers"] : void 0;
				return isRecord(providers) && route in providers;
			},
			discoverModels: async (request) => {
				const result = (await this.api.llm.discoverModels({
					settingsNs: "llm-pi-ai",
					...request
				}, this.abort.signal)).result;
				if (!result.ok) throw new Error(result.error.message);
				return result.value.models;
			},
			envShadows: async (ref) => {
				const result = (await this.api.credentials.describe({ refs: [ref] }, this.abort.signal)).result;
				if (!result.ok) throw new Error(result.error.message);
				return result.value.credentials[ref]?.source === "env";
			},
			readCredential: async () => void 0,
			writeCredential: async (ref, value) => {
				const result = (await this.api.credentials.set({
					ref,
					value
				}, this.abort.signal)).result;
				if (!result.ok) throw new Error(result.error.message);
			},
			removeCredential: async (ref) => {
				const result = (await this.api.credentials.unset({ ref }, this.abort.signal)).result;
				if (!result.ok) throw new Error(result.error.message);
			},
			writeProfile: async (route, profile) => {
				const namespace = await this.piAiSettings();
				const result = (await this.api.settings.mutate({
					ns: "llm-pi-ai",
					ops: [{
						op: "set",
						path: ["providers", route],
						value: profile
					}],
					expectedRevision: namespace.revision
				}, this.abort.signal)).result;
				if (!result.ok) throw new Error(result.error.message);
			},
			commitProvider: (request) => this.control.setupProvider(request, this.abort.signal).then(() => void 0)
		};
	}
	async listFiles() {
		const result = (await this.api.host.listDirectory({ path: this.cwd }, this.abort.signal)).result;
		if (!result.ok) return [];
		return result.value.entries.map((entry) => entry.name);
	}
	async listSessions() {
		const result = (await this.api.sessions.list({})).result;
		if (!result.ok) throw new Error(result.error.message);
		return result.value.items.map(sessionRecord);
	}
	setResumeTarget() {}
	renameSession(title) {
		this.renameSessionTo(this.sessionId, title);
	}
	async deleteSession(sessionId) {
		return (await this.api.workspace.archiveSession({ sessionId })).result.ok;
	}
	async renameSessionTo(sessionId, title) {
		const result = (await this.api.sessions.rename({
			sessionId,
			title
		})).result;
		if (!result.ok) return false;
		if (sessionId === this.sessionId) this.sessionTitle = result.value.title;
		this.emit();
		return true;
	}
	compact() {
		this.runExternalCommand("compact", "").catch((error) => this.notify(errorMessage(error), { color: "error" }));
	}
	pushLocal(title, lines) {
		this.rows = [
			...this.rows,
			{
				id: this.nextRowId(),
				kind: "local",
				text: title
			},
			...lines.map((text) => ({
				id: this.nextRowId(),
				kind: "local-output",
				text
			}))
		];
		this.emit();
	}
	mcpStatus() {
		return ["Loading MCP status from the remote Host…"];
	}
	async exportSession() {
		const archive = await this.control.host.downloadSessionLog(String(this.sessionId), true, this.abort.signal);
		const target = join(process.cwd(), `dsh-tui-export-${Date.now()}-${archive.fileName}`);
		await writeFile(target, archive.data, { flag: "wx" });
		return target;
	}
	initWorkspace() {
		return null;
	}
	doctorInfo() {
		return ["Loading diagnostics from the remote Host…"];
	}
	async listSubagents() {
		const result = (await this.api.subagents.list({ parentSessionId: this.sessionId })).result;
		if (!result.ok) return [];
		return result.value.entries.map((item) => item.kind === "diagnostic" ? `${String(item.id)} · ${item.reason}` : `${String(item.id)} · ${item.activity}`);
	}
	traceEvents() {
		return this.events;
	}
	async dispose() {
		if (this.status === "disposed") return;
		this.status = "disposed";
		this.abort.abort(/* @__PURE__ */ new Error("Remote TUI channel disposed"));
		await Promise.all([this.muxTask, this.hostTask].filter((task) => task !== void 0).map((task) => task.catch(() => void 0)));
		this.emit();
	}
	async loadOlderPage() {
		while (this.syncing) {
			this.abort.signal.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!this.hasOlder) return 0;
		const targetSession = this.sessionId;
		const boundary = this.events[0]?.seq;
		if (boundary === void 0) {
			this.hasOlder = false;
			this.emit();
			return 0;
		}
		this.syncing = true;
		try {
			const response = (await this.api.sessions.history({
				sessionId: targetSession,
				beforeSeq: boundary,
				maxMessages: 200
			}, this.abort.signal)).result;
			if (!response.ok) throw new Error(response.error.message);
			if (targetSession !== this.sessionId) return 0;
			const known = new Set(this.events.map((event) => event.seq));
			const entries = response.value.events.filter((entry) => !known.has(entry.event.seq));
			for (const entry of entries) {
				this.events.push(entry.event);
				if (entry.view !== void 0) this.views.set(entry.event.seq, entry.view);
			}
			this.events.sort((left, right) => left.seq - right.seq);
			this.hasOlder = response.value.hasMore;
			const beforeRows = this.rows.length;
			this.rebuildTranscript();
			return Math.max(0, this.rows.length - beforeRows);
		} finally {
			this.syncing = false;
			const buffered = this.bufferedEvents;
			this.bufferedEvents = [];
			for (const item of buffered.sort((left, right) => left.event.seq - right.event.seq)) if (item.event.seq > this.lastSeq) this.acceptEvent(item.event, item.view);
			this.emit();
		}
	}
	rebuildTranscript() {
		const localRows = this.rows.filter((row) => row.kind === "local" || row.kind === "local-output");
		this.rows = [];
		this.lastSeq = -1;
		this.resetDerivedState();
		for (const event of this.events) {
			this.lastSeq = Math.max(this.lastSeq, event.seq);
			this.renderEvent(event, this.views.get(event.seq));
		}
		this.restoreLocalRows(localRows);
	}
	startStreams() {
		if (this.streamStarted) return;
		this.streamStarted = true;
		this.muxTask = this.consumeMux();
		this.hostTask = this.consumeHost();
	}
	async consumeMux() {
		try {
			for await (const envelope of this.api.events.mux({}, this.abort.signal, () => {
				this.resync();
			})) await this.handleMux(envelope);
		} catch (error) {
			if (!this.abort.signal.aborted) this.notify(`Remote event stream failed: ${errorMessage(error)}`, { color: "error" });
		}
	}
	async consumeHost() {
		try {
			for await (const envelope of this.api.events.host({}, this.abort.signal)) this.handleHost(envelope.payload);
		} catch (error) {
			if (!this.abort.signal.aborted) this.notify(`Remote Host stream failed: ${errorMessage(error)}`, { color: "error" });
		}
	}
	async handleMux(envelope) {
		const frame = envelope.payload;
		if ("sessionId" in frame && String(frame.sessionId) !== this.sessionId) return;
		switch (frame.type) {
			case "session/event":
				if (this.syncing) this.bufferedEvents.push({
					event: frame.event,
					...frame.view === void 0 ? {} : { view: frame.view }
				});
				else this.acceptEvent(frame.event, frame.view);
				return;
			case "session/subscribed":
				if (frame.lastSeq > this.lastSeq) this.resync();
				return;
			case "session/queue":
				this.pending = frame.items.flatMap((item) => {
					const text = textFromUnknown(item.message);
					return text.length === 0 ? [] : [{
						id: String(item.id),
						text,
						placement: item.placement === "steering" ? "steer" : "followup"
					}];
				});
				this.emit();
				return;
			case "approval/requested":
				this.answerApproval(envelope.rpcId, frame);
				return;
			case "approval/resolved":
				this.approvalControllers.get(String(frame.approvalId))?.abort(/* @__PURE__ */ new Error("Approval resolved by another client"));
				this.approvalControllers.delete(String(frame.approvalId));
				return;
			case "question/requested":
				this.answerQuestion(envelope.rpcId, frame);
				return;
			case "question/resolved":
				this.questionControllers.get(String(frame.questionRpcId))?.abort(/* @__PURE__ */ new Error("Question resolved by another client"));
				this.questionControllers.delete(String(frame.questionRpcId));
				return;
			case "session/projection":
				this.applyProjection(frame.key, frame.value, frame.seq);
				return;
			case "stream/error":
				this.notify(frame.error.message, { color: "error" });
				return;
			default: return;
		}
	}
	handleHost(frame) {
		if ("sessionId" in frame && String(frame.sessionId) !== this.sessionId) return;
		if (frame.type === "host/session-status") {
			this.working = frame.running;
			this.status = frame.running ? "running" : "idle";
			this.emit();
		} else if (frame.type === "host/agent-error") this.notify(frame.message, { color: "error" });
	}
	async loadSession(sessionId) {
		this.cancelInteractionRequests("Remote session changed");
		this.sessionId = sessionId;
		this.agentId = String(sessionId);
		this.hasOlder = false;
		await this.resync(true);
		const models = (await this.api.sessions.models({ sessionId: this.sessionId })).result;
		if (models.ok) {
			this.provider = models.value.current.provider;
			this.model = models.value.current.model;
			this.reasoningEffort = models.value.current.reasoningEffort;
		}
		const listed = (await this.api.sessions.list({})).result;
		if (listed.ok) {
			const summary = listed.value.items.find((item) => String(item.sessionId) === sessionId);
			if (summary !== void 0) {
				this.working = summary.running;
				this.status = summary.running ? "running" : "idle";
				this.agentPreset = summary.agentPreset;
				this.sessionTitle = sessionTitle(summary);
			}
		}
		await this.loadRemoteCommands();
		this.emit();
	}
	async resync(force = false) {
		if (this.syncing && !force) return;
		this.syncing = true;
		const targetSession = this.sessionId;
		try {
			const result = (await this.api.sessions.history({
				sessionId: targetSession,
				maxMessages: 200
			}, this.abort.signal)).result;
			if (!result.ok) throw new Error(result.error.message);
			if (targetSession !== this.sessionId) return;
			const localRows = this.rows.filter((row) => row.kind === "local" || row.kind === "local-output");
			this.events.splice(0, this.events.length);
			this.views.clear();
			this.projections.clear();
			this.rows = [];
			this.lastSeq = -1;
			this.resetDerivedState();
			for (const entry of result.value.events) this.acceptHistoryEntry(entry);
			this.restoreLocalRows(localRows);
			this.hasOlder = result.value.hasMore;
			const baseline = result.value.projections;
			if (baseline !== void 0) for (const [key, value] of Object.entries(baseline.values)) this.applyProjection(key, value, baseline.asOfSeq);
			const buffered = this.bufferedEvents;
			this.bufferedEvents = [];
			for (const item of buffered.sort((left, right) => left.event.seq - right.event.seq)) if (item.event.seq > this.lastSeq) this.acceptEvent(item.event, item.view);
		} finally {
			this.syncing = false;
			this.emit();
		}
	}
	acceptHistoryEntry(entry) {
		this.acceptEvent(entry.event, entry.view);
	}
	acceptEvent(event, view) {
		if (event.seq <= this.lastSeq) return;
		if (event.seq > this.lastSeq + 1 && this.lastSeq >= 0) {
			this.bufferedEvents.push({
				event,
				...view === void 0 ? {} : { view }
			});
			this.resync();
			return;
		}
		this.lastSeq = event.seq;
		this.events.push(event);
		if (view !== void 0) this.views.set(event.seq, view);
		this.renderEvent(event, view);
		this.emit();
	}
	renderEvent(event, view) {
		switch (event.type) {
			case "turn/start":
				this.working = true;
				this.status = "running";
				this.turnStart = event.time;
				this.responseChars = 0;
				return;
			case "turn/end":
				this.working = false;
				this.status = "idle";
				this.activeToolCount = 0;
				for (const row of this.rows) if (row.streaming) row.streaming = false;
				return;
			case "user/message": {
				if (event.data.source.kind !== "user") return;
				const text = textFromUnknown(event.data.content);
				if (text.length === 0) return;
				this.lastUserText = text;
				this.rows.push({
					id: this.nextRowId(),
					kind: "user",
					text,
					seq: event.seq,
					time: event.time
				});
				return;
			}
			case "assistant/chunk": {
				const chunk = event.data.chunk;
				const text = recordString(chunk, "text") ?? "";
				if (text.length === 0) return;
				const kind = recordString(chunk, "type")?.includes("reasoning") === true ? "reasoning" : "assistant";
				let row = this.rows.findLast((candidate) => candidate.streaming === true && candidate.kind === kind);
				if (row === void 0) {
					row = {
						id: this.nextRowId(),
						kind,
						text: "",
						streaming: true,
						seq: event.seq,
						time: event.time
					};
					this.rows.push(row);
				}
				row.text += text;
				this.responseChars += text.length;
				return;
			}
			case "assistant/message": {
				const text = textFromUnknown(event.data.message.content);
				let row = this.rows.findLast((candidate) => candidate.streaming === true && candidate.kind === "assistant");
				if (row === void 0 && text.length > 0) {
					row = {
						id: this.nextRowId(),
						kind: "assistant",
						text,
						seq: event.seq,
						time: event.time
					};
					this.rows.push(row);
				} else if (row !== void 0) {
					row.text = text || row.text;
					row.streaming = false;
					row.seq = event.seq;
				}
				const usage = event.data.usage;
				if (usage !== void 0) {
					const input = usage.inputTokens ?? 0;
					const output = usage.outputTokens ?? 0;
					this.tokens = {
						input: this.tokens.input + input,
						output: this.tokens.output + output
					};
					this.lastUsage = {
						input,
						output,
						cacheRead: usage.cacheReadTokens ?? 0,
						cacheWrite: usage.cacheWriteTokens ?? 0
					};
				}
				return;
			}
			case "tool/call": {
				const callView = view?.for === "call" ? toolCallView(view.view) : void 0;
				this.rows.push({
					id: this.nextRowId(),
					kind: "tool",
					text: event.data.name,
					seq: event.seq,
					time: event.time,
					tool: {
						callId: String(event.data.callId),
						name: event.data.name,
						argsText: event.data.arguments,
						argsFull: event.data.arguments,
						status: "running",
						...callView === void 0 ? {} : { callView },
						startedAt: event.time
					}
				});
				this.activeToolCount += 1;
				return;
			}
			case "tool/result": {
				const callId = toolResultCallId(event.data.message);
				const row = this.rows.findLast((candidate) => candidate.tool !== void 0 && (callId === void 0 || candidate.tool.callId === callId));
				if (row?.tool === void 0) return;
				const resultText = textFromUnknown(event.data.message);
				row.tool.status = event.data.error === void 0 ? "ok" : "error";
				row.tool.resultText = resultText;
				row.tool.resultFull = resultText;
				row.tool.durationMs = Math.max(0, event.time - row.tool.startedAt);
				if (event.data.error !== void 0) row.tool.errorText = `${event.data.error.name}: ${event.data.error.code}`;
				const resultView = view?.for === "result" ? toolResultView(view.view) : void 0;
				if (resultView !== void 0) row.tool.resultView = resultView;
				this.activeToolCount = Math.max(0, this.activeToolCount - 1);
				return;
			}
			case "request/header":
				this.provider = event.data.header.config.provider;
				this.model = event.data.header.config.model;
				this.reasoningEffort = event.data.header.config.reasoningEffort;
				return;
			case "request/context":
				this.provider = event.data.provider;
				this.model = event.data.model;
				this.contextWindow = event.data.contextWindow;
				return;
			default: return;
		}
	}
	async send(text, mode) {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		if (trimmed.startsWith("!")) {
			const command = trimmed.slice(1).trim();
			if (command.length === 0) return;
			try {
				const result = await this.control.runShell(command, this.cwd, void 0, this.abort.signal);
				const lines = [
					...splitOutput(result.stdout),
					...splitOutput(result.stderr),
					...result.exitCode === 0 && !result.timedOut ? [] : [`Process exited with ${result.timedOut ? "a timeout" : `code ${String(result.exitCode)}`}.`],
					...result.truncated ? ["Output was truncated by the remote Host."] : []
				];
				this.pushLocal(`!${command}`, lines.length === 0 ? ["(no output)"] : lines);
			} catch (error) {
				this.notify(errorMessage(error), { color: "error" });
			}
			return;
		}
		const content = [{
			type: "text",
			text
		}];
		for (const [token, image] of this.stagedImages) {
			if (!text.includes(token)) continue;
			content.push({
				type: "image",
				mediaType: image.mediaType,
				data: image.data,
				...image.name === void 0 ? {} : { name: image.name }
			});
		}
		const result = (await this.api.sessions.prompt({
			sessionId: this.sessionId,
			mode,
			content
		})).result;
		if (!result.ok) this.notify(result.error.message, { color: "error" });
		else this.stagedImages.clear();
	}
	async runBackendCommand(name) {
		if (name === "doctor") {
			const result = await this.control.doctor(String(this.sessionId), this.cwd, this.abort.signal);
			this.pushLocal("/doctor", formatDoctorInfo(result, this.provider, this.model, this.contextWindow, this.sessionTitle));
			return;
		}
		if (name === "mcp") {
			const result = await this.control.mcp(String(this.sessionId), this.abort.signal);
			this.pushLocal("/mcp", formatMcpStatus(result.servers));
			return;
		}
		const result = await this.control.init(this.cwd, defaultAgentsFile(), this.abort.signal);
		this.notify(result.status === "exists" ? "AGENTS.md already exists on the remote Host; it was not overwritten." : `Created ${result.path} on the remote Host.`, {
			color: result.status === "created" ? "success" : "warning",
			timeoutMs: 6e3
		});
	}
	async piAiSettings() {
		const result = (await this.api.settings.describe({}, this.abort.signal)).result;
		if (!result.ok) throw new Error(result.error.message);
		if (!result.value.writable) throw new Error("the remote Host settings provider is read-only");
		const namespace = result.value.namespaces.find((candidate) => candidate.ns === "llm-pi-ai");
		if (namespace === void 0) throw new Error("the remote Host has no llm-pi-ai settings namespace");
		return {
			value: namespace.value,
			revision: namespace.revision
		};
	}
	async updateQueue(id, action) {
		const result = (await this.api.sessions.updateQueue({
			sessionId: this.sessionId,
			itemId: id,
			action
		})).result;
		if (!result.ok) this.notify(result.error.message, { color: "error" });
	}
	async answerApproval(rpcId, frame) {
		const controller = new AbortController();
		const approvalId = String(frame.approvalId);
		this.approvalControllers.get(approvalId)?.abort(/* @__PURE__ */ new Error("Approval request replaced"));
		this.approvalControllers.set(approvalId, controller);
		const abort = () => controller.abort(this.abort.signal.reason);
		this.abort.signal.addEventListener("abort", abort, { once: true });
		try {
			const outcome = await this.ui.requestApproval({
				events: this.events,
				toolName: frame.toolName,
				...frame.callId === void 0 ? {} : { callId: frame.callId },
				...frame.reason === void 0 ? {} : { reason: frame.reason },
				signal: controller.signal
			});
			if (outcome !== "allowed-once" && outcome !== "rejected") return;
			await this.api.respond({
				type: "client-response",
				rpcId,
				result: {
					ok: true,
					value: {
						sessionId: this.sessionId,
						approvalId: frame.approvalId,
						outcome
					}
				}
			});
		} catch (error) {
			if (!this.abort.signal.aborted && !controller.signal.aborted) this.notify(errorMessage(error), { color: "error" });
		} finally {
			this.abort.signal.removeEventListener("abort", abort);
			if (this.approvalControllers.get(approvalId) === controller) this.approvalControllers.delete(approvalId);
		}
	}
	async answerQuestion(rpcId, frame) {
		const controller = new AbortController();
		const requestId = String(rpcId);
		this.questionControllers.get(requestId)?.abort(/* @__PURE__ */ new Error("Question request replaced"));
		this.questionControllers.set(requestId, controller);
		const abort = () => controller.abort(this.abort.signal.reason);
		this.abort.signal.addEventListener("abort", abort, { once: true });
		try {
			const answer = await this.ui.askQuestions({
				questions: frame.questions,
				signal: controller.signal
			});
			await this.api.respond({
				type: "client-response",
				rpcId,
				result: {
					ok: true,
					value: {
						sessionId: this.sessionId,
						answer
					}
				}
			});
		} catch (error) {
			if (!this.abort.signal.aborted && !controller.signal.aborted) this.notify(errorMessage(error), { color: "error" });
		} finally {
			this.abort.signal.removeEventListener("abort", abort);
			if (this.questionControllers.get(requestId) === controller) this.questionControllers.delete(requestId);
		}
	}
	applyProjection(key, value, seq) {
		const current = this.projections.get(key);
		if (current !== void 0 && current.seq >= seq) return;
		this.projections.set(key, {
			seq,
			value
		});
		if (key === "title" && typeof value === "string") this.sessionTitle = value;
		else if (key === "goal") this.goal = channelGoal(value);
		else if (key === "todos") this.todos = todoItems(value);
		else if (key === "loadedContext") this.loadedContext = loadedContext(value);
		else if (key === "plan" || key === "permissions") this.refreshModeFromProjections();
		this.emit();
	}
	refreshModeFromProjections() {
		const planValue = this.projections.get("plan")?.value;
		const permissionValue = this.projections.get("permissions")?.value;
		const plan = recordBoolean(planValue, "active") ?? false;
		const permission = recordString(permissionValue, "currentValue");
		const index = this.sessionModes.findIndex((spec) => {
			if (spec.plan !== void 0 && spec.plan !== plan) return false;
			if (spec.sandbox === void 0 && spec.approval === void 0) return true;
			return permission === spec.id || permission === spec.sandbox;
		});
		this.modeIndex = index < 0 ? 0 : index;
		this.mode = this.sessionModes[this.modeIndex];
	}
	cancelInteractionRequests(reason) {
		for (const controller of this.approvalControllers.values()) controller.abort(new Error(reason));
		for (const controller of this.questionControllers.values()) controller.abort(new Error(reason));
		this.approvalControllers.clear();
		this.questionControllers.clear();
	}
	resetDerivedState() {
		this.tokens = {
			input: 0,
			output: 0
		};
		this.lastUsage = void 0;
		this.responseChars = 0;
		this.activeToolCount = 0;
		this.lastUserText = "";
		this.working = false;
	}
	nextRowId() {
		return (this.rows.at(-1)?.id ?? -1) + 1;
	}
	restoreLocalRows(rows) {
		for (const row of rows) this.rows.push({
			...row,
			id: this.nextRowId()
		});
	}
	emit() {
		this.version += 1;
		for (const listener of this.listeners) listener();
	}
	callLocalArray(method, args) {
		const member = Reflect.get(this.ui.channel, method, this.ui.channel);
		if (typeof member !== "function") return [];
		const value = Reflect.apply(member, this.ui.channel, args);
		return Array.isArray(value) ? value : [];
	}
};
const DISCONNECT_COMMAND = {
	name: "disconnect",
	description: "Disconnect from the remote machine",
	descriptions: { zh: "断开远程主机连接" }
};
function isLocalOnlyCompletion(commandLine) {
	return commandLine === "/connect" || /^\/workspace[\t ]+(?:connect|remote)(?:$|[\t ])/iu.test(commandLine);
}
function workspaceTarget(workspace, server) {
	return {
		uri: `dsh-host-workspace://${encodeURIComponent(String(workspace.workspaceId))}`,
		cwd: workspace.path,
		label: workspace.title,
		description: workspace.path,
		kind: "provider",
		badge: remoteServerIdentity(server)
	};
}
function sessionRecord(summary) {
	return {
		id: String(summary.sessionId),
		title: sessionTitle(summary),
		cwd: summary.cwd ?? "",
		createdAt: summary.updatedAt,
		updatedAt: summary.updatedAt
	};
}
function sessionTitle(summary) {
	const title = (summary.projections?.values)?.title;
	if (typeof title === "string" && title.trim().length > 0) return title;
	return summary.cwd === void 0 ? String(summary.sessionId) : posix.basename(summary.cwd) || summary.cwd;
}
function textFromUnknown(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value;
	if (typeof record.text === "string") return record.text;
	if (typeof record.content === "string") return record.content;
	if (record.content !== void 0) return textFromUnknown(record.content);
	if (record.message !== void 0) return textFromUnknown(record.message);
	return "";
}
/** Narrow Host presentation payloads to the stable subset dsh-tui renders. */
function toolCallView(value) {
	if (!isRecord(value) || typeof value["card"] !== "string" || typeof value["title"] !== "string") return void 0;
	if (value["card"] === "generic" || value["card"] === "terminal") return value;
	if (value["card"] === "diff" && Array.isArray(value["diffs"])) return value;
}
/** Unknown/new Host card shapes intentionally fall back to raw result text. */
function toolResultView(value) {
	if (!isRecord(value) || typeof value["card"] !== "string") return void 0;
	if (value["card"] === "generic" || value["card"] === "terminal") return value;
	if (value["card"] === "diff" && Array.isArray(value["diffs"])) return value;
	if (value["card"] === "read") return value;
	if (value["card"] !== "search") return void 0;
	if (value["shape"] === "matches" && Array.isArray(value["files"]) && typeof value["truncated"] === "boolean" && typeof value["total"] === "number") return value;
	if (value["shape"] === "paths" && Array.isArray(value["paths"]) && typeof value["truncated"] === "boolean" && typeof value["total"] === "number") return value;
}
function channelGoal(value) {
	if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["revision"] !== "number" || typeof value["objective"] !== "string" || ![
		"active",
		"paused",
		"blocked",
		"complete"
	].includes(String(value["phase"])) || typeof value["maxGoalRounds"] !== "number" || typeof value["roundsStarted"] !== "number") return void 0;
	return value;
}
function todoItems(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => isRecord(item) && typeof item["content"] === "string" && [
		"pending",
		"in_progress",
		"completed"
	].includes(String(item["status"])));
}
function loadedContext(value) {
	if (!isRecord(value)) return void 0;
	if (![
		"sections",
		"contexts",
		"files",
		"skills",
		"tools"
	].every((key) => Array.isArray(value[key]))) return void 0;
	return value;
}
function recordString(value, key) {
	if (typeof value !== "object" || value === null) return void 0;
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : void 0;
}
function recordBoolean(value, key) {
	if (typeof value !== "object" || value === null) return void 0;
	const candidate = value[key];
	return typeof candidate === "boolean" ? candidate : void 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toolResultCallId(message) {
	const direct = recordString(message, "callId") ?? recordString(message, "toolCallId");
	if (direct !== void 0) return direct;
	if (typeof message !== "object" || message === null) return void 0;
	const content = message.content;
	if (!Array.isArray(content)) return void 0;
	for (const block of content) {
		const id = recordString(block, "toolCallId") ?? recordString(block, "callId");
		if (id !== void 0) return id;
	}
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function arrayValue(value) {
	return Array.isArray(value) ? value : [];
}
function formatMcpStatus(servers) {
	if (servers.length === 0) return ["No MCP servers are mounted on the remote Host."];
	return servers.map((server) => `${server.name} (${String(server.tools.length)} tools): ${server.tools.join(", ")}`);
}
function formatDoctorInfo(result, provider, model, contextWindow, sessionTitle) {
	return [
		`Node ${result.node} · ${result.platform} ${result.arch}`,
		`API key: ${result.apiKeyConfigured ? "configured" : "not configured"}`,
		`Model: ${model || "(unknown)"} · Provider: ${provider || "(unknown)"}`,
		`Working directory: ${result.cwd}`,
		`Context window: ${contextWindow === void 0 ? "unknown" : `${String(contextWindow)} tokens`}`,
		`Session: ${result.sessionId ?? "(unknown)"}${sessionTitle.length === 0 ? "" : ` · ${sessionTitle}`}`,
		`Session attached: ${result.sessionAttached ? "yes" : "no"}`,
		`Remote home: ${result.home}`
	];
}
function splitOutput(value) {
	const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").filter((line, index, lines) => line.length > 0 || index < lines.length - 1) : normalized.length === 0 ? [] : normalized.split("\n");
}
function defaultAgentsFile() {
	return [
		"# AGENTS.md",
		"",
		"## Project",
		"",
		"Document the project structure, build commands, and important entry points here.",
		"",
		"## Conventions",
		"",
		"- Read relevant files before editing them.",
		"- Follow the project's existing style and verify changes with its checks.",
		""
	].join("\n");
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/profiles/tui-backend.ts
const name = "dsh-ssh-workspace-tui-backend";
const inject = ["remoteSshManager"];
/** Observe dsh-tui's optional registry without making it a profile dependency. */
function apply(ctx) {
	ctx.inject(["tuiBackends"], registerTuiBackend);
}
/** Register the Remote Host adapter through dsh-tui's public backend seam. */
function registerTuiBackend(ctx) {
	const controller = new RemoteSshTuiBackendController(ctx.remoteSshManager);
	const unregisterFactory = controller.registerFactory(new RemoteHostTuiChannelFactory());
	const unregisterProvider = ctx.tuiBackends.register(controller);
	ctx.provide("remoteSshTuiBackend", controller);
	ctx.effect(() => () => {
		unregisterProvider();
		unregisterFactory();
		controller.dispose();
	}, "Remote SSH dsh-tui backend adapter");
}
//#endregion
export { apply, apply as default, inject, name };
