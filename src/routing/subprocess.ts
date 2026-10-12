// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { ContentEncoding, TerminalClientClaim } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { fileUriFromPosixPath, quotePosix } from '../transport/runtime.ts'

/** Subprocess router that selects the host from `spec.cwd`, never tool identity. */
export class TransparentSubprocessRuntime extends SubprocessRuntime {
  static inject = ['localSubprocess', 'remoteSshManager']

  private readonly local: SubprocessRuntime
  private readonly manager: RemoteSshManager
  private readonly remoteHandles = new Set<SubprocessHandle>()
  private readonly remoteTerminals = new Set<SubprocessTerminalHandle>()

  constructor(ctx: Context) {
    super(ctx)
    this.local = ctx.localSubprocess
    this.manager = ctx.remoteSshManager
    ctx.effect(() => async () => {
      for (const handle of this.remoteHandles) handle.terminate()
      await Promise.allSettled([...this.remoteHandles].map(handle => handle.done))
      await Promise.allSettled([...this.remoteTerminals].map(terminal => terminal.terminate()))
    }, 'Remote SSH subprocess teardown')
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    // Executable lookup has no cwd in the DSH seam. Keep constructor-time
    // discovery local; a remote spawn re-resolves the executable in the
    // selected workspace's execution world.
    return this.local.resolveExecutable(command, env, signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const route = this.manager.route(undefined, spec.cwd)
    if (route.kind === 'local') return this.local.spawn(spec)
    const handle = new RemoteAhpProcessHandle(
      route,
      this.manager.workspaceContext(route),
      this.manager.workspaceShell(route, 'bash'),
      spec,
    )
    this.remoteHandles.add(handle)
    void handle.done.finally(() => { this.remoteHandles.delete(handle) }).catch(() => {})
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const route = this.manager.route(undefined, spec.cwd)
    if (route.kind === 'local') return this.local.spawnTerminal(spec)
    const handle = await RemoteAhpTerminalHandle.create(route, await this.manager.workspaceContext(route), spec)
    this.remoteTerminals.add(handle)
    void handle.done.finally(() => { this.remoteTerminals.delete(handle) }).catch(() => {})
    return handle
  }
}

/** All ordinary remote subprocess modes stay on the persistent AHP host. */
export function canUseAhpSubprocess(_spec: SubprocessSpawnSpec): boolean {
  return true
}

/**
 * Subprocess over the persistent host AHP connection. A short-lived remote
 * PTY launches the exact argv while stdout/stderr are redirected to separate
 * Resource files. Live stdin is streamed through a second AHP Terminal into a
 * remote FIFO, so no per-command SSH transport exists.
 */
class RemoteAhpProcessHandle implements SubprocessHandle {
  readonly pid = -1
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly controller = new AbortController()
  private readonly stdoutSink: RemoteOutputSink
  private readonly stderrSink: RemoteOutputSink
  private readonly stdinPipe: DeferredAhpStdin | undefined
  private settled = false

