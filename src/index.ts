// Entry point: wire the real cco client and viz pool into the app. One shutdown path runs
// on every exit — Bun does not reap children, so a leaked viz server is the failure mode.

import { createCliRenderer } from "@opentui/core"
import { homedir } from "node:os"

import { buildApp } from "./app.ts"
import { CcoClient } from "./data/cco.ts"
import { VizPool, spawnVizProcess } from "./data/ccnotes.ts"

const POLL_INTERVAL_MS = 2000

// Any cco invocation auto-starts the daemon and republishes ~/.cc-orchestrate/http.json.
async function wakeDaemon(): Promise<void> {
  await Bun.spawn(["cco", "fleet", "status"], { stdout: "ignore", stderr: "ignore" }).exited
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true })

const cco = new CcoClient({ homeDir: homedir(), fetchFn: fetch, wake: wakeDaemon })
const vizPool = new VizPool(spawnVizProcess)

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.dispose()
  await vizPool.stopAll()
  renderer.destroy()
  process.exit(0)
}

const app = buildApp(renderer, {
  cco,
  viz: vizPool,
  pollIntervalMs: POLL_INTERVAL_MS,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  onQuit: () => void shutdown(),
})

process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

void app.refreshFleet()
