// The list/tree renderable behind the repo list, fleet tree, and timeline.
// Glyphs live in the caller's renderRow, never in the pure flattenFleet.

import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  createTextAttributes,
  stringToStyledText,
  type BoxOptions,
  type RenderContext,
} from "@opentui/core"

import { repoRows, type AgentView, type FleetStatus, type SprintView, type WorkstreamView } from "../model.ts"

const SELECTION_MARKER = "❯ "
const BLANK_MARKER = "  "
const INVERSE_ATTRIBUTES = createTextAttributes({ inverse: true })

// A flat render row of the fleet hierarchy; `key` is the stable entity id.
export type TreeRow =
  | {
      readonly kind: "workstream"
      readonly key: string
      readonly depth: number
      readonly workstream: WorkstreamView
      readonly expanded: boolean
      readonly sprintCount: number
      readonly agentCount: number
    }
  | {
      readonly kind: "sprint"
      readonly key: string
      readonly depth: number
      readonly sprint: SprintView
      readonly expanded: boolean
      readonly agentCount: number
    }
  | {
      readonly kind: "agent"
      readonly key: string
      readonly depth: number
      readonly agent: AgentView
    }

export interface ListItem {
  readonly key: string
}

export interface ListRenderableOptions<T extends ListItem> extends BoxOptions {
  readonly renderRow: (row: T) => StyledText
  readonly onSelectionChange?: (row: T | undefined) => void
  // Stick the viewport to the newest (bottom) row as content grows — a log/timeline tail.
  readonly stickyBottom?: boolean
}

/**
 * Flatten the workstream→sprint→agent hierarchy for the repo keyed by `repoKey`
 * (the repo's on-disk path, matching `repoRows(...).key`), depth-first and honoring
 * `expandedIds`. Unknown or registry-only keys (no activated DB repo) yield [].
 */
export function flattenFleet(fleet: FleetStatus, repoKey: string, expandedIds: ReadonlySet<string>): readonly TreeRow[] {
  const repoRow = repoRows(fleet).find((r) => r.key === repoKey)
  if (!repoRow || repoRow.kind === "registry-only") return []
  const repoId = repoRow.repo.id

  const rows: TreeRow[] = []
  for (const workstream of fleet.workstreams) {
    if (workstream.repoId !== repoId) continue
    const sprints = fleet.sprints.filter((s) => s.workstreamId === workstream.id)
    const sprintIds = new Set(sprints.map((s) => s.id))
    const workstreamAgentCount = fleet.agents.filter((a) => sprintIds.has(a.sprintId)).length
    const workstreamExpanded = expandedIds.has(workstream.id)
    rows.push({
      kind: "workstream",
      key: workstream.id,
      depth: 0,
      workstream,
      expanded: workstreamExpanded,
      sprintCount: sprints.length,
      agentCount: workstreamAgentCount,
    })
    if (!workstreamExpanded) continue

    for (const sprint of sprints) {
      const agents = fleet.agents.filter((a) => a.sprintId === sprint.id)
      const sprintExpanded = expandedIds.has(sprint.id)
      rows.push({ kind: "sprint", key: sprint.id, depth: 1, sprint, expanded: sprintExpanded, agentCount: agents.length })
      if (!sprintExpanded) continue

      for (const agent of agents) {
        rows.push({ kind: "agent", key: agent.id, depth: 2, agent })
      }
    }
  }
  return rows
}

/**
 * A generic scrollable list: one `TextRenderable` per row inside a `ScrollBox`,
 * with selection keyed by `row.key` so a poll-driven reorder keeps the same row
 * highlighted. No key handling here — the app's central router drives `move`.
 */
export class ListRenderable<T extends ListItem> extends BoxRenderable {
  private readonly scroll: ScrollBoxRenderable
  private readonly renderRow: (row: T) => StyledText
  private rows: readonly T[] = []
  private rowRenderables: TextRenderable[] = []
  private selectedKey: string | undefined = undefined
  onSelectionChange: ((row: T | undefined) => void) | undefined

