// Derived from Yan-Zero/dsh-remote-ssh; modified by ahian-lee. See NOTICE.
import type { UserConfig } from "tsdown";

const PLUGIN_ID = "dsh-ssh-workspace";

export default [
  {
    entry: {
      host: "src/profiles/host.ts",
      index: "src/transport/runtime.ts",
      fs: "src/transport/fs.ts",
      "binary-fs": "src/transport/binary-fs.ts",
      shell: "src/transport/shell.ts",
      search: "src/transport/search.ts",
      manager: "src/routing/manager.ts",
      backend: "src/backend/web.ts",
      "backend-client": "src/backend/client.ts",
      "backend-control": "src/backend/control.ts",
      "backend-connection": "src/backend/connection.ts",
      "backend-tunnel": "src/backend/tunnel.ts",
      "router-fs": "src/routing/fs.ts",
      "router-subprocess": "src/routing/subprocess.ts",
      spill: "src/routing/spill.ts",
      "local-bridge": "src/routing/local-bridge.ts",
      "shell-transparent": "src/routing/shell.ts",
      "agent-policy": "src/routing/agent-policy.ts",
      "tui-backend": "src/profiles/tui-backend.ts",
      tui: "src/profiles/tui.ts",
      web: "src/profiles/web.ts",
    },
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      neverBundle: [
        "@microsoft/agent-host-protocol",
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-fs",
        "@deepseek-ai/dsh-settings",
        "@deepseek-ai/dsh-spill",
        "@deepseek-ai/dsh-subprocess",
        "@deepseek-ai/dsh-workspace",
        "@deepseek-ai/dsh-host-directory-picker-browse",
        "@deepseek-ai/dsh-host-webserver",
        "@deepseek-ai/dsh-host-apiproxy",
        "@deepseek-ai/dsh-llm",
        "@deepseek-ai/dsh-sandbox",
        "@deepseek-ai/dsh-shell",
        "@deepseek-ai/dsh-system-prompt",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/schemastery",
      ],
    },
  },
  {
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    dts: false,
    clean: false,
    deps: {
      neverBundle: [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-client-runtime/client",
        "@deepseek-ai/dsh-client-ui-settings-plugins/client",
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "production"
      ),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
] satisfies UserConfig[];
