import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { AgentView, filterEvents } from "../src/views/agent.ts"
import { CaptureConflictError } from "../src/data/cco.ts"
import type {
  AgentRepoChain,
  AgentView as AgentModel,
  Capture,
  NotesEvent,
  NotesEventType,
  RepoView,
  SprintView,
  WorkstreamView,
} from "../src/model.ts"

function makeChain(
  over: {
    agent?: Partial<AgentModel>
    sprint?: Partial<SprintView>
    workstream?: Partial<WorkstreamView>
  } = {},
): AgentRepoChain {
  const agent: AgentModel = {
    id: "ag",
    name: "impl-agent",
    sprintId: "sp",
    backend: "tmux",
    terminalHandle: "t1",
    status: "active",
    state: "working",
    activity: "editing auth.ts",
    tokens: 12300,
    prompt: "",
    updatedAt: "",
    createdAt: "",
    sessionId: "",
    subjectId: "",
    scope: "",
    ccnotesTask: "task-1",
    restartCount: 0,
    lastRestartAt: "",
    ...over.agent,
  }
  const sprint: SprintView = {
    id: "sp",
    workstreamId: "ws",
    name: "sprint-1",
    ccnotesSprint: "sprint-1",
    status: "active",
    createdAt: "",
    ...over.sprint,
  }
  const workstream: WorkstreamView = {
    id: "ws",
    repoId: "repo",
    name: "feature-x",
    backend: "tmux",
    workspaceHandle: "h",
    branch: "feature-x",
    worktree: "wt",
    isPrimary: false,
    ccnotesProject: "proj-1",
    status: "active",
    createdAt: "",
    ...over.workstream,
  }
  const repo: RepoView = { id: "repo", name: "cc-pane", backend: "tmux", cwd: "/repo", status: "active", createdAt: "" }
  return { agent, sprint, workstream, repo }
}

function evt(over: {
  id?: string
  title?: string
  branch?: string
  type?: NotesEventType
  time?: number
  detail?: string
}): NotesEvent {
  return {
    entity: { kind: "task", id: over.id ?? "e", short: over.id ?? "e", title: over.title ?? "an event" },
    type: over.type ?? "created",
    time: over.time ?? 1784285930,
    branch: over.branch ?? "feature-x",
    sha: "",
    detail: over.detail ?? "",
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function makeAgentView(chain: AgentRepoChain, now: () => number = () => 0, timeZone = "UTC", height = 24) {
  const setup = await createTestRenderer({ width: 80, height })
  const view = new AgentView(setup.renderer, { id: "agent", chain, timeZone, now })
  setup.renderer.root.add(view)
  await setup.renderOnce()
  return { ...setup, view }
}

test("filterEvents keeps branch matches and each entity-id match, drops the rest", () => {
  const chain = makeChain()
  const events: NotesEvent[] = [
    evt({ branch: "feature-x", id: "unrelated", title: "branch-hit" }),
    evt({ branch: "main", id: "task-1", title: "task-hit" }),
    evt({ branch: "main", id: "sprint-1", title: "sprint-hit" }),
    evt({ branch: "main", id: "proj-1", title: "project-hit" }),
    evt({ branch: "main", id: "nope", title: "no-hit" }),
  ]
  const kept = filterEvents(events, chain)
  expect(kept.map((e) => e.entity.title)).toEqual(["branch-hit", "task-hit", "sprint-hit", "project-hit"])
})

test("filterEvents never matches on empty entity ids", () => {
  const chain = makeChain({ agent: { ccnotesTask: "" }, sprint: { ccnotesSprint: "" }, workstream: { ccnotesProject: "", branch: "feature-x" } })
  const kept = filterEvents([evt({ branch: "main", id: "", title: "empty-id" })], chain)
  expect(kept).toEqual([])
})

test("captured snapshot renders content, header, and the pinned age", async () => {
  const chain = makeChain({ agent: { status: "active", state: "working", tokens: 12300 } })
  const now = () => Date.parse("2026-07-18T00:00:05Z")
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain, now)
  await view.loadCapture(async () => ({ id: "ag", content: "THE SCREEN TEXT", capturedAt: "2026-07-18T00:00:00Z" }))
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("THE SCREEN TEXT")
  expect(frame).toContain("working")
  expect(frame).toContain("12.3k tok")
  expect(frame).toContain("captured 5s ago")
  expect(frame).toContain("s to refresh")
  renderer.destroy()
})

test("an exited agent renders the placeholder and never fetches capture", async () => {
  const chain = makeChain({ agent: { status: "exited" } })
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  let calls = 0
  await view.loadCapture(async (id) => {
    calls += 1
    return { id, content: "SHOULD NOT APPEAR", capturedAt: "2026-07-18T00:00:00Z" }
  })
  await renderOnce()

  expect(calls).toBe(0)
  const frame = captureCharFrame()
  expect(frame).toContain("agent exited")
  expect(frame).not.toContain("SHOULD NOT APPEAR")
  renderer.destroy()
})

test("a capture Conflict from a race renders the exited placeholder", async () => {
  const chain = makeChain({ agent: { status: "active" } })
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  await view.loadCapture(async () => {
    throw new CaptureConflictError("ag", "agent ag is exited, not active")
  })
  await renderOnce()

  expect(captureCharFrame()).toContain("agent exited")
  renderer.destroy()
})

test("loadCapture commits only the newest call when two overlap", async () => {
  const chain = makeChain({ agent: { status: "active" } })
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)

  const first = deferred<Capture>()
  const second = deferred<Capture>()
  const p1 = view.loadCapture(() => first.promise)
  const p2 = view.loadCapture(() => second.promise)

  // The newer call resolves first and commits; the older one resolves last and is dropped.
  second.resolve({ id: "ag", content: "NEWER-SCREEN", capturedAt: "2026-07-18T00:00:00Z" })
  await p2
  first.resolve({ id: "ag", content: "STALE-SCREEN", capturedAt: "2026-07-18T00:00:00Z" })
  await p1
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("NEWER-SCREEN")
  expect(frame).not.toContain("STALE-SCREEN")
  renderer.destroy()
})

