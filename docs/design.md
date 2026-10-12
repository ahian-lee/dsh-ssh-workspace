> Retained upstream design/reference. This release supports Windows Desktop workspace routing only; current behavior and installation instructions are in the root README and CHANGELOG.

# 设计说明：工作区驱动的透明 Remote SSH

## 核心不变量

1. 不存在 `remote_read`、`remote_bash` 等平行工具；shell 名称按工作区 OS 选择（POSIX Remote 为 `bash`，Windows LOCAL 为 `pwsh`）。
2. 当前 workspace cwd 是执行世界的唯一主选择器。
3. 远端错误、断线、缺少程序和删除映射都 fail closed；禁止本机 fallback。
4. alias 是稳定身份，不是同步目录或挂载点，也不得出现在模型或插件可见的文件路径中。
5. Workspace/Session 是历史数据；删除执行映射不能删除历史。

## 组合结构

DSH 原有本地 filesystem/subprocess provider 被隔离在 private Cordis realm，并通过 `localFs`、`localSubprocess` 暴露给根路由：

```text
                           ┌─ localFs / localSubprocess
ordinary tools ─ routers ─┤
                           └─ RemoteSshManager ─ SSH/AHP
```

- `TransparentFileSystem`：用 cwd/path 匹配 alias，委托本机 fs 或该 workspace 的 AHP fs；
- `TransparentSpillStore`：按持有者 session 的固定执行域选择本机或远端 spill backend；远端结果写入 host runtime 私有目录；
- `search`：在官方搜索模块加载时向路径解析入口注入远端 hook；远端绝对路径使用 POSIX 语义，本地路径继续走官方实现；
- `TransparentSubprocessRuntime`：用 `spec.cwd` 选择本机 subprocess 或 host-scoped AHP subprocess；所有 stdin 模式都留在 AHP；
- Remote `bash`：官方 `dsh-tool-bash` → Bash `ctx.shell` → 路由后的 AHP Terminal channel；所有 channel 复用 host 级 SSH/AHP 长连接，不重新握手；
- `TransparentShellExecutor`：保留给非模型工具的 one-shot shell consumer；
- 内置 `tool-fs-search` 保持原名并复用 routed subprocess，因此 `rg` 在当前 workspace 主机解析；
- background handle 也由同一 subprocess 路由产生。

## Catalog 与标题

Settings 保存两类 durable record：

```text
Server    { id, label, sshTarget, sshArgs, remoteCodeCommand }
Workspace { id, serverId, remotePath, aliasPath? }
```

Manager 为每个 Remote Workspace 生成稳定本地 alias，并向 DSH WorkspaceRegistry 注册：

```text
<server.label> > <remote basename>
```

本机 picker 选中的路径会注册为：

```text
LOCAL > <local basename>
```

## 路由判定

Manager 维护 active routes 和 `remoteAliases` 历史集合。判定顺序：

1. cwd 落在 active remote alias：remote；
2. cwd 落在 tombstoned alias：抛错；
3. absolute path 落在 active remote alias：remote；
4. absolute path 落在 tombstoned alias：抛错；
5. 其余：local。

cwd 优先保证远端工作区中的相对路径始终在远端解释。对 POSIX 远端，alias 下的本地表现路径由 `WorkspacePathMapper` 转换为远端绝对路径。

Spill 不参与普通 path 路由，而是只使用 Agent 创建时记录的 session world。远端 spill 通过既有 AHP Resource 权限写到 `remote.runtimeRoot/spills/session-<hash>/...`，目录和文件名均不可由模型选择；未知、已移除或未绑定的 session 失败关闭，不会转用宿主机 spill。

## 远端墓碑状态机

```text
configured ──remove──► tombstoned
    │                      │
    │ tools allowed        │ history readable
    │ lazy context         │ tools rejected
    ▼                      ▼
 remote/local alias     alias retained
```

移除 mapping 时 active route 与远端 context 会消失；alias 目录、WorkspaceRegistry 中已有 Workspace 和 Session 数据均保留。`remoteAliases` 不删除旧 alias，因此旧会话的新工具调用不能掉进 local 分支。

重新添加同一远端路径默认生成新的 workspace id/alias。旧 alias 继续是墓碑，避免把旧会话悄悄绑定到一个语义上可能不同的新目标。

## 文件系统与连接

远端 filesystem 使用 VS Code Agent Host Protocol：

