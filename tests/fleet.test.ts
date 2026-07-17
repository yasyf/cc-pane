import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { FleetView, repoListRows } from "../src/views/fleet.ts"
import { parseFleetStatus } from "../src/model.ts"

const fleetRaw: unknown = await Bun.file(`${import.meta.dir}/fixtures/fleet-status.json`).json()
const fleet = parseFleetStatus(fleetRaw)

const E2E_KEY = "/private/tmp/cco-e2e.Jw7r"
const E2E_A1 = "4f7f07ba-5c9e-4f38-b0bc-d8ccc12dfcd8"
const SMOKE_ZELLIJ_KEY = "/tmp/cco-smoke-zellij"
const SMOKE_37998_AGENT = "7eef08e7-4cb0-48f8-8a82-4cd8397e60a8"

function lineWith(frame: string, needle: string): string {
  const line = frame.split("\n").find((l) => l.includes(needle))
  if (line === undefined) throw new Error(`no frame line contains ${JSON.stringify(needle)}`)
  return line
}

async function makeView(height = 32) {
  const setup = await createTestRenderer({ width: 90, height })
  const drills: string[] = []
  const view = new FleetView(setup.renderer, { id: "fleet", onDrillIn: (id) => drills.push(id) })
  setup.renderer.root.add(view)
  view.setFleet(fleet)
  await setup.renderOnce()
  return { ...setup, view, drills }
}

test("repoListRows: working repos float first, registry-only dims to the bottom", () => {
  const names = repoListRows(fleet).map((r) => r.repoRow.name)
  expect(names[0]).toBe("e2e-chan") // 3 working agents
  expect(names[1]).toBe("smoke-37998") // 1 working agent
  expect(names.at(-2)).toBe("cc-notes") // registry-only, alpha
  expect(names.at(-1)).toBe("ugh") // registry-only, alpha
  // a stuck (active) repo ranks above an idle-only repo
  expect(names.indexOf("cco-smoke-zellij")).toBeLessThan(names.indexOf("tokval2-cmux"))
  expect(names.indexOf("final-cmux")).toBeLessThan(names.indexOf("tokval2-cmux"))
})

test("repoListRows: per-state badge counts come from the chain-joined agents", () => {
  const rows = repoListRows(fleet)
  const e2e = rows.find((r) => r.key === E2E_KEY)
  if (!e2e) throw new Error("e2e-chan row missing")
  expect(e2e.counts.working).toBe(3)
  expect(e2e.counts.idle).toBe(1)
  expect(e2e.counts.stuck).toBe(0)

  const zellij = rows.find((r) => r.key === SMOKE_ZELLIJ_KEY)
  if (!zellij) throw new Error("cco-smoke-zellij row missing")
  expect(zellij.counts.stuck).toBe(1)
  expect(zellij.counts.working).toBe(0)

  const ccNotes = rows.find((r) => r.repoRow.name === "cc-notes")
  if (!ccNotes) throw new Error("cc-notes row missing")
  expect(ccNotes.repoRow.kind).toBe("registry-only")
})

test("the selected repo row renders its per-state badges", async () => {
  const { renderer, captureCharFrame, view } = await makeView()
  expect(view.selectedRepoKey).toBe(E2E_KEY) // first row selected on load
  const line = lineWith(captureCharFrame(), "3●") // the selected left-pane data row
  expect(line).toContain("e2e-chan")
  expect(line).toContain("1○") // 3 working (green ●), 1 idle (grey ○) in badge order
  expect(line).toContain("❯") // and it is the selected row
  renderer.destroy()
})

test("tab switches panes; the router's methods never fire keys themselves", async () => {
  const { renderer, view } = await makeView()
  expect(view.focusedPane).toBe("repos")
  view.switchPane()
  expect(view.focusedPane).toBe("tree")
  view.switchPane()
  expect(view.focusedPane).toBe("repos")
  renderer.destroy()
})

test("expanding the tree and activating an agent drills in via the callback", async () => {
  const { renderer, renderOnce, view, drills } = await makeView()
  view.switchPane() // focus the tree
  view.toggleExpand() // expand e2e-chan's workstream → sprint appears
  view.moveSelection(1) // move onto the sprint
  view.toggleExpand() // expand the sprint → its agents appear
  view.moveSelection(1) // move onto the first agent (a1)
  await renderOnce()

  expect(view.selectedAgentId()).toBe(E2E_A1)
  view.activate()
  expect(drills).toEqual([E2E_A1])
  renderer.destroy()
})

test("activate from the repo pane focuses the tree instead of drilling", async () => {
  const { renderer, view, drills } = await makeView()
  view.activate() // repos focused → no agent under cursor
  expect(view.focusedPane).toBe("tree")
  expect(drills).toEqual([])
  renderer.destroy()
})

test("setFleet keeps the selected repo by path across a sort reorder", async () => {
  const { renderer, renderOnce, view } = await makeView()
  view.moveSelection(1) // e2e-chan → smoke-37998
  view.moveSelection(1) // → cco-smoke-zellij
  expect(view.selectedRepoKey).toBe(SMOKE_ZELLIJ_KEY)

  // Demote smoke-37998 to idle: it leaves the working group, so cco-smoke-zellij floats up.
  const reordered = structuredClone(fleetRaw) as { agents: Array<{ id: string; state: string }> }
  const agent = reordered.agents.find((a) => a.id === SMOKE_37998_AGENT)
  if (!agent) throw new Error("smoke-37998 agent missing")
  agent.state = "idle"
  const reorderedFleet = parseFleetStatus(reordered)
  expect(repoListRows(reorderedFleet)[1]?.repoRow.name).toBe("cco-smoke-zellij") // was index 2

  view.setFleet(reorderedFleet)
  await renderOnce()
  expect(view.selectedRepoKey).toBe(SMOKE_ZELLIJ_KEY) // preserved despite the reorder
  renderer.destroy()
})
