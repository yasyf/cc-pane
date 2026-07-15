import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { buildApp } from "../src/app.ts"

test("renders the framed dashboard placeholder", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 12 })
  buildApp(renderer)
  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain("cc-pane")
  expect(frame).toContain("No sessions yet. The cc-orchestrate fleet lands here.")
  renderer.destroy()
})
