# Installation

Follow [README.md](README.md#install) or [README.zh.md](README.zh.md#安装).

Use the prebuilt GitHub Release asset. Do not enable this bundle together with `dsh-remote-ssh`. Preserve the catalog under `~/.dsh/remote-ssh/` when switching packages. Do not replace DSH itself, overwrite SSH configuration, disable local sandboxing, or install remote prerequisites automatically.

After installation, fully exit and reopen Desktop. Verify Settings → Remote SSH loads, the normal Agent presets remain available, and an entered remote directory enables Add workspace. Test remote access only against a host and directory the user selected. Remote shell full access is a conversation-level choice; do not change the user's global defaults.
