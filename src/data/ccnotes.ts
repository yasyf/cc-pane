// The cc-notes viz-server lifecycle plus its /api/graph client, pooled to one live child.

import { parseNotesGraph, type NotesGraph } from "../model.ts"

const VIZ_START_TIMEOUT_MS = 5000

// The slice of a spawned child this module drives; injectable so tests need no real binary.
export interface VizProcess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | string): void
}

export type SpawnFn = (repoPath: string) => VizProcess

type StartOutcome =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "closed" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "timeout" }

type ServerState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly child: VizProcess }
  | { readonly status: "running"; readonly child: VizProcess; readonly baseUrl: URL }
  | { readonly status: "stopped" }

// Notes are unavailable, not broken: viz died before its URL, timed out, or /api/graph 500'd.
export class NotesUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotesUnavailableError"
  }
}

export class VizServer {
  private state: ServerState = { status: "idle" }
  private stopping: Promise<void> | null = null

  constructor(
    private readonly repoPath: string,
    private readonly spawn: SpawnFn,
    private readonly timeoutMs: number = VIZ_START_TIMEOUT_MS,
  ) {}

  get status(): ServerState["status"] {
    return this.state.status
  }

  get url(): string {
    if (this.state.status !== "running") throw new Error(`VizServer.url: not running (status=${this.state.status})`)
    return this.state.baseUrl.origin
  }

  async start(): Promise<void> {
    if (this.state.status !== "idle") throw new Error(`VizServer.start: already ${this.state.status}`)
    let child: VizProcess
    try {
      child = this.spawn(this.repoPath)
    } catch (err) {
      this.state = { status: "stopped" }
      throw new NotesUnavailableError(`viz spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.state = { status: "starting", child }
    let baseUrl: URL
    try {
      baseUrl = await this.raceForUrl(child)
    } catch (err) {
      await this.stop()
      throw err
    }
    // A concurrent stop() during startup already killed the child: never register it as running.
    if (this.state.status !== "starting") throw new NotesUnavailableError("viz stopped during startup")
    this.state = { status: "running", child, baseUrl }
  }

  async graph(): Promise<NotesGraph> {
    if (this.state.status !== "running") throw new Error(`VizServer.graph: not running (status=${this.state.status})`)
    const res = await fetch(new URL("/api/graph", this.state.baseUrl))
    if (res.status === 500) throw new NotesUnavailableError(`viz graph unavailable: ${await res.text()}`)
    const raw: unknown = await res.json()
    return parseNotesGraph(raw)
  }

  stop(): Promise<void> {
    if (this.stopping === null) this.stopping = this.doStop()
    return this.stopping
  }

  private async doStop(): Promise<void> {
    const state = this.state
    this.state = { status: "stopped" }
    if (state.status === "starting" || state.status === "running") {
      state.child.kill("SIGTERM")
      await state.child.exited
    }
  }

  private async raceForUrl(child: VizProcess): Promise<URL> {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let timer: ReturnType<typeof setTimeout> | undefined
    const line: Promise<StartOutcome> = (async (): Promise<StartOutcome> => {
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return { kind: "closed" }
        buf += decoder.decode(value, { stream: true })
        const nl = buf.indexOf("\n")
        if (nl >= 0) return { kind: "line", line: buf.slice(0, nl).trim() }
      }
    })()
    const exit: Promise<StartOutcome> = child.exited.then((code): StartOutcome => ({ kind: "exit", code }))
    const timeout: Promise<StartOutcome> = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), this.timeoutMs)
    })
    const outcome = await Promise.race([line, exit, timeout])
    if (timer !== undefined) clearTimeout(timer)
    switch (outcome.kind) {
      case "line":
        return new URL(outcome.line)
      case "closed":
        throw new NotesUnavailableError("viz stdout closed before printing its URL")
      case "exit":
        throw new NotesUnavailableError(`viz exited (code ${outcome.code}) before printing its URL`)
      case "timeout":
        throw new NotesUnavailableError(`viz did not print its URL within ${this.timeoutMs}ms`)
    }
  }
}

const noop = (): void => {}

// One live viz server; serverFor serializes on a promise-chain mutex and registers the entry
// before its start awaits, so mutex-skipping stopAll() can kill a still-starting child.
export class VizPool {
  private current: { readonly repoPath: string; readonly server: VizServer; readonly started: Promise<void> } | null = null
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly spawn: SpawnFn,
    private readonly timeoutMs: number = VIZ_START_TIMEOUT_MS,
  ) {}

  serverFor(repoPath: string): Promise<VizServer> {
    const result = this.chain.then(() => this.serverForLocked(repoPath))
    this.chain = result.then(noop, noop)
    return result
  }

  private async serverForLocked(repoPath: string): Promise<VizServer> {
    // stopAll is terminal: a call queued behind an interrupted start must not respawn.
    if (this.closed) throw new NotesUnavailableError("viz pool closed")
    const current = this.current
    if (current !== null && current.repoPath === repoPath) {
      try {
        await current.started
      } catch (err) {
        if (this.current === current) this.current = null
        throw err
      }
      return current.server
    }
    if (current !== null) {
      this.current = null
      await current.server.stop()
    }
    const server = new VizServer(repoPath, this.spawn, this.timeoutMs)
    const entry = { repoPath, server, started: server.start() }
    this.current = entry
    try {
      await entry.started
    } catch (err) {
      if (this.current === entry) this.current = null
      throw err
    }
    return server
  }

  async stopAll(): Promise<void> {
    this.closed = true
    const c = this.current
    this.current = null
    if (c) await c.server.stop()
  }
}

export const spawnVizProcess: SpawnFn = (repoPath) =>
  Bun.spawn(["cc-notes", "viz", "--no-open", "--port", "0"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "ignore",
  })
