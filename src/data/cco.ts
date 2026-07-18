// The cc-orchestrate HTTP client: port discovered fresh from ~/.cc-orchestrate/http.json
// per attempt, waking the daemon and retrying once on a missing file or connection failure.

import { join } from "node:path"
import {
  type Capture,
  type FleetStatus,
  type KillResult,
  type MessageReceipt,
  type RespawnResult,
  parseCapture,
  parseFleetStatus,
  parseKillResult,
  parseMessageReceipt,
  parseRespawnResult,
} from "../model.ts"

const PORT_FILE = ".cc-orchestrate/http.json"
const FLEET_STATUS_METHOD = "cco.fleet.status"
const AGENT_CAPTURE_METHOD = "cco.agent.capture"
const AGENT_KILL_METHOD = "cco.agent.kill"
const AGENT_SEND_MESSAGE_METHOD = "cco.agent.sendMessage"
const AGENT_RESPAWN_METHOD = "cco.agent.respawn"
const CONFLICT_CODE = "Conflict"

export interface CcoClientDeps {
  readonly homeDir: string
  readonly fetchFn: typeof fetch
  // Spawns the `cco` CLI, which auto-starts the daemon and republishes the port file.
  readonly wake: () => Promise<void>
}

function parsePort(raw: unknown): number {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`http.json: expected object, got ${raw === null ? "null" : typeof raw}`)
  }
  const port = (raw as Record<string, unknown>).port
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    throw new Error(`http.json: expected positive integer port, got ${JSON.stringify(port)}`)
  }
  return port
}

function parseErrorEnvelope(raw: unknown): { readonly error: string; readonly message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`xrpc error envelope: expected object, got ${raw === null ? "null" : typeof raw}`)
  }
  const o = raw as Record<string, unknown>
  if (typeof o.error !== "string") throw new Error(`xrpc error envelope: expected string error, got ${typeof o.error}`)
  if (typeof o.message !== "string") throw new Error(`xrpc error envelope: expected string message, got ${typeof o.message}`)
  return { error: o.error, message: o.message }
}

// The daemon could not be reached even after a wake-and-retry.
export class DaemonUnreachableError extends Error {
  constructor(readonly method: string) {
    super(`cco daemon unreachable for ${method}`)
    this.name = "DaemonUnreachableError"
  }
}

// A non-ok xrpc response, carrying the server's error code, HTTP status, and message.
export class XrpcError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "XrpcError"
  }
}

// cco.agent.capture on an agent that is not active (status != active).
export class CaptureConflictError extends Error {
  constructor(
    readonly agentId: string,
    serverMessage: string,
  ) {
    super(serverMessage)
    this.name = "CaptureConflictError"
  }
}

// Internal control signal: missing port file or connection-level fetch failure — both
// mean the daemon needs a wake before a retry.
class Unreachable extends Error {}

export class CcoClient {
  private readonly homeDir: string
  private readonly fetchFn: typeof fetch
  private readonly wake: () => Promise<void>

  constructor(deps: CcoClientDeps) {
    this.homeDir = deps.homeDir
    this.fetchFn = deps.fetchFn
    this.wake = deps.wake
  }

  async fleetStatus(): Promise<FleetStatus> {
    return this.call(FLEET_STATUS_METHOD, {}, parseFleetStatus)
  }

  async capture(agentId: string): Promise<Capture> {
    try {
      return await this.call(AGENT_CAPTURE_METHOD, { agent_id: agentId }, parseCapture)
    } catch (err) {
      if (err instanceof XrpcError && err.code === CONFLICT_CODE && err.status === 409) {
        throw new CaptureConflictError(agentId, err.message)
      }
      throw err
    }
  }

  async kill(agentId: string): Promise<KillResult> {
    return this.runWithWake(AGENT_KILL_METHOD, () => this.attemptPost(AGENT_KILL_METHOD, { agent_id: agentId }, parseKillResult))
  }

  async sendMessage(agentId: string, text: string): Promise<MessageReceipt> {
    return this.runWithWake(AGENT_SEND_MESSAGE_METHOD, () =>
      this.attemptPost(AGENT_SEND_MESSAGE_METHOD, { agent_id: agentId, text }, parseMessageReceipt),
    )
  }

  async respawn(agentId: string): Promise<RespawnResult> {
    return this.runWithWake(AGENT_RESPAWN_METHOD, () => this.attemptPost(AGENT_RESPAWN_METHOD, { agent_id: agentId }, parseRespawnResult))
  }

  private async readPort(): Promise<number> {
    const file = Bun.file(join(this.homeDir, PORT_FILE))
    let text: string
    try {
      text = await file.text()
    } catch {
      throw new Unreachable()
    }
    return parsePort(JSON.parse(text))
  }

  private async fetchOrUnreachable(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init)
    } catch {
      throw new Unreachable()
    }
  }

  private async attempt<T>(method: string, params: Record<string, string>, parse: (raw: unknown) => T): Promise<T> {
    const port = await this.readPort()
    const qs = new URLSearchParams(params).toString()
    const url = `http://127.0.0.1:${port}/xrpc/${method}${qs ? `?${qs}` : ""}`
    const res = await this.fetchOrUnreachable(url)
    if (res.ok) return parse(await res.json())
    const envelope = parseErrorEnvelope(await res.json())
    throw new XrpcError(envelope.error, res.status, envelope.message)
  }

  private async attemptPost<T>(method: string, body: Record<string, string>, parse: (raw: unknown) => T): Promise<T> {
    const port = await this.readPort()
    const url = `http://127.0.0.1:${port}/xrpc/${method}`
    const res = await this.fetchOrUnreachable(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (res.ok) return parse(await res.json())
    const envelope = parseErrorEnvelope(await res.json())
    throw new XrpcError(envelope.error, res.status, envelope.message)
  }

  // Wake-once/retry discipline shared by GET (attempt) and POST (attemptPost) thunks.
  private async runWithWake<T>(method: string, attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err
    }
    await this.wake()
    try {
      return await attempt()
    } catch (err) {
      if (err instanceof Unreachable) throw new DaemonUnreachableError(method)
      throw err
    }
  }

  private async call<T>(method: string, params: Record<string, string>, parse: (raw: unknown) => T): Promise<T> {
    return this.runWithWake(method, () => this.attempt(method, params, parse))
  }
}
