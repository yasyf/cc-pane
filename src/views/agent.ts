// The drill-in view: a scrollable plain-text snapshot of the agent's screen (top) over a
// filtered, sticky-bottom timeline of its cc-notes events. No key handling — the app routes.

import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  dim,
  fg,
  t,
  type BoxOptions,
  type RenderContext,
} from "@opentui/core"

import { ListRenderable, type ListItem } from "../components/tree.ts"
import { CaptureConflictError } from "../data/cco.ts"
import { formatAge, formatEventTime, formatTokens } from "../format.ts"
import { type AgentRepoChain, type Capture, type NotesEvent, type NotesGraph } from "../model.ts"
import { AGENT_STATE_GLYPHS, AGENT_STATUS_GLYPHS, NOTES_EVENT_GLYPHS } from "../theme.ts"

const EVENT_GLYPH_COLOR = "#58a6ff"
const TIME_COLOR = "#6e7681"
const EXITED_PLACEHOLDER = "agent exited — last state"
const NOTES_UNAVAILABLE = "timeline unavailable — cc-notes not reachable"

type SnapshotState =
  | { readonly kind: "loading" }
  | { readonly kind: "captured"; readonly capture: Capture }
  | { readonly kind: "placeholder"; readonly message: string }

type NotesState =
  | { readonly kind: "loading" }
  | { readonly kind: "graph"; readonly graph: NotesGraph }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly message: string }

type TimelineRow =
  | { readonly kind: "event"; readonly key: string; readonly event: NotesEvent }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }

export interface AgentViewOptions extends BoxOptions {
  readonly chain: AgentRepoChain
  readonly timeZone: string
  readonly now?: () => number
}

// Keep an event iff its branch is the agent's workstream branch, or its entity is the
// agent's task / sprint / project. Empty ids never match.
export function filterEvents(events: readonly NotesEvent[], chain: AgentRepoChain): readonly NotesEvent[] {
  const branch = chain.workstream.branch
  const ids = new Set(
    [chain.agent.ccnotesTask, chain.sprint.ccnotesSprint, chain.workstream.ccnotesProject].filter((id) => id !== ""),
  )
  return events.filter((event) => event.branch === branch || ids.has(event.entity.id))
}

function eventContentKey(event: NotesEvent): string {
  const parts = [
    String(event.time),
    event.type,
    event.entity.kind,
    event.entity.id,
    event.entity.short,
    event.entity.title,
    event.branch,
    event.sha,
    event.detail,
  ]
  return parts.map((part) => `${part.length}:${part}`).join("")
}

export class AgentView extends BoxRenderable {
  private readonly chain: AgentRepoChain
  private readonly timeZone: string
  private readonly now: () => number
  private readonly snapshotPane: ScrollBoxRenderable
  private readonly snapshotText: TextRenderable
  private readonly timeline: ListRenderable<TimelineRow>

  private snapshot: SnapshotState = { kind: "loading" }
  private notes: NotesState = { kind: "loading" }
  private filterOn = true
  private following = true
  private timelineRows: readonly TimelineRow[] = []
  private disposed = false
  private captureSeq = 0

  constructor(ctx: RenderContext, options: AgentViewOptions) {
    const { chain, timeZone, now, ...boxOptions } = options
    super(ctx, { flexGrow: 1, ...boxOptions, flexDirection: "column" })
    this.chain = chain
    this.timeZone = timeZone
    this.now = now ?? Date.now

    this.snapshotPane = new ScrollBoxRenderable(ctx, {
      id: `${this.id}-snapshot`,
      flexGrow: 3,
      border: true,
      borderStyle: "rounded",
    })
    this.snapshotText = new TextRenderable(ctx, { id: `${this.id}-snapshot-text`, content: "" })
    this.snapshotPane.add(this.snapshotText)

    this.timeline = new ListRenderable<TimelineRow>(ctx, {
      id: `${this.id}-timeline`,
      flexGrow: 2,
      border: true,
      borderStyle: "rounded",
      stickyBottom: true,
      renderRow: (row) => this.renderTimelineRow(row),
    })

    this.add(this.snapshotPane)
    this.add(this.timeline)
    this.renderSnapshot()
    this.renderTimeline()
  }

  get filterActive(): boolean {
    return this.filterOn
  }

  // Fetch policy lives here: a non-active agent is never captured, and a losing-the-race
  // Conflict renders the same exited placeholder as an up-front skip.
  async loadCapture(fetchCapture: (agentId: string) => Promise<Capture>): Promise<void> {
    if (this.chain.agent.status !== "active") {
      this.setSnapshotExited()
      return
    }
    const seq = ++this.captureSeq
    this.snapshot = { kind: "loading" }
    this.renderSnapshot()
    try {
      const capture = await fetchCapture(this.chain.agent.id)
      if (!this.disposed && seq === this.captureSeq) this.setCapture(capture)
    } catch (err) {
      if (this.disposed || seq !== this.captureSeq) return
      if (err instanceof CaptureConflictError) this.setSnapshotExited()
      else this.setSnapshotError(err instanceof Error ? err.message : String(err))
    }
  }

