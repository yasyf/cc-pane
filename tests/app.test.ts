import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { buildApp, type FleetSource, type GraphSource } from "../src/app.ts"
import { DaemonUnreachableError } from "../src/data/cco.ts"
import { parseFleetStatus, type Capture, type FleetStatus, type NotesEvent, type NotesGraph } from "../src/model.ts"
import type { PollerClock } from "../src/data/poller.ts"

const fleetRaw: unknown = await Bun.file(`${import.meta.dir}/fixtures/fleet-status.json`).json()
const E2E_A1 = "4f7f07ba-5c9e-4f38-b0bc-d8ccc12dfcd8"
const E2E_A2 = "17cff5e2-2e2b-473b-8b18-6046e6268257"

// The fixture is all-exited; promote a1 to active so drill-in actually fetches capture.
function activeFleet(): FleetStatus {
  const clone = structuredClone(fleetRaw) as { agents: Array<{ id: string; status: string }> }
  const a1 = clone.agents.find((a) => a.id === E2E_A1)
  if (!a1) throw new Error("a1 missing from fixture")
  a1.status = "active"
  return parseFleetStatus(clone)
}

// activeFleet with the e2e-chan repo renamed, so two poll responses are visibly distinct.
function fleetNamed(repoName: string): FleetStatus {
  const clone = structuredClone(fleetRaw) as {
    agents: Array<{ id: string; status: string }>
    repos: Array<{ name: string }>
  }
  const a1 = clone.agents.find((a) => a.id === E2E_A1)
  if (!a1) throw new Error("a1 missing from fixture")
  a1.status = "active"
  const repo = clone.repos.find((r) => r.name === "e2e-chan")
  if (!repo) throw new Error("e2e-chan repo missing from fixture")
  repo.name = repoName
  return parseFleetStatus(clone)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// A timeline event on a1's "main" branch, so the default filter keeps it.
function notesEvent(title: string): NotesEvent {
  return {
    entity: { kind: "task", id: "task-x", short: "task-x", title },
    type: "created",
    time: 1784285930,
    branch: "main",
    sha: "",
    detail: "",
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function manualClock(): PollerClock {
  return { now: () => 0, every: () => () => {} }
}

interface AppOpts {
  fleetStatus?: () => Promise<FleetStatus>
  graph?: () => Promise<NotesGraph>
  onQuit?: () => void
}

async function makeApp(opts: AppOpts = {}) {
  const setup = await createTestRenderer({ width: 92, height: 30 })
  const captureCalls: string[] = []
  const cco: FleetSource = {
    fleetStatus: opts.fleetStatus ?? (async () => activeFleet()),
    capture: async (id) => {
      captureCalls.push(id)
      return { id, content: `SCREEN ${captureCalls.length}`, capturedAt: "2026-07-18T00:00:00Z" } satisfies Capture
    },
  }
  const viz: GraphSource = {
    serverFor: async () => ({ graph: opts.graph ?? (async () => ({ events: [] })) }),
    stopAll: async () => {},
  }
  let quit = 0
  const handle = buildApp(setup.renderer, {
    cco,
    viz,
    pollIntervalMs: 2000,
    timeZone: "UTC",
    clock: manualClock(),
    onQuit: opts.onQuit ?? (() => quit++),
  })
  return { ...setup, handle, captureCalls, quitCount: () => quit }
}

// tab → tree, expand workstream, move to sprint, expand, move to a1, drill.
async function drillToA1(handle: { route: (k: string) => void }, renderOnce: () => Promise<void>): Promise<void> {
  handle.route("tab")
  handle.route("return")
  handle.route("j")
  handle.route("return")
  handle.route("j")
  handle.route("return")
  await settle()
  await renderOnce()
}

test("enter drills into the selected agent; esc returns to the fleet view", async () => {
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp()
  await handle.refreshFleet()
  await renderOnce()
  expect(handle.currentView()).toEqual({ view: "fleet" })

  await drillToA1(handle, renderOnce)
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A1 })
  expect(captureCharFrame()).toContain("s to refresh")

  handle.route("escape")
  await renderOnce()
  expect(handle.currentView()).toEqual({ view: "fleet" })
  expect(captureCharFrame()).toContain("repos")
  renderer.destroy()
})

test("keys route to the active view: 'a' toggles the timeline filter in the agent view", async () => {
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp()
  await handle.refreshFleet()
  await drillToA1(handle, renderOnce)

  handle.route("a")
  await renderOnce()
  expect(captureCharFrame()).toContain("all-repo events")
  renderer.destroy()
})

test("'s' refetches the snapshot, hitting the capture source again", async () => {
  const { renderer, renderOnce, handle, captureCalls } = await makeApp()
  await handle.refreshFleet()
  await drillToA1(handle, renderOnce)
  expect(captureCalls[0]).toBe(E2E_A1)
  const before = captureCalls.length

  handle.route("s")
  await settle()
  expect(captureCalls.length).toBe(before + 1)
  expect(captureCalls.at(-1)).toBe(E2E_A1)
  renderer.destroy()
})

test("'q' fires the quit callback the entry point provides", async () => {
  const { renderer, handle, quitCount } = await makeApp()
  handle.route("q")
  expect(quitCount()).toBe(1)
  renderer.destroy()
})

test("the central keyInput router handles real key presses", async () => {
  let quit = 0
  const { renderer, mockInput } = await makeApp({ onQuit: () => quit++ })
  mockInput.pressKey("q")
  expect(quit).toBe(1)
  renderer.destroy()
})

test("a failed poll shows the daemon-unreachable header while stale data stays rendered", async () => {
  let calls = 0
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({
    fleetStatus: async () => {
      calls += 1
      if (calls === 1) return activeFleet()
      throw new DaemonUnreachableError("cco.fleet.status")
    },
  })
  await handle.refreshFleet()
  await renderOnce()
  let frame = captureCharFrame()
  expect(frame).toContain("daemon ok")
  expect(frame).toContain("e2e-chan")

  await handle.refreshFleet()
  await renderOnce()
  frame = captureCharFrame()
  expect(frame).toContain("daemon unreachable")
  expect(frame).toContain("e2e-chan") // last good snapshot still on screen
  renderer.destroy()
})

test("a schema-mismatch poll shows the bad-response header with the parse message, not unreachable", async () => {
  let calls = 0
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({
    fleetStatus: async () => {
      calls += 1
      if (calls === 1) return activeFleet()
      throw new Error("fleetStatus.registry: expected array, got undefined")
    },
  })
  await handle.refreshFleet()
  await renderOnce()
  await handle.refreshFleet()
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("bad response: fleetStatus.registry")
  expect(frame).not.toContain("daemon unreachable")
  expect(frame).toContain("e2e-chan") // last good snapshot still on screen
  renderer.destroy()
})

test("ctrl-c routes through the central router to the quit callback", async () => {
  let quit = 0
  const { renderer, mockInput } = await makeApp({ onQuit: () => quit++ })
  mockInput.pressKey("c", { ctrl: true })
  expect(quit).toBe(1)
  renderer.destroy()
})

test("a modified key other than ctrl+c is ignored, never collapsed onto a plain command", async () => {
  let quit = 0
  const { renderer, mockInput } = await makeApp({ onQuit: () => quit++ })
  mockInput.pressKey("q", { ctrl: true }) // ctrl+q must not quit
  expect(quit).toBe(0)
  mockInput.pressKey("c", { ctrl: true }) // ctrl+c still quits
  expect(quit).toBe(1)
  renderer.destroy()
})

test("the newest fleet poll wins even when an older request resolves later", async () => {
  const older = deferred<FleetStatus>()
  const newer = deferred<FleetStatus>()
  let call = 0
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({
    fleetStatus: async () => {
      call += 1
      return call === 1 ? older.promise : newer.promise
    },
  })

  const p1 = handle.refreshFleet() // stamped id 1
  const p2 = handle.refreshFleet() // stamped id 2

  newer.resolve(fleetNamed("newer-fleet"))
  await p2
  await renderOnce()
  expect(captureCharFrame()).toContain("newer-fleet")

  older.resolve(fleetNamed("older-fleet"))
  await p1
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("newer-fleet")
  expect(frame).not.toContain("older-fleet")
  renderer.destroy()
})

test("a late timeline result from a prior drill never lands in the current agent view", async () => {
  const staleGraph = deferred<NotesGraph>()
  let graphCall = 0
  const graph = async (): Promise<NotesGraph> => {
    graphCall += 1
    if (graphCall === 1) return staleGraph.promise
    return { events: [notesEvent("BBB-FRESH")] }
  }
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({ graph })
  await handle.refreshFleet()
  await renderOnce()

  // Drill a1: its initial timeline fetch stays pending.
  await drillToA1(handle, renderOnce)
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A1 })

  // Back out and drill a fresh view (a2), whose timeline resolves with a distinct title.
  handle.route("escape")
  await renderOnce()
  handle.route("j")
  handle.route("return")
  await settle()
  await renderOnce()
  await renderOnce()
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A2 })
  expect(captureCharFrame()).toContain("BBB-FRESH")

  // The first drill's fetch finally resolves — the stale result must be dropped.
  staleGraph.resolve({ events: [notesEvent("AAA-STALE")] })
  await settle()
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("BBB-FRESH")
  expect(frame).not.toContain("AAA-STALE")
  renderer.destroy()
})

test("a timeline failure that isn't notes-unavailable renders the error message", async () => {
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({
    graph: async () => {
      throw new Error("graph exploded")
    },
  })
  await handle.refreshFleet()
  await drillToA1(handle, renderOnce)
  await settle()
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("timeline error: graph exploded")
  expect(frame).not.toContain("timeline unavailable")
  renderer.destroy()
})

test("an unreachable daemon on first load renders the header state with an empty fleet", async () => {
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({
    fleetStatus: async () => {
      throw new DaemonUnreachableError("cco.fleet.status")
    },
  })
  await handle.refreshFleet()
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("daemon unreachable")
  expect(frame).not.toContain("e2e-chan")
  renderer.destroy()
})

test("footer hints change between the fleet and agent views", async () => {
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp()
  await handle.refreshFleet()
  await renderOnce()
  expect(captureCharFrame()).toContain("tab pane")

  await drillToA1(handle, renderOnce)
  expect(captureCharFrame()).toContain("esc back")
  renderer.destroy()
})
