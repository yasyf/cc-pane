import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { StyledText, fg, t } from "@opentui/core"

import { flattenFleet, ListRenderable, type ListItem, type TreeRow } from "../src/components/tree.ts"
import { parseFleetStatus } from "../src/model.ts"
import { AGENT_STATE_COLORS, AGENT_STATE_GLYPHS } from "../src/theme.ts"

const fleetRaw: unknown = await Bun.file(`${import.meta.dir}/fixtures/fleet-status.json`).json()
const fleet = parseFleetStatus(fleetRaw)

// smoke-zellij repo: 2 workstreams → 2 sprints → 1 agent (registry-matched key).
const SMOKE_KEY = "/tmp/cco-smoke-zellij"
const SMOKE_WS_MAIN = "main-de293e1e"
const SMOKE_WS_ZELLIJ = "smoke-zellij-e746c6c3"
const SMOKE_SPRINT_MAIN = "main-bbfa01f2"
const SMOKE_SPRINT_ZELLIJ = "main-1ee941a2"
const SMOKE_AGENT = "95b7014a-96e0-43fa-b406-a1927cf2a0b8"

// e2e-chan repo: 1 workstream → 1 sprint → 4 agents (db-only key).
const E2E_KEY = "/private/tmp/cco-e2e.Jw7r"
const E2E_WS = "main-efffe6e2"
const E2E_SPRINT = "main-57884e73"
const E2E_A1 = "4f7f07ba-5c9e-4f38-b0bc-d8ccc12dfcd8"
const E2E_A2 = "17cff5e2-2e2b-473b-8b18-6046e6268257"
const E2E_A3 = "9ef74f7f-2124-4edd-b9ca-21cdb2cc33bf"
const E2E_A4 = "0cf2b05d-0fd1-4bbb-b3bb-f9aefcd95bd4"

const REGISTRY_ONLY_KEY = "/Users/yasyf/Code/cc-notes"

const shape = (rows: readonly TreeRow[]): string[] => rows.map((r) => `${r.kind}:${r.key}:${r.depth}`)
const expanded = (...ids: string[]): ReadonlySet<string> => new Set(ids)

test("flattenFleet: collapsed repo shows only its workstreams", () => {
  const rows = flattenFleet(fleet, SMOKE_KEY, expanded())
  expect(shape(rows)).toEqual([`workstream:${SMOKE_WS_MAIN}:0`, `workstream:${SMOKE_WS_ZELLIJ}:0`])
  const [wsMain, wsZellij] = rows
  if (wsMain?.kind !== "workstream" || wsZellij?.kind !== "workstream") throw new Error("expected workstream rows")
  expect(wsMain.expanded).toBe(false)
  expect(wsMain.workstream.name).toBe("main")
  expect(wsMain.sprintCount).toBe(1)
  expect(wsMain.agentCount).toBe(0)
  expect(wsZellij.sprintCount).toBe(1)
  expect(wsZellij.agentCount).toBe(1)
})

test("flattenFleet: fully expanded repo is the depth-first hierarchy", () => {
  const rows = flattenFleet(fleet, SMOKE_KEY, expanded(SMOKE_WS_MAIN, SMOKE_WS_ZELLIJ, SMOKE_SPRINT_MAIN, SMOKE_SPRINT_ZELLIJ))
  expect(shape(rows)).toEqual([
    `workstream:${SMOKE_WS_MAIN}:0`,
    `sprint:${SMOKE_SPRINT_MAIN}:1`,
    `workstream:${SMOKE_WS_ZELLIJ}:0`,
    `sprint:${SMOKE_SPRINT_ZELLIJ}:1`,
    `agent:${SMOKE_AGENT}:2`,
  ])
  const agentRow = rows.find((r) => r.kind === "agent")
  if (agentRow?.kind !== "agent") throw new Error("expected an agent row")
  expect(agentRow.agent.name).toBe("smoke-agent")
  expect(agentRow.agent.state).toBe("stuck")
})

test("flattenFleet: an expanded workstream with a collapsed sprint hides its agents", () => {
  const rows = flattenFleet(fleet, SMOKE_KEY, expanded(SMOKE_WS_ZELLIJ))
  expect(shape(rows)).toEqual([
    `workstream:${SMOKE_WS_MAIN}:0`,
    `workstream:${SMOKE_WS_ZELLIJ}:0`,
    `sprint:${SMOKE_SPRINT_ZELLIJ}:1`,
  ])
  const sprintRow = rows.find((r) => r.kind === "sprint")
  if (sprintRow?.kind !== "sprint") throw new Error("expected a sprint row")
  expect(sprintRow.expanded).toBe(false)
  expect(sprintRow.agentCount).toBe(1)
})