  constructor(
    private readonly route: RemoteWorkspaceRoute,
    private readonly workspace: ReturnType<RemoteSshManager['workspaceContext']>,
    private readonly shell: ReturnType<RemoteSshManager['workspaceShell']>,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    this.stdoutSink = new RemoteOutputSink(spec.stdio.stdout, process.stdout)
    this.stderrSink = new RemoteOutputSink(spec.stdio.stderr, process.stderr)
    this.stdout = this.stdoutSink.stream
    this.stderr = this.stderrSink.stream
    this.stdinPipe = spec.stdio.stdin === 'pipe' ? new DeferredAhpStdin() : undefined
    this.stdin = this.stdinPipe
    this.collected = {
      ...(this.stdoutSink.reader === undefined ? {} : { stdout: this.stdoutSink.reader }),
      ...(this.stderrSink.reader === undefined ? {} : { stderr: this.stderrSink.reader }),
    }
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) this.controller.abort(spec.signal.reason)
      else spec.signal.addEventListener('abort', () => { this.controller.abort(spec.signal?.reason) }, { once: true })
    }
    this.done = this.execute().catch(error => {
      this.stdinPipe?.fail(error)
      throw error
    }).finally(() => {
      this.settled = true
      this.stdoutSink.end()
      this.stderrSink.end()
    })
  }

  terminate(): void {
    if (!this.settled) this.controller.abort(new Error('remote subprocess terminated'))
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    return Promise.race([
      this.done.then(() => true, () => true),
      signal === undefined ? new Promise<boolean>(() => {}) : new Promise<boolean>(resolvePromise => {
        signal.addEventListener('abort', () => { resolvePromise(false) }, { once: true })
      }),
    ])
  }

  private async execute(): Promise<SubprocessOutcome> {
    const stdinMode = this.spec.stdio.stdin
    const [{ remote }, shell] = await Promise.all([this.workspace, this.shell])
    const client = await remote.getClient()
    const token = randomUUID()
    const stdoutPath = `${remote.runtimeRoot}/process-${token}.stdout`
    const stderrPath = `${remote.runtimeRoot}/process-${token}.stderr`
    const stdinPath = `${remote.runtimeRoot}/process-${token}.stdin`
    const fifoPath = `${remote.runtimeRoot}/process-${token}.fifo`
    const stdoutUri = fileUriFromPosixPath(stdoutPath)
    const stderrUri = fileUriFromPosixPath(stderrPath)
    const stdinUri = fileUriFromPosixPath(stdinPath)
    const fifoUri = fileUriFromPosixPath(fifoPath)
    const empty = { data: '', encoding: 'base64' as ContentEncoding }
    let writer: RemoteAhpTerminalHandle | undefined
    let completed = false
    let run: ReturnType<typeof shell.run> | undefined
    try {
      await Promise.all([
        client.resourceWrite({ uri: stdoutUri, ...empty }),
        client.resourceWrite({ uri: stderrUri, ...empty }),
        stdinMode === 'ignore' || stdinMode === 'pipe'
          ? Promise.resolve()
          : client.resourceWrite({
              uri: stdinUri,
              data: Buffer.from(stdinMode.data).toString('base64'),
              encoding: 'base64' as ContentEncoding,
            }),
      ])
      if (stdinMode === 'pipe') {
        const prepared = await shell.run(shell.resolve({
          command: `rm -f -- ${quotePosix(fifoPath)} && mkfifo -- ${quotePosix(fifoPath)}`,
          workdir: this.spec.cwd,
          signal: this.controller.signal,
          sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: this.route.aliasPath },
        }))
        if (prepared.exitCode !== 0) {
          if (this.controller.signal.aborted) return { exitCode: null, signal: prepared.signal ?? 'SIGTERM' }
          throw new Error(`dsh-ssh-workspace: failed to create remote stdin FIFO (exit ${prepared.exitCode ?? prepared.signal})`)
        }
      }
      const inputPath = stdinMode === 'ignore' ? '/dev/null' : stdinMode === 'pipe' ? fifoPath : stdinPath
      const argv = remoteExecutable(this.spec.argv[0] ?? '') === 'rg' && this.route.server.remoteRgCommand
        ? [this.route.server.remoteRgCommand, ...this.spec.argv.slice(1)] : this.spec.argv
      const command = buildRemoteProcessCommand(argv, this.spec.env, inputPath, stdoutPath, stderrPath)
      const resolved = shell.resolve({
        command,
        workdir: this.spec.cwd,
        signal: this.controller.signal,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: this.route.aliasPath },
      })
      run = shell.run(resolved).finally(() => { completed = true })
      if (stdinMode === 'pipe') {
        const endMarker = `__DSH_STDIN_EOF_${randomUUID().replaceAll('-', '')}__`
        writer = await RemoteAhpTerminalHandle.create(this.route, await this.workspace, {
          argv: ['bash', '-c', buildRemoteStdinWriterCommand(fifoPath, endMarker)],
          cwd: this.spec.cwd,
          rows: 24,
          cols: 80,
          graceMs: this.spec.graceMs,
          signal: this.controller.signal,
        })
        writer.output.resume()
        this.stdinPipe?.bind(writer, endMarker)
      }
      while (!completed) {
        await this.poll(client, stdoutUri, stderrUri)
        await delay(40)
      }
      const result = await run
      await this.poll(client, stdoutUri, stderrUri)
      return { exitCode: result.exitCode, signal: result.signal }
    } catch (error) {
      this.stdinPipe?.fail(error)
      this.controller.abort(error)
      await run?.catch(() => {})
      throw error
    } finally {
      if (writer !== undefined) await writer.terminate()
      this.stdinPipe?.finishRemote()
      await Promise.allSettled([
        client.resourceDelete({ uri: stdoutUri, recursive: false }),
        client.resourceDelete({ uri: stderrUri, recursive: false }),
        ...(stdinMode === 'ignore' || stdinMode === 'pipe' ? [] : [client.resourceDelete({ uri: stdinUri, recursive: false })]),
        ...(stdinMode === 'pipe' ? [client.resourceDelete({ uri: fifoUri, recursive: false })] : []),
      ])
    }
  }

  private async poll(client: AhpClient, stdoutUri: string, stderrUri: string): Promise<void> {
    const [stdout, stderr] = await Promise.all([
      readRemoteOutput(client, stdoutUri),
      readRemoteOutput(client, stderrUri),
    ])
    this.stdoutSink.update(stdout)
    this.stderrSink.update(stderr)
  }
}

