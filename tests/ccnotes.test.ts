import { expect, test } from "bun:test"

import { NotesUnavailableError, VizPool, VizServer, type SpawnFn, type VizProcess } from "../src/data/ccnotes.ts"

// A scripted stand-in for a spawned viz child: the test drives stdout lines and exit, and
// records every kill signal. A SIGTERM exits cleanly (as real cc-notes does) so stop() ends.
class FakeChild implements VizProcess {
  readonly killed: (number | string)[] = []
  readonly stdout: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  private controller!: ReadableStreamDefaultController<Uint8Array>
  private resolveExited!: (code: number) => void
  private streamClosed = false
  private hasExited = false

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c
      },
      cancel: () => {
        this.streamClosed = true
      },
    })
    this.exited = new Promise<number>((resolve) => {
      this.resolveExited = resolve
    })
  }

  emitLine(line: string): void {
    this.controller.enqueue(new TextEncoder().encode(`${line}\n`))
  }

  exit(code: number): void {
    if (this.hasExited) return
    this.hasExited = true
    if (!this.streamClosed) {
      this.streamClosed = true
      this.controller.close()
    }
    this.resolveExited(code)
  }

  kill(signal?: number | string): void {
    this.killed.push(signal ?? "SIGTERM")
    this.exit(0)
  }
}

// A spawn that hands out pre-scripted children in order and records them for assertions.
function queuedSpawn(children: readonly FakeChild[]): { spawn: SpawnFn; used: FakeChild[] } {
  const used: FakeChild[] = []
  let next = 0
  const spawn: SpawnFn = () => {
    const child = children[next]
    if (!child) throw new Error(`queuedSpawn: no scripted child at index ${next}`)
    next += 1
    used.push(child)
    return child
  }
  return { spawn, used }
}

// A spawn whose every child prints a valid dummy URL immediately, so start() resolves.
function autoUrlSpawn(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn: SpawnFn = () => {
    const child = new FakeChild()
    child.emitLine(`http://127.0.0.1:${9000 + children.length}`)
    children.push(child)
    return child
  }
  return { spawn, children }
}

test("start parses the URL line printed alone on stdout", async () => {
  const fake = new FakeChild()
  const viz = new VizServer("/repo", () => fake, 1000)
  const started = viz.start()
  fake.emitLine("http://127.0.0.1:45678")
  await started

  expect(viz.status).toBe("running")
  expect(viz.url).toBe("http://127.0.0.1:45678")
  await viz.stop()
  expect(fake.killed).toContain("SIGTERM")
})

test("start ignores trailing stderr-style noise and trims the URL line", async () => {
  const fake = new FakeChild()
  const viz = new VizServer("/repo", () => fake, 1000)
  const started = viz.start()
  fake.emitLine("  http://127.0.0.1:33333  ")
  await started

  expect(viz.url).toBe("http://127.0.0.1:33333")
  await viz.stop()
})

test("start rejects with NotesUnavailableError when the child exits before the URL", async () => {
  const fake = new FakeChild()
  const viz = new VizServer("/repo", () => fake, 1000)
  const started = viz.start()
  fake.exit(1)

  await expect(started).rejects.toBeInstanceOf(NotesUnavailableError)
  expect(viz.status).toBe("stopped")
})

test("start rejects with NotesUnavailableError when the URL never arrives (timeout)", async () => {
  const fake = new FakeChild()
  const viz = new VizServer("/repo", () => fake, 25)

  await expect(viz.start()).rejects.toBeInstanceOf(NotesUnavailableError)
  expect(viz.status).toBe("stopped")
  expect(fake.killed).toContain("SIGTERM")
})

test("stop mid-start kills the child and start rejects", async () => {
  const fake = new FakeChild()
  const viz = new VizServer("/repo", () => fake, 1000)
  const started = viz.start()
  await viz.stop()

  await expect(started).rejects.toBeInstanceOf(NotesUnavailableError)
  expect(fake.killed).toContain("SIGTERM")
  expect(viz.status).toBe("stopped")
})

test("stop is idempotent: a double stop sends one SIGTERM", async () => {
  const fake = new FakeChild()
  const viz = new VizServer("/repo", () => fake, 1000)
  const started = viz.start()
  fake.emitLine("http://127.0.0.1:45678")
  await started

  await Promise.all([viz.stop(), viz.stop()])
  await viz.stop()
  expect(fake.killed).toEqual(["SIGTERM"])
})

test("graph fetches /api/graph and returns the parsed notes graph", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path !== "/api/graph") return new Response("not found", { status: 404 })
      return Response.json({
        repo: { root: "/repo", trunk: "main", head: "main" },
        lanes: [],
        entities: [],
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
    },
  })
  try {
    const fake = new FakeChild()
    const viz = new VizServer("/repo", () => fake, 1000)
    const started = viz.start()
    fake.emitLine(`http://127.0.0.1:${server.port}`)
    await started

    const graph = await viz.graph()
    expect(graph.events.length).toBe(1)
    const event = graph.events[0]
    if (!event) throw new Error("expected one event")
    expect(event.type).toBe("claimed")
    expect(event.entity.title).toBe("implement auth")
    expect(event.branch).toBe("feature-x")
    await viz.stop()
  } finally {
    server.stop(true)
  }
})

test("graph maps an HTTP 500 (no cc-notes refs) to NotesUnavailableError", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ error: "cannot determine trunk: no ref for main" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    },
  })
  try {
    const fake = new FakeChild()
    const viz = new VizServer("/repo", () => fake, 1000)
    const started = viz.start()
    fake.emitLine(`http://127.0.0.1:${server.port}`)
    await started

    await expect(viz.graph()).rejects.toBeInstanceOf(NotesUnavailableError)
    await viz.stop()
  } finally {
    server.stop(true)
  }
})

