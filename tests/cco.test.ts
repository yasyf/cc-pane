import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureConflictError, CcoClient, DaemonUnreachableError, XrpcError } from "../src/data/cco.ts"

type Server = ReturnType<typeof Bun.serve>

const servers: Server[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop(true)))
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })))
})

async function makeHome(port?: number): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "cco-test-"))
  homes.push(home)
  await mkdir(join(home, ".cc-orchestrate"), { recursive: true })
  if (port !== undefined) await writePort(home, port)
  return home
}

async function writePort(home: string, port: number): Promise<void> {
  await writeFile(join(home, ".cc-orchestrate", "http.json"), JSON.stringify({ port }))
}

function serve(handler: (req: Request) => Response): Server {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return server
}

// A port that was open then closed — a subsequent connection is refused.
async function deadPort(): Promise<number> {
  const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const port = tmp.port!
  await tmp.stop(true)
  return port
}

const MINIMAL_FLEET = {
  fleet_subject: "s",
  seq: 7,
  http_port: 12345,
  repos: [],
  workstreams: [],
  sprints: [],
  agents: [],
  registry: [],
}

test("fleetStatus fetches and parses the full fleet tree", async () => {
  const fixture: unknown = await Bun.file(join(import.meta.dir, "fixtures", "fleet-status.json")).json()
  const paths: string[] = []
  const server = serve((req) => {
    paths.push(new URL(req.url).pathname)
    return Response.json(fixture)
  })
  const home = await makeHome(server.port)
  let wakeCalls = 0
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake: async () => void wakeCalls++ })

  const result = await client.fleetStatus()

  expect(wakeCalls).toBe(0)
  expect(paths).toEqual(["/xrpc/cco.fleet.status"])
  expect(result.seq).toBe(400)
  expect(result.httpPort).toBe(54869)
  expect(result.repos).toHaveLength(25)
  expect(result.agents).toHaveLength(26)
  expect(result.registry).toEqual([
    { relpath: "cco-smoke-zellij", path: "/tmp/cco-smoke-zellij", origin: null, trunk: null, localOnly: false, repoId: "smoke-zellij-repo-237ff04c" },
    { relpath: "cc-notes", path: "/Users/yasyf/Code/cc-notes", origin: "git@github.com:yasyf/cc-notes.git", trunk: "main", localOnly: false, repoId: null },
    { relpath: "ugh", path: "/Users/yasyf/Code/ugh", origin: null, trunk: null, localOnly: true, repoId: null },
  ])
})

test("a stale port refuses, wake republishes it, and the retry succeeds", async () => {
  const live = serve(() => Response.json({ ...MINIMAL_FLEET, seq: 42 }))
  const stale = await deadPort()
  const home = await makeHome(stale)
  let wakeCalls = 0
  const wake = async () => {
    wakeCalls++
    await writePort(home, live.port!)
  }
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake })

  const result = await client.fleetStatus()

  expect(wakeCalls).toBe(1)
  expect(result.seq).toBe(42)
})

test.each([
  {
    id: "the port file is missing",
    arrange: async (_home: string) => {},
  },
  {
    id: "the port keeps refusing after wake",
    arrange: async (home: string) => writePort(home, await deadPort()),
  },
])("throws DaemonUnreachableError when $id", async ({ arrange }) => {
  const home = await makeHome()
  await arrange(home)
  let wakeCalls = 0
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake: async () => void wakeCalls++ })

  await expect(client.fleetStatus()).rejects.toBeInstanceOf(DaemonUnreachableError)
  expect(wakeCalls).toBe(1)
})

test("capture requests exactly the agent_id param and parses the snapshot", async () => {
  const queries: string[] = []
  const server = serve((req) => {
    const url = new URL(req.url)
    queries.push(`${url.pathname}?${url.searchParams.toString()}`)
    return Response.json({ id: "impl-agent", content: "the rendered screen", captured_at: "2026-07-18T09:00:00Z" })
  })
  const home = await makeHome(server.port)
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake: async () => {} })

  const cap = await client.capture("impl-agent")

  expect(cap.id).toBe("impl-agent")
  expect(cap.content).toBe("the rendered screen")
  expect(cap.capturedAt).toBe("2026-07-18T09:00:00Z")
  expect(queries).toEqual(["/xrpc/cco.agent.capture?agent_id=impl-agent"])
})

test("capture on a non-active agent throws CaptureConflictError carrying the server message", async () => {
  const message = "agent impl-agent is exited, not active"
  const server = serve(() => Response.json({ error: "Conflict", message }, { status: 409 }))
  const home = await makeHome(server.port)
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake: async () => {} })

  try {
    await client.capture("impl-agent")
    throw new Error("expected capture to reject")
  } catch (err) {
    expect(err).toBeInstanceOf(CaptureConflictError)
    expect((err as CaptureConflictError).agentId).toBe("impl-agent")
    expect((err as CaptureConflictError).message).toBe(message)
  }
})

test("capture 500 with a coincidental Conflict body stays a raw XrpcError", async () => {
  const server = serve(() => Response.json({ error: "Conflict", message: "internal boom" }, { status: 500 }))
  const home = await makeHome(server.port)
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake: async () => {} })

  try {
    await client.capture("impl-agent")
    throw new Error("expected capture to reject")
  } catch (err) {
    expect(err).toBeInstanceOf(XrpcError)
    expect(err).not.toBeInstanceOf(CaptureConflictError)
    expect((err as XrpcError).status).toBe(500)
    expect((err as XrpcError).code).toBe("Conflict")
  }
})

test("a readable but malformed http.json fails loudly without waking the daemon", async () => {
  const home = await makeHome()
  await writeFile(join(home, ".cc-orchestrate", "http.json"), JSON.stringify({ port: "not-a-number" }))
  let wakeCalls = 0
  const client = new CcoClient({ homeDir: home, fetchFn: fetch, wake: async () => void wakeCalls++ })

  await expect(client.fleetStatus()).rejects.toThrow(/expected positive integer port/)
  expect(wakeCalls).toBe(0)
})
