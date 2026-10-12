# Publishing

1. Run `pnpm run check` on Node.js 24 / pnpm 11.7.0.
2. Run `pnpm run pack:release`. Independently install the resulting tarball and validate the Desktop UI and routing. Do not assume a source-linked install proves the release package works.
3. Commit source, `lib/`, documentation, screenshots and `dsh-ssh-workspace.tgz` to `ahian-lee/dsh-ssh-workspace`.
4. Tag the same commit as the package version, for example `v1.0.0`. Create a GitHub Release and attach **dsh-ssh-workspace.tgz** (the asset name stays version-free for `latest/download/`).
5. Keep the `dsh-plugin` topic. Submit only `data/plugins/ahian-lee__dsh-ssh-workspace.yml` to `awesome-dsh-plugin/awesome-dsh-plugin`, the catalog consumed by dsh-market. Follow its current repository age and review requirements.
6. Announce one project in DeepSeek Harness → Discussions → Show Your Plugins!, using `DSH | Project Name | One-line description`, an explicit unofficial notice, screenshots, install instructions and upstream attribution.

This project uses GitHub release packages. It is not automatically published to npm.
