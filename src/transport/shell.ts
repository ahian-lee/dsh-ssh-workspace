// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { ContentEncoding, TerminalClientClaim } from '@microsoft/agent-host-protocol'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import z from '@deepseek-ai/schemastery'
import type { RemoteSshRuntime } from './runtime.ts'
import { fileUriFromPosixPath, quotePosix, WorkspacePathMapper } from './runtime.ts'

export interface Config {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  outputMaxBytes?: number
  maxOutputMaxBytes?: number
  shellCommand?: string
  localWorkspace?: string
  remoteWorkspace?: string
}

interface ResolvedConfig extends Config {
  defaultTimeoutMs: number
  maxTimeoutMs: number
  outputMaxBytes: number
  maxOutputMaxBytes: number
  shellCommand: string
}

interface ExecutionOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  output: TailBuffer
}

const UTF8 = 'utf-8' as ContentEncoding

export class RemoteSshShellExecutor extends ShellExecutor {
  static inject = ['remoteSsh']
  static Config: z<Config> = z.object({
    defaultTimeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    outputMaxBytes: z.number().default(256 * 1024),
    maxOutputMaxBytes: z.number().default(16 * 1024 * 1024),
    shellCommand: z.string().default('bash'),
    localWorkspace: z.string(),
    remoteWorkspace: z.string(),
  })