test("flattenFleet: expanding the sprint reveals its agent", () => {
  const rows = flattenFleet(fleet, SMOKE_KEY, expanded(SMOKE_WS_ZELLIJ, SMOKE_SPRINT_ZELLIJ))
  expect(shape(rows)).toEqual([
    `workstream:${SMOKE_WS_MAIN}:0`,
    `workstream:${SMOKE_WS_ZELLIJ}:0`,
    `sprint:${SMOKE_SPRINT_ZELLIJ}:1`,
    `agent:${SMOKE_AGENT}:2`,
  ])
})

test("flattenFleet: a db-only repo's sprint lists every agent in fleet order", () => {
  const rows = flattenFleet(fleet, E2E_KEY, expanded(E2E_WS, E2E_SPRINT))
  expect(shape(rows)).toEqual([
    `workstream:${E2E_WS}:0`,
    `sprint:${E2E_SPRINT}:1`,
    `agent:${E2E_A1}:2`,
    `agent:${E2E_A2}:2`,
    `agent:${E2E_A3}:2`,
    `agent:${E2E_A4}:2`,
  ])
  const wsRow = rows[0]
  if (wsRow?.kind !== "workstream") throw new Error("expected a workstream row")
  expect(wsRow.agentCount).toBe(4)
  const agentNames = rows.filter((r) => r.kind === "agent").map((r) => (r.kind === "agent" ? r.agent.name : ""))
  expect(agentNames).toEqual(["a1", "a2", "a3", "a4"])
})

test("flattenFleet: an unknown repo key yields no rows", () => {
  expect(flattenFleet(fleet, "/does/not/exist", expanded())).toEqual([])
})

test("flattenFleet: a registry-only key (no activated DB repo) yields no rows", () => {
  expect(flattenFleet(fleet, REGISTRY_ONLY_KEY, expanded(SMOKE_WS_MAIN))).toEqual([])
})

interface Row extends ListItem {
  readonly key: string
  readonly glyph: string
  readonly label: string
}

const ROWS: readonly Row[] = [
  { key: "a", glyph: "●", label: "alpha" },
  { key: "b", glyph: "○", label: "beta" },
  { key: "c", glyph: "◐", label: "gamma" },
]

const rowRenderRow = (r: Row): StyledText => t`${fg("#3fb950")(r.glyph)} ${r.label}`
const keyOf = (r: Row | undefined): string | undefined => r?.key

function lineWith(frame: string, needle: string): string {
  const line = frame.split("\n").find((l) => l.includes(needle))
  if (line === undefined) throw new Error(`no frame line contains ${JSON.stringify(needle)}`)
  return line
}

async function makeList(rows: readonly Row[], height = 8) {
  const setup = await createTestRenderer({ width: 40, height })
  const selections: Array<Row | undefined> = []
  const list = new ListRenderable<Row>(setup.renderer, {
    id: "list",
    flexGrow: 1,
    renderRow: rowRenderRow,
    onSelectionChange: (r) => selections.push(r),
  })
  setup.renderer.root.add(list)
  list.setRows(rows)
  await setup.renderOnce()
  return { ...setup, list, selections }
}

test("ListRenderable: rows render with glyphs and the first row is selected", async () => {
  const { renderer, captureCharFrame, list } = await makeList(ROWS)
  const frame = captureCharFrame()
  expect(frame).toContain("alpha")
  expect(frame).toContain("beta")
  expect(frame).toContain("gamma")
  expect(frame).toContain("●")
  expect(frame).toContain("○")
  expect(list.selected?.key).toBe("a")
  expect(lineWith(frame, "alpha")).toContain("❯")
  expect(lineWith(frame, "beta")).not.toContain("❯")
  expect(lineWith(frame, "gamma")).not.toContain("❯")
  renderer.destroy()
})

test("ListRenderable: move shifts the highlight and clamps at the ends", async () => {
  const { renderer, renderOnce, captureCharFrame, list } = await makeList(ROWS)

  list.move(1)
  await renderOnce()
  let frame = captureCharFrame()
  expect(list.selected?.key).toBe("b")
  expect(lineWith(frame, "beta")).toContain("❯")
  expect(lineWith(frame, "alpha")).not.toContain("❯")

  list.move(5) // clamps at the last row
  await renderOnce()
  frame = captureCharFrame()
  expect(list.selected?.key).toBe("c")
  expect(lineWith(frame, "gamma")).toContain("❯")

  list.move(-10) // clamps at the first row
  await renderOnce()
  frame = captureCharFrame()
  expect(list.selected?.key).toBe("a")
  expect(lineWith(frame, "alpha")).toContain("❯")
  renderer.destroy()
})

