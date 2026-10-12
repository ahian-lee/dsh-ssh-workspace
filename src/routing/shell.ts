// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
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
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { RemoteSshManager } from './manager.ts'

export interface Config {
  dialect: 'bash' | 'pwsh' | 'auto'
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
  executable?: string
}

interface ResolvedConfig extends Config {
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  maxSpillBytes: number
  graceMs: number
}

const PWSH_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Syntax-specific shell provider over the cwd-routed subprocess service. */
export class TransparentShellExecutor extends ShellExecutor {
  static inject = ['subprocess', 'remoteSshManager', 'localShell', 'sandboxPolicy']
  static Config: z<Config> = z.object({
    dialect: z.union(['bash', 'pwsh', 'auto'] as const).required(),
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(64 * 1024 * 1024),
    graceMs: z.number().default(3_000),
    executable: z.string(),
  })

  private readonly config: ResolvedConfig
  private readonly manager: RemoteSshManager

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    this.manager = ctx.remoteSshManager
    for (const name of ['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs'] as const) {
      const value = this.config[name]
      if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-ssh-workspace/shell-transparent: ${name} must be positive`)
    }
  }

  /** Remote and local routing is explicitly unconfined at the process layer. */
  override get sandboxMode() {
    return this.ctx.localShell.sandboxMode
  }

  override resolve(request: ShellExecRequest): ShellExecSpec & { onExpiry?: 'kill' | 'none' } {
    if (this.manager.routeShell(request.workdir ?? process.cwd(), request.dshEnv?.DSH_SESSION_ID).kind === 'local') return this.ctx.localShell.resolve(request)
    const timeoutMs = Math.min(Math.floor(request.timeoutMs ?? this.config.timeoutMs), this.config.maxTimeoutMs)
    const stdoutMaxBytes = Math.floor(request.stdoutMaxBytes ?? this.config.maxOutputBytes)
    if (timeoutMs <= 0 || stdoutMaxBytes <= 0) throw new Error('dsh-ssh-workspace/shell-transparent: timeout and output limits must be positive')
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      dshEnv: request.dshEnv,
      sandboxPolicy: request.sandboxPolicy ?? (this.ctx as unknown as { sandboxPolicy: { resolve(): SandboxExecutionPolicy } }).sandboxPolicy.resolve(),
      onExpiry: (request as ShellExecRequest & { onExpiry?: 'kill' | 'none' }).onExpiry ?? 'kill',
    }
  }

  /** Current Harness execution seam; local calls retain the shipped sandbox provider. */
  async execute(spec: ShellExecSpec & { onExpiry?: 'kill' | 'none' }): Promise<ShellProcess & { result(): Promise<ShellRunResult> }> {
    const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID)
    if (route.kind === 'local') {
      return (this.ctx.localShell as ShellExecutor & { execute(spec: ShellExecSpec): Promise<ShellProcess & { result(): Promise<ShellRunResult> }> }).execute(spec)
    }
    assertUnconfined(spec)
    const remote = await this.manager.workspaceShell(route, this.config.dialect === 'auto' ? this.manager.dialectFor(spec.workdir) : this.config.dialect)
    return (remote as ShellExecutor & { execute(spec: ShellExecSpec): Promise<ShellProcess & { result(): Promise<ShellRunResult> }> }).execute(spec)
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID)
    if (route.kind === 'local') return this.ctx.localShell.run(spec)
    assertUnconfined(spec)
    if (route.kind === 'remote') {
      const result = await (await this.manager.workspaceShell(route, this.config.dialect === 'auto' ? this.manager.dialectFor(spec.workdir) : this.config.dialect)).run(spec)
      return { ...result, sandbox: { mode: 'danger-full-access', denied: false } }
    }
    const controller = new AbortController()
    let cause: 'timeout' | 'abort' | undefined
    const abort = (): void => {
      if (cause !== undefined) return
      cause = 'abort'
      controller.abort(spec.signal?.reason)
    }
    if (spec.signal?.aborted) abort()
    else spec.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      if (cause !== undefined) return
      cause = 'timeout'
      controller.abort(new Error('shell timeout'))
    }, spec.timeoutMs)
    try {
      const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, controller.signal))
      const outcome = await handle.done
      const collected = requireCollected(handle)
      return {
        ...outcome,
        timedOut: cause === 'timeout',
        aborted: cause === 'abort',
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected.stdout),
        stderr: finalOutput(collected.stderr),
        sandbox: { mode: 'danger-full-access', denied: false },
      }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', abort)
    }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID)
    if (route.kind === 'local') return this.ctx.localShell.start(spec)
    assertUnconfined(spec)
    if (route.kind === 'remote') {
      return new DeferredShellProcess(this.manager.workspaceShell(route, this.config.dialect === 'auto' ? this.manager.dialectFor(spec.workdir) : this.config.dialect), spec)
    }
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, this.config.maxOutputBytes, spec.signal))
    const collected = requireCollected(handle)
    let stdoutOffset = 0
    let stderrOffset = 0
    let spawnFailure: string | undefined
    const processHandle: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      sandbox: { mode: 'danger-full-access', denied: false },
      done: handle.done.then(outcome => {
        processHandle.exitCode = outcome.exitCode
        processHandle.signal = outcome.signal
        processHandle.status = outcome.signal === null ? 'completed' : 'killed'
      }, (error: unknown) => {
        processHandle.status = 'killed'
        processHandle.signal = 'SIGTERM'
        spawnFailure = `spawn failed: ${String(error)}`
      }),
      readOutput: (): ShellProcessRead => {
        const stdout = collected.stdout.readFrom(stdoutOffset)
        const stderr = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = stdout.nextOffset
        stderrOffset = stderr.nextOffset
        const error = stderr.text || spawnFailure || ''
        spawnFailure = undefined
        return {
          delta: stdout.text + (error.length === 0 ? '' : `${stdout.text.length > 0 && !stdout.text.endsWith('\n') ? '\n' : ''}[stderr]\n${error}`),
          lossy: stdout.lossy || stderr.lossy,
          ...(stdout.spillPath === undefined ? {} : { stdoutSpillPath: stdout.spillPath }),
          ...(stderr.spillPath === undefined ? {} : { stderrSpillPath: stderr.spillPath }),
        }
      },
      kill: (): boolean => {
        if (processHandle.status !== 'running') return false
        processHandle.status = 'killed'
        handle.terminate()
        return true
      },
    }
    return processHandle
  }

  private spawnSpec(spec: ShellExecSpec, stdoutMaxBytes: number, signal: AbortSignal | undefined): SubprocessSpawnSpec {
    const collect = (maxBytes: number) => ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: this.argv(spec.command),
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', ...spec.env, ...spec.dshEnv },
    }
  }

  private argv(command: string): string[] {
    if (this.config.dialect === 'bash') return [this.config.executable ?? 'bash', '-c', command]
    return [this.config.executable ?? 'pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PWSH_PREAMBLE + command]
  }
}

class DeferredShellProcess implements ShellProcess {
  status: 'running' | 'completed' | 'killed' = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly sandbox = { mode: 'danger-full-access' as const, denied: false }
  readonly done: Promise<void>

  private inner: ShellProcess | undefined
  private cancelled = false
  private startupError = ''

  constructor(shell: Promise<ShellExecutor>, spec: ShellExecSpec) {
    this.done = shell.then(async executor => {
      if (this.cancelled) return
      this.inner = executor.start(spec)
      await this.inner.done
      this.status = this.inner.status
      this.exitCode = this.inner.exitCode
      this.signal = this.inner.signal
    }, (error: unknown) => {
      this.status = 'killed'
      this.signal = 'SIGTERM'
      this.startupError = `[dsh-ssh-workspace infrastructure error] ${String(error)}\n`
    })
  }

  readOutput(): ShellProcessRead {
    if (this.inner !== undefined) return this.inner.readOutput()
    const delta = this.startupError
    this.startupError = ''
    return { delta, lossy: false }
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.status = 'killed'
    this.cancelled = true
    return this.inner?.kill() ?? true
  }
}

function assertUnconfined(spec: ShellExecSpec): void {
  if (spec.sandboxPolicy !== undefined && spec.sandboxPolicy.mode !== 'danger-full-access') {
    throw new Error(`dsh-ssh-workspace: transparent shell cannot enforce ${spec.sandboxPolicy.mode} across SSH; select danger-full-access or confine the SSH account`)
  }
}

function requireCollected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
  const { stdout, stderr } = handle.collected
  if (stdout === undefined || stderr === undefined) throw new Error('dsh-ssh-workspace: subprocess dropped requested collected output')
  return { stdout, stderr }
}

function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const value = reader.readFrom(0)
  return {
    text: value.text,
    truncated: value.lossy,
    ...(value.spillPath === undefined ? {} : { spillPath: value.spillPath }),
  }
}

export default TransparentShellExecutor