  setCapture(capture: Capture): void {
    this.snapshot = { kind: "captured", capture }
    this.renderSnapshot()
  }

  setSnapshotExited(): void {
    this.snapshot = { kind: "placeholder", message: EXITED_PLACEHOLDER }
    this.renderSnapshot()
  }

  setSnapshotError(message: string): void {
    this.snapshot = { kind: "placeholder", message: `snapshot unavailable: ${message}` }
    this.renderSnapshot()
  }

  setNotes(graph: NotesGraph): void {
    this.notes = { kind: "graph", graph }
    this.renderTimeline()
  }

  setNotesUnavailable(): void {
    this.notes = { kind: "unavailable" }
    this.renderTimeline()
  }

  setNotesError(message: string): void {
    this.notes = { kind: "error", message }
    this.renderTimeline()
  }

  toggleFilter(): void {
    this.filterOn = !this.filterOn
    this.following = true
    this.renderTimeline()
  }

  moveSelection(delta: number): void {
    this.timeline.move(delta)
    this.following = this.atBottom()
  }

  dispose(): void {
    this.disposed = true
  }

  private renderSnapshot(): void {
    this.snapshotPane.title = this.snapshotTitle()
    this.snapshotPane.bottomTitle = this.chain.agent.activity
    this.snapshotText.content = this.snapshotBody()
    this.requestRender()
  }

  private snapshotTitle(): string {
    const agent = this.chain.agent
    const glyph = AGENT_STATUS_GLYPHS[agent.status] ?? AGENT_STATE_GLYPHS[agent.state]
    const parts = [`screen`, `${glyph} ${agent.state}`, `${formatTokens(agent.tokens)} tok`]
    if (this.snapshot.kind === "captured") {
      parts.push(`captured ${formatAge(Date.parse(this.snapshot.capture.capturedAt), this.now())}`)
    }
    parts.push("s to refresh")
    return parts.join(" · ")
  }

  private snapshotBody(): string {
    switch (this.snapshot.kind) {
      case "loading":
        return "loading snapshot…"
      case "captured":
        return this.snapshot.capture.content
      case "placeholder":
        return this.snapshot.message
    }
  }

  private renderTimeline(): void {
    this.timeline.title = this.timelineTitle()
    this.timelineRows = this.computeTimelineRows()
    this.timeline.setRows([...this.timelineRows])
    if (this.following) this.timeline.move(this.timelineRows.length)
    this.requestRender()
  }

  private timelineTitle(): string {
    if (!this.filterOn) return "timeline · all-repo events"
    const task = this.chain.agent.ccnotesTask
    const prefix = task === "" ? "" : `task ${task} · `
    return `timeline · ${prefix}branch ${this.chain.workstream.branch}`
  }

  private computeTimelineRows(): readonly TimelineRow[] {
    if (this.notes.kind === "unavailable") return [{ kind: "notice", key: "__notice__", text: NOTES_UNAVAILABLE }]
    if (this.notes.kind === "error") return [{ kind: "notice", key: "__notice__", text: `timeline error: ${this.notes.message}` }]
    if (this.notes.kind === "loading") return [{ kind: "notice", key: "__notice__", text: "loading timeline…" }]
    const events = this.filterOn ? filterEvents(this.notes.graph.events, this.chain) : this.notes.graph.events
    if (events.length === 0) {
      return [{ kind: "notice", key: "__notice__", text: this.filterOn ? "no events for this agent" : "no events" }]
    }
    const occurrences = new Map<string, number>()
    return events.map<TimelineRow>((event) => {
      const contentKey = eventContentKey(event)
      const occurrence = occurrences.get(contentKey) ?? 0
      occurrences.set(contentKey, occurrence + 1)
      return { kind: "event", key: `${contentKey}#${occurrence}`, event }
    })
  }

  private renderTimelineRow(row: TimelineRow): StyledText {
    if (row.kind === "notice") return new StyledText([dim(row.text)])
    const event = row.event
    const time = formatEventTime(event.time, this.timeZone)
    const glyph = NOTES_EVENT_GLYPHS[event.type]
    return t`${fg(TIME_COLOR)(time)} ${fg(EVENT_GLYPH_COLOR)(glyph)} ${event.entity.title} ${dim(event.detail)}`
  }

  private atBottom(): boolean {
    const last = this.timelineRows.at(-1)
    return last !== undefined && this.timeline.selected?.key === last.key
  }
}