test("timeline events render UTC time, glyph, title, and detail", async () => {
  const chain = makeChain()
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  view.setNotes({
    events: [evt({ id: "task-1", title: "implement auth", type: "claimed", time: 1784285930, branch: "main", detail: "open to progress" })],
  })
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("10:58") // 1784285930 in UTC
  expect(frame).toContain("implement auth")
  expect(frame).toContain("open to progress")
  renderer.destroy()
})

test("the filter hides whole-repo events until toggled off", async () => {
  const chain = makeChain()
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  view.setNotes({
    events: [
      evt({ branch: "feature-x", id: "x", title: "kept-evt" }),
      evt({ branch: "other-branch", id: "nope", title: "dropped-evt" }),
    ],
  })
  await renderOnce()
  let frame = captureCharFrame()
  expect(frame).toContain("kept-evt")
  expect(frame).not.toContain("dropped-evt")

  view.toggleFilter()
  await renderOnce()
  frame = captureCharFrame()
  expect(view.filterActive).toBe(false)
  expect(frame).toContain("dropped-evt")
  renderer.destroy()
})

test("notes-unavailable renders a labeled timeline state, not a crash", async () => {
  const chain = makeChain()
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  view.setNotesUnavailable()
  await renderOnce()
  expect(captureCharFrame()).toContain("timeline unavailable")
  renderer.destroy()
})

test("a timeline error renders its message, distinct from the unavailable label", async () => {
  const chain = makeChain()
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  view.setNotesError("graph exploded")
  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("timeline error: graph exploded")
  expect(frame).not.toContain("timeline unavailable")
  renderer.destroy()
})

test("new events stick to the bottom of the timeline", async () => {
  const chain = makeChain()
  const { renderer, renderOnce, captureCharFrame, view } = await makeAgentView(chain)
  const many = Array.from({ length: 40 }, (_, i) => evt({ branch: "feature-x", id: `e${i}`, title: `evt-${String(i).padStart(2, "0")}` }))
  view.setNotes({ events: many })
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("evt-39") // newest is followed into view
  expect(frame).not.toContain("evt-00") // oldest scrolled off the top
  renderer.destroy()
})
