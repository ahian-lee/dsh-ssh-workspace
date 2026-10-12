window.__ModuleLoader__.load({
	id: "dsh-ssh-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#region src/client/api.ts
		const STATE_PATH = "/plugins/dsh-ssh-workspace/state";
		const WORKSPACE_PATH = "/plugins/dsh-ssh-workspace/workspace";
		const WORKSPACE_REMOVE_PATH = "/plugins/dsh-ssh-workspace/workspace/remove";
		const LOCAL_WORKSPACE_PATH = "/plugins/dsh-ssh-workspace/local-workspace";
		const PROBE_PATH = "/plugins/dsh-ssh-workspace/probe";
		const CONFIG_HOST_PATH = "/plugins/dsh-ssh-workspace/ssh-config/host";
		const SETTINGS_PATH = "/plugins/dsh-ssh-workspace/settings";
		const DIRECTORY_PATH = "/plugins/dsh-ssh-workspace/directory";
		const emptyCatalog = {
			servers: [],
			workspaces: [],
			serverCount: 0,
			discoveredServerCount: 0,
			workspaceCount: 0,
			configFiles: [],
			loadedConfigFiles: [],
			configErrors: [],
			openFileMode: "auto"
		};
		async function request(path, method = "GET", body) {
			const response = await fetch(path, {
				method,
				credentials: "same-origin",
				headers: {
					accept: "application/json",
					...body === void 0 ? {} : { "content-type": "application/json" }
				},
				...body === void 0 ? {} : { body: JSON.stringify(body) }
			});
			const value = await response.json().catch(() => void 0);
			if (!response.ok) {
				const message = typeof value === "object" && value !== null && "error" in value ? String(value.error) : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return value;
		}
		//#endregion
		//#region src/client/styles.ts
		const page = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			maxWidth: 760
		};
		const card = {
			display: "flex",
			flexDirection: "column",
			gap: 12,
			padding: 18,
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-module-platform)"
		};
		const row = {
			display: "flex",
			gap: 10,
			alignItems: "center",
			flexWrap: "wrap"
		};
		const input = {
			minWidth: 180,
			flex: "1 1 180px",
			padding: "8px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)"
		};
		const singleLineInput = {
			...input,
			minWidth: 0,
			width: 520,
			maxWidth: "100%",
			height: 36,
			flex: "0 0 auto",
			boxSizing: "border-box"
		};
		const button = {
			padding: "7px 13px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer"
		};
		const primary = {
			...button,
			borderColor: "#2563eb",
			background: "#2563eb",
			color: "white"
		};
		const dim = {
			margin: 0,
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 14
		};
		const primaryButton = (disabled) => ({
			...primary,
			...disabled ? {
				opacity: .45,
				cursor: "not-allowed"
			} : {}
		});
		//#endregion
		//#region src/client/types.ts
		function requireTranslate(t, surface) {
			if (t === void 0) throw new Error(`${surface} requires its translation function`);
			return t;
		}
		//#endregion
		//#region src/client/RemoteSshPluginCard.tsx
		/** Settings > Plugins card for SSH discovery and remote file opening. */
		function RemoteSshPluginCard({ t: optionalT }) {
			const t = requireTranslate(optionalT, "Remote SSH plugin settings");
			const [current, setCurrent] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)("");
			const [currentMode, setCurrentMode] = (0, react.useState)("auto");
			const [mode, setMode] = (0, react.useState)("auto");
			const [currentEditorPath, setCurrentEditorPath] = (0, react.useState)("");
			const [editorPath, setEditorPath] = (0, react.useState)("");
			const [open, setOpen] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [loading, setLoading] = (0, react.useState)(true);
			const [failed, setFailed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				request(STATE_PATH).then((state) => {
					const value = state.customConfigFile ?? "";
					const editor = state.openFileEditorPath ?? "";
					setCurrent(value);
					setDraft(value);
					setCurrentMode(state.openFileMode);
					setMode(state.openFileMode);
					setCurrentEditorPath(editor);
					setEditorPath(editor);
					setLoading(false);
				}, () => {
					setFailed(true);
					setLoading(false);
				});
			}, []);
			const absolute = (value) => /^(?:[A-Za-z]:[\\/]|\/)/.test(value);
			const invalid = draft.trim() !== "" && !absolute(draft.trim());
			const invalidEditor = mode === "custom" && !absolute(editorPath.trim());
			const dirty = draft !== current || mode !== currentMode || editorPath !== currentEditorPath;
			const save = async () => {
				setSaving(true);
				setFailed(false);
				try {
					const result = await request(SETTINGS_PATH, "POST", {
						sshConfigFile: draft.trim(),
						openFileMode: mode,
						openFileEditorPath: editorPath.trim()
					});
					const value = result.sshConfigFile ?? "";
					const editor = result.openFileEditorPath ?? "";
					setCurrent(value);
					setDraft(value);
					setCurrentMode(result.openFileMode);
					setMode(result.openFileMode);
					setCurrentEditorPath(editor);
					setEditorPath(editor);
				} catch {
					setFailed(true);
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: {
					listStyle: "none",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: 12,
					overflow: "hidden"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: {
						...button,
						width: "100%",
						border: 0,
						borderRadius: 0,
						padding: 14,
						textAlign: "left"
					},
					"aria-expanded": open,
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Remote SSH" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							display: "block",
							...dim
						},
						children: t("pluginSummary")
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: 14,
						display: "flex",
						flexDirection: "column",
						gap: 10
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "plugin-remote-ssh-config",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("sshConfigLabel") })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "plugin-remote-ssh-config",
							style: singleLineInput,
							placeholder: t("sshConfigPlaceholder"),
							value: draft,
							disabled: loading || saving,
							onChange: (event) => {
								setDraft(event.target.value);
								setFailed(false);
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: dim,
							children: t("sshConfigHelp")
						}),
						invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "alert",
							style: dim,
							children: t("absolutePathRequired")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							htmlFor: "plugin-remote-ssh-open-file",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("openFileLabel") })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							id: "plugin-remote-ssh-open-file",
							style: singleLineInput,
							value: mode,
							disabled: loading || saving,
							onChange: (event) => {
								setMode(event.target.value);
								setFailed(false);
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "auto",
									children: t("openFileAuto")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "vscode",
									children: t("openFileVscode")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "cursor",
									children: t("openFileCursor")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "windsurf",
									children: t("openFileWindsurf")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "vscodium",
									children: t("openFileVscodium")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "custom",
									children: t("openFileCustom")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "download",
									children: t("openFileDownload")
								})
							]
						}),
						mode === "custom" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: "plugin-remote-ssh-editor",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("customEditorLabel") })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "plugin-remote-ssh-editor",
								style: singleLineInput,
								placeholder: t("customEditorPlaceholder"),
								value: editorPath,
								disabled: loading || saving,
								onChange: (event) => {
									setEditorPath(event.target.value);
									setFailed(false);
								}
							}),
							invalidEditor ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								style: dim,
								children: t("absolutePathRequired")
							}) : null
						] }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: dim,
							children: t("openFileHelp")
						}),
						failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "alert",
							style: dim,
							children: t("saveFailed")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...row,
								justifyContent: "flex-end"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: !dirty || saving,
								onClick: () => {
									setDraft(current);
									setMode(currentMode);
									setEditorPath(currentEditorPath);
									setFailed(false);
								},
								children: t("discard")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: primary,
								disabled: !dirty || invalid || invalidEditor || loading || saving,
								onClick: () => {
									save();
								},
								children: saving ? t("saving") : t("save")
							})]
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/WorkspaceDirectoryPicker.tsx
		/** Shared in-app local/remote directory browser. */
		function WorkspaceDirectoryPicker(props) {
			const [listing, setListing] = (0, react.useState)();
			const [draft, setDraft] = (0, react.useState)("");
			const [loading, setLoading] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const requestGeneration = (0, react.useRef)(0);
			const browse = async (path) => {
				const generation = ++requestGeneration.current;
				setLoading(true);
				setError("");
				try {
					const next = await props.list(path === void 0 || path.trim() === "" ? void 0 : path.trim());
					if (generation !== requestGeneration.current) return;
					setListing(next);
					setDraft(next.path);
				} catch (reason) {
					if (generation === requestGeneration.current) setError(String(reason));
				} finally {
					if (generation === requestGeneration.current) setLoading(false);
				}
			};
			(0, react.useEffect)(() => {
				if (!props.open) return;
				const initial = props.initialPath.trim().startsWith("/") ? props.initialPath.trim() : void 0;
				browse(initial);
				return () => {
					requestGeneration.current += 1;
				};
			}, [props.open, props.sourceKey]);
			if (!props.open) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 1100,
					display: "grid",
					placeItems: "center",
					background: "rgba(0,0,0,.42)"
				},
				role: "dialog",
				"aria-modal": "true",
				"aria-label": props.title,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...card,
						width: "min(620px, calc(100vw - 32px))",
						maxHeight: "min(720px, calc(100vh - 32px))"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: props.title }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: {
									...singleLineInput,
									flex: "1 1 320px"
								},
								"aria-label": props.t("directoryPath", { title: props.title }),
								value: draft,
								onChange: (event) => {
									setDraft(event.target.value);
								},
								onKeyDown: (event) => {
									if (event.key === "Enter") browse(draft);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								disabled: loading || draft.trim() === "",
								onClick: () => {
									browse(draft);
								},
								children: props.t("go")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									disabled: loading || listing === void 0 || listing.path === listing.home,
									onClick: () => {
										if (listing !== void 0) browse(listing.home);
									},
									children: props.t("home")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									disabled: loading || listing?.parent === void 0,
									onClick: () => {
										if (listing?.parent !== void 0) browse(listing.parent);
									},
									children: props.t("parent")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: dim,
									children: listing?.path ?? props.t("directoryLoading")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4,
								minHeight: 120,
								maxHeight: 360,
								overflowY: "auto",
								border: "1px solid var(--dsw-alias-border-l2)",
								borderRadius: 8,
								padding: 6
							},
							children: [
								listing?.entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									style: {
										...button,
										border: 0,
										borderRadius: 6,
										textAlign: "left",
										background: "transparent"
									},
									onClick: () => {
										browse(entry.path);
									},
									children: ["📁 ", entry.name]
								}, entry.path)),
								!loading && listing?.entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										...dim,
										padding: 8
									},
									children: props.t("directoryEmpty")
								}) : null,
								loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										...dim,
										padding: 8
									},
									children: props.t("directoryLoading")
								}) : null
							]
						}),
						error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "alert",
							style: dim,
							children: error
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...row,
								justifyContent: "flex-end"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								onClick: props.onCancel,
								children: props.t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: primary,
								disabled: loading || listing === void 0,
								onClick: () => {
									if (listing !== void 0) props.onPick(listing.path);
								},
								children: props.t("selectCurrentFolder")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/RemoteSshSettings.tsx
		/** Full Remote SSH settings page. */
		function RemoteSshSettings({ t: optionalT }) {
			const t = requireTranslate(optionalT, "Remote SSH settings");
			const [state, setState] = (0, react.useState)(emptyCatalog);
			const [serverId, setServerId] = (0, react.useState)("");
			const [remotePath, setRemotePath] = (0, react.useState)("");
			const [showDirectoryPicker, setShowDirectoryPicker] = (0, react.useState)(false);
			const [showAddHost, setShowAddHost] = (0, react.useState)(false);
			const [hostCommand, setHostCommand] = (0, react.useState)("");
			const [configPath, setConfigPath] = (0, react.useState)("");
			const [message, setMessage] = (0, react.useState)("");
			const [backendStage, setBackendStage] = (0, react.useState)();
			const refresh = (0, react.useCallback)(async () => {
				const next = await request(STATE_PATH);
				setState(next);
				setServerId((current) => next.servers.some((server) => server.id === current) ? current : next.servers[0]?.id ?? "");
				setConfigPath((current) => next.configFiles.includes(current) ? current : next.configFiles[0] ?? "");
			}, []);
			(0, react.useEffect)(() => {
				refresh().catch((error) => {
					setMessage(String(error));
				});
			}, [refresh]);
			const addHost = async () => {
				await request(CONFIG_HOST_PATH, "POST", {
					command: hostCommand,
					configPath
				});
				setHostCommand("");
				setShowAddHost(false);
				setMessage(t("hostAdded"));
				await refresh();
			};
			const addWorkspace = async () => {
				await request(WORKSPACE_PATH, "POST", {
					serverId,
					remotePath
				});
				setRemotePath("");
				await refresh();
			};
			const probe = async (id) => {
				const result = await request(PROBE_PATH, "POST", { id });
				const commands = Object.entries(result.commands ?? {}).map(([name, yes]) => `${name} ${yes ? "✓" : "×"}`).join(", ");
				setMessage(result.reachable ? t("probeSuccess", {
					hostname: result.hostname ?? id,
					commands
				}) : t("probeFailure", { error: result.error ?? t("unknownError") }));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							margin: 0,
							fontSize: 20
						},
						children: t("title")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...dim,
							marginTop: 6
						},
						children: t("summary", {
							servers: state.discoveredServerCount,
							workspaces: state.workspaceCount
						})
					})] }),
					backendStage !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "status",
						style: {
							display: "grid",
							gap: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("progress", {
							"aria-label": message,
							style: { width: "100%" }
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: dim,
							children: message
						})]
					}) : message ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						style: dim,
						children: message
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("servers") }),
							state.servers.map((server) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { flex: 1 },
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: server.label }),
										server.hostName ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											" · ",
											server.user ? `${server.user}@` : "",
											server.hostName,
											server.port ? `:${server.port}` : ""
										] }) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
											style: {
												display: "block",
												color: "var(--dsw-alias-label-secondary)"
											},
											children: server.configPath ?? t("savedServer")
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									onClick: () => {
										probe(server.id);
									},
									children: t("test")
								})]
							}, server.id)),
							state.servers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: dim,
								children: t("noHosts")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									onClick: () => {
										setShowAddHost((value) => !value);
									},
									children: t("addSshHost")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									onClick: () => {
										refresh().then(() => {
											setMessage(t("configReloaded"));
										}, (error) => {
											setMessage(String(error));
										});
									},
									children: t("refresh")
								})]
							}),
							showAddHost ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									...card,
									padding: 12
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: singleLineInput,
										"aria-label": t("sshCommand"),
										placeholder: "ssh user@hostname -p 22",
										value: hostCommand,
										onChange: (event) => {
											setHostCommand(event.target.value);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
										style: { fontSize: 14 },
										children: t("chooseSshConfig")
									}),
									state.configFiles.map((path) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											...row,
											alignItems: "flex-start"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "ssh-config-file",
											checked: configPath === path,
											onChange: () => {
												setConfigPath(path);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: path })]
									}, path)),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: button,
										onClick: () => {
											setMessage(t("customConfigGuidance"));
										},
										children: t("customConfigAction")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											...row,
											justifyContent: "flex-end"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: button,
											onClick: () => {
												setShowAddHost(false);
											},
											children: t("cancel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: primary,
											disabled: !hostCommand.trim() || !configPath,
											onClick: () => {
												addHost().catch((error) => {
													setMessage(String(error));
												});
											},
											children: t("add")
										})]
									})
								]
							}) : null,
							state.configErrors.map((error) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: dim,
								children: error
							}, error))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("remoteWorkspaces") }),
							state.workspaces.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { flex: 1 },
									children: [
										state.servers.find((server) => server.id === workspace.serverId)?.label ?? workspace.serverId,
										" > ",
										workspace.remotePath
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									onClick: () => {
										request(WORKSPACE_REMOVE_PATH, "POST", { id: workspace.id }).then(refresh);
									},
									children: t("removeMapping")
								})]
							}, workspace.id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										style: input,
										"aria-label": t("server"),
										value: serverId,
										onChange: (event) => {
											setServerId(event.target.value);
											setRemotePath("");
											setShowDirectoryPicker(false);
										},
										children: state.servers.map((server) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: server.id,
											children: server.label
										}, server.id))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: input,
										"aria-label": t("remotePath"),
										placeholder: t("remotePathPlaceholder"),
										value: remotePath,
										onChange: (event) => {
											setRemotePath(event.target.value);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: button,
										disabled: !serverId,
										onClick: () => {
											setShowDirectoryPicker(true);
										},
										children: t("browseRemote")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: primaryButton(!serverId || !remotePath.trim()),
										disabled: !serverId || !remotePath.trim(),
										onClick: () => {
											addWorkspace().catch((error) => {
												setMessage(String(error));
											});
										},
										children: t("addWorkspace")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: dim,
								children: t("remotePathHelp")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceDirectoryPicker, {
								t,
								open: showDirectoryPicker,
								title: t("selectRemoteFolder"),
								sourceKey: `remote:${serverId}`,
								initialPath: remotePath,
								list: (path) => request(DIRECTORY_PATH, "POST", {
									serverId,
									...path === void 0 ? {} : { path }
								}),
								onCancel: () => {
									setShowDirectoryPicker(false);
								},
								onPick: (path) => {
									setRemotePath(path);
									setShowDirectoryPicker(false);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: dim,
								children: t("tombstoneHelp")
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/SshHostForm.tsx
		/** Add an OpenSSH host without leaving the workspace creation flow. */
		function SshHostForm({ t, configFiles, onAdded, onCancel }) {
			const [command, setCommand] = (0, react.useState)("");
			const [configPath, setConfigPath] = (0, react.useState)(configFiles[0] ?? "");
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const submit = async () => {
				setSaving(true);
				setError("");
				try {
					await onAdded((await request(CONFIG_HOST_PATH, "POST", {
						command: command.trim(),
						configPath
					})).alias);
				} catch (reason) {
					setError(String(reason));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...card,
					padding: 12
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("sshCommand") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: singleLineInput,
						"aria-label": t("sshCommand"),
						placeholder: "ssh user@hostname -p 22",
						value: command,
						disabled: saving,
						onChange: (event) => {
							setCommand(event.target.value);
						}
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("chooseSshConfig") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						style: singleLineInput,
						"aria-label": t("chooseSshConfig"),
						value: configPath,
						disabled: saving,
						onChange: (event) => {
							setConfigPath(event.target.value);
						},
						children: configFiles.map((path) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: path,
							children: path
						}, path))
					})] }),
					error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: error
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...row,
							justifyContent: "flex-end"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: button,
							disabled: saving,
							onClick: onCancel,
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: primary,
							disabled: saving || !command.trim() || !configPath,
							onClick: () => {
								submit();
							},
							children: saving ? t("saving") : t("add")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/RemoteWorkspaceFlow.tsx
		/** Combined LOCAL and Remote SSH workspace creation flow. */
		function RemoteWorkspaceFlow(props) {
			const [state, setState] = (0, react.useState)(emptyCatalog);
			const [serverId, setServerId] = (0, react.useState)("");
			const [remotePath, setRemotePath] = (0, react.useState)("");
			const [showDirectoryPicker, setShowDirectoryPicker] = (0, react.useState)(false);
			const [showAddHost, setShowAddHost] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const wasOpen = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!props.open || wasOpen.current) {
					wasOpen.current = props.open;
					return;
				}
				wasOpen.current = true;
				request(STATE_PATH).then((next) => {
					setState(next);
					setServerId(next.servers[0]?.id ?? "");
				}, (reason) => {
					props.onError(String(reason));
				});
			}, [props.open, props.onError]);
			if (!props.open) return null;
			const chooseLocal = async (path) => {
				const adopted = await request(LOCAL_WORKSPACE_PATH, "POST", { path });
				props.onPicked(adopted.path);
			};
			const chooseRemote = async () => {
				const created = await request(WORKSPACE_PATH, "POST", {
					serverId,
					remotePath
				});
				props.onPicked(created.aliasPath);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 1e3,
					display: "grid",
					placeItems: "center",
					background: "rgba(0,0,0,.35)"
				},
				role: "dialog",
				"aria-modal": "true",
				"aria-label": props.t("addWorkspaceTitle"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...card,
						width: "min(600px, calc(100vw - 32px))",
						maxHeight: "85vh",
						overflowY: "auto"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: props.t("addWorkspaceTitle") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							disabled: props.busy,
							onClick: () => {
								props.pickLocal().then((path) => path === null ? void 0 : chooseLocal(path)).catch((reason) => {
									setError(String(reason));
								});
							},
							children: props.t("chooseLocalFolder")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: row,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									style: input,
									"aria-label": props.t("server"),
									value: serverId,
									onChange: (event) => {
										setServerId(event.target.value);
										setRemotePath("");
										setShowDirectoryPicker(false);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: props.t("selectRemoteSsh")
									}), state.servers.map((server) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: server.id,
										children: server.label
									}, server.id))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: input,
									"aria-label": props.t("remotePath"),
									placeholder: props.t("remotePathPlaceholder"),
									value: remotePath,
									onChange: (event) => {
										setRemotePath(event.target.value);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: button,
									disabled: !serverId || props.busy,
									onClick: () => {
										setShowDirectoryPicker(true);
									},
									children: props.t("browseRemote")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: dim,
							children: props.t("remotePathHelp")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: button,
							onClick: () => {
								setShowAddHost((value) => !value);
							},
							children: props.t("addSshHost")
						}),
						showAddHost ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SshHostForm, {
							t: props.t,
							configFiles: state.configFiles,
							onCancel: () => {
								setShowAddHost(false);
							},
							onAdded: async (alias) => {
								const next = await request(STATE_PATH);
								setState(next);
								setServerId(next.servers.find((server) => server.sshTarget === alias)?.id ?? next.servers[0]?.id ?? "");
								setShowAddHost(false);
							}
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceDirectoryPicker, {
							t: props.t,
							open: showDirectoryPicker,
							title: props.t("selectRemoteFolder"),
							sourceKey: `remote:${serverId}`,
							initialPath: remotePath,
							list: (path) => request(DIRECTORY_PATH, "POST", {
								serverId,
								...path === void 0 ? {} : { path }
							}),
							onCancel: () => {
								setShowDirectoryPicker(false);
							},
							onPick: (path) => {
								setRemotePath(path);
								setShowDirectoryPicker(false);
							}
						}),
						error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: dim,
							children: error
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...row,
								justifyContent: "flex-end"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: button,
								onClick: props.onCancel,
								children: props.t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: primaryButton(props.busy || !serverId || !remotePath.trim()),
								disabled: props.busy || !serverId || !remotePath.trim(),
								onClick: () => {
									chooseRemote().catch((reason) => {
										setError(String(reason));
									});
								},
								children: props.t("addWorkspace")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/backend-context.ts
		/** Same-origin signal exposed only by a Web window attached to a remote Host. */
		const REMOTE_BACKEND_CONTEXT_PATH = "/dsh-ssh-workspace/backend-context";
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-ssh-workspace-client";
		const inject = [
			"slots",
			"uiWorkspace",
			"locale"
		];
		/** Register the localized settings, workspace flow, and transparent file opener. */
		async function apply(ctx) {
			const namespace = "settings.remote-ssh";
			ctx.effect(() => ctx.locale.register(namespace, {
				zh,
				en
			}), "dsh-ssh-workspace: client copy");
			const t = ctx.locale.bind(namespace);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "remote-ssh",
				order: 16,
				label: () => t("nav"),
				inject: () => ({ t })
			}, RemoteSshSettings));
			const flowInjected = () => ({
				t,
				pickLocal: () => ctx.uiWorkspace.pickDirectory()
			});
			for (const slot of ["sidebar.workspaces.directoryFlow", "conversation.hero.workspace.directoryFlow"]) ctx.slots.inject(slot, () => ctx.slots.register({
				name: slot,
				priority: -10,
				inject: flowInjected
			}, RemoteWorkspaceFlow));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "remote-ssh",
				order: 30,
				inject: () => ({ t })
			}, RemoteSshPluginCard));
		}
		/** Detect the gateway before registering any local-only Remote SSH chrome. */
		async function isRemoteBackendWindow(fetcher = globalThis.fetch) {
			try {
				const response = await fetcher(REMOTE_BACKEND_CONTEXT_PATH, {
					credentials: "same-origin",
					cache: "no-store",
					headers: { accept: "application/json" }
				});
				if (!response.ok) return false;
				const value = await response.json();
				return value.attached === true && value.transport === "ssh";
			} catch {
				return false;
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.isRemoteBackendWindow = isRemoteBackendWindow;
		exports.name = name;
		return module.exports;
	}
});
