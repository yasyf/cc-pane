import { expect, test } from "bun:test"

import {
  agentRepoChain,
  parseCapture,
  parseFleetStatus,
  parseNotesGraph,
  repoRows,
  type FleetStatus,
  type RepoRow,
} from "../src/model.ts"

const fleetRaw: unknown = await Bun.file(`${import.meta.dir}/fixtures/fleet-status.json`).json()
const notesRaw: unknown = await Bun.file(`${import.meta.dir}/fixtures/notes-graph.json`).json()
const fleet = parseFleetStatus(fleetRaw)

const SMOKE_AGENT_ID = "95b7014a-96e0-43fa-b406-a1927cf2a0b8"

type MutableFleet = {
  fleet_subject: string
  seq: number
  http_port: number
  repos: Array<Record<string, unknown>>
  workstreams: Array<Record<string, unknown>>
  sprints: Array<Record<string, unknown>>
  agents: Array<Record<string, unknown>>
  registry: Array<Record<string, unknown>>
}

function cloneFleet(): MutableFleet {
  return structuredClone(fleetRaw) as MutableFleet
}

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error("fixture array is empty")
  return row
}

function byId<T extends { id: string }>(rows: readonly T[], id: string): T {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`no row with id ${id}`)
  return found
}

function rowByKey(rows: readonly RepoRow[], key: string): RepoRow {
  const found = rows.find((r) => r.key === key)
  if (!found) throw new Error(`no repo row keyed ${key}`)
  return found
}

test("parseFleetStatus: exact counts and scalar header", () => {
  expect(fleet.fleetSubject).toBe("ff7403f6566c2ef9153ca55c789991c4")
  expect(fleet.seq).toBe(400)
  expect(fleet.httpPort).toBe(54869)
  expect(fleet.repos.length).toBe(25)
  expect(fleet.workstreams.length).toBe(41)
  expect(fleet.sprints.length).toBe(41)
  expect(fleet.agents.length).toBe(26)
  expect(fleet.registry.length).toBe(3)
})

test("parseFleetStatus: narrows a specific agent row by id", () => {
  const agent = byId(fleet.agents, SMOKE_AGENT_ID)
  expect(agent.name).toBe("smoke-agent")
  expect(agent.state).toBe("stuck")
  expect(agent.status).toBe("exited")
  expect(agent.backend).toBe("zellij")
  expect(agent.terminalHandle).toBe("terminal_1")
  expect(agent.sprintId).toBe("main-1ee941a2")
  expect(agent.tokens).toBe(0)
  expect(agent.restartCount).toBe(0)
  expect(agent.ccnotesTask).toBe("")
})

test("parseFleetStatus: registry entries carry omitempty zeros as null/false", () => {
  const ccNotes = fleet.registry.find((e) => e.relpath === "cc-notes")
  if (!ccNotes) throw new Error("cc-notes registry entry missing")
  expect(ccNotes.path).toBe("/Users/yasyf/Code/cc-notes")
  expect(ccNotes.origin).toBe("git@github.com:yasyf/cc-notes.git")
  expect(ccNotes.trunk).toBe("main")
  expect(ccNotes.localOnly).toBe(false)
  expect(ccNotes.repoId).toBeNull()

  const ugh = fleet.registry.find((e) => e.relpath === "ugh")
  if (!ugh) throw new Error("ugh registry entry missing")
  expect(ugh.localOnly).toBe(true)
  expect(ugh.origin).toBeNull()
  expect(ugh.trunk).toBeNull()
  expect(ugh.repoId).toBeNull()
})

test("agentRepoChain: resolves the full sprint→workstream→repo chain", () => {
  const chain = agentRepoChain(fleet, SMOKE_AGENT_ID)
  expect(chain.agent.id).toBe(SMOKE_AGENT_ID)
  expect(chain.sprint.id).toBe("main-1ee941a2")
  expect(chain.workstream.id).toBe("smoke-zellij-e746c6c3")
  expect(chain.workstream.branch).toBe("smoke-zellij")
  expect(chain.repo.id).toBe("smoke-zellij-repo-237ff04c")
  expect(chain.repo.name).toBe("smoke-zellij-repo")
  expect(chain.repo.cwd).toBe("/tmp/cco-smoke-zellij")
})

test("agentRepoChain: every fixture agent resolves", () => {
  for (const agent of fleet.agents) {
    const chain = agentRepoChain(fleet, agent.id)
    expect(chain.agent.id).toBe(agent.id)
  }
})

test("repoRows: union size is every registry entry plus unmatched DB repos", () => {
  const rows = repoRows(fleet)
  expect(rows.length).toBe(27)
  expect(rows.filter((r) => r.kind === "matched").length).toBe(1)
  expect(rows.filter((r) => r.kind === "registry-only").length).toBe(2)
  expect(rows.filter((r) => r.kind === "db-only").length).toBe(24)
})

test("repoRows: a registry entry joined to its DB repo (path === cwd)", () => {
  const row = rowByKey(repoRows(fleet), "/tmp/cco-smoke-zellij")
  expect(row.kind).toBe("matched")
  if (row.kind !== "matched") throw new Error("expected matched row")
  expect(row.name).toBe("cco-smoke-zellij")
  expect(row.registry.relpath).toBe("cco-smoke-zellij")
  expect(row.repo.id).toBe("smoke-zellij-repo-237ff04c")
  expect(row.repo.cwd).toBe("/tmp/cco-smoke-zellij")
})

