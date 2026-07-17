// The home view: a repo list whose selection drives the workstream→sprint→agent tree.
// Selection is keyed by on-disk path; no key handling here — the app's router drives it.

import {
  BoxRenderable,
  StyledText,
  dim,
  fg,
  stringToStyledText,
  t,
  type BoxOptions,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"

import { flattenFleet, ListRenderable, type ListItem, type TreeRow } from "../components/tree.ts"
import { formatTokens } from "../format.ts"
import { repoRows, type AgentState, type AgentView, type FleetStatus, type RepoRow } from "../model.ts"
import { AGENT_STATE_COLORS, AGENT_STATE_GLYPHS, AGENT_STATUS_GLYPHS, BADGE_STATE_ORDER } from "../theme.ts"

const REPO_LIST_WIDTH = 32
const FOCUS_BORDER = "#58a6ff"
const BLUR_BORDER = "#30363d"
const DIM_TEXT = "#6e7681"
// Non-idle attention states; their tally is the repo list's "active-agent count" sort key.
const ACTIVE_STATES: readonly AgentState[] = ["working", "awaiting-input", "blocked", "stuck"]

export type FocusedPane = "repos" | "tree"

export interface RepoListRow extends ListItem {
  readonly key: string
  readonly repoRow: RepoRow
  readonly counts: Readonly<Record<AgentState, number>>
}

export interface FleetViewOptions extends BoxOptions {
  readonly onDrillIn: (agentId: string) => void
}

function emptyCounts(): Record<AgentState, number> {
  return { working: 0, idle: 0, "awaiting-input": 0, unknown: 0, blocked: 0, stuck: 0 }
}

// Agents grouped by repo id, joined the lax way flattenFleet joins (unjoinable agents skipped).
function agentsByRepoId(fleet: FleetStatus): Map<string, AgentView[]> {
  const sprintToWorkstream = new Map(fleet.sprints.map((s) => [s.id, s.workstreamId]))
  const workstreamToRepo = new Map(fleet.workstreams.map((w) => [w.id, w.repoId]))
  const out = new Map<string, AgentView[]>()
  for (const agent of fleet.agents) {
    const workstreamId = sprintToWorkstream.get(agent.sprintId)
    if (workstreamId === undefined) continue
    const repoId = workstreamToRepo.get(workstreamId)
    if (repoId === undefined) continue
    const bucket = out.get(repoId)
    if (bucket) bucket.push(agent)
    else out.set(repoId, [agent])
  }
  return out
}

function activeCount(counts: Readonly<Record<AgentState, number>>): number {
  return ACTIVE_STATES.reduce((sum, state) => sum + counts[state], 0)
}

function totalCount(counts: Readonly<Record<AgentState, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0)
}

// working-first → active-count desc → idle above empty → registry-only last; alpha within group.
function compareRepoRows(a: RepoListRow, b: RepoListRow): number {
  const registryA = a.repoRow.kind === "registry-only" ? 1 : 0
  const registryB = b.repoRow.kind === "registry-only" ? 1 : 0
  if (registryA !== registryB) return registryA - registryB

  const workingA = a.counts.working > 0 ? 0 : 1
  const workingB = b.counts.working > 0 ? 0 : 1
  if (workingA !== workingB) return workingA - workingB

  const activeDelta = activeCount(b.counts) - activeCount(a.counts)
  if (activeDelta !== 0) return activeDelta

  const totalDelta = totalCount(b.counts) - totalCount(a.counts)
  if (totalDelta !== 0) return totalDelta

  return a.repoRow.name.localeCompare(b.repoRow.name)
}

export function repoListRows(fleet: FleetStatus): readonly RepoListRow[] {
  const byRepo = agentsByRepoId(fleet)
  const rows = repoRows(fleet).map<RepoListRow>((repoRow) => {
    const counts = emptyCounts()
    if (repoRow.kind !== "registry-only") {
      for (const agent of byRepo.get(repoRow.repo.id) ?? []) counts[agent.state] += 1
    }
    return { key: repoRow.key, repoRow, counts }
  })
  return rows.sort(compareRepoRows)
}

function renderRepoRow(row: RepoListRow): StyledText {
  if (row.repoRow.kind === "registry-only") return new StyledText([dim(row.repoRow.name)])
  const chunks: TextChunk[] = [...stringToStyledText(row.repoRow.name).chunks]
  for (const state of BADGE_STATE_ORDER) {
    const count = row.counts[state]
    if (count > 0) {
      chunks.push(...stringToStyledText("  ").chunks)
      chunks.push(fg(AGENT_STATE_COLORS[state])(`${count}${AGENT_STATE_GLYPHS[state]}`))
    }
  }
  return new StyledText(chunks)
}

