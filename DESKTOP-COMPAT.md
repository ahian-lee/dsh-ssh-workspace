# Local Desktop compatibility build

Version: 1.0.0. Derived from Yan-Zero/dsh-remote-ssh 0.2.4. Adapted for DeepSeek Harness Desktop 0.2.0-rc.2 on Windows; not an upstream release.

- Uses the current shell execution handle and preserves the shipped local sandbox provider.
- The workspace chooser offers local folders, remote folders, and new SSH hosts; local folder selection uses the native desktop picker. Default approval/sandbox settings remain intact.
- Primary buttons have explicit readable colors; empty remote paths disable workspace creation with an explanatory hint.
- Exposes Remote SSH under Settings; remote workspaces appear in the regular workspace sidebar.
- Persists the custom Remote SSH catalog atomically at ~/.dsh/remote-ssh/config.json on the current settings API. Existing older settings APIs retain their original registration behavior.
- Supports an optional remoteRgCommand per server to reuse a remote ripgrep binary outside PATH.
- Defers the legacy standalone backend client; its button is omitted from the desktop settings page. That separate backend protocol is not migrated here.
- Arbitrary remote commands cannot enforce the local kernel sandbox. Restrictive remote shell requests are rejected; choose the session's full-access permission preset explicitly when executing remote commands. Local sessions keep their existing defaults.

Validated locally: all four presets; local file read and read-only write denial; local sandboxed command; client settings registration and dependencies; remote directory and README read; remote Bash pwd; remote ripgrep; standard session creation on the selected remote workspace. No model inference request was sent during validation.
