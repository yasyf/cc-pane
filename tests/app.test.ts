import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { buildApp, type FleetSource, type GraphSource } from "../src/app.ts"
import { PromptRenderable } from "../src/components/prompt.ts"
import { DaemonUnreachableError, XrpcError } from "../src/data/cco.ts"
import {
  parseFleetStatus,
  type Capture,
  type FleetStatus,
  type KillResult,
  type MessageReceipt,
  type NotesEvent,
  type NotesGraph,
  type RespawnResult,
} from "../src/model.ts"
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

type RawFleet = {
  agents: Array<{ id: string; status: string; backend: string }>
  repos: Array<{ name: string }>
}

function patchAgent(clone: RawFleet, id: string, patch: { status?: string; backend?: string }): void {
  const agent = clone.agents.find((a) => a.id === id)
  if (!agent) throw new Error(`agent ${id} missing from fixture`)
  if (patch.status !== undefined) agent.status = patch.status
  if (patch.backend !== undefined) agent.backend = patch.backend
}

// a1 active (its repo sorts first, so the tree is navigable); a2 patched for eligibility tests.
function fleetWithA2(patch: { status?: string; backend?: string }): FleetStatus {
  const clone = structuredClone(fleetRaw) as RawFleet
  patchAgent(clone, E2E_A1, { status: "active" })
  patchAgent(clone, E2E_A2, { status: patch.status ?? "exited", backend: patch.backend })
  return parseFleetStatus(clone)
}

// a1 active with a pinned backend, for attach-eligibility tests on a1 itself.
function fleetA1(patch: { backend?: string }): FleetStatus {
  const clone = structuredClone(fleetRaw) as RawFleet
  patchAgent(clone, E2E_A1, { status: "active", backend: patch.backend })
  return parseFleetStatus(clone)
}

// Select a1's tree row without drilling in (drillToA1 minus the final return).
function selectA1(handle: { route: (k: string) => void }): void {
  handle.route("tab")
  handle.route("return")
  handle.route("j")
  handle.route("return")
  handle.route("j")
}

// a2 is the row right after a1 in the same sprint.
function selectA2(handle: { route: (k: string) => void }): void {
  selectA1(handle)
  handle.route("j")
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
  kill?: (id: string) => Promise<KillResult>
  sendMessage?: (id: string, text: string) => Promise<MessageReceipt>
  respawn?: (id: string) => Promise<RespawnResult>
  attach?: (id: string) => Promise<{ code: number; stderr: string }>
}

async function makeApp(opts: AppOpts = {}) {
  const setup = await createTestRenderer({ width: 92, height: 30 })
  const captureCalls: string[] = []
  const killCalls: string[] = []
  const messageCalls: Array<[string, string]> = []
  const respawnCalls: string[] = []
  const attachCalls: string[] = []
  let fleetStatusCalls = 0
  const fleetStatus = opts.fleetStatus ?? (async () => activeFleet())
  const cco: FleetSource = {
    fleetStatus: async () => {
      fleetStatusCalls += 1
      return fleetStatus()
    },
    capture: async (id) => {
      captureCalls.push(id)
      return { id, content: `SCREEN ${captureCalls.length}`, capturedAt: "2026-07-18T00:00:00Z" } satisfies Capture
    },
    kill: async (id) => {
      killCalls.push(id)
      return opts.kill ? opts.kill(id) : ({ id, status: "killed" } satisfies KillResult)
    },
    sendMessage: async (id, text) => {
      messageCalls.push([id, text])
      return opts.sendMessage ? opts.sendMessage(id, text) : ({ seq: messageCalls.length } satisfies MessageReceipt)
    },
    respawn: async (id) => {
      respawnCalls.push(id)
      return opts.respawn ? opts.respawn(id) : ({ respawned: [] } satisfies RespawnResult)
    },
  }
  const viz: GraphSource = {
    serverFor: async () => ({ graph: opts.graph ?? (async () => ({ events: [] })) }),
    stopAll: async () => {},
  }
  const attach = async (id: string) => {
    attachCalls.push(id)
    return opts.attach ? opts.attach(id) : { code: 0, stderr: "" }
  }
  let quit = 0
  const handle = buildApp(setup.renderer, {
    cco,
    viz,
    attach,
    pollIntervalMs: 2000,
    timeZone: "UTC",
    clock: manualClock(),
    onQuit: opts.onQuit ?? (() => quit++),
  })
  return {
    ...setup,
    handle,
    captureCalls,
    killCalls,
    messageCalls,
    respawnCalls,
    attachCalls,
    fleetStatusCalls: () => fleetStatusCalls,
    quitCount: () => quit,
  }
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

test("both footers advertise the write actions", async () => {
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp()
  await handle.refreshFleet()
  await renderOnce()
  let frame = captureCharFrame()
  expect(frame).toContain("x kill")
  expect(frame).toContain("t attach")

  await drillToA1(handle, renderOnce)
  frame = captureCharFrame()
  expect(frame).toContain("x kill")
  expect(frame).toContain("t attach")
  renderer.destroy()
})

test("x opens a confirm modal; y kills the selected agent and refetches the fleet", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, killCalls, fleetStatusCalls } = await makeApp()
  await handle.refreshFleet()
  const before = fleetStatusCalls()
  selectA1(handle)

  handle.route("x")
  await renderOnce()
  let frame = captureCharFrame()
  expect(frame).toContain("kill a1?")
  expect(frame).toContain("y confirm")

  handle.route("y")
  await settle()
  await renderOnce()
  expect(killCalls).toEqual([E2E_A1])
  frame = captureCharFrame()
  expect(frame).toContain("killed a1")
  expect(fleetStatusCalls()).toBe(before + 1)
  renderer.destroy()
})