test("repoRows: a registry-only entry with no DB repo", () => {
  const row = rowByKey(repoRows(fleet), "/Users/yasyf/Code/cc-notes")
  expect(row.kind).toBe("registry-only")
  if (row.kind !== "registry-only") throw new Error("expected registry-only row")
  expect(row.name).toBe("cc-notes")
  expect(row.registry.origin).toBe("git@github.com:yasyf/cc-notes.git")
})

test("repoRows: a local-only registry entry", () => {
  const row = rowByKey(repoRows(fleet), "/Users/yasyf/Code/ugh")
  expect(row.kind).toBe("registry-only")
  if (row.kind !== "registry-only") throw new Error("expected registry-only row")
  expect(row.name).toBe("ugh")
  expect(row.registry.localOnly).toBe(true)
})

test("repoRows: a DB repo no registry entry claims", () => {
  const row = rowByKey(repoRows(fleet), "/private/tmp/cco-smoke-superset")
  expect(row.kind).toBe("db-only")
  if (row.kind !== "db-only") throw new Error("expected db-only row")
  expect(row.name).toBe("smoke-superset")
  expect(row.repo.id).toBe("smoke-superset-fd490a05")
})

test("parseNotesGraph: the live fixture has a null events slice → empty", () => {
  const graph = parseNotesGraph(notesRaw)
  expect(graph.events.length).toBe(0)
})

test("parseNotesGraph: narrows a populated event feed", () => {
  const graph = parseNotesGraph({
    events: [
      {
        entity: { kind: "task", id: "ab12", short: "ab12", title: "implement auth" },
        type: "claimed",
        time: 1784285930,
        branch: "feature-x",
        sha: "a1b2c3",
        detail: "open → in_progress",
      },
    ],
  })
  expect(graph.events.length).toBe(1)
  const event = first(graph.events)
  expect(event.type).toBe("claimed")
  expect(event.entity.title).toBe("implement auth")
  expect(event.time).toBe(1784285930)
  expect(event.branch).toBe("feature-x")
  expect(event.detail).toBe("open → in_progress")
})

test("parseCapture: narrows the rendered-text capture", () => {
  const capture = parseCapture({ id: "a1", content: "plain screen text", captured_at: "2026-07-17T00:00:00Z" })
  expect(capture.id).toBe("a1")
  expect(capture.content).toBe("plain screen text")
  expect(capture.capturedAt).toBe("2026-07-17T00:00:00Z")
})

const malformed: ReadonlyArray<{ id: string; fn: () => unknown; match: RegExp }> = [
  {
    id: "fleet: missing required registry",
    fn: () => {
      const f = cloneFleet()
      delete (f as Partial<MutableFleet>).registry
      return parseFleetStatus(f)
    },
    match: /registry/,
  },
  {
    id: "fleet: repos wrong type",
    fn: () => {
      const f = cloneFleet()
      ;(f as { repos: unknown }).repos = "not-an-array"
      return parseFleetStatus(f)
    },
    match: /repos: expected array/,
  },
  {
    id: "fleet: unknown agent state enum",
    fn: () => {
      const f = cloneFleet()
      first(f.agents).state = "melting"
      return parseFleetStatus(f)
    },
    match: /\.state: expected one of/,
  },
  {
    id: "fleet: unknown lifecycle status enum",
    fn: () => {
      const f = cloneFleet()
      first(f.repos).status = "zombie"
      return parseFleetStatus(f)
    },
    match: /repos\[0\]\.status: expected one of active\|exited\|killed/,
  },
  {
    id: "fleet: agent tokens not a number",
    fn: () => {
      const f = cloneFleet()
      first(f.agents).tokens = "lots"
      return parseFleetStatus(f)
    },
    match: /tokens: expected finite number/,
  },
  {
    id: "capture: missing content",
    fn: () => parseCapture({ id: "a1", captured_at: "t" }),
    match: /content: expected string/,
  },
  {
    id: "capture: content wrong type",
    fn: () => parseCapture({ id: "a1", content: 7, captured_at: "t" }),
    match: /content: expected string/,
  },
  {
    id: "notesGraph: missing events key",
    fn: () => parseNotesGraph({}),
    match: /notesGraph: missing events/,
  },
  {
    id: "notesGraph: unknown event type enum",
    fn: () =>
      parseNotesGraph({
        events: [
          {
            entity: { kind: "task", id: "x", short: "x", title: "t" },
            type: "exploded",
            time: 1,
            branch: "b",
            sha: "s",
            detail: "d",
          },
        ],
      }),
    match: /\.type: expected one of/,
  },
  {
    id: "notesGraph: event entity missing title",
    fn: () =>
      parseNotesGraph({
        events: [
          {
            entity: { kind: "task", id: "x", short: "x" },
            type: "created",
            time: 1,
            branch: "b",
            sha: "s",
            detail: "d",
          },
        ],
      }),
    match: /entity\.title: expected string/,
  },
  {
    id: "agentRepoChain: unknown agent id",
    fn: () => agentRepoChain(fleet, "does-not-exist"),
    match: /no agent with id does-not-exist/,
  },
  {
    id: "agentRepoChain: dangling sprint_id",
    fn: () => {
      const f = cloneFleet()
      first(f.agents).sprint_id = "sprint-that-vanished"
      const parsed: FleetStatus = parseFleetStatus(f)
      return agentRepoChain(parsed, first(parsed.agents).id)
    },
    match: /dangling sprint_id sprint-that-vanished/,
  },
]

for (const c of malformed) {
  test(`rejects ${c.id}`, () => {
    expect(c.fn).toThrow(c.match)
  })
}