/** Interactive terminal over the same persistent AHP host connection. */
class RemoteAhpTerminalHandle implements SubprocessTerminalHandle {
  readonly pid = -1
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private stopping: ((signal: NodeJS.Signals) => void) | undefined
  private readonly stopped = new Promise<NodeJS.Signals>(resolvePromise => { this.stopping = resolvePromise })
  private terminating: Promise<void> | undefined

  private constructor(
    private readonly client: AhpClient,
    private readonly channel: string,
    private readonly subscription: Subscription,
  ) {
    this.done = this.pump()
  }

  static async create(
    route: RemoteWorkspaceRoute,
    workspace: Awaited<ReturnType<RemoteSshManager['workspaceContext']>>,
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<RemoteAhpTerminalHandle> {
    if (spec.signal?.aborted) throw spec.signal.reason ?? new Error('remote terminal allocation aborted')
    const client = await workspace.remote.getClient()
    const channel = `ahp-terminal:/${randomUUID()}`
    const claim = { kind: 'client', clientId: workspace.remote.clientId } as TerminalClientClaim
    await client.request('createTerminal', {
      channel,
      claim,
      name: 'DeepSeek Harness Remote SSH subprocess',
      cwd: fileUriFromPosixPath(route.mapper.toRemotePath(spec.cwd)),
      cols: spec.cols,
      rows: spec.rows,
    })
    try {
      const subscribed = await client.subscribe(channel)
      const handle = new RemoteAhpTerminalHandle(client, channel, subscribed.subscription)
      if (spec.signal?.aborted) {
        await handle.terminate()
        throw spec.signal.reason ?? new Error('remote terminal allocation aborted')
      }
      if (spec.signal !== undefined) {
        const onAbort = () => { void handle.terminate() }
        spec.signal.addEventListener('abort', onAbort, { once: true })
        void handle.done.finally(() => { spec.signal?.removeEventListener('abort', onAbort) }).catch(() => {})
      }
      client.dispatch(channel, { type: ActionType.TerminalInput, data: `${buildRemoteInteractiveCommand(spec.argv, spec.env)}\r` })
      return handle
    } catch (error) {
      await client.request('disposeTerminal', { channel }).catch(() => {})
      throw error
    }
  }

  async write(data: string): Promise<void> {
    this.client.dispatch(this.channel, { type: ActionType.TerminalInput, data })
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return undefined
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (signal === 'SIGINT') {
      await this.write('\x03')
      return -1
    }
    if (signal === 'SIGTSTP') {
      await this.write('\x1a')
      return -1
    }
    throw new Error(`dsh-ssh-workspace: AHP PTY cannot address a foreground process group for ${signal}`)
  }

  terminate(): Promise<void> {
    this.terminating ??= (async () => {
      await this.client.request('disposeTerminal', { channel: this.channel }).catch(() => {})
      this.stopping?.('SIGTERM')
      await this.done.catch(() => {})
    })()
    return this.terminating
  }

  private async pump(): Promise<SubprocessOutcome> {
    try {
      for (;;) {
        const next = await Promise.race([
          this.subscription.next().then(result => ({ kind: 'event' as const, result })),
          this.stopped.then(signal => ({ kind: 'stopped' as const, signal })),
        ])
        if (next.kind === 'stopped') return { exitCode: null, signal: next.signal }
        if (next.result.done) throw new Error('dsh-ssh-workspace: AHP terminal subscription ended before terminal exit')
        const event = next.result.value
        if (event.type !== 'action') continue
        const action = event.params.action
        if (action.type === ActionType.TerminalData) this.output.write(action.data)
        else if (action.type === ActionType.TerminalExited) {
          return { exitCode: action.exitCode ?? null, signal: action.exitCode === undefined ? 'SIGTERM' : null }
        }
      }
    } finally {
      this.output.end()
      await this.subscription.close().catch(() => {})
      await this.client.request('disposeTerminal', { channel: this.channel }).catch(() => {})
    }
  }
}

/** Writable exposed synchronously while its remote AHP input pump boots. */
export class DeferredAhpStdin extends Writable {
  private readonly binding: Promise<{ terminal: RemoteAhpTerminalHandle; endMarker: string }>
  private resolveBinding!: (value: { terminal: RemoteAhpTerminalHandle; endMarker: string }) => void
  private rejectBinding!: (reason: unknown) => void
  private bound = false
  private remoteFinished = false

  constructor() {
    super()
    this.binding = new Promise((resolvePromise, reject) => {
      this.resolveBinding = resolvePromise
      this.rejectBinding = reject
    })
    // Match ChildProcess.stdin: an EPIPE is observable by callbacks without
    // becoming an unhandled EventEmitter error when callers only await done.
    this.on('error', () => {})
  }

  bind(terminal: RemoteAhpTerminalHandle, endMarker: string): void {
    if (this.bound || this.remoteFinished) return
    this.bound = true
    this.resolveBinding({ terminal, endMarker })
  }

