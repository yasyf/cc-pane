# cc-pane Development Guide

Single pane of glass for Claude Code fleets. A full-screen OpenTUI dashboard,
run with bun (`bun start`), that renders every cc-orchestrate-managed session —
across repos, workstreams, and agents — in one view.

## Repository Structure

```
cc-pane/
├── src/              # The TUI — entry point (index.ts) and renderable tree (app.ts)
├── tests/            # bun test suite, rendered via OpenTUI's test renderer
├── .github/          # CI — typecheck + tests on bun
├── docs/assets/      # Brand images (logo, README banner, social card)
├── AGENTS.md         # This file — shared conventions
└── README.md         # Project overview
```
