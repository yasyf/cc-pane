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
import { NotesUnavailableError } from "./data/ccnotes.ts"
import { DaemonUnreachableError } from "./data/cco.ts"
import { Poller, systemClock, type PollerClock } from "./data/poller.ts"
import { formatAge } from "./format.ts"
import { agentRepoChain, type AgentRepoChain, type Capture, type FleetStatus, type NotesGraph } from "./model.ts"
import { AGENT_STATE_COLORS, AGENT_STATE_GLYPHS, BADGE_STATE_ORDER } from "./theme.ts"

const OK_COLOR = "#3fb950"
const ALERT_COLOR = "#f85149"
const FLEET_FOOTER = "enter drill · tab pane · j/k move · q quit"
const AGENT_FOOTER = "esc back · s snapshot · a all-repo events · j/k scroll · q quit"

export type View = { readonly view: "fleet" } | { readonly view: "agent"; readonly agentId: string }

// Structural sources so tests inject fakes; CcoClient and VizPool are assignable as-is.
export interface FleetSource {
  fleetStatus(): Promise<FleetStatus>
  capture(agentId: string): Promise<Capture>
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
  readonly pollIntervalMs: number
  readonly timeZone: string
  readonly onQuit: () => void
  readonly clock?: PollerClock
}

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
      if (event.ctrl && event.name === "c") return this.route("q")
      if (event.ctrl || event.meta || event.option) return
      this.route(event.name)
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
    }
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
