// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type {
  HistoryEntry,
  HostFrame,
  MuxFrame,
  PromptContentPart,
  RpcRequest,
  SessionSummary,
  ToolEventView,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { TuiBackendCommandRequest, TuiBackendHost } from '@deepseek-harness-tui/dsh-tui/backends'
import type {
  Channel,
  ChatRow,
  NotificationItem,
} from '@deepseek-harness-tui/dsh-tui/channel'
import type { ProviderSetupHost } from '@deepseek-harness-tui/dsh-tui/provider-setup'
import type { RemoteDshHostClient } from '../backend/client.ts'
import type { RemoteSshServer } from '../routing/manager.ts'
import RemoteDshHostControlClient, {
  RemoteHostOperationUnsupportedError,
  type HostDoctorResult,
  type HostMcpServer,
  type HostSessionModeSpec,
} from '../backend/control.ts'
import type {
  RemoteTuiChannelAttachment,
  RemoteTuiChannelFactory,
  RemoteTuiChannelFactoryRequest,
} from './backend-controller.ts'
import { remoteDisplayCwd, remoteServerIdentity } from './servers.ts'

type SessionEvent = HistoryEntry['event']
type SessionId = SessionSummary['sessionId']
type WorkspaceTarget = Awaited<ReturnType<Channel['listWorkspaces']>>[number]
type SessionRecord = Awaited<ReturnType<Channel['listSessions']>>[number]
type ToolRow = NonNullable<ChatRow['tool']>

interface StagedImage {
  mediaType: string
  data: string
  name?: string
}

/** Creates one Host-owned session Channel after the control plane selects a workspace. */
export class RemoteHostTuiChannelFactory implements RemoteTuiChannelFactory {
  async attach(request: RemoteTuiChannelFactoryRequest): Promise<RemoteTuiChannelAttachment> {
    const created = (await request.api.sessions.create({ workspaceId: request.workspace.workspaceId })).result
    if (!created.ok) throw new Error(created.error.message)
    const channel = new RemoteHostChannel(
      request.client,
      request.server,
      request.workspace,
      created.value.sessionId,
      request.host,
      created.value.agentPreset,
    )
    await channel.open()
    return {
      channel,
      handleCommand: request => channel.handleBackendCommand(request),
      dispose: () => channel.dispose(),
    }
  }
}

/** Host-protocol implementation of dsh-tui's public Channel contract. */
export class RemoteHostChannel implements Channel {
  version = 0
  rows: ChatRow[] = []
  status: 'idle' | 'running' | 'disposed' | 'starting' = 'starting'
  sessionTitle: string
  agentId: string
  model = ''
  provider = ''
  tokens = { input: 0, output: 0 }
  cwd: string
  displayCwd: string
  gitBranch: string | undefined
  working = false
  spinnerMode: Channel['spinnerMode'] = 'thinking'
  responseChars = 0
  activeToolCount = 0
  turnStart = 0
  lastUserText = ''
  notifications: NotificationItem[] = []
  contextWindow: number | undefined
  reasoningEffort: string | undefined
  lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
  tps: number | undefined
  tpsSamples: Array<{ tps: number; at: number }> = []
  workingActivity: Channel['workingActivity'] = undefined
  activityFrames: string | undefined
  activityEnabled: boolean
  contextBarEnabled: boolean
  goal: Channel['goal'] = undefined
  todos: Channel['todos'] = []
  loadedContext: Channel['loadedContext'] = undefined
  pending: Channel['pending'] = []
  contextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
  mode: HostSessionModeSpec = { id: 'default', label: 'Default' }
  modeIndex = 0
  hasOlder = false
  agentPreset: string | undefined

  private readonly listeners = new Set<() => void>()
  private readonly api: IApiClient
  private readonly control: RemoteDshHostControlClient
  private readonly abort = new AbortController()
  private readonly events: SessionEvent[] = []
  private readonly views = new Map<number, ToolEventView>()
  private readonly projections = new Map<string, { seq: number; value: unknown }>()
  private readonly approvalControllers = new Map<string, AbortController>()
  private readonly questionControllers = new Map<string, AbortController>()
  private readonly stagedImages = new Map<string, StagedImage>()
  private readonly sessionModes: readonly HostSessionModeSpec[]
  private remoteCommands: Channel['commandList'] = []
  private notificationSeq = 0
  private imageSeq = 0
  private streamStarted = false
  private muxTask: Promise<void> | undefined
  private hostTask: Promise<void> | undefined
  private syncing = false
  private historyLoading: Promise<number> | undefined
  private bufferedEvents: Array<{ event: SessionEvent; view?: ToolEventView }> = []
  private lastSeq = -1
  private workspace: WorkspaceView
  private sessionId: SessionId