test("ListRenderable: the selection-changed callback fires only on real changes", async () => {
  const { renderer, list, selections } = await makeList(ROWS)
  expect(selections.map(keyOf)).toEqual(["a"]) // initial selection of the first row

  list.move(1)
  list.move(1)
  list.move(1) // already last → no change → no fire
  list.move(-1)
  expect(selections.map(keyOf)).toEqual(["a", "b", "c", "b"])
  renderer.destroy()
})

test("ListRenderable: setRows keeps the selected key across a reorder", async () => {
  const { renderer, renderOnce, captureCharFrame, list, selections } = await makeList(ROWS)
  list.move(1)
  expect(list.selected?.key).toBe("b")
  expect(selections.map(keyOf)).toEqual(["a", "b"])

  list.setRows([
    { key: "c", glyph: "◐", label: "gamma" },
    { key: "a", glyph: "●", label: "alpha" },
    { key: "b", glyph: "○", label: "beta" },
  ])
  await renderOnce()
  const frame = captureCharFrame()
  expect(list.selected?.key).toBe("b")
  expect(lineWith(frame, "beta")).toContain("❯")
  expect(lineWith(frame, "gamma")).not.toContain("❯")
  expect(selections.map(keyOf)).toEqual(["a", "b"]) // surviving key → no extra fire
  renderer.destroy()
})

test("ListRenderable: setRows clamps the selection when the selected key vanishes", async () => {
  const { renderer, renderOnce, list, selections } = await makeList(ROWS)
  list.move(1) // select "b" at index 1
  expect(list.selected?.key).toBe("b")

  list.setRows([
    { key: "a", glyph: "●", label: "alpha" },
    { key: "c", glyph: "◐", label: "gamma" },
  ])
  await renderOnce()
  expect(list.selected?.key).toBe("c") // index 1 clamped into the shorter list
  expect(selections.map(keyOf)).toEqual(["a", "b", "c"])
  renderer.destroy()
})

test("ListRenderable: setRows to an empty list clears the selection", async () => {
  const { renderer, renderOnce, list, selections } = await makeList(ROWS)
  list.setRows([])
  await renderOnce()
  expect(list.selected).toBeUndefined()
  expect(selections.at(-1)).toBeUndefined()
  renderer.destroy()
})

test("ListRenderable: move scrolls the selected row into view", async () => {
  const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
    key: `r${i}`,
    glyph: "●",
    label: `row-${String(i).padStart(2, "0")}`,
  }))
  const { renderer, renderOnce, captureCharFrame, list } = await makeList(rows, 6)
  expect(captureCharFrame()).toContain("row-00")

  for (let i = 0; i < 19; i++) list.move(1)
  await renderOnce()
  const frame = captureCharFrame()
  expect(list.selected?.key).toBe("r19")
  expect(frame).toContain("row-19")
  expect(frame).not.toContain("row-00")
  renderer.destroy()
})

test("ListRenderable: setRows re-scrolls a reordered selection back into view", async () => {
  const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
    key: `r${i}`,
    glyph: "●",
    label: `row-${String(i).padStart(2, "0")}`,
  }))
  const { renderer, renderOnce, captureCharFrame, list } = await makeList(rows, 6)
  expect(list.selected?.key).toBe("r0")
  expect(captureCharFrame()).toContain("row-00")

  // A poll reorder moves the selected row (r0) to the far bottom, outside the viewport.
  list.setRows([...rows.slice(1), rows[0]!])
  await renderOnce()

  const frame = captureCharFrame()
  expect(list.selected?.key).toBe("r0")
  expect(frame).toContain("row-00")
  expect(lineWith(frame, "row-00")).toContain("❯")
  renderer.destroy()
})

test("ListRenderable: renders a flattenFleet tree with theme glyphs and indentation", async () => {
  const treeRenderRow = (row: TreeRow): StyledText => {
    const indent = "  ".repeat(row.depth)
    if (row.kind === "agent") {
      const glyph = AGENT_STATE_GLYPHS[row.agent.state]
      return t`${indent}${fg(AGENT_STATE_COLORS[row.agent.state])(glyph)} ${row.agent.name}`
    }
    if (row.kind === "sprint") return t`${indent}${row.expanded ? "▾" : "▸"} ${row.sprint.name}`
    return t`${indent}${row.expanded ? "▾" : "▸"} ${row.workstream.name}`
  }

  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 44, height: 10 })
  const tree = new ListRenderable<TreeRow>(renderer, { id: "tree", flexGrow: 1, renderRow: treeRenderRow })
  renderer.root.add(tree)
  tree.setRows([...flattenFleet(fleet, E2E_KEY, expanded(E2E_WS, E2E_SPRINT))])
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("a1")
  expect(frame).toContain("a4")
  expect(frame).toContain("●") // working-state glyph
  expect(frame).toContain("▾ main")
  renderer.destroy()
})