function renderTreeRow(row: TreeRow): StyledText {
  const indent = "  ".repeat(row.depth)
  if (row.kind === "workstream") {
    const caret = row.expanded ? "▾" : "▸"
    return t`${indent}${caret} ${row.workstream.name} ${dim(`(${row.sprintCount} sprint · ${row.agentCount} ag)`)}`
  }
  if (row.kind === "sprint") {
    const caret = row.expanded ? "▾" : "▸"
    return t`${indent}${caret} ${row.sprint.name} ${dim(`(${row.agentCount} ag)`)}`
  }
  const agent = row.agent
  const glyph = AGENT_STATUS_GLYPHS[agent.status] ?? AGENT_STATE_GLYPHS[agent.state]
  const color = agent.status === "active" ? AGENT_STATE_COLORS[agent.state] : DIM_TEXT
  return t`${indent}${fg(color)(glyph)} ${agent.name} ${dim(agent.activity)} ${dim(`${formatTokens(agent.tokens)} tok`)}`
}

export class FleetView extends BoxRenderable {
  private readonly repoList: ListRenderable<RepoListRow>
  private readonly tree: ListRenderable<TreeRow>
  private readonly onDrillIn: (agentId: string) => void
  private readonly expandedIds = new Set<string>()
  private fleet: FleetStatus | null = null
  private pane: FocusedPane = "repos"

  constructor(ctx: RenderContext, options: FleetViewOptions) {
    const { onDrillIn, ...boxOptions } = options
    super(ctx, { flexGrow: 1, ...boxOptions, flexDirection: "row" })
    this.onDrillIn = onDrillIn
    this.repoList = new ListRenderable<RepoListRow>(ctx, {
      id: `${this.id}-repos`,
      width: REPO_LIST_WIDTH,
      border: true,
      borderStyle: "rounded",
      title: "repos",
      renderRow: renderRepoRow,
      onSelectionChange: () => this.rebuildTree(),
    })
    this.tree = new ListRenderable<TreeRow>(ctx, {
      id: `${this.id}-tree`,
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      title: "fleet",
      renderRow: renderTreeRow,
    })
    this.add(this.repoList)
    this.add(this.tree)
    this.applyFocus()
  }

  get focusedPane(): FocusedPane {
    return this.pane
  }

  get selectedRepoKey(): string | undefined {
    return this.repoList.selected?.key
  }

  setFleet(fleet: FleetStatus): void {
    this.fleet = fleet
    this.repoList.setRows([...repoListRows(fleet)])
    this.rebuildTree()
  }

  moveSelection(delta: number): void {
    if (this.pane === "repos") this.repoList.move(delta)
    else this.tree.move(delta)
  }

  switchPane(): void {
    this.pane = this.pane === "repos" ? "tree" : "repos"
    this.applyFocus()
  }

  toggleExpand(): void {
    const row = this.tree.selected
    if (row === undefined || row.kind === "agent") return
    if (this.expandedIds.has(row.key)) this.expandedIds.delete(row.key)
    else this.expandedIds.add(row.key)
    this.rebuildTree()
  }

  selectedAgentId(): string | undefined {
    const row = this.tree.selected
    return row?.kind === "agent" ? row.agent.id : undefined
  }

  // Enter: from the repo pane, focus the tree; on an agent, drill in; else expand/collapse.
  activate(): void {
    if (this.pane === "repos") {
      this.switchPane()
      return
    }
    const agentId = this.selectedAgentId()
    if (agentId !== undefined) this.onDrillIn(agentId)
    else this.toggleExpand()
  }

  private rebuildTree(): void {
    const selected = this.repoList.selected
    if (this.fleet === null || selected === undefined) {
      this.tree.setRows([])
      this.tree.title = "fleet"
      return
    }
    this.tree.title = selected.repoRow.name
    this.tree.setRows([...flattenFleet(this.fleet, selected.key, this.expandedIds)])
  }

  private applyFocus(): void {
    this.repoList.borderColor = this.pane === "repos" ? FOCUS_BORDER : BLUR_BORDER
    this.tree.borderColor = this.pane === "tree" ? FOCUS_BORDER : BLUR_BORDER
    this.requestRender()
  }
}