  fail(reason: unknown): void {
    if (!this.bound) {
      this.remoteFinished = true
      this.rejectBinding(reason)
    }
    if (!this.destroyed) this.destroy(reason instanceof Error ? reason : new Error(String(reason)))
  }

  finishRemote(): void {
    this.remoteFinished = true
    if (!this.bound) this.rejectBinding(new Error('dsh-ssh-workspace: remote stdin pump ended before startup'))
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.sendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)).then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    void (async () => {
      const { terminal, endMarker } = await this.binding
      await terminal.write(`${endMarker}\n`)
      const outcome = await terminal.done
      if (outcome.exitCode !== 0) throw new Error(`dsh-ssh-workspace: stdin pump failed (exit ${outcome.exitCode ?? outcome.signal})`)
    })().then(() => callback(), callback)
  }

  private async sendChunk(chunk: Buffer): Promise<void> {
    if (this.remoteFinished) throw new Error('dsh-ssh-workspace: remote stdin is already closed')
    const { terminal } = await this.binding
    await terminal.write(`${chunk.toString('base64')}\n`)
  }
}

class TailOutputReader implements SubprocessOutputReader {
  private tail = Buffer.alloc(0)
  private tailStart = 0
  private total = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.total += chunk.length
    const combined = Buffer.concat([this.tail, chunk])
    if (combined.length <= this.maxBytes) {
      this.tail = combined
      return
    }
    const dropped = combined.length - this.maxBytes
    this.tail = combined.subarray(dropped)
    this.tailStart += dropped
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const lossy = fromByte < this.tailStart
    const start = Math.max(fromByte, this.tailStart) - this.tailStart
    return {
      text: this.tail.subarray(start).toString('utf8'),
      nextOffset: this.total,
      lossy,
    }
  }
}

class RemoteOutputSink {
  readonly stream: PassThrough | undefined
  readonly reader: TailOutputReader | undefined
  private offset = 0

  constructor(mode: SubprocessOutputMode, private readonly inherited: Writable) {
    this.stream = mode === 'pipe' ? new PassThrough() : undefined
    this.reader = typeof mode === 'object' ? new TailOutputReader(mode.maxBytes) : undefined
  }

  update(content: Buffer): void {
    if (content.length < this.offset) this.offset = 0
    if (content.length === this.offset) return
    const delta = content.subarray(this.offset)
    this.offset = content.length
    if (this.stream !== undefined) this.stream.write(delta)
    else if (this.reader !== undefined) this.reader.append(delta)
    else this.inherited.write(delta)
  }

  end(): void {
    this.stream?.end()
  }
}

const BASE64 = 'base64' as ContentEncoding

async function readRemoteOutput(client: AhpClient, uri: string): Promise<Buffer> {
  const result = await client.resourceRead({ uri, encoding: BASE64 })
  return result.encoding === BASE64 ? Buffer.from(result.data, 'base64') : Buffer.from(result.data, 'utf8')
}

export function buildRemoteProcessCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined,
  stdinPath: string,
  stdoutPath: string,
  stderrPath: string,
): string {
  const executable = argv[0]
  if (executable === undefined || executable.length === 0) throw new Error('dsh-ssh-workspace: subprocess argv must contain a program')
  const envArgs: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`dsh-ssh-workspace: invalid environment variable '${key}'`)
    if (value === undefined) envArgs.push('-u', key)
    else envArgs.push(`${key}=${value}`)
  }
  const remoteArgv = [remoteExecutable(executable), ...argv.slice(1)]
  return `exec env ${envArgs.map(quotePosix).join(' ')} ${remoteArgv.map(quotePosix).join(' ')} < ${quotePosix(stdinPath)} > ${quotePosix(stdoutPath)} 2> ${quotePosix(stderrPath)}`
}

export function buildRemoteInteractiveCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): string {
  const executable = argv[0]
  if (executable === undefined || executable.length === 0) throw new Error('dsh-ssh-workspace: terminal argv must contain a program')
  const envArgs: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`dsh-ssh-workspace: invalid environment variable '${key}'`)
    envArgs.push(`${key}=${value}`)
  }
  const remoteArgv = [remoteExecutable(executable), ...argv.slice(1)]
  return `exec env ${envArgs.map(quotePosix).join(' ')} ${remoteArgv.map(quotePosix).join(' ')}`
}

/** Decode newline-delimited base64 records until the unguessable EOF marker. */
export function buildRemoteStdinWriterCommand(fifoPath: string, endMarker: string): string {
  return `while IFS= read -r line; do [ "$line" = ${quotePosix(endMarker)} ] && break; printf '%s' "$line" | base64 -d; done > ${quotePosix(fifoPath)}`
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function remoteExecutable(executable: string): string {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(executable)) return executable
  return win32.basename(executable).replace(/\.exe$/i, '')
}

export default TransparentSubprocessRuntime