  readonly config: ResolvedConfig
  private readonly remote: RemoteSshRuntime
  private readonly mapper: WorkspacePathMapper
  private readonly processes = new Set<AhpShellProcess>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.remote = ctx.remoteSsh
    this.config = config as ResolvedConfig
    if ((config.localWorkspace === undefined) !== (config.remoteWorkspace === undefined)) {
      throw new Error('dsh-ssh-workspace/shell: localWorkspace and remoteWorkspace must be configured together')
    }
    this.mapper = config.localWorkspace !== undefined && config.remoteWorkspace !== undefined
      ? new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace)
      : mapperOf(this.remote)
    this.validate()
    ctx.effect(() => async () => {
      for (const process of this.processes) process.kill()
      await Promise.allSettled([...this.processes].map(process => process.done))
    }, 'Remote SSH shell teardown')
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampPositive(request.timeoutMs ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs, 'timeoutMs')
    const stdoutMaxBytes = clampPositive(request.stdoutMaxBytes ?? this.config.outputMaxBytes, this.config.maxOutputMaxBytes, 'stdoutMaxBytes')
    return {
      command: request.command,
      workdir: request.workdir ?? this.mapper.localWorkspace,
      timeoutMs,
      stdoutMaxBytes,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      dshEnv: request.dshEnv,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** Unified handle used by Harness 0.2 foreground commands and jobs. */
  async execute(spec: ShellExecSpec & { onExpiry?: 'kill' | 'none' }): Promise<ShellProcess & { result(): Promise<ShellRunResult> }> {
    const process = new AhpShellProcess(this.remote, this.mapper, this.config.shellCommand, spec, this.config.outputMaxBytes, spec.onExpiry === 'none' ? 0 : spec.timeoutMs)
    this.processes.add(process)
    void process.done.finally(() => { this.processes.delete(process) })
    return process
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const outcome = await executeTerminal(this.remote, this.mapper, this.config.shellCommand, spec, spec.stdoutMaxBytes, spec.timeoutMs)
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      timeoutMs: spec.timeoutMs,
      stdout: outcome.output.collected(),
      stderr: { text: '', truncated: false },
    }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const process = new AhpShellProcess(this.remote, this.mapper, this.config.shellCommand, spec, this.config.outputMaxBytes)
    this.processes.add(process)
    void process.done.finally(() => { this.processes.delete(process) })
    return process
  }

  private validate(): void {
    for (const name of ['defaultTimeoutMs', 'maxTimeoutMs', 'outputMaxBytes', 'maxOutputMaxBytes'] as const) {
      const value = this.config[name]
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-ssh-workspace/shell: ${name} must be a positive integer`)
    }
    if (this.config.defaultTimeoutMs > this.config.maxTimeoutMs) throw new Error('dsh-ssh-workspace/shell: defaultTimeoutMs exceeds maxTimeoutMs')
    if (this.config.outputMaxBytes > this.config.maxOutputMaxBytes) throw new Error('dsh-ssh-workspace/shell: outputMaxBytes exceeds maxOutputMaxBytes')
    if (this.config.shellCommand.trim().length === 0) throw new Error('dsh-ssh-workspace/shell: shellCommand must be non-empty')
  }
}

class AhpShellProcess implements ShellProcess {
  status: 'running' | 'completed' | 'killed' = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly done: Promise<void>

  private readonly controller = new AbortController()
  private readonly timeoutMs: number
  private readonly completion: Promise<ExecutionOutcome>
  private readonly output: TailBuffer

  constructor(remote: RemoteSshRuntime, mapper: WorkspacePathMapper, shellCommand: string, spec: ShellExecSpec, outputMaxBytes: number, timeoutMs = 0) {
    this.timeoutMs = spec.timeoutMs
    this.output = new TailBuffer(outputMaxBytes)
    this.completion = executeTerminal(remote, mapper, shellCommand, { ...spec, signal: combineSignals(spec.signal, this.controller.signal) }, outputMaxBytes, timeoutMs, this.output)
    this.done = this.completion
      .then((outcome) => {
        this.exitCode = outcome.exitCode
        this.signal = outcome.signal
        this.status = outcome.signal === null ? 'completed' : 'killed'
      }, (error: unknown) => {
        this.output.append(`\n[dsh-ssh-workspace infrastructure error] ${errorMessage(error)}\n`)
        this.exitCode = null
        this.signal = 'SIGTERM'
        this.status = 'killed'
      })
  }

  async result(): Promise<ShellRunResult> {
    const outcome = await this.completion
    return { exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, aborted: outcome.aborted,
      timeoutMs: this.timeoutMs, stdout: outcome.output.collected(), stderr: { text: '', truncated: false },
      sandbox: { mode: 'danger-full-access', denied: false } } as ShellRunResult
  }

  readOutput(): ShellProcessRead {
    return this.output.readIncremental()
  }

  kill(): boolean {
    if (this.status !== 'running' || this.controller.signal.aborted) return false
    this.controller.abort(new Error('background process killed'))
    return true
  }
}

async function executeTerminal(
  remote: RemoteSshRuntime,
  mapper: WorkspacePathMapper,
  shellCommand: string,
  spec: ShellExecSpec,
  outputMaxBytes: number,
  timeoutMs: number,
  existingOutput?: TailBuffer,
): Promise<ExecutionOutcome> {
  const output = existingOutput ?? new TailBuffer(outputMaxBytes)
  if (spec.sandboxPolicy !== undefined && spec.sandboxPolicy.mode !== 'danger-full-access') {
    throw new Error(`dsh-ssh-workspace/shell: ${spec.sandboxPolicy.mode} cannot confine arbitrary remote commands; use danger-full-access or a separately sandboxed SSH account`)
  }
  const client = await remote.getClient()
  const token = randomUUID()
  const terminalUri = `ahp-terminal:/${token}`
  const commandPath = posix.join(remote.runtimeRoot, `command-${token}.sh`)
  const stdinPath = posix.join(remote.runtimeRoot, `stdin-${token}.bin`)
  const commandUri = fileUriFromPosixPath(commandPath)
  const stdinUri = fileUriFromPosixPath(stdinPath)
  const workdir = mapper.toRemotePath(spec.workdir)
  let subscription: Subscription | undefined
  let terminalCreated = false
  let stdinCreated = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let stopCause: 'timeout' | 'abort' | undefined
  let resolveStop: ((cause: 'timeout' | 'abort') => void) | undefined
  const stopped = new Promise<'timeout' | 'abort'>(resolvePromise => { resolveStop = resolvePromise })

  const stop = (cause: 'timeout' | 'abort'): void => {
    if (stopCause !== undefined) return
    stopCause = cause
    resolveStop?.(cause)
  }

  try {
    if (spec.signal?.aborted) stop('abort')
    await client.resourceWrite({ uri: commandUri, data: spec.command, encoding: UTF8, contentType: 'text/x-shellscript' })
    if (spec.stdin !== undefined) {
      await client.resourceWrite({ uri: stdinUri, data: Buffer.from(spec.stdin).toString('base64'), encoding: 'base64' as ContentEncoding })
      stdinCreated = true
    }
    const claim = { kind: 'client', clientId: remote.clientId } as TerminalClientClaim
    await client.request('createTerminal', {
      channel: terminalUri,
      claim,
      name: 'DeepSeek Harness Remote SSH',
      cwd: fileUriFromPosixPath(workdir),
      cols: 120,
      rows: 30,
    })
    terminalCreated = true
    const subscribed = await client.subscribe(terminalUri)
    subscription = subscribed.subscription

    if (timeoutMs > 0) timer = setTimeout(() => { stop('timeout') }, timeoutMs)
    if (spec.signal !== undefined) {
      abortListener = () => { stop('abort') }
      spec.signal.addEventListener('abort', abortListener, { once: true })
    }

    const env = mergeEnvironment(mapper, spec)
    const envArgs = Object.entries(env).map(([key, value]) => `${key}=${quotePosix(value)}`).join(' ')
    const stdinRedirect = stdinCreated ? quotePosix(stdinPath) : '/dev/null'
    // Control-byte markers distinguish executed output from PTY prompt/input
    // echo even when the embedded Agent Host exposes no command-detection
    // actions. The echoed source contains the printable escape spelling, not
    // the RS/US bytes emitted by printf.
    const marker = new TerminalOutputCapture(token, output)
    const input = `printf '\\036DSH:${token}:BEGIN\\037'; env ${envArgs} ${quotePosix(shellCommand)} ${quotePosix(commandPath)} < ${stdinRedirect}; __dsh_status=$?; printf '\\036DSH:${token}:END:%s\\037' "$__dsh_status"; exit "$__dsh_status"\r`
    client.dispatch(terminalUri, { type: ActionType.TerminalInput, data: input })

    let commandId: string | undefined
    for (;;) {
      const eventOrStop = await Promise.race([
        subscription.next().then(result => ({ kind: 'event' as const, result })),
        stopped.then(cause => ({ kind: 'stop' as const, cause })),
      ])
      if (eventOrStop.kind === 'stop') {
        await client.request('disposeTerminal', { channel: terminalUri }).catch(() => {})
        terminalCreated = false
        return {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: eventOrStop.cause === 'timeout',
          aborted: eventOrStop.cause === 'abort',
          output,
        }
      }
      if (eventOrStop.result.done) {
        throw new Error('Agent Host terminal subscription ended before command completion')
      }
      const event = eventOrStop.result.value
      if (event.type !== 'action') continue
      const action = event.params.action
      if (action.type === ActionType.TerminalCommandExecuted && commandId === undefined) {
        commandId = action.commandId
      } else if (action.type === ActionType.TerminalData) {
        const exitCode = marker.push(action.data)
        if (exitCode !== undefined) {
          return {
            exitCode,
            signal: null,
            timedOut: false,
            aborted: false,
            output,
          }
        }
      } else if (action.type === ActionType.TerminalCommandFinished && action.commandId === commandId && marker.started) {
        // The marker is authoritative. Keep reading because commandFinished
        // may race the final terminal/data action on different Agent Hosts.
        continue
      } else if (action.type === ActionType.TerminalCommandFinished && commandId === undefined) {
        continue
      } else if (action.type === ActionType.TerminalCommandFinished && action.commandId === commandId) {
        return {
          exitCode: action.exitCode ?? null,
          signal: null,
          timedOut: false,
          aborted: false,
          output,
        }
      } else if (action.type === ActionType.TerminalExited) {
        if (!marker.finished) {
          throw new Error(`Agent Host terminal exited before the output marker (exit ${action.exitCode ?? 'unknown'})`)
        }
        return {
          exitCode: action.exitCode ?? null,
          signal: action.exitCode === undefined ? 'SIGTERM' : null,
          timedOut: false,
          aborted: false,
          output,
        }
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener !== undefined) spec.signal?.removeEventListener('abort', abortListener)
    await subscription?.close().catch(() => {})
    if (terminalCreated) await client.request('disposeTerminal', { channel: terminalUri }).catch(() => {})
    await client.resourceDelete({ uri: commandUri }).catch(() => {})
    if (stdinCreated) await client.resourceDelete({ uri: stdinUri }).catch(() => {})
  }
}

class TerminalOutputCapture {
  readonly begin: string
  readonly endPrefix: string
  started = false
  finished = false
  private pending = ''

  constructor(token: string, private readonly output: TailBuffer) {
    this.begin = `\x1eDSH:${token}:BEGIN\x1f`
    this.endPrefix = `\x1eDSH:${token}:END:`
  }

  push(data: string): number | undefined {
    if (this.finished) return undefined
    this.pending += data
    if (!this.started) {
      const at = this.pending.indexOf(this.begin)
      if (at === -1) {
        this.pending = this.pending.slice(-Math.max(0, this.begin.length - 1))
        return undefined
      }
      this.started = true
      this.pending = this.pending.slice(at + this.begin.length)
    }

    const end = this.pending.indexOf(this.endPrefix)
    if (end === -1) {
      const safe = Math.max(0, this.pending.length - (this.endPrefix.length - 1))
      if (safe > 0) {
        this.output.append(this.pending.slice(0, safe))
        this.pending = this.pending.slice(safe)
      }
      return undefined
    }
    this.output.append(this.pending.slice(0, end))
    const statusStart = end + this.endPrefix.length
    const terminator = this.pending.indexOf('\x1f', statusStart)
    if (terminator === -1) {
      // Retain the marker and its partial status until the next data action.
      this.pending = this.pending.slice(end)
      return undefined
    }
    const raw = this.pending.slice(statusStart, terminator)
    if (!/^\d+$/.test(raw)) throw new Error(`Agent Host terminal emitted an invalid exit marker: ${JSON.stringify(raw)}`)
    this.finished = true
    this.pending = ''
    return Number(raw)
  }
}

function mergeEnvironment(mapper: WorkspacePathMapper, spec: ShellExecSpec): Record<string, string> {
  const result: Record<string, string> = { ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) }
  if (result.DSH_CWD !== undefined) result.DSH_CWD = mapper.toRemotePath(result.DSH_CWD)
  for (const key of Object.keys(result)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid remote environment variable name: ${key}`)
    if (result[key]?.includes('\0')) throw new Error(`remote environment variable ${key} contains a NUL byte`)
  }
  return result
}

