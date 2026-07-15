# ![cc-pane](docs/assets/readme-banner.webp)

**Your whole Claude Code fleet in one pane of glass.** cc-pane is the full-screen TUI cockpit for [cc-orchestrate](https://github.com/yasyf/cc-orchestrate), putting every session across your repos, workstreams, and agents on one screen, so the stuck one can't hide.

[![CI](https://img.shields.io/github/actions/workflow/status/yasyf/cc-pane/ci.yml?branch=main&label=CI)](https://github.com/yasyf/cc-pane/actions/workflows/ci.yml)
[![License PolyForm-Noncommercial-1.0.0](https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg)](LICENSE)

## Get started

```bash
git clone https://github.com/yasyf/cc-pane && cd cc-pane && bun install
bun start
```

The full-screen dashboard opens (Ctrl+C exits):

```text
╭──────────────────────────────cc-pane───────────────────────────────╮
│No sessions yet. The cc-orchestrate fleet lands here.               │
│                                                                    │
│                                                                    │
│                                                                    │
│                                                                    │
╰────────────────────────────────────────────────────────────────────╯
```

Driving with an agent? Paste this:

```text
Set up cc-pane: run `git clone https://github.com/yasyf/cc-pane && cd cc-pane && bun install`, then launch the dashboard with `bun start`.
Confirm the full-screen cc-pane frame renders and Ctrl+C exits cleanly.
Then read src/app.ts and report where the cc-orchestrate session list plugs into the renderable tree.
```

---

## Use cases

### Spot the blocked session without cycling terminal tabs

Five Claude Code sessions means five terminal tabs, and the one stuck on a permission prompt looks exactly like the four that are working. Put every session in one pane:

```bash
bun start
```

One frame, every session, status first. Today that frame is the placeholder from Get started; the cc-orchestrate session list is milestone one.

### Watch a cc-orchestrate fleet without memorizing cco incantations

[cc-orchestrate](https://github.com/yasyf/cc-orchestrate) cuts a fresh worktree per workstream and spawns Claude agents across five backends, which leaves your fleet's state spread across `cco` invocations. cc-pane renders repos, their workstreams, and the agents working them as one dashboard, in a frame the suite asserts headlessly:

```bash
bun test
```

```text
 1 pass
 0 fail
 2 expect() calls
Ran 1 test across 1 file. [90.00ms]
```

The test captures the char frame through OpenTUI's test renderer, so anything that renders into the pane gets asserted the same way.

---

A Bun + OpenTUI app over cc-orchestrate's CLI and MCP surface. Each cc-* helper plugs its per-session meta into the pane instead of shipping its own front end.

Status: early skeleton. The frame renders and is asserted headlessly; wiring in the cc-orchestrate session list is milestone one.

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE).