test("a confirm modal swallows navigation keys; the list resumes after cancel", async () => {
  const { renderer, renderOnce, handle, killCalls } = await makeApp()
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("x") // confirm open on a1
  handle.route("j") // swallowed by the modal
  handle.route("j") // swallowed by the modal
  handle.route("n") // cancel
  await renderOnce()
  expect(killCalls).toEqual([]) // cancel never kills

  // The j's were eaten, so the selection is still a1: drilling now lands on a1.
  handle.route("return")
  await settle()
  await renderOnce()
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A1 })

  // The list moves again after cancel: back out, j to a2, drill.
  handle.route("escape")
  await renderOnce()
  handle.route("j")
  handle.route("return")
  await settle()
  await renderOnce()
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A2 })
  renderer.destroy()
})

test("x on a non-active row flashes without opening a modal", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, killCalls } = await makeApp({
    fleetStatus: async () => fleetWithA2({ status: "killed" }),
  })
  await handle.refreshFleet()
  selectA2(handle) // a2 is killed

  handle.route("x")
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("kill: agent not active")
  expect(frame).not.toContain("y confirm") // no modal
  expect(killCalls).toEqual([])
  renderer.destroy()
})

test("r flashes on a killed row but confirms and respawns an exited one", async () => {
  const killed = await makeApp({ fleetStatus: async () => fleetWithA2({ status: "killed" }) })
  await killed.handle.refreshFleet()
  selectA2(killed.handle)
  killed.handle.route("r")
  await killed.renderOnce()
  expect(killed.captureCharFrame()).toContain("respawn: agent not exited")
  expect(killed.respawnCalls).toEqual([])
  killed.renderer.destroy()

  const exited = await makeApp({ fleetStatus: async () => fleetWithA2({ status: "exited" }) })
  await exited.handle.refreshFleet()
  selectA2(exited.handle)
  exited.handle.route("r")
  await exited.renderOnce()
  expect(exited.captureCharFrame()).toContain("respawn a2?")
  exited.handle.route("y")
  await settle()
  expect(exited.respawnCalls).toEqual([E2E_A2])
  exited.renderer.destroy()
})

test("an action with no agent selected flashes", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, killCalls } = await makeApp()
  await handle.refreshFleet()
  await renderOnce()
  // Initial state: the tree's selected row is a workstream, not an agent.
  handle.route("x")
  await renderOnce()
  expect(captureCharFrame()).toContain("no agent selected")
  expect(killCalls).toEqual([])
  renderer.destroy()
})

test("actions fire from the agent view too", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, killCalls } = await makeApp()
  await handle.refreshFleet()
  await drillToA1(handle, renderOnce)
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A1 })

  handle.route("x")
  await renderOnce()
  expect(captureCharFrame()).toContain("kill a1?")
  handle.route("y")
  await settle()
  expect(killCalls).toEqual([E2E_A1])
  renderer.destroy()
})

test("m opens a prompt; typed keys feed the input while the tree stays put", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, mockInput } = await makeApp()
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("m")
  await renderOnce()
  // Nav keys typed into the prompt land in the input, never the tree.
  await mockInput.typeText("jk")
  await renderOnce()
  expect(captureCharFrame()).toContain("jk")

  handle.route("escape")
  await renderOnce()
  // Selection never moved: drilling lands on a1, not a2.
  handle.route("return")
  await settle()
  await renderOnce()
  expect(handle.currentView()).toEqual({ view: "agent", agentId: E2E_A1 })
  renderer.destroy()
})