| DSH fs | AHP |
|---|---|
| resolve/stat/lstat | resourceResolve |
| read text/bytes | resourceRead |
| guarded write/edit | resourceWrite createOnly / ifMatch |
| exact-byte write | resourceWrite with internal base64 encoding plus createOnly / ifMatch |
| list directory | resourceList |
| mkdir/delete/move | 对应 Resource action |

AHP etag 作为 opaque FsVersion，保持 read-before-write 和 stale-version 语义。`writeBytes` 接收插件已经持有的 `Uint8Array`；Remote SSH 只在调用 `resourceWrite` 时转换为 base64，模型参数、工具结果和工作区文件中都没有这层编码。`RemoteSshManager` 按 `serverId` 惰性创建一个 host runtime/AHP client；每个 workspace 只创建自己的 mapper、fs view 和 shell view。同主机 workspace 的 `remote` 对象引用相同。

host runtime 请求 POSIX `/` Resource access，以实现 DSH 原生权限含义：Full Access 可跨 workspace；workspace-write 的 mutation 由 `RemoteSshFileSystem` 按每次调用的 `workspaceRoot` 检查；read-only 拒绝 mutation。AHP 授权范围不是 DSH workspace sandbox。

## 远端文件打开

Client 包装原有 `workspaces.openPath`，按文件 alias 或当前 Session 选择远端 Workspace。原生模式调用本机 VSC 兼容编辑器的标准 Remote SSH CLI：authority 为 `ssh-remote+<Host>`，文件名保持远端 POSIX 绝对路径。Windows 使用编辑器安装目录中的版本化 `resources/app/out/cli.js`，不会把 CLI 参数直接交给 GUI 入口。

找不到兼容编辑器或 Remote SSH 扩展时，Host 通过现有 AHP filesystem 读取文件，将按内容寻址的快照写入插件专用临时目录，再交给原有本机 `openPath`。下载上限默认 64 MiB。原生编辑器连接由其 Remote SSH 扩展自行管理，与插件的 SSH/AHP 长连接相互独立。

## 进程与 shell

普通远端 subprocess 使用共享 AHP：

1. 在 host runtime root 创建 fixed stdin（可选）、stdout、stderr Resource；
2. AHP Terminal 在映射后的 cwd 启动精确 argv，stdout/stderr 重定向到不同文件；
3. 本地通过同一 AHP WebSocket 轮询 Resource 并向 pipe/inherit/bounded reader 增量发布；
4. Terminal marker 返回 exit code，AbortSignal dispose Terminal；
5. live stdin 先创建 FIFO，再由第二条 AHP Terminal 接收 Base64 分块并解码写入；随机 EOF marker 关闭 writer；
6. 最终采集后删除临时 Resource/FIFO，取消会同时 dispose 主进程与输入泵。

这使 `rg`/glob/grep、普通后台收集进程与 ignore/fixed/live stdin 调用都不再新建 SSH，同时保留 stdout/stderr 分离。argv、cwd 和环境变量使用固定 POSIX quoting；Windows 本机绝对 executable（例如某插件缓存的 `C:\...\rg.exe`）在远端只保留 basename 并去掉 `.exe`，让远端 PATH 重新解析。

Remote `bash` 保留 Harness 官方工具接口。每个前台调用通过 host 级 SSH/AHP 长连接新建一个 AHP Terminal channel；后台调用继续由 Jobs 管理，并通过同一连接执行。channel 彼此独立，但不会触发新的 SSH 握手，也不会创建每调用一次的远端脚本 Resource。

交互 subprocess terminal 同样直接使用 AHP `createTerminal`/TerminalInput/TerminalData；Ctrl-C、Ctrl-Z 可写入 PTY。AHP 不公开 foreground process group id，因此其他定向 signal 明确失败。

OpenSSH 仅用于 host runtime 的 bootstrap 与 tunnel。POSIX 本机可用短 ControlPath、`ControlMaster=auto` 与 `ControlPersist=60` 合并启动阶段的 SSH 会话；Windows 自带 OpenSSH 和 Git OpenSSH 在实测中会 reset multiplex session，因此 Windows 禁用 ControlMaster。两种平台进入 AHP ready 状态后，普通 fs、shell、搜索、subprocess 和 PTY 都走 host 长连接，不存在逐命令握手。

## 完整 Backend 单例

