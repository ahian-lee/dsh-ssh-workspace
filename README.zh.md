# SSH Workspace：DeepSeek Harness 远程工作区

[English](README.md) · [下载安装包](https://github.com/ahian-lee/dsh-ssh-workspace/releases/latest)

**非官方社区插件**，由 ahian-lee 维护；基于 [Yan-Zero/dsh-remote-ssh](https://github.com/Yan-Zero/dsh-remote-ssh) 修改，保留 Apache-2.0 许可证和原作者署名。

在 DSH Desktop 中选择 SSH 主机和远端目录，像普通项目一样建立工作区、创建对话，并使用原有的文件、搜索与 Bash 工具。

**DSH 主程序、对话运行时、模型请求和插件仍在本地运行。** 插件将支持的工作区文件操作、搜索、子进程和 Bash 路由到对应 SSH 主机。安装它不需要换一份 DSH，也不会把所有插件搬到远端。

![添加 SSH 工作区](assets/workspace-picker.png)

## 功能

- 读取 OpenSSH 主机配置，支持 `Include` 和 `ProxyJump`；在添加工作区弹窗或“设置 → Remote SSH”中添加新主机。
- 本地项目继续使用 DSH 原生目录选择器；远程项目可浏览目录或填写绝对路径。
- 每个远程项目成为普通工作区，使用独立对话与历史记录。
- 原有文件、搜索和 Bash 工具随工作区切换执行位置；远端失败或映射移除时不会回退本地执行。
- 保留 DSH 本地沙箱和默认权限设置。
- 修复主按钮白底白字；路径为空时明确显示禁用状态及填写提示。

![Remote SSH 设置](assets/remote-settings.png)

截图使用演示主机和目录，安装包不包含任何个人 SSH 配置。

## 支持范围

本版已验证 **Windows DSH Desktop 0.2.0-rc.2 + Linux/POSIX SSH 远端**，要求 Node.js 22+。本地执行使用 Windows PowerShell 沙箱提供者。暂不支持 Linux/macOS 本地主机、Windows SSH 远端、遗留 TUI 适配器和整个 DSH 后端迁移到远端的模式。

这是基于上游 0.2.4 的 Desktop 兼容分支，适配了 DSH 0.2 的服务、设置、Shell 执行结果和 UI 插槽接口，并非原作者发布的版本。

## 安装

在 **DSH Desktop → 插件** 中安装以下预构建包，然后从托盘完全退出 DSH 并重新打开：

```text
https://github.com/ahian-lee/dsh-ssh-workspace/releases/latest/download/dsh-ssh-workspace.tgz
```

安装包包含编译后的 `lib/`、前端模块及 `cordis.patch.yml`，无需用户在本机编译。仓库也保留编译文件，供 GitHub 安装使用。

Windows 上独立 CLI 的 Web profile 可使用：

```sh
dsh plugin --profile web add https://github.com/ahian-lee/dsh-ssh-workspace/releases/latest/download/dsh-ssh-workspace.tgz
dsh web
```

独立 CLI 不管理 Electron 专用的 `desktop` profile，桌面版请使用应用中的插件管理入口。

**从 `dsh-remote-ssh` 切换：** 先停用或移除旧 bundle，再启用本插件。两者接管相同的执行服务，不能同时启用。主机目录与工作区映射仍保存在 `~/.dsh/remote-ssh/`，无需删除原来的配置、别名目录或对话。独立的 `dsh-ssh` 运维面板可继续使用。

## 建立第一个工作区

1. 先在终端确认 `ssh 主机别名` 能连接；首次主机指纹确认、密码和 MFA 在终端完成。
2. 点击“添加工作区”，选择服务器，填写 `/home/user/project` 这样的远端绝对路径，或点击“浏览远端”。输入框里的占位示例不表示已经填好路径。
3. 添加工作区，在其中创建对话。也可以在“设置 → Remote SSH”管理主机与工作区。
4. 执行任意远端 Bash 命令时，主动把**该远端会话**设为“完全权限”。受限模式的远端 Shell 请求会明确拒绝，插件不会偷偷放宽权限；本地默认权限不变。

远端命令继承 SSH 账户的权限，工作区目录只决定路由位置，并不是操作系统沙箱。需要隔离时请使用权限合适的 SSH 账户。

远端需要 OpenSSH、`bash`、`base64`、`mkfifo`、`rg`，以及兼容的 VS Code Agent Host/CLI 或已有的 VS Code Server。缺少软件会报错，不会静默安装。若远端 `rg` 已存在但不在 `PATH` 中，可在 `~/.dsh/remote-ssh/config.json` 为该服务器配置 `remoteRgCommand`。

## 验证与开发

首版通过 **35 项针对性测试**，覆盖路由、文件系统、现行 Shell handle、配置持久化、SSH 配置、路径映射、AHP 协商、SOCKS 与 bundle 组合。独立安装打包产物后，验证实际 DSH 组合、浏览器新增主机/工作区、空路径禁用状态和四个 Agent 预设。Linux SSH 实测包含文件读取、Bash `pwd` 和 ripgrep，验证过程未发起模型推理请求。

```sh
pnpm install
pnpm run check
pnpm run pack:release
```

开发建议 Node.js 24、pnpm 11.7.0。`test` 只执行本版支持的 Desktop 路由测试，保留的上游 backend/TUI 测试不属于支持范围。`build` 负责转译与前端打包，不代表全项目 TypeScript 类型检查通过。变更与署名见 [CHANGELOG.md](CHANGELOG.md)、[DESKTOP-COMPAT.md](DESKTOP-COMPAT.md)、[NOTICE](NOTICE)。
