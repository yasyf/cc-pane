// The dashboard shell: a header/body/footer frame, a 2s fleet poll, a central key router,
// and the fleet⇄agent view switch. Failed polls become a displayed header state, never a throw.

import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  dim,
  fg,
  stringToStyledText,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core"

import { AgentView } from "./views/agent.ts"
import { FleetView } from "./views/fleet.ts"
import { ConfirmModal } from "./components/confirm.ts"
import { PromptRenderable } from "./components/prompt.ts"
import { NotesUnavailableError } from "./data/ccnotes.ts"
import { DaemonUnreachableError } from "./data/cco.ts"
import { Poller, systemClock, type PollerClock } from "./data/poller.ts"
import { formatAge } from "./format.ts"
import {
  agentRepoChain,
  type AgentRepoChain,
  type AgentView as ModelAgentView,
  type Capture,
  type FleetStatus,
  type KillResult,
  type MessageReceipt,
  type NotesGraph,
  type RespawnResult,
} from "./model.ts"
import { AGENT_STATE_COLORS, AGENT_STATE_GLYPHS, BADGE_STATE_ORDER } from "./theme.ts"

const OK_COLOR = "#3fb950"
const ALERT_COLOR = "#f85149"
const FLASH_COLOR = "#d29922"
const FLEET_FOOTER = "enter drill · tab pane · j/k move · x kill · m msg · r respawn · t attach · q quit"
const AGENT_FOOTER = "esc back · s snap · a filter · j/k scroll · x kill · m msg · r respawn · t attach · q quit"

export type View = { readonly view: "fleet" } | { readonly view: "agent"; readonly agentId: string }

// Runs `cco agent attach <id>` with the real TTY; the exit code + stderr drive the flash.
export type AttachFn = (agentId: string) => Promise<{ readonly code: number; readonly stderr: string }>

// Structural sources so tests inject fakes; CcoClient and VizPool are assignable as-is.
export interface FleetSource {
  fleetStatus(): Promise<FleetStatus>
  capture(agentId: string): Promise<Capture>
  kill(agentId: string): Promise<KillResult>
  sendMessage(agentId: string, text: string): Promise<MessageReceipt>
  respawn(agentId: string): Promise<RespawnResult>
}
export interface GraphServer {
  graph(): Promise<NotesGraph>
}
export interface GraphSource {
  serverFor(repoPath: string): Promise<GraphServer>
  stopAll(): Promise<void>
}

export interface AppDeps {
  readonly cco: FleetSource
  readonly viz: GraphSource
  readonly attach: AttachFn
  readonly pollIntervalMs: number
  readonly timeZone: string
  readonly onQuit: () => void
  readonly clock?: PollerClock
}

// An orthogonal overlay over the live view: it never bumps viewEpoch, so closing restores
// the selection/scroll beneath it. `attach` swallows all keys and guards re-entry.
type Overlay =
  | { readonly kind: "none" }
  | { readonly kind: "confirm"; readonly action: "kill" | "respawn"; readonly agent: ModelAgentView; readonly modal: ConfirmModal }
  | { readonly kind: "prompt"; readonly agent: ModelAgentView; readonly prompt: PromptRenderable }
  | { readonly kind: "attach" }

export interface AppHandle {
  refreshFleet(): Promise<void>
  route(keyName: string): void
  currentView(): View
  dispose(): void
}

type FleetOutcome = { readonly ok: true; readonly fleet: FleetStatus } | { readonly ok: false; readonly error: Error }
type StampedFleetOutcome = { readonly id: number; readonly outcome: FleetOutcome }
type NotesOutcome = { readonly ok: true; readonly graph: NotesGraph } | { readonly ok: false; readonly error: Error }
type DaemonState =
  | { readonly kind: "pending" }
  | { readonly kind: "ok" }
  | { readonly kind: "unreachable"; readonly error: Error }
  | { readonly kind: "bad-response"; readonly message: string }

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