  constructor(ctx: RenderContext, options: ListRenderableOptions<T>) {
    const { renderRow, onSelectionChange, stickyBottom, ...boxOptions } = options
    super(ctx, boxOptions)
    this.renderRow = renderRow
    this.onSelectionChange = onSelectionChange
    this.scroll = new ScrollBoxRenderable(ctx, {
      id: `${this.id}-scroll`,
      flexGrow: 1,
      stickyScroll: stickyBottom ?? false,
      stickyStart: stickyBottom ? "bottom" : undefined,
    })
    this.add(this.scroll)
  }

  // Re-render `rows`; a surviving selected key stays selected, a vanished one clamps.
  setRows(rows: readonly T[]): void {
    const previousKey = this.selectedKey
    const previousIndex = previousKey === undefined ? -1 : this.rows.findIndex((r) => r.key === previousKey)

    for (const renderable of this.rowRenderables) {
      this.scroll.remove(renderable)
      renderable.destroy()
    }

    this.rows = rows
    const nextKey = pickSelection(previousKey, previousIndex, rows)
    this.selectedKey = nextKey
    this.rowRenderables = rows.map((row) => {
      const renderable = new TextRenderable(this.ctx, { id: this.rowId(row.key) })
      this.paint(renderable, row, row.key === nextKey)
      this.scroll.add(renderable)
      return renderable
    })

    this.scrollSelectedIntoView()

    this.requestRender()
    if (nextKey !== previousKey) this.emitSelection()
  }

  // Shift selection by `delta` (clamped to the ends) and scroll it into view.
  move(delta: number): void {
    if (this.rows.length === 0) return
    const currentIndex = this.selectedIndex()
    const nextIndex = clamp(currentIndex + delta, 0, this.rows.length - 1)
    if (nextIndex === currentIndex) return

    this.paint(this.rowRenderables[currentIndex]!, this.rows[currentIndex]!, false)
    const nextRow = this.rows[nextIndex]!
    this.selectedKey = nextRow.key
    this.paint(this.rowRenderables[nextIndex]!, nextRow, true)
    this.scroll.scrollChildIntoView(this.rowId(nextRow.key))

    this.requestRender()
    this.emitSelection()
  }

  // Bring the selection on screen after a setRows reorder. Rows are single-line, so their
  // index is the scroll offset; a sticky-bottom list lets its own tail-follow win.
  private scrollSelectedIntoView(): void {
    if (this.selectedKey === undefined || this.scroll.stickyScroll) return
    const index = this.rows.findIndex((r) => r.key === this.selectedKey)
    const capacity = this.scroll.viewport.height
    if (index < 0 || capacity <= 0) return
    const maxTop = Math.max(0, this.rows.length - capacity)
    const top = clamp(this.scroll.scrollTop, 0, maxTop)
    const nextTop = index < top ? index : index >= top + capacity ? index - capacity + 1 : top
    this.scroll.scrollTo(clamp(nextTop, 0, maxTop))
  }

  get selected(): T | undefined {
    if (this.selectedKey === undefined) return undefined
    return this.rows.find((r) => r.key === this.selectedKey)
  }

  private selectedIndex(): number {
    if (this.selectedKey === undefined) return -1
    return this.rows.findIndex((r) => r.key === this.selectedKey)
  }

  private rowId(key: string): string {
    return `l${this.num}:${key}`
  }

  private paint(renderable: TextRenderable, row: T, selected: boolean): void {
    const marker = stringToStyledText(selected ? SELECTION_MARKER : BLANK_MARKER).chunks
    renderable.content = new StyledText([...marker, ...this.renderRow(row).chunks])
    renderable.attributes = selected ? INVERSE_ATTRIBUTES : 0
  }

  private emitSelection(): void {
    this.onSelectionChange?.(this.selected)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function pickSelection<T extends ListItem>(
  previousKey: string | undefined,
  previousIndex: number,
  rows: readonly T[],
): string | undefined {
  if (rows.length === 0) return undefined
  if (previousKey !== undefined && rows.some((r) => r.key === previousKey)) return previousKey
  return rows[clamp(previousIndex, 0, rows.length - 1)]!.key
}