class TailBuffer {
  private tail = Buffer.alloc(0)
  private tailStart = 0
  private total = 0
  private readOffset = 0

  constructor(private readonly maxBytes: number) {}

  append(value: string): void {
    const chunk = Buffer.from(value)
    this.total += chunk.length
    const combined = Buffer.concat([this.tail, chunk])
    if (combined.length > this.maxBytes) {
      const dropped = combined.length - this.maxBytes
      this.tail = combined.subarray(dropped)
      this.tailStart += dropped
    } else {
      this.tail = combined
    }
  }

  collected(): CollectedOutput {
    return { text: this.tail.toString('utf8'), truncated: this.tailStart > 0 }
  }

  readIncremental(): ShellProcessRead {
    const lossy = this.readOffset < this.tailStart
    const start = Math.max(this.readOffset, this.tailStart) - this.tailStart
    const delta = this.tail.subarray(start).toString('utf8')
    this.readOffset = this.total
    return { delta, lossy }
  }
}

function clampPositive(value: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-ssh-workspace/shell: ${name} must be positive`)
  return Math.min(Math.floor(value), max)
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapperOf(remote: RemoteSshRuntime): ReturnType<RemoteSshRuntime['getMapper']> {
  return remote.mapper ?? remote.getMapper()
}

export default RemoteSshShellExecutor