class App {
  private readonly header: TextRenderable
  private readonly body: BoxRenderable
  private readonly footer: TextRenderable
  private readonly fleetView: FleetView
  private readonly fleetPoller: Poller<StampedFleetOutcome>
  private readonly clock: PollerClock
  private readonly onKeypress: (event: KeyEvent) => void

  private state: View = { view: "fleet" }
  private overlay: Overlay = { kind: "none" }
  private flash: string | null = null
  private lastFleet: FleetStatus | null = null
  private lastSuccessAt: number | null = null
  private daemon: DaemonState = { kind: "pending" }
  private agentView: AgentView | null = null
  private agentChain: AgentRepoChain | null = null
  private timelinePoller: Poller<NotesOutcome> | null = null
  private viewEpoch = 0
  private fleetSeq = 0
  private lastAppliedFleetSeq = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly deps: AppDeps,
  ) {
    this.clock = deps.clock ?? systemClock
    this.header = new TextRenderable(renderer, { id: "app-header", content: "", height: 1 })
    this.body = new BoxRenderable(renderer, { id: "app-body", flexGrow: 1 })
    this.footer = new TextRenderable(renderer, { id: "app-footer", content: "", height: 1 })
    this.fleetView = new FleetView(renderer, { id: "fleet-view", onDrillIn: (id) => this.openAgent(id) })
    this.body.add(this.fleetView)
    const frame = new BoxRenderable(renderer, { id: "app-frame", flexGrow: 1, flexDirection: "column" })
    frame.add(this.header)
    frame.add(this.body)
    frame.add(this.footer)
    renderer.root.add(frame)

    this.fleetPoller = new Poller<StampedFleetOutcome>({
      producer: () => this.pollFleet(),
      intervalMs: deps.pollIntervalMs,
      onResult: (stamped) => this.applyFleetOutcome(stamped),
      clock: this.clock,
    })
    this.fleetPoller.start()

    this.onKeypress = (event) => {
      if (event.ctrl && event.name === "c") return this.deps.onQuit()
      if (event.ctrl || event.meta || event.option) return
      // A key that opens the prompt focuses its input mid-dispatch; veto so keyInput's
      // renderable phase doesn't deliver that same key into the freshly-focused input.
      const wasPrompt = this.overlay.kind === "prompt"
      this.route(event.name)
      if (!wasPrompt && this.overlay.kind === "prompt") event.preventDefault()
    }
    renderer.keyInput.on("keypress", this.onKeypress)

    this.renderHeader()
    this.renderFooter()
  }

  currentView(): View {
    return this.state
  }

  async refreshFleet(): Promise<void> {
    this.applyFleetOutcome(await this.pollFleet())
  }

  route(keyName: string): void {
    if (this.flash !== null) {
      this.flash = null
      this.renderFooter()
      this.renderer.requestRender()
    }
    const overlay = this.overlay
    switch (overlay.kind) {
      case "confirm":
        return this.routeConfirm(overlay, keyName)
      case "prompt":
        return this.routePrompt(keyName)
      case "attach":
        return
      case "none":
        break
    }
    if (keyName === "q") {
      this.deps.onQuit()
      return
    }
    if (this.state.view === "agent") {
      this.routeAgent(keyName)
      return
    }
    this.routeFleet(keyName)
  }

  dispose(): void {
    this.fleetPoller.stop()
    this.timelinePoller?.stop()
    this.renderer.keyInput.off("keypress", this.onKeypress)
  }

  private routeFleet(keyName: string): void {
    switch (keyName) {
      case "tab":
        return this.fleetView.switchPane()
      case "j":
      case "down":
        return this.fleetView.moveSelection(1)
      case "k":
      case "up":
        return this.fleetView.moveSelection(-1)
      case "return":
        return this.fleetView.activate()
      case "x":
        return this.tryKill()
      case "m":
        return this.tryMessage()
      case "r":
        return this.tryRespawn()
      case "t":
        return this.tryAttach()
    }
  }

  private routeAgent(keyName: string): void {
    switch (keyName) {
      case "escape":
        return this.backToFleet()
      case "s":
        return void this.refreshCapture()
      case "a":
        return this.agentView?.toggleFilter()
      case "j":
      case "down":
        return this.agentView?.moveSelection(1)
      case "k":
      case "up":
        return this.agentView?.moveSelection(-1)
      case "x":
        return this.tryKill()
      case "m":
        return this.tryMessage()
      case "r":
        return this.tryRespawn()
      case "t":
        return this.tryAttach()
    }
  }

  // Confirm: y/return confirm, n/escape cancel, else swallowed.
  private routeConfirm(overlay: Extract<Overlay, { kind: "confirm" }>, keyName: string): void {
    if (keyName === "y" || keyName === "return") {
      this.closeOverlay()
      void this.runAction(overlay.action, overlay.agent)
      return
    }
    if (keyName === "n" || keyName === "escape") this.closeOverlay()
  }

  // Escape only; typed chars and Enter fall through to the focused input (return would double-fire).
  private routePrompt(keyName: string): void {
    if (keyName === "escape") this.closeOverlay()
  }

  // The drilled-in agent, else the selected fleet-tree row, resolved against lastFleet.
  private actionTarget(): ModelAgentView | null {
    const id = this.state.view === "agent" ? this.state.agentId : this.fleetView.selectedAgentId()
    if (id === undefined || this.lastFleet === null) return null
    return this.lastFleet.agents.find((a) => a.id === id) ?? null
  }

  private tryKill(): void {
    const agent = this.actionTarget()
    if (agent === null) return this.setFlash("no agent selected")
    if (agent.status !== "active") return this.setFlash("kill: agent not active")
    this.openConfirm("kill", agent)
  }

  private tryMessage(): void {
    const agent = this.actionTarget()
    if (agent === null) return this.setFlash("no agent selected")
    if (agent.status !== "active") return this.setFlash("message: agent not active")
    this.openPrompt(agent)
  }

  private tryRespawn(): void {
    const agent = this.actionTarget()
    if (agent === null) return this.setFlash("no agent selected")
    if (agent.status !== "exited") return this.setFlash("respawn: agent not exited")
    this.openConfirm("respawn", agent)
  }

  private tryAttach(): void {
    const agent = this.actionTarget()
    if (agent === null) return this.setFlash("no agent selected")
    if (agent.status !== "active") return this.setFlash("attach: agent not active")
    if (agent.backend !== "tmux" && agent.backend !== "zellij") return this.setFlash("attach: agent not attachable")
    void this.runAttach(agent)
  }

  private openConfirm(action: "kill" | "respawn", agent: ModelAgentView): void {
    const modal = new ConfirmModal(this.renderer, {
      id: "confirm-overlay",
      title: `${action} agent`,
      message: `${action} ${agent.name}?`,
    })
    this.renderer.root.add(modal)
    this.overlay = { kind: "confirm", action, agent, modal }
    this.renderer.requestRender()
  }

  private openPrompt(agent: ModelAgentView): void {
    const prompt = new PromptRenderable(this.renderer, {
      id: "prompt-overlay",
      title: `message ${agent.name}`,
      onSubmit: (value) => this.submitMessage(agent, value),
    })
    this.renderer.root.add(prompt)
    prompt.open()
    this.overlay = { kind: "prompt", agent, prompt }
    this.renderer.requestRender()
  }

  private submitMessage(agent: ModelAgentView, text: string): void {
    this.closeOverlay()
    if (text === "") return
    void this.runMessage(agent, text)
  }

  private closeOverlay(): void {
    const overlay = this.overlay
    if (overlay.kind === "confirm") {
      this.renderer.root.remove(overlay.modal)
      overlay.modal.destroy()
    } else if (overlay.kind === "prompt") {
      overlay.prompt.close()
      this.renderer.root.remove(overlay.prompt)
      overlay.prompt.destroy()
    }
    this.overlay = { kind: "none" }
    this.renderer.requestRender()
  }

  // Completions touch only app-global state (flash + seq-guarded refreshFleet); stale ones are harmless.
  private async runAction(action: "kill" | "respawn", agent: ModelAgentView): Promise<void> {
    try {
      if (action === "kill") {
        await this.deps.cco.kill(agent.id)
        this.setFlash(`killed ${agent.name}`)
      } else {
        await this.deps.cco.respawn(agent.id)
        this.setFlash(`respawned ${agent.name}`)
      }
      void this.refreshFleet()
    } catch (err) {
      this.setFlash(toError(err).message)
    }
  }

  private async runMessage(agent: ModelAgentView, text: string): Promise<void> {
    try {
      await this.deps.cco.sendMessage(agent.id, text)
      this.setFlash(`sent to ${agent.name}`)
      void this.refreshFleet()
    } catch (err) {
      this.setFlash(toError(err).message)
    }
  }

  // Overlay set before suspend(); resume + poller restart + overlay clear happen in finally so a
  // spawn rejection still restores the renderer. The attach overlay guards re-entry.
  private async runAttach(agent: ModelAgentView): Promise<void> {
    this.overlay = { kind: "attach" }
    this.fleetPoller.stop()
    this.timelinePoller?.stop()
    this.renderer.suspend()
    let result: { readonly code: number; readonly stderr: string }
    try {
      result = await this.deps.attach(agent.id)
    } catch (err) {
      result = { code: 1, stderr: toError(err).message }
    } finally {
      this.renderer.resume()
      this.fleetPoller.start()
      this.timelinePoller?.start()
      this.overlay = { kind: "none" }
    }
    if (result.code !== 0) this.setFlash(`attach failed: ${result.stderr}`)
    void this.refreshFleet()
    void this.refreshCapture()
  }

  private setFlash(message: string): void {
    this.flash = message
    this.renderFooter()
    this.renderer.requestRender()
  }

  private async pollFleet(): Promise<StampedFleetOutcome> {
    const id = ++this.fleetSeq
    try {
      return { id, outcome: { ok: true, fleet: await this.deps.cco.fleetStatus() } }
    } catch (err) {
      return { id, outcome: { ok: false, error: toError(err) } }
    }
  }

  // Newest issued request wins: a stamp that lost the race to a later one is dropped.
  private applyFleetOutcome(stamped: StampedFleetOutcome): void {
    if (stamped.id <= this.lastAppliedFleetSeq) return
    this.lastAppliedFleetSeq = stamped.id
    const outcome = stamped.outcome
    if (outcome.ok) {
      this.lastFleet = outcome.fleet
      this.lastSuccessAt = this.clock.now()
      this.daemon = { kind: "ok" }
      if (this.state.view === "fleet") this.fleetView.setFleet(outcome.fleet)
    } else {
      this.daemon =
        outcome.error instanceof DaemonUnreachableError
          ? { kind: "unreachable", error: outcome.error }
          : { kind: "bad-response", message: outcome.error.message }
    }
    this.renderHeader()
    this.renderer.requestRender()
  }

  private openAgent(agentId: string): void {
    if (this.lastFleet === null) return
    this.viewEpoch++
    const chain = agentRepoChain(this.lastFleet, agentId)
    this.state = { view: "agent", agentId }
    this.agentChain = chain
    this.body.remove(this.fleetView)
    const agentView = new AgentView(this.renderer, {
      id: "agent-view",
      chain,
      timeZone: this.deps.timeZone,
      now: () => this.clock.now(),
    })
    this.agentView = agentView
    this.body.add(agentView)

    void agentView.loadCapture((id) => this.deps.cco.capture(id))
    this.startTimelinePoller(chain.repo.cwd)

    this.renderHeader()
    this.renderFooter()
    this.renderer.requestRender()
  }

  private backToFleet(): void {
    this.viewEpoch++
    this.timelinePoller?.stop()
    this.timelinePoller = null
    const agentView = this.agentView
    this.agentView = null
    this.agentChain = null
    if (agentView) {
      agentView.dispose()
      this.body.remove(agentView)
      agentView.destroy()
    }
    this.body.add(this.fleetView)
    this.state = { view: "fleet" }
    if (this.lastFleet) this.fleetView.setFleet(this.lastFleet)

    this.renderHeader()
    this.renderFooter()
    this.renderer.requestRender()
  }

  private refreshCapture(): Promise<void> {
    if (this.agentView === null) return Promise.resolve()
    return this.agentView.loadCapture((id) => this.deps.cco.capture(id))
  }

  private startTimelinePoller(repoPath: string): void {
    const epoch = this.viewEpoch
    const poll = async (): Promise<NotesOutcome> => {
      try {
        const server = await this.deps.viz.serverFor(repoPath)
        return { ok: true, graph: await server.graph() }
      } catch (err) {
        return { ok: false, error: toError(err) }
      }
    }
    this.timelinePoller = new Poller<NotesOutcome>({
      producer: poll,
      intervalMs: this.deps.pollIntervalMs,
      onResult: (outcome) => this.applyNotesOutcome(outcome),
      clock: this.clock,
    })
    this.timelinePoller.start()
    // The Poller path self-suppresses late results via stop(); this standalone initial fetch
    // must not land in a view opened after it was issued.
    void poll().then((outcome) => {
      if (epoch === this.viewEpoch) this.applyNotesOutcome(outcome)
    })
  }

  private applyNotesOutcome(outcome: NotesOutcome): void {
    if (this.agentView === null) return
    if (outcome.ok) this.agentView.setNotes(outcome.graph)
    else if (outcome.error instanceof NotesUnavailableError) this.agentView.setNotesUnavailable()
    else this.agentView.setNotesError(outcome.error.message)
    this.renderer.requestRender()
  }

  private renderHeader(): void {
    const chunks: TextChunk[] = [...stringToStyledText("cc-pane  ").chunks]
    if (this.state.view === "agent" && this.agentChain) {
      const c = this.agentChain
      chunks.push(...stringToStyledText(`· ${c.repo.name} › ${c.workstream.name} › ${c.sprint.name} › ${c.agent.name}   `).chunks)
    } else if (this.lastFleet) {
      chunks.push(...this.fleetBadgeChunks(this.lastFleet), ...stringToStyledText("  ").chunks)
    }
    chunks.push(this.daemonChunk(), ...stringToStyledText("   ").chunks, dim(this.pollText()))
    this.header.content = new StyledText(chunks)
  }

  private fleetBadgeChunks(fleet: FleetStatus): TextChunk[] {
    const chunks: TextChunk[] = []
    for (const state of BADGE_STATE_ORDER) {
      const count = fleet.agents.filter((a) => a.state === state).length
      if (count > 0) {
        chunks.push(fg(AGENT_STATE_COLORS[state])(`${count}${AGENT_STATE_GLYPHS[state]}`))
        chunks.push(...stringToStyledText(" ").chunks)
      }
    }
    return chunks
  }

  private daemonChunk(): TextChunk {
    switch (this.daemon.kind) {
      case "pending":
        return dim("daemon starting…")
      case "ok":
        return fg(OK_COLOR)("daemon ok")
      case "unreachable":
        return fg(ALERT_COLOR)("daemon unreachable — retrying")
      case "bad-response":
        return fg(ALERT_COLOR)(`bad response: ${this.daemon.message}`)
    }
  }

  private pollText(): string {
    if (this.lastSuccessAt === null) return "polling…"
    return `polled ${formatAge(this.lastSuccessAt, this.clock.now())}`
  }

  private renderFooter(): void {
    if (this.flash !== null) {
      this.footer.content = new StyledText([fg(FLASH_COLOR)(this.flash)])
      return
    }
    this.footer.content = new StyledText([dim(this.state.view === "agent" ? AGENT_FOOTER : FLEET_FOOTER)])
  }
}

export function buildApp(renderer: CliRenderer, deps: AppDeps): AppHandle {
  const app = new App(renderer, deps)
  return {
    refreshFleet: () => app.refreshFleet(),
    route: (keyName) => app.route(keyName),
    currentView: () => app.currentView(),
    dispose: () => app.dispose(),
  }
}
