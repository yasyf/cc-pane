// The visual vocabulary: glyphs and colors keyed by the model's state unions, plus the
// order per-state badge counts render in the repo list.

import type { AgentState, LifecycleStatus, NotesEventType } from "./model.ts"

export const AGENT_STATE_GLYPHS: Record<AgentState, string> = {
  working: "●",
  idle: "○",
  "awaiting-input": "◐",
  blocked: "■",
  stuck: "▲",
  unknown: "?",
}

// null defers to the state glyph; a non-active agent shows ✕ regardless of state.
export const AGENT_STATUS_GLYPHS: Record<LifecycleStatus, string | null> = {
  active: null,
  exited: "✕",
  killed: "✕",
}

export const AGENT_STATE_COLORS: Record<AgentState, string> = {
  working: "#3fb950",
  idle: "#6e7681",
  "awaiting-input": "#d29922",
  blocked: "#db6d28",
  stuck: "#f85149",
  unknown: "#484f58",
}

export const NOTES_EVENT_GLYPHS: Record<NotesEventType, string> = {
  created: "✦",
  claimed: "●",
  reclaimed: "↻",
  closed: "✓",
  status: "⇄",
  branch_moved: "⎇",
  commit_linked: "⚑",
  edited: "✎",
  verified: "✔",
  superseded: "⊘",
  stale: "◌",
  entry: "•",
  run_started: "▷",
  run_finished: "◼",
}

// Order the per-state counts appear in a repo-list badge: live work first, then the
// attention states, idle, and unknown last.
export const BADGE_STATE_ORDER: readonly AgentState[] = [
  "working",
  "awaiting-input",
  "blocked",
  "stuck",
  "idle",
  "unknown",
]