test("the key that opens the prompt never leaks into the freshly-focused input", async () => {
  const { renderer, renderOnce, handle, messageCalls, mockInput } = await makeApp()
  await handle.refreshFleet()
  selectA1(handle)

  // Pressing "m" opens the prompt and focuses its input mid-dispatch; that same "m"
  // must not fall through into the input during the renderable phase.
  mockInput.pressKey("m")
  await renderOnce()
  const prompt = renderer.root.findDescendantById("prompt-overlay")
  if (!(prompt instanceof PromptRenderable)) throw new Error("prompt overlay not open")
  expect(prompt.value).toBe("")

  await mockInput.typeText("ping")
  mockInput.pressEnter()
  await settle()
  expect(messageCalls).toEqual([[E2E_A1, "ping"]])
  renderer.destroy()
})

test("prompt return submits the typed message with the agent id, then closes with a flash", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, messageCalls, mockInput } = await makeApp()
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("m")
  await renderOnce()
  await mockInput.typeText("hello")
  mockInput.pressEnter()
  await settle()
  await renderOnce()
  expect(messageCalls).toEqual([[E2E_A1, "hello"]])
  const frame = captureCharFrame()
  expect(frame).toContain("sent to a1")
  expect(frame).not.toContain("message a1") // prompt closed
  renderer.destroy()
})

test("prompt escape closes without sending", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, messageCalls } = await makeApp()
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("m")
  await renderOnce()
  expect(captureCharFrame()).toContain("message a1")

  handle.route("escape")
  await renderOnce()
  expect(messageCalls).toEqual([])
  expect(captureCharFrame()).not.toContain("message a1")
  renderer.destroy()
})

test("an empty prompt submit closes silently without sending", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, messageCalls, mockInput } = await makeApp()
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("m")
  await renderOnce()
  mockInput.pressEnter() // empty input
  await settle()
  await renderOnce()
  expect(messageCalls).toEqual([])
  expect(captureCharFrame()).not.toContain("message a1") // closed
  renderer.destroy()
})

test("a sendMessage rejection surfaces the server message as a flash", async () => {
  const { renderer, renderOnce, captureCharFrame, handle, mockInput } = await makeApp({
    sendMessage: async () => {
      throw new XrpcError("Conflict", 409, "agent has no subject")
    },
  })
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("m")
  await renderOnce()
  await mockInput.typeText("hello")
  mockInput.pressEnter()
  await settle()
  await renderOnce()
  expect(captureCharFrame()).toContain("agent has no subject")
  renderer.destroy()
})

test("t attaches: suspend before attach before resume, keys inert while pending, fleet refetched, clean exit is silent", async () => {
  const attachGate = deferred<{ code: number; stderr: string }>()
  const events: string[] = []
  const { renderer, renderOnce, captureCharFrame, handle, attachCalls, fleetStatusCalls } = await makeApp({
    attach: async () => {
      events.push("attach")
      return attachGate.promise
    },
  })
  renderer.suspend = () => events.push("suspend")
  renderer.resume = () => events.push("resume")
  await handle.refreshFleet()
  const beforeFleet = fleetStatusCalls()
  selectA1(handle) // a1 active, tmux

  handle.route("t")
  handle.route("j") // inert: overlay swallows
  handle.route("t") // inert: no second attach
  expect(attachCalls).toEqual([E2E_A1])
  expect(events).toEqual(["suspend", "attach"])

  attachGate.resolve({ code: 0, stderr: "" })
  await settle()
  await renderOnce()
  expect(events).toEqual(["suspend", "attach", "resume"])
  expect(fleetStatusCalls()).toBe(beforeFleet + 1)
  const frame = captureCharFrame()
  expect(frame).not.toContain("attach failed")
  expect(frame).toContain("t attach") // hints restored, no flash
  renderer.destroy()
})

test("a nonzero attach exit flashes the stderr", async () => {
  const events: string[] = []
  const { renderer, renderOnce, captureCharFrame, handle } = await makeApp({
    attach: async () => ({ code: 1, stderr: "tmux: no server running" }),
  })
  renderer.suspend = () => events.push("suspend")
  renderer.resume = () => events.push("resume")
  await handle.refreshFleet()
  selectA1(handle)

  handle.route("t")
  await settle()
  await renderOnce()
  expect(events).toEqual(["suspend", "resume"])
  expect(captureCharFrame()).toContain("attach failed: tmux: no server running")
  renderer.destroy()
})

test("t on a non-attachable backend flashes and never suspends", async () => {
  const events: string[] = []
  const { renderer, renderOnce, captureCharFrame, handle, attachCalls } = await makeApp({
    fleetStatus: async () => fleetA1({ backend: "cmux" }),
  })
  renderer.suspend = () => events.push("suspend")
  await handle.refreshFleet()
  selectA1(handle) // a1 active, backend cmux

  handle.route("t")
  await renderOnce()
  expect(attachCalls).toEqual([])
  expect(events).toEqual([]) // never suspended
  expect(captureCharFrame()).toContain("attach: agent not attachable")
  renderer.destroy()
})
