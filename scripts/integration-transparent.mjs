import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import RemoteSshManager from '../lib/manager.js'
import TransparentFileSystem from '../lib/router-fs.js'
import TransparentSubprocessRuntime from '../lib/router-subprocess.js'
import TransparentShellExecutor from '../lib/shell-transparent.js'

const sshTarget = process.argv[2]
const remoteWorkspace = process.argv[3]
if (!sshTarget || !remoteWorkspace) {
  throw new Error('usage: node scripts/integration-transparent.mjs <ssh-target> <remote-posix-workspace>')
}

const local = new Context()
const ctx = new Context()

class MemorySettings extends SettingsProvider {
  storedDocument = {}
  get writable() { return true }
  async load() { return structuredClone(this.storedDocument) }
  async persist(namespace, section) {
    this.storedDocument = { ...this.storedDocument, [namespace]: structuredClone(section) }
  }
}

await local.plugin(LocalSubprocessRuntime, {})
await local.plugin(LocalFileSystem, { cwd: process.cwd() })
await ctx.plugin(MemorySettings).await()
ctx.provide('localFs', local.fs)
ctx.provide('localSubprocess', local.subprocess)

const aliasRoot = resolve('.tmp', 'transparent-workspaces')
await ctx.plugin(RemoteSshManager, {
  aliasRoot,
  servers: [{ id: 'laptop', label: 'Laptop', sshTarget }],
  workspaces: [
    { id: 'integration', serverId: 'laptop', remotePath: remoteWorkspace },
    { id: 'integration-b', serverId: 'laptop', remotePath: remoteWorkspace },
  ],
  startupTimeoutMs: 60_000,
})
await ctx.plugin(TransparentFileSystem, {})
await ctx.plugin(TransparentSubprocessRuntime, {})
await ctx.plugin(TransparentShellExecutor, { dialect: 'bash' })

try {
  const alias = resolve(aliasRoot, 'integration')
  const originalSshTransport = ctx.remoteSshManager.sshTransport.bind(ctx.remoteSshManager)
  let subprocessSshFallbacks = 0
  ctx.remoteSshManager.sshTransport = route => {
    subprocessSshFallbacks += 1
    return originalSshTransport(route)
  }
  const firstContext = await ctx.remoteSshManager.workspaceContext(ctx.remoteSshManager.workspace('integration'))
  const secondContext = await ctx.remoteSshManager.workspaceContext(ctx.remoteSshManager.workspace('integration-b'))
  const sharedHostRuntime = firstContext.remote === secondContext.remote
  const seed = await ctx.fs.resolve('seed.txt', { cwd: alias })
  const seedText = await ctx.fs.readText(seed)
  const handle = ctx.subprocess.spawn({
    argv: ['bash', '-lc', 'printf "cwd=%s\\nhost=%s\\n" "$PWD" "$(hostname)"; cat seed.txt; printf "stderr-transparent\\n" >&2; exit 11'],
    cwd: alias,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 1_000,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout.readFrom(0)
  const stderr = handle.collected.stderr.readFrom(0)
  const stdinHandle = ctx.subprocess.spawn({
    argv: ['bash', '-c', 'read value; printf "fixed-stdin=%s\\n" "$value"'],
    cwd: alias,
    stdio: {
      stdin: { data: 'through-ahp\n' },
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 1_000,
  })
  const stdinOutcome = await stdinHandle.done
  const stdinStdout = stdinHandle.collected.stdout.readFrom(0)
  const pipeHandle = ctx.subprocess.spawn({
    argv: ['bash', '-c', 'while IFS= read -r line; do printf "pipe=%s\\n" "$line"; done'],
    cwd: alias,
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 1_000,
  })
  pipeHandle.stdin.write('first chunk\n')
  pipeHandle.stdin.end('第二块\n')
  const pipeOutcome = await pipeHandle.done
  const pipeStdout = pipeHandle.collected.stdout.readFrom(0)
  const cancelledPipe = ctx.subprocess.spawn({
    argv: ['bash', '-c', 'cat'],
    cwd: alias,
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 1_000,
  })
  cancelledPipe.stdin.write('before-cancel\n')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  cancelledPipe.terminate()
  const cancelledPipeOutcome = await cancelledPipe.done
  const fifoCheck = ctx.subprocess.spawn({
    argv: ['bash', '-c', `find ${JSON.stringify(firstContext.remote.runtimeRoot)} -maxdepth 1 -type p -name 'process-*.fifo' -print`],
    cwd: alias,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 1_000,
  })
  const fifoCheckOutcome = await fifoCheck.done
  const fifoCheckStdout = fifoCheck.collected.stdout.readFrom(0)
  const localPackage = await ctx.fs.readText(await ctx.fs.resolve('package.json', { cwd: process.cwd() }))
  const result = { sharedHostRuntime, subprocessSshFallbacks, seedText, outcome, stdout, stderr, stdinOutcome, stdinStdout, pipeOutcome, pipeStdout, cancelledPipeOutcome, fifoCheckOutcome, fifoCheckStdout, localPackageName: JSON.parse(localPackage).name }
  const shell = await ctx.shell.run(ctx.shell.resolve({
    command: 'printf "shell-host=%s\\n" "$(hostname)"',
    workdir: alias,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: alias },
  }))
  result.shell = shell
  const terminal = await ctx.subprocess.spawnTerminal({
    argv: ['bash', '-lc', 'printf "terminal-host=%s\\n" "$(hostname)"; exit 6'],
    cwd: alias,
    rows: 30,
    cols: 100,
    graceMs: 1_000,
  })
  const terminalChunks = []
  terminal.output.on('data', chunk => { terminalChunks.push(Buffer.from(chunk)) })
  const terminalOutcome = await terminal.done
  result.terminal = { outcome: terminalOutcome, output: Buffer.concat(terminalChunks).toString('utf8') }
  console.log(JSON.stringify(result, null, 2))
  if (!sharedHostRuntime
    || subprocessSshFallbacks !== 0
    || outcome.exitCode !== 11
    || !stdout.text.includes(`cwd=${remoteWorkspace}`)
    || !stdout.text.includes('host=Laptop')
    || !stderr.text.includes('stderr-transparent')
    || stdinOutcome.exitCode !== 0
    || !stdinStdout.text.includes('fixed-stdin=through-ahp')
    || pipeOutcome.exitCode !== 0
    || !pipeStdout.text.includes('pipe=first chunk')
    || !pipeStdout.text.includes('pipe=第二块')
    || cancelledPipeOutcome.signal !== 'SIGTERM'
    || fifoCheckOutcome.exitCode !== 0
    || fifoCheckStdout.text !== ''
    || !shell.stdout.text.includes('shell-host=Laptop')
    || terminalOutcome.exitCode !== 6
    || !result.terminal.output.includes('terminal-host=Laptop')
    || result.localPackageName !== 'dsh-ssh-workspace') {
    throw new Error('transparent routing integration did not prove both execution worlds')
  }
} finally {
  await ctx.fiber.dispose()
  await local.fiber.dispose()
}
