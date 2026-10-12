import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteSshRuntime from '../lib/index.js'
import RemoteSshFileSystem from '../lib/fs.js'
import RemoteSshShellExecutor from '../lib/shell.js'

const sshTarget = process.argv[2]
const remoteWorkspace = process.argv[3]
if (!sshTarget || !remoteWorkspace) {
  throw new Error('usage: node scripts/integration-ssh.mjs <ssh-target> <remote-posix-workspace>')
}

const localWorkspace = resolve('.tmp', 'ssh-integration-alias')
const ctx = new Context()
await ctx.plugin(RemoteSshRuntime, {
  sshTarget,
  remoteWorkspace,
  localWorkspace,
  startupTimeoutMs: 60_000,
})
await ctx.plugin(RemoteSshFileSystem, {
  diffBasisMaxBytes: 1024 * 1024,
  maxReadBytes: 1024 * 1024,
})
await ctx.plugin(RemoteSshShellExecutor, {
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  outputMaxBytes: 1024 * 1024,
  maxOutputMaxBytes: 2 * 1024 * 1024,
  shellCommand: 'bash',
})

try {
  const seed = await ctx.fs.resolve('seed.txt')
  const seedText = await ctx.fs.readText(seed)
  const result = await ctx.shell.run(ctx.shell.resolve({
    command: 'printf "cwd=%s\\nhost=%s\\n" "$PWD" "$(hostname)"; cat seed.txt; printf "err-line\\n" >&2; exit 7',
    workdir: localWorkspace,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: localWorkspace },
  }))
  console.log(JSON.stringify({
    protocolVersion: (await ctx.remoteSsh.getConnection()).protocolVersion,
    seedText,
    shell: result,
  }, null, 2))
  if (result.exitCode !== 7 || !result.stdout.text.includes(`cwd=${remoteWorkspace}`) || !result.stdout.text.includes(seedText.trim())) {
    throw new Error('remote shell result did not prove workspace routing')
  }
} finally {
  await ctx.fiber.dispose()
}