test("pool: serverFor returns the same live server for the same repo", async () => {
  const { spawn, children } = autoUrlSpawn()
  const pool = new VizPool(spawn, 1000)

  const first = await pool.serverFor("/repo/a")
  const second = await pool.serverFor("/repo/a")

  expect(second).toBe(first)
  expect(children.length).toBe(1)
  await pool.stopAll()
})

test("pool: serverFor swaps servers on a repo change, stopping the old with SIGTERM", async () => {
  const { spawn, children } = autoUrlSpawn()
  const pool = new VizPool(spawn, 1000)

  const first = await pool.serverFor("/repo/a")
  const second = await pool.serverFor("/repo/b")

  expect(second).not.toBe(first)
  expect(children.length).toBe(2)
  const [oldChild, newChild] = children
  if (!oldChild || !newChild) throw new Error("expected two scripted children")
  expect(oldChild.killed).toContain("SIGTERM")
  expect(newChild.killed.length).toBe(0)
  await pool.stopAll()
})

test("pool: stopAll stops the live server", async () => {
  const { spawn, children } = autoUrlSpawn()
  const pool = new VizPool(spawn, 1000)

  await pool.serverFor("/repo/a")
  await pool.stopAll()

  const [child] = children
  if (!child) throw new Error("expected one scripted child")
  expect(child.killed).toContain("SIGTERM")
})

test("pool: a rejected start leaves no live server behind", async () => {
  const dies = new FakeChild()
  dies.exit(3)
  const { spawn } = queuedSpawn([dies])
  const pool = new VizPool(spawn, 1000)

  await expect(pool.serverFor("/repo/a")).rejects.toBeInstanceOf(NotesUnavailableError)
  await pool.stopAll()
})

// A macrotask flush, so a queued serverForLocked runs and registers its entry before we act.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test("pool: concurrent serverFor for the same repo spawns once and shares the server", async () => {
  const { spawn, children } = autoUrlSpawn()
  const pool = new VizPool(spawn, 1000)

  const [first, second] = await Promise.all([pool.serverFor("/repo/a"), pool.serverFor("/repo/a")])

  expect(second).toBe(first)
  expect(children.length).toBe(1)
  await pool.stopAll()
})

test("pool: a repo switch kills repo A before repo B spawns, orphaning nothing", async () => {
  const { spawn, children } = autoUrlSpawn()
  const pool = new VizPool(spawn, 1000)

  await pool.serverFor("/repo/a")
  await pool.serverFor("/repo/b")

  expect(children.length).toBe(2)
  const [oldChild, newChild] = children
  if (!oldChild || !newChild) throw new Error("expected two scripted children")
  expect(oldChild.killed).toContain("SIGTERM")
  expect(newChild.killed.length).toBe(0)
  await pool.stopAll()
})

test("pool: stopAll during a pending start kills the starting child and rejects the caller", async () => {
  const pending = new FakeChild() // never prints a URL, so start() stays in flight
  const { spawn, used } = queuedSpawn([pending])
  const pool = new VizPool(spawn, 1000)

  const inflight = pool.serverFor("/repo/a")
  await tick() // let serverForLocked register this.current before we interrupt it
  await pool.stopAll()

  await expect(inflight).rejects.toBeInstanceOf(NotesUnavailableError)
  expect(pending.killed).toContain("SIGTERM")
  expect(used.length).toBe(1)
})

test("pool: a serverFor queued behind stopAll rejects instead of respawning", async () => {
  const pending = new FakeChild() // never prints a URL, so the first start stays in flight
  const spare = new FakeChild() // must never be spawned
  const { spawn, used } = queuedSpawn([pending, spare])
  const pool = new VizPool(spawn, 1000)

  const inflight = pool.serverFor("/repo/a")
  await tick() // let serverForLocked register this.current before we interrupt it
  const queued = pool.serverFor("/repo/b")
  await pool.stopAll()

  await expect(inflight).rejects.toBeInstanceOf(NotesUnavailableError)
  await expect(queued).rejects.toBeInstanceOf(NotesUnavailableError)
  expect(used.length).toBe(1) // the queued call never spawned after close
  expect(pending.killed).toContain("SIGTERM")
})

test("pool: a synchronously throwing spawn surfaces as NotesUnavailableError", async () => {
  const spawn: SpawnFn = () => {
    throw new Error("posix_spawn 'cc-notes': No such file or directory (ENOENT)")
  }
  const pool = new VizPool(spawn, 1000)

  try {
    await pool.serverFor("/deleted/repo")
    throw new Error("expected serverFor to reject")
  } catch (err) {
    expect(err).toBeInstanceOf(NotesUnavailableError)
    expect((err as Error).message).toContain("viz spawn failed")
  }
})

test("pool: a failed start clears current, so the next serverFor spawns fresh", async () => {
  const dies = new FakeChild()
  dies.exit(3)
  const good = new FakeChild()
  good.emitLine("http://127.0.0.1:45999")
  const { spawn, used } = queuedSpawn([dies, good])
  const pool = new VizPool(spawn, 1000)

  await expect(pool.serverFor("/repo/a")).rejects.toBeInstanceOf(NotesUnavailableError)

  const server = await pool.serverFor("/repo/a")
  expect(server.status).toBe("running")
  expect(used.length).toBe(2) // the retry did not reuse a cached dead server
  await pool.stopAll()
})