完整 Backend 使用远端固定实例键 `dsh-ssh-workspace`，而不是为每次连接启动进程。`dsh-host` 将当前 generation、PID、随机 loopback 端口和 token 文件发布到远端 per-user 注册表。连接过程先在同一 SSH 上完成 payload hash 协商，再用 OpenSSH `-D` 建立动态 SOCKS；客户端从注册表取得实际端口后，才在本机建立 TCP 入口。SSH 断开只销毁入口，不停止 Host。

payload hash 相同则复用现有 generation；hash 变化才 `--replace`。安装锁把并发 attach/升级串行化，因此正常状态下每个远端 OS 用户只有一个 Remote SSH Host，固定远端端口也不再是身份或生命周期依据。

`RemoteDshHostConnection` 是稳定逻辑连接，`RemoteDshHostTunnel` 只表示一次 SSH。
Tunnel 退出会触发共享的、带抖动指数退避重连；并发消费者等待同一个 attempt。
Web adapter 保留原 gateway URL，并为新请求解析当前 tunnel；通用 Client 会重新打开
Mux/Host WebSocket 流。连接边界上失败的 unary mutation 不自动重放，避免远端其实
已执行时产生重复副作用。插件退出会取消正在进行的 SSH bootstrap。

dsh-tui 只提供 UI 中性的 `tuiBackends` registry 和命令分发入口。Remote SSH 在该
service 存在时注册 Host Channel provider；registry 支持晚注册和卸载，现有 TUI binding
会在本地 Channel 与远端 Channel 间切换，同时保持交给界面的 Channel 对象身份稳定。
Remote SSH bundle 的 `tui-backend` 条目本身只强依赖 UI 中性的 manager，并在内部观察
可选的 `tuiBackends`；因此同一个 bundle 装入 Web profile 时也能完成激活，不会等待 TUI
专属 service。
因此 bundle 无需定向修改 `dsh-tui` 行，也没有源码 loader hook；未安装 Remote SSH 时，
registry 直接委托原本的本地 Channel。

## Agent Host 版本策略

`@microsoft/agent-host-protocol` 的正式支持版本和经真实集成验证的 forward protocol 只在 `src/ahp-compat.ts` 合并。运行时不根据“最新版”猜测兼容性，而以 `initialize` 握手为准。默认 bootstrap 顺序为 PATH `code` / 私有 CLI、随后是远端缓存的所有 VS Code Server `code-server`（按新到旧）；协议不匹配会清理本次 tunnel/host 并继续下一个候选。

私有 CLI 是唯一由插件生命周期管理层关注的远端可执行文件。CLI 通过官方更新服务管理 Agent Host 的下载、缓存与空闲更新；插件不覆盖 Server 文件。CLI 更新与 AHP SDK 更新分别执行，兼容握手和旧 Server 缓存构成升级安全网。

## 本地 picker 的 UTF-16 兼容层

上游 `@deepseek-ai/dsh-host-directory-picker-native@0.1.0-rc.6` 的 Windows worker 只检查 UTF-16LE 码元低字节是否为零，会截断含“开”(U+5F00) 等字符的路径（discussion #396）。bundle 因此禁用 stock picker occupant，并注册 `directory-picker-native-fixed`：Windows 使用 STA FolderBrowserDialog，完整路径以 UTF-16LE Base64 跨进程返回；macOS/Linux 继续调用上游 `pickNativeDirectory`。这层只改变 host capability，不改变组合后的 LOCAL/Remote workspace 流。

## 失败域

- alias tombstoned：明确报映射已移除；
- SSH 认证/网络失败：返回 ssh 错误，不切 local；
- 远端 executable 缺失：远端 exit 127，不查本机；
- 所有已安装 Agent Host 候选均无法启动/协商：列出客户端 offered versions 与 Server accepted ranges 后失败；
- restrictive shell policy：明确拒绝；
- remote `rg` 缺失：普通 glob/grep 工具失败；
- mapper 收到远端 alias 外路径：拒绝，避免把本机路径发送到远端。

## 非目标与后续

- 不实现第二套远端工具；完整 Backend 通过通用 `dsh-host` 协议承载 Harness；
- 不实现经典 Remote Agent 私有 wire protocol；
- 不声称本地 sandbox 能约束远端内核；
- 当前不支持 Windows SSH 远端；
- live stdin 输入泵依赖远端 POSIX `mkfifo` 与 `base64 -d`；
- AHP stdout/stderr Resource polling 当前每次读取整文件，尚无 range/offset read；
- 当前不自动安装远端 bash/pwsh/rg/code。