  constructor(
    client: RemoteDshHostClient,
    private readonly server: RemoteSshServer,
    workspace: WorkspaceView,
    sessionId: SessionId,
    private readonly ui: TuiBackendHost,
    agentPreset?: string,
  ) {
    this.api = client.api
    this.control = new RemoteDshHostControlClient(client)
    this.workspace = workspace
    this.sessionId = sessionId
    this.agentId = String(sessionId)
    this.cwd = workspace.path
    this.displayCwd = remoteDisplayCwd(server, workspace.path)
    this.sessionTitle = posix.basename(workspace.path) || workspace.title
    this.agentPreset = agentPreset
    this.sessionModes = ui.sessionModes?.length > 0
      ? ui.sessionModes
      : [
          { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
          { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
          { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
        ]
    this.mode = this.sessionModes[0]!
    const local = ui.channel
    this.activityFrames = stringValue(local.activityFrames)
    this.activityEnabled = local.activityEnabled !== false
    this.contextBarEnabled = local.contextBarEnabled !== false
  }

  get commandList(): Channel['commandList'] {
    const commands = this.localUiCommands()
    const names = new Set(commands.map(command => command.name))
    const remote = this.remoteCommands.filter(command => !names.has(command.name))
    return [...commands, ...remote, DISCONNECT_COMMAND]
  }

  async open(): Promise<void> {
    await this.loadSession(this.sessionId)
    // Open streams after the first history baseline. session/subscribed
    // carries the post-open tail seq, so any gap between these two operations
    // is detected and repaired without racing two initial resyncs.
    this.startStreams()
    this.status = this.working ? 'running' : 'idle'
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  commandCompletions(input: string): ReturnType<Channel['commandCompletions']> {
    const localRoots = new Set(this.localUiCommands().map(command => command.name))
    const completions = (this.callLocalArray('commandCompletions', [input]) as ReturnType<Channel['commandCompletions']>)
      .filter(completion => localRoots.has(completion.name.split(' ', 1)[0] ?? '')
        && !isLocalOnlyCompletion(completion.commandLine))
    const body = input.startsWith('/') ? input.slice(1) : ''
    const remote = input.startsWith('/') && !/[\t ]/u.test(body)
      ? this.remoteCommands.flatMap(command => command.name.startsWith(body.toLowerCase())
          ? [{ ...command, replacement: `/${command.name} `, commandLine: `/${command.name}` }]
          : [])
      : []
    if (!input.startsWith('/') || !DISCONNECT_COMMAND.name.startsWith(input.slice(1).trim().toLowerCase())) {
      return [...completions, ...remote]
    }
    if (completions.some(completion => completion.commandLine === '/disconnect')) return completions
    return [...completions, ...remote, {
      ...DISCONNECT_COMMAND,
      replacement: '/disconnect ',
      commandLine: '/disconnect',
    }]
  }

  private localUiCommands(): Channel['commandList'] {
    return (arrayValue(this.ui.channel.commandList) as Channel['commandList'])
      .filter(command => command.external !== true && command.skill !== true && command.name !== DISCONNECT_COMMAND.name)
      .map(command => command.name === 'connect' ? { ...command, hidden: true } : command)
  }

  private async loadRemoteCommands(): Promise<void> {
    try {
      const catalog = await this.control.commandCatalog(String(this.sessionId), this.abort.signal)
      this.remoteCommands = catalog.commands.map(command => ({
        name: command.name,
        description: command.description,
        external: true,
      }))
    } catch (error) {
      if (!(error instanceof RemoteHostOperationUnsupportedError)) throw error
      this.remoteCommands = []
    }
  }

  async runExternalCommand(name: string, rawInput: string): Promise<string | undefined> {
    const line = `/${name}${rawInput.trim().length === 0 ? '' : ` ${rawInput.trim()}`}`
    const result = (await this.api.sessions.prompt({
      sessionId: this.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: line }],
    })).result
    if (!result.ok) {
      if (result.error.code === 'unknown-command') return undefined
      throw new Error(result.error.message)
    }
    return result.value.command?.text ?? ''
  }

  async sideQuestion(
    question: string,
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<{ answer: string | null; error?: string }> {
    const result = await this.control.btw(String(this.sessionId), question, options?.signal)
    if (result.answer !== null) options?.onText?.(result.answer)
    return result
  }

  handleBackendCommand(request: TuiBackendCommandRequest): boolean {
    if (request.name !== 'doctor' && request.name !== 'mcp' && request.name !== 'init') return false
    void this.runBackendCommand(request.name).catch(error => {
      this.notify(errorMessage(error), { color: 'error', timeoutMs: 8000 })
    })
    return true
  }

  async stageImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<string> {
    const token = `[Image #${String(++this.imageSeq)}]`
    this.stagedImages.set(token, {
      mediaType: input.mediaType,
      data: Buffer.from(input.data).toString('base64'),
      ...(input.name === undefined ? {} : { name: input.name }),
    })
    return token
  }

  submit(text: string): void {
    void this.send(text, 'queue')
  }

  steer(text: string): void {
    void this.send(text, 'steer')
  }

  removePending(id: string): boolean {
    const found = this.pending.some(item => item.id === id)
    if (found) void this.updateQueue(id, { kind: 'remove' })
    return found
  }

  cancel(): void {
    void this.api.sessions.cancel({ sessionId: this.sessionId }).then(response => {
      if (!response.result.ok) this.notify(response.result.error.message, { color: 'error' })
    }).catch(error => this.notify(errorMessage(error), { color: 'error' }))
  }

  interruptAndDeliver(texts: readonly string[]): number {
    if (texts.length === 0) return 0
    void this.api.sessions.cancel({ sessionId: this.sessionId }).then(async () => {
      for (const text of texts) await this.send(text, 'queue')
    }).catch(error => this.notify(errorMessage(error), { color: 'error' }))
    return texts.length
  }

  async rewindTo(row: ChatRow): Promise<string | null> {
    if (row.seq === undefined) return null
    const forked = (await this.api.sessions.fork({ sessionId: this.sessionId, atSeq: row.seq })).result
    if (!forked.ok) {
      this.notify(forked.error.message, { color: 'error' })
      return null
    }
    await this.loadSession(forked.value.sessionId)
    return row.text
  }

  async resumeTo(sessionId: string): Promise<boolean> {
    try {
      await this.loadSession(sessionId)
      return true
    } catch (error) {
      this.notify(errorMessage(error), { color: 'error' })
      return false
    }
  }

  async newSession(): Promise<boolean> {
    const created = (await this.api.sessions.create({ workspaceId: this.workspace.workspaceId })).result
    if (!created.ok) {
      this.notify(created.error.message, { color: 'error' })
      return false
    }
    this.agentPreset = created.value.agentPreset
    await this.loadSession(created.value.sessionId)
    return true
  }

  async listWorkspaces(): ReturnType<Channel['listWorkspaces']> {
    const result = (await this.api.workspace.list({})).result
    if (!result.ok) throw new Error(result.error.message)
    return result.value.items.map(workspace => workspaceTarget(workspace, this.server))
  }

  async resolveWorkspace(reference: string): ReturnType<Channel['resolveWorkspace']> {
    const result = (await this.api.workspace.list({})).result
    if (!result.ok) throw new Error(result.error.message)
    const workspace = result.value.items.find(item => item.workspaceId === reference || item.path === reference)
    return workspace === undefined ? undefined : workspaceTarget(workspace, this.server)
  }

  async switchWorkspace(target: Parameters<Channel['switchWorkspace']>[0]): Promise<boolean> {
    const path = recordString(target, 'cwd')
    if (path === undefined) return false
    const workspaceResult = (await this.api.workspace.create({ path })).result
    if (!workspaceResult.ok) {
      this.notify(workspaceResult.error.message, { color: 'error' })
      return false
    }
    this.workspace = workspaceResult.value.workspace
    this.cwd = this.workspace.path
    this.displayCwd = remoteDisplayCwd(this.server, this.workspace.path)
    return this.newSession()
  }

  async renameWorkspace(title: string): Promise<boolean> {
    const result = (await this.api.workspace.rename({ workspaceId: this.workspace.workspaceId, title })).result
    if (!result.ok) {
      this.notify(result.error.message, { color: 'error' })
      return false
    }
    this.workspace = result.value.workspace
    this.emit()
    return true
  }

  workspaceCommands(): ReturnType<Channel['workspaceCommands']> { return [] }
  async runWorkspaceCommand(): Promise<undefined> { return undefined }

  async switchModel(provider: string, model: string): Promise<boolean> {
    const result = (await this.api.sessions.selectModel({ sessionId: this.sessionId, provider, model })).result
    if (!result.ok) {
      this.notify(result.error.message, { color: 'error' })
      return false
    }
    this.provider = result.value.selected.provider
    this.model = result.value.selected.model
    this.reasoningEffort = result.value.selected.reasoningEffort
    this.emit()
    return true
  }

  async listEfforts(): ReturnType<Channel['listEfforts']> {
    const models = (await this.api.sessions.models({ sessionId: this.sessionId })).result
    if (!models.ok) return { efforts: [], defaultEffort: undefined }
    const current = models.value.current
    const model = models.value.groups.find(group => group.id === current.provider)?.models.find(item => item.id === current.model)
    return { efforts: model?.reasoning?.efforts ?? [], defaultEffort: model?.reasoning?.defaultEffort }
  }

  async setEffort(id: string): Promise<boolean> {
    const result = (await this.api.sessions.selectModel({
      sessionId: this.sessionId,
      provider: this.provider,
      model: this.model,
      reasoningEffort: id,
    })).result
    if (!result.ok) return false
    this.reasoningEffort = result.value.selected.reasoningEffort
    this.emit()
    return true
  }

  async cycleMode(): Promise<void> {
    const nextIndex = (this.modeIndex + 1) % this.sessionModes.length
    const next = this.sessionModes[nextIndex]!
    try {
      this.mode = await this.control.setSessionMode(String(this.sessionId), next, this.abort.signal)
      this.modeIndex = nextIndex
      this.emit()
    } catch (error) {
      this.notify(errorMessage(error), { color: 'error', timeoutMs: 8000 })
    }
  }

  async listPresets(): ReturnType<Channel['listPresets']> {
    const result = (await this.api.agentPresets.list({})).result
    if (!result.ok) return []
    return result.value.presets.map(item => ({
      id: item.id,
      ...(item.name === undefined ? {} : { name: item.name }),
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.broken === undefined ? {} : { broken: item.broken }),
      isDefault: item.isDefault,
    }))
  }

  async switchPreset(presetId: string): Promise<boolean> {
    const result = (await this.api.agentPresets.select({ sessionId: this.sessionId, agentPreset: presetId })).result
    if (!result.ok) {
      this.notify(result.error.message, { color: 'error' })
      return false
    }
    this.agentPreset = presetId
    this.emit()
    return true
  }

  clear(): void {
    this.rows = []
    this.emit()
  }

  loadOlder(): Promise<number> {
    if (!this.hasOlder) return Promise.resolve(0)
    this.historyLoading ??= this.loadOlderPage().finally(() => { this.historyLoading = undefined })
    return this.historyLoading
  }

  notify(text: string, options?: { color?: 'error' | 'warning' | 'success'; timeoutMs?: number }): void {
    const item: NotificationItem = {
      id: ++this.notificationSeq,
      text,
      timeoutMs: options?.timeoutMs ?? 4000,
      ...(options?.color === undefined ? {} : { color: options.color }),
    }
    this.notifications = [...this.notifications, item]
    this.emit()
    if (item.timeoutMs > 0) {
      setTimeout(() => {
        this.notifications = this.notifications.filter(candidate => candidate !== item)
        this.emit()
      }, item.timeoutMs).unref?.()
    }
  }

  setActivityFrames(name: string): boolean {
    this.activityFrames = name
    this.emit()
    return true
  }

  async listModels(): ReturnType<Channel['listModels']> {
    const result = (await this.api.sessions.models({ sessionId: this.sessionId })).result
    if (!result.ok) return []
    return result.value.groups.flatMap(group => group.models.map(model => ({
      provider: group.id,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
    })))
  }

  providerSetup(): ProviderSetupHost {
    return {
      listCatalogProviders: async () => {
        const result = (await this.api.llm.providers({})).result
        if (!result.ok) throw new Error(result.error.message)
        return result.value.providers
          .filter(provider => provider.settingsNs === 'llm-pi-ai' && provider.declared !== true)
          .map(provider => ({ provider: provider.provider, displayName: provider.displayName }))
      },
      routeExists: async (route) => {
        const namespace = await this.piAiSettings()
        const providers = isRecord(namespace.value) ? namespace.value['providers'] : undefined
        return isRecord(providers) && route in providers
      },
      discoverModels: async (request) => {
        const result = (await this.api.llm.discoverModels({ settingsNs: 'llm-pi-ai', ...request }, this.abort.signal)).result
        if (!result.ok) throw new Error(result.error.message)
        return result.value.models
      },
      envShadows: async (ref) => {
        const result = (await this.api.credentials.describe({ refs: [ref] }, this.abort.signal)).result
        if (!result.ok) throw new Error(result.error.message)
        return result.value.credentials[ref]?.source === 'env'
      },
      readCredential: async () => undefined,
      writeCredential: async (ref, value) => {
        const result = (await this.api.credentials.set({ ref, value }, this.abort.signal)).result
        if (!result.ok) throw new Error(result.error.message)
      },
      removeCredential: async (ref) => {
        const result = (await this.api.credentials.unset({ ref }, this.abort.signal)).result
        if (!result.ok) throw new Error(result.error.message)
      },
      writeProfile: async (route, profile) => {
        const namespace = await this.piAiSettings()
        const result = (await this.api.settings.mutate({
          ns: 'llm-pi-ai',
          ops: [{ op: 'set', path: ['providers', route], value: profile }],
          expectedRevision: namespace.revision,
        }, this.abort.signal)).result
        if (!result.ok) throw new Error(result.error.message)
      },
      commitProvider: request => this.control.setupProvider(request, this.abort.signal).then(() => undefined),
    }
  }

  async listFiles(): Promise<readonly string[]> {
    const result = (await this.api.host.listDirectory({ path: this.cwd }, this.abort.signal)).result
    if (!result.ok) return []
    return result.value.entries.map(entry => entry.name)
  }

  async listSessions(): ReturnType<Channel['listSessions']> {
    const result = (await this.api.sessions.list({})).result
    if (!result.ok) throw new Error(result.error.message)
    return result.value.items.map(sessionRecord)
  }

  setResumeTarget(): void {}

  renameSession(title: string): void {
    void this.renameSessionTo(this.sessionId, title)
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = (await this.api.workspace.archiveSession({ sessionId: sessionId as SessionId })).result
    return result.ok
  }

  async renameSessionTo(sessionId: string, title: string): Promise<boolean> {
    const result = (await this.api.sessions.rename({ sessionId: sessionId as SessionId, title })).result
    if (!result.ok) return false
    if (sessionId === this.sessionId) this.sessionTitle = result.value.title
    this.emit()
    return true
  }

  compact(): void {
    void this.runExternalCommand('compact', '').catch(error => this.notify(errorMessage(error), { color: 'error' }))
  }

  pushLocal(title: string, lines: readonly string[]): void {
    this.rows = [
      ...this.rows,
      { id: this.nextRowId(), kind: 'local', text: title },
      ...lines.map(text => ({ id: this.nextRowId(), kind: 'local-output' as const, text })),
    ]
    this.emit()
  }

  mcpStatus(): string[] { return ['Loading MCP status from the remote Host…'] }
  async exportSession(): Promise<string | null> {
    const client = this.control.host
    const archive = await client.downloadSessionLog(String(this.sessionId), true, this.abort.signal)
    const target = join(process.cwd(), `dsh-tui-export-${Date.now()}-${archive.fileName}`)
    await writeFile(target, archive.data, { flag: 'wx' })
    return target
  }
  initWorkspace(): null { return null }
  doctorInfo(): string[] { return ['Loading diagnostics from the remote Host…'] }

  async listSubagents(): Promise<string[]> {
    const result = (await this.api.subagents.list({ parentSessionId: this.sessionId })).result
    if (!result.ok) return []
    return result.value.entries.map(item => item.kind === 'diagnostic'
      ? `${String(item.id)} · ${item.reason}`
      : `${String(item.id)} · ${item.activity}`)
  }

  traceEvents(): readonly SessionEvent[] { return this.events }

  async dispose(): Promise<void> {
    if (this.status === 'disposed') return
    this.status = 'disposed'
    this.abort.abort(new Error('Remote TUI channel disposed'))
    await Promise.all([this.muxTask, this.hostTask].filter(task => task !== undefined).map(task => task!.catch(() => undefined)))
    this.emit()
  }

  private async loadOlderPage(): Promise<number> {
    while (this.syncing) {
      this.abort.signal.throwIfAborted()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (!this.hasOlder) return 0
    const targetSession = this.sessionId
    const boundary = this.events[0]?.seq
    if (boundary === undefined) {
      this.hasOlder = false
      this.emit()
      return 0
    }
    this.syncing = true
    try {
      const response = (await this.api.sessions.history({
        sessionId: targetSession,
        beforeSeq: boundary,
        maxMessages: 200,
      }, this.abort.signal)).result
      if (!response.ok) throw new Error(response.error.message)
      if (targetSession !== this.sessionId) return 0
      const known = new Set(this.events.map(event => event.seq))
      const entries = response.value.events.filter(entry => !known.has(entry.event.seq))
      for (const entry of entries) {
        this.events.push(entry.event)
        if (entry.view !== undefined) this.views.set(entry.event.seq, entry.view)
      }
      this.events.sort((left, right) => left.seq - right.seq)
      this.hasOlder = response.value.hasMore
      const beforeRows = this.rows.length
      this.rebuildTranscript()
      return Math.max(0, this.rows.length - beforeRows)
    } finally {
      this.syncing = false
      const buffered = this.bufferedEvents
      this.bufferedEvents = []
      for (const item of buffered.sort((left, right) => left.event.seq - right.event.seq)) {
        if (item.event.seq > this.lastSeq) this.acceptEvent(item.event, item.view)
      }
      this.emit()
    }
  }

  private rebuildTranscript(): void {
    // Rows produced only by this terminal (/doctor, !shell, etc.) have no
    // SessionEvent counterpart. Pagination rebuilds the durable transcript,
    // but must not erase those local diagnostics from the current screen.
    const localRows = this.rows.filter(row => row.kind === 'local' || row.kind === 'local-output')
    this.rows = []
    this.lastSeq = -1
    this.resetDerivedState()
    for (const event of this.events) {
      this.lastSeq = Math.max(this.lastSeq, event.seq)
      this.renderEvent(event, this.views.get(event.seq))
    }
    this.restoreLocalRows(localRows)
  }

  private startStreams(): void {
    if (this.streamStarted) return
    this.streamStarted = true
    this.muxTask = this.consumeMux()
    this.hostTask = this.consumeHost()
  }

  private async consumeMux(): Promise<void> {
    try {
      for await (const envelope of this.api.events.mux({}, this.abort.signal, () => { void this.resync() })) {
        await this.handleMux(envelope)
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.notify(`Remote event stream failed: ${errorMessage(error)}`, { color: 'error' })
    }
  }

  private async consumeHost(): Promise<void> {
    try {
      for await (const envelope of this.api.events.host({}, this.abort.signal)) this.handleHost(envelope.payload)
    } catch (error) {
      if (!this.abort.signal.aborted) this.notify(`Remote Host stream failed: ${errorMessage(error)}`, { color: 'error' })
    }
  }

  private async handleMux(envelope: RpcRequest<MuxFrame>): Promise<void> {
    const frame = envelope.payload
    if ('sessionId' in frame && String(frame.sessionId) !== this.sessionId) return
    switch (frame.type) {
      case 'session/event':
        if (this.syncing) this.bufferedEvents.push({ event: frame.event, ...(frame.view === undefined ? {} : { view: frame.view }) })
        else this.acceptEvent(frame.event, frame.view)
        return
      case 'session/subscribed':
        if (frame.lastSeq > this.lastSeq) void this.resync()
        return
      case 'session/queue':
        this.pending = frame.items.flatMap(item => {
          const text = textFromUnknown(item.message)
          return text.length === 0 ? [] : [{ id: String(item.id), text, placement: item.placement === 'steering' ? 'steer' as const : 'followup' as const }]
        })
        this.emit()
        return
      case 'approval/requested':
        void this.answerApproval(envelope.rpcId, frame)
        return
      case 'approval/resolved':
        this.approvalControllers.get(String(frame.approvalId))?.abort(new Error('Approval resolved by another client'))
        this.approvalControllers.delete(String(frame.approvalId))
        return
      case 'question/requested':
        void this.answerQuestion(envelope.rpcId, frame)
        return
      case 'question/resolved':
        this.questionControllers.get(String(frame.questionRpcId))?.abort(new Error('Question resolved by another client'))
        this.questionControllers.delete(String(frame.questionRpcId))
        return
      case 'session/projection':
        this.applyProjection(frame.key, frame.value, frame.seq)
        return
      case 'stream/error':
        this.notify(frame.error.message, { color: 'error' })
        return
      default:
        return
    }
  }

  private handleHost(frame: HostFrame): void {
    if ('sessionId' in frame && String(frame.sessionId) !== this.sessionId) return
    if (frame.type === 'host/session-status') {
      this.working = frame.running
      this.status = frame.running ? 'running' : 'idle'
      this.emit()
    } else if (frame.type === 'host/agent-error') {
      this.notify(frame.message, { color: 'error' })
    }
  }

  private async loadSession(sessionId: string | SessionId): Promise<void> {
    this.cancelInteractionRequests('Remote session changed')
    this.sessionId = sessionId as SessionId
    this.agentId = String(sessionId)
    this.hasOlder = false
    await this.resync(true)
    const models = (await this.api.sessions.models({ sessionId: this.sessionId })).result
    if (models.ok) {
      this.provider = models.value.current.provider
      this.model = models.value.current.model
      this.reasoningEffort = models.value.current.reasoningEffort
    }
    const listed = (await this.api.sessions.list({})).result
    if (listed.ok) {
      const summary = listed.value.items.find(item => String(item.sessionId) === sessionId)
      if (summary !== undefined) {
        this.working = summary.running
        this.status = summary.running ? 'running' : 'idle'
        this.agentPreset = summary.agentPreset
        this.sessionTitle = sessionTitle(summary)
      }
    }
    await this.loadRemoteCommands()
    this.emit()
  }

  private async resync(force = false): Promise<void> {
    if (this.syncing && !force) return
    this.syncing = true
    const targetSession = this.sessionId
    try {
      const result = (await this.api.sessions.history({ sessionId: targetSession, maxMessages: 200 }, this.abort.signal)).result
      if (!result.ok) throw new Error(result.error.message)
      if (targetSession !== this.sessionId) return
      // A shell/backend command may finish while the reconnect history call
      // is in flight. Those terminal-only rows are not SessionEvents, so keep
      // them across the authoritative replay instead of flashing and vanishing.
      const localRows = this.rows.filter(row => row.kind === 'local' || row.kind === 'local-output')
      this.events.splice(0, this.events.length)
      this.views.clear()
      this.projections.clear()
      this.rows = []
      this.lastSeq = -1
      this.resetDerivedState()
      for (const entry of result.value.events) this.acceptHistoryEntry(entry)
      this.restoreLocalRows(localRows)
      this.hasOlder = result.value.hasMore
      const baseline = result.value.projections
      if (baseline !== undefined) {
        for (const [key, value] of Object.entries(baseline.values)) {
          this.applyProjection(key, value, baseline.asOfSeq)
        }
      }
      const buffered = this.bufferedEvents
      this.bufferedEvents = []
      for (const item of buffered.sort((left, right) => left.event.seq - right.event.seq)) {
        if (item.event.seq > this.lastSeq) this.acceptEvent(item.event, item.view)
      }
    } finally {
      this.syncing = false
      this.emit()
    }
  }

  private acceptHistoryEntry(entry: HistoryEntry): void {
    this.acceptEvent(entry.event, entry.view)
  }

  private acceptEvent(event: SessionEvent, view?: ToolEventView): void {
    if (event.seq <= this.lastSeq) return
    if (event.seq > this.lastSeq + 1 && this.lastSeq >= 0) {
      this.bufferedEvents.push({ event, ...(view === undefined ? {} : { view }) })
      void this.resync()
      return
    }
    this.lastSeq = event.seq
    this.events.push(event)
    if (view !== undefined) this.views.set(event.seq, view)
    this.renderEvent(event, view)
    this.emit()
  }

  private renderEvent(event: SessionEvent, view?: ToolEventView): void {
    switch (event.type) {
      case 'turn/start':
        this.working = true
        this.status = 'running'
        this.turnStart = event.time
        this.responseChars = 0
        return
      case 'turn/end':
        this.working = false
        this.status = 'idle'
        this.activeToolCount = 0
        for (const row of this.rows) if (row.streaming) row.streaming = false
        return
      case 'user/message': {
        // Match dsh-tui's native Channel projection: runtime-context, skill,
        // goal, and other plugin injections use the user role for the model,
        // but they are not human chat bubbles.
        if (event.data.source.kind !== 'user') return
        const text = textFromUnknown(event.data.content)
        if (text.length === 0) return
        this.lastUserText = text
        this.rows.push({
          id: this.nextRowId(), kind: 'user', text, seq: event.seq, time: event.time,
        })
        return
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk as unknown
        const text = recordString(chunk, 'text') ?? ''
        if (text.length === 0) return
        const kind = recordString(chunk, 'type')?.includes('reasoning') === true ? 'reasoning' : 'assistant'
        let row = this.rows.findLast(candidate => candidate.streaming === true && candidate.kind === kind)
        if (row === undefined) {
          row = { id: this.nextRowId(), kind, text: '', streaming: true, seq: event.seq, time: event.time }
          this.rows.push(row)
        }
        row.text += text
        this.responseChars += text.length
        return
      }
      case 'assistant/message': {
        const text = textFromUnknown(event.data.message.content)
        let row = this.rows.findLast(candidate => candidate.streaming === true && candidate.kind === 'assistant')
        if (row === undefined && text.length > 0) {
          row = { id: this.nextRowId(), kind: 'assistant', text, seq: event.seq, time: event.time }
          this.rows.push(row)
        } else if (row !== undefined) {
          row.text = text || row.text
          row.streaming = false
          row.seq = event.seq
        }
        const usage = event.data.usage
        if (usage !== undefined) {
          const input = usage.inputTokens ?? 0
          const output = usage.outputTokens ?? 0
          this.tokens = { input: this.tokens.input + input, output: this.tokens.output + output }
          this.lastUsage = {
            input,
            output,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
        }
        return
      }
      case 'tool/call': {
        const callView = view?.for === 'call' ? toolCallView(view.view) : undefined
        this.rows.push({
          id: this.nextRowId(), kind: 'tool', text: event.data.name, seq: event.seq, time: event.time,
          tool: {
            callId: String(event.data.callId),
            name: event.data.name,
            argsText: event.data.arguments,
            argsFull: event.data.arguments,
            status: 'running',
            ...(callView === undefined ? {} : { callView }),
            startedAt: event.time,
          },
        })
        this.activeToolCount += 1
        return
      }
      case 'tool/result': {
        const callId = toolResultCallId(event.data.message)
        const row = this.rows.findLast(candidate => candidate.tool !== undefined && (callId === undefined || candidate.tool.callId === callId))
        if (row?.tool === undefined) return
        const resultText = textFromUnknown(event.data.message)
        row.tool.status = event.data.error === undefined ? 'ok' : 'error'
        row.tool.resultText = resultText
        row.tool.resultFull = resultText
        row.tool.durationMs = Math.max(0, event.time - row.tool.startedAt)
        if (event.data.error !== undefined) row.tool.errorText = `${event.data.error.name}: ${event.data.error.code}`
        const resultView = view?.for === 'result' ? toolResultView(view.view) : undefined
        if (resultView !== undefined) row.tool.resultView = resultView
        this.activeToolCount = Math.max(0, this.activeToolCount - 1)
        return
      }
      case 'request/header':
        this.provider = event.data.header.config.provider
        this.model = event.data.header.config.model
        this.reasoningEffort = event.data.header.config.reasoningEffort
        return
      case 'request/context':
        this.provider = event.data.provider
        this.model = event.data.model
        this.contextWindow = event.data.contextWindow
        return
      default:
        return
    }
  }

  private async send(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim()
      if (command.length === 0) return
      try {
        const result = await this.control.runShell(command, this.cwd, undefined, this.abort.signal)
        const lines = [
          ...splitOutput(result.stdout),
          ...splitOutput(result.stderr),
          ...(result.exitCode === 0 && !result.timedOut
            ? []
            : [`Process exited with ${result.timedOut ? 'a timeout' : `code ${String(result.exitCode)}`}.`]),
          ...(result.truncated ? ['Output was truncated by the remote Host.'] : []),
        ]
        this.pushLocal(`!${command}`, lines.length === 0 ? ['(no output)'] : lines)
      } catch (error) {
        this.notify(errorMessage(error), { color: 'error' })
      }
      return
    }
    const content: PromptContentPart[] = [{ type: 'text', text }]
    for (const [token, image] of this.stagedImages) {
      if (!text.includes(token)) continue
      content.push({ type: 'image', mediaType: image.mediaType as never, data: image.data, ...(image.name === undefined ? {} : { name: image.name }) })
    }
    const result = (await this.api.sessions.prompt({ sessionId: this.sessionId, mode, content })).result
    if (!result.ok) this.notify(result.error.message, { color: 'error' })
    else this.stagedImages.clear()
  }

  private async runBackendCommand(name: 'doctor' | 'mcp' | 'init'): Promise<void> {
    if (name === 'doctor') {
      const result = await this.control.doctor(String(this.sessionId), this.cwd, this.abort.signal)
      this.pushLocal('/doctor', formatDoctorInfo(result, this.provider, this.model, this.contextWindow, this.sessionTitle))
      return
    }
    if (name === 'mcp') {
      const result = await this.control.mcp(String(this.sessionId), this.abort.signal)
      this.pushLocal('/mcp', formatMcpStatus(result.servers))
      return
    }
    const result = await this.control.init(this.cwd, defaultAgentsFile(), this.abort.signal)
    this.notify(
      result.status === 'exists'
        ? 'AGENTS.md already exists on the remote Host; it was not overwritten.'
        : `Created ${result.path} on the remote Host.`,
      { color: result.status === 'created' ? 'success' : 'warning', timeoutMs: 6000 },
    )
  }

  private async piAiSettings(): Promise<{ value: unknown; revision: number }> {
    const result = (await this.api.settings.describe({}, this.abort.signal)).result
    if (!result.ok) throw new Error(result.error.message)
    if (!result.value.writable) throw new Error('the remote Host settings provider is read-only')
    const namespace = result.value.namespaces.find(candidate => candidate.ns === 'llm-pi-ai')
    if (namespace === undefined) throw new Error('the remote Host has no llm-pi-ai settings namespace')
    return { value: namespace.value, revision: namespace.revision }
  }

  private async updateQueue(id: string, action: { kind: 'remove' }): Promise<void> {
    const result = (await this.api.sessions.updateQueue({ sessionId: this.sessionId, itemId: id as never, action })).result
    if (!result.ok) this.notify(result.error.message, { color: 'error' })
  }

  private async answerApproval(rpcId: string, frame: Extract<MuxFrame, { type: 'approval/requested' }>): Promise<void> {
    const controller = new AbortController()
    const approvalId = String(frame.approvalId)
    this.approvalControllers.get(approvalId)?.abort(new Error('Approval request replaced'))
    this.approvalControllers.set(approvalId, controller)
    const abort = (): void => controller.abort(this.abort.signal.reason)
    this.abort.signal.addEventListener('abort', abort, { once: true })
    try {
      const outcome = await this.ui.requestApproval({
        events: this.events,
        toolName: frame.toolName,
        ...(frame.callId === undefined ? {} : { callId: frame.callId }),
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
        signal: controller.signal,
      })
      if (outcome !== 'allowed-once' && outcome !== 'rejected') return
      await this.api.respond({
        type: 'client-response', rpcId: rpcId as never,
        result: { ok: true, value: { sessionId: this.sessionId, approvalId: frame.approvalId, outcome } },
      })
    } catch (error) {
      if (!this.abort.signal.aborted && !controller.signal.aborted) this.notify(errorMessage(error), { color: 'error' })
    } finally {
      this.abort.signal.removeEventListener('abort', abort)
      if (this.approvalControllers.get(approvalId) === controller) this.approvalControllers.delete(approvalId)
    }
  }

  private async answerQuestion(rpcId: string, frame: Extract<MuxFrame, { type: 'question/requested' }>): Promise<void> {
    const controller = new AbortController()
    const requestId = String(rpcId)
    this.questionControllers.get(requestId)?.abort(new Error('Question request replaced'))
    this.questionControllers.set(requestId, controller)
    const abort = (): void => controller.abort(this.abort.signal.reason)
    this.abort.signal.addEventListener('abort', abort, { once: true })
    try {
      const answer = await this.ui.askQuestions({ questions: frame.questions, signal: controller.signal })
      await this.api.respond({
        type: 'client-response', rpcId: rpcId as never,
        result: { ok: true, value: { sessionId: this.sessionId, answer } },
      })
    } catch (error) {
      if (!this.abort.signal.aborted && !controller.signal.aborted) this.notify(errorMessage(error), { color: 'error' })
    } finally {
      this.abort.signal.removeEventListener('abort', abort)
      if (this.questionControllers.get(requestId) === controller) this.questionControllers.delete(requestId)
    }
  }

  private applyProjection(key: string, value: unknown, seq: number): void {
    const current = this.projections.get(key)
    if (current !== undefined && current.seq >= seq) return
    this.projections.set(key, { seq, value })
    if (key === 'title' && typeof value === 'string') this.sessionTitle = value
    else if (key === 'goal') this.goal = channelGoal(value)
    else if (key === 'todos') this.todos = todoItems(value)
    else if (key === 'loadedContext') this.loadedContext = loadedContext(value)
    else if (key === 'plan' || key === 'permissions') this.refreshModeFromProjections()
    this.emit()
  }

  private refreshModeFromProjections(): void {
    const planValue = this.projections.get('plan')?.value
    const permissionValue = this.projections.get('permissions')?.value
    const plan = recordBoolean(planValue, 'active') ?? false
    const permission = recordString(permissionValue, 'currentValue')
    const index = this.sessionModes.findIndex(spec => {
      if (spec.plan !== undefined && spec.plan !== plan) return false
      if (spec.sandbox === undefined && spec.approval === undefined) return true
      return permission === spec.id || permission === spec.sandbox
    })
    this.modeIndex = index < 0 ? 0 : index
    this.mode = this.sessionModes[this.modeIndex]!
  }

  private cancelInteractionRequests(reason: string): void {
    for (const controller of this.approvalControllers.values()) controller.abort(new Error(reason))
    for (const controller of this.questionControllers.values()) controller.abort(new Error(reason))
    this.approvalControllers.clear()
    this.questionControllers.clear()
  }

  private resetDerivedState(): void {
    this.tokens = { input: 0, output: 0 }
    this.lastUsage = undefined
    this.responseChars = 0
    this.activeToolCount = 0
    this.lastUserText = ''
    this.working = false
  }

  private nextRowId(): number {
    const last = this.rows.at(-1)?.id ?? -1
    return last + 1
  }

  private restoreLocalRows(rows: readonly ChatRow[]): void {
    for (const row of rows) this.rows.push({ ...row, id: this.nextRowId() })
  }

  private emit(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  private callLocalArray(method: string, args: unknown[]): readonly unknown[] {
    const member = Reflect.get(this.ui.channel, method, this.ui.channel)
    if (typeof member !== 'function') return []
    const value = Reflect.apply(member, this.ui.channel, args) as unknown
    return Array.isArray(value) ? value : []
  }
}

const DISCONNECT_COMMAND = {
  name: 'disconnect',
  description: 'Disconnect from the remote machine',
  descriptions: { zh: '断开远程主机连接' },
} as const

function isLocalOnlyCompletion(commandLine: string): boolean {
  return commandLine === '/connect'
    || /^\/workspace[\t ]+(?:connect|remote)(?:$|[\t ])/iu.test(commandLine)
}

function workspaceTarget(workspace: WorkspaceView, server: RemoteSshServer): WorkspaceTarget {
  return {
    uri: `dsh-host-workspace://${encodeURIComponent(String(workspace.workspaceId))}`,
    cwd: workspace.path,
    label: workspace.title,
    description: workspace.path,
    kind: 'provider',
    badge: remoteServerIdentity(server),
  }
}

function sessionRecord(summary: SessionSummary): SessionRecord {
  return {
    id: String(summary.sessionId),
    title: sessionTitle(summary),
    cwd: summary.cwd ?? '',
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
  }
}

function sessionTitle(summary: SessionSummary): string {
  const title = (summary.projections?.values as Record<string, unknown> | undefined)?.title
  if (typeof title === 'string' && title.trim().length > 0) return title
  return summary.cwd === undefined ? String(summary.sessionId) : posix.basename(summary.cwd) || summary.cwd
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join('\n')
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content
  if (record.content !== undefined) return textFromUnknown(record.content)
  if (record.message !== undefined) return textFromUnknown(record.message)
  return ''
}

/** Narrow Host presentation payloads to the stable subset dsh-tui renders. */
function toolCallView(value: unknown): ToolRow['callView'] {
  if (!isRecord(value) || typeof value['card'] !== 'string' || typeof value['title'] !== 'string') return undefined
  if (value['card'] === 'generic' || value['card'] === 'terminal') return value as ToolRow['callView']
  if (value['card'] === 'diff' && Array.isArray(value['diffs'])) return value as ToolRow['callView']
  return undefined
}

/** Unknown/new Host card shapes intentionally fall back to raw result text. */
function toolResultView(value: unknown): ToolRow['resultView'] {
  if (!isRecord(value) || typeof value['card'] !== 'string') return undefined
  if (value['card'] === 'generic' || value['card'] === 'terminal') return value as ToolRow['resultView']
  if (value['card'] === 'diff' && Array.isArray(value['diffs'])) return value as ToolRow['resultView']
  if (value['card'] === 'read') return value as ToolRow['resultView']
  if (value['card'] !== 'search') return undefined
  if (value['shape'] === 'matches' && Array.isArray(value['files'])
    && typeof value['truncated'] === 'boolean' && typeof value['total'] === 'number') {
    return value as ToolRow['resultView']
  }
  if (value['shape'] === 'paths' && Array.isArray(value['paths'])
    && typeof value['truncated'] === 'boolean' && typeof value['total'] === 'number') {
    return value as ToolRow['resultView']
  }
  return undefined
}

function channelGoal(value: unknown): Channel['goal'] {
  if (!isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['revision'] !== 'number'
    || typeof value['objective'] !== 'string'
    || !['active', 'paused', 'blocked', 'complete'].includes(String(value['phase']))
    || typeof value['maxGoalRounds'] !== 'number'
    || typeof value['roundsStarted'] !== 'number') return undefined
  return value as unknown as NonNullable<Channel['goal']>
}

function todoItems(value: unknown): Channel['todos'] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Channel['todos'][number] => isRecord(item)
    && typeof item['content'] === 'string'
    && ['pending', 'in_progress', 'completed'].includes(String(item['status'])))
}

function loadedContext(value: unknown): Channel['loadedContext'] {
  if (!isRecord(value)) return undefined
  if (!['sections', 'contexts', 'files', 'skills', 'tools'].every(key => Array.isArray(value[key]))) return undefined
  return value as unknown as NonNullable<Channel['loadedContext']>
}

function recordString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function recordBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'boolean' ? candidate : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultCallId(message: unknown): string | undefined {
  const direct = recordString(message, 'callId') ?? recordString(message, 'toolCallId')
  if (direct !== undefined) return direct
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const id = recordString(block, 'toolCallId') ?? recordString(block, 'callId')
    if (id !== undefined) return id
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function formatMcpStatus(servers: readonly HostMcpServer[]): string[] {
  if (servers.length === 0) return ['No MCP servers are mounted on the remote Host.']
  return servers.map(server => `${server.name} (${String(server.tools.length)} tools): ${server.tools.join(', ')}`)
}

function formatDoctorInfo(
  result: HostDoctorResult,
  provider: string,
  model: string,
  contextWindow: number | undefined,
  sessionTitle: string,
): string[] {
  return [
    `Node ${result.node} · ${result.platform} ${result.arch}`,
    `API key: ${result.apiKeyConfigured ? 'configured' : 'not configured'}`,
    `Model: ${model || '(unknown)'} · Provider: ${provider || '(unknown)'}`,
    `Working directory: ${result.cwd}`,
    `Context window: ${contextWindow === undefined ? 'unknown' : `${String(contextWindow)} tokens`}`,
    `Session: ${result.sessionId ?? '(unknown)'}${sessionTitle.length === 0 ? '' : ` · ${sessionTitle}`}`,
    `Session attached: ${result.sessionAttached ? 'yes' : 'no'}`,
    `Remote home: ${result.home}`,
  ]
}

function splitOutput(value: string): string[] {
  const normalized = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  return normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n').filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    : normalized.length === 0 ? [] : normalized.split('\n')
}

function defaultAgentsFile(): string {
  return [
    '# AGENTS.md',
    '',
    '## Project',
    '',
    'Document the project structure, build commands, and important entry points here.',
    '',
    '## Conventions',
    '',
    '- Read relevant files before editing them.',
    '- Follow the project\'s existing style and verify changes with its checks.',
    '',
  ].join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
