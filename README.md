# ![cc-pane](docs/assets/readme-banner.webp)

**One of your Claude sessions is waiting on you right now.** cc-pane shows status, tasks, reviews, and token burn for every cmux, superset, and tmux session on one screen, so the stuck one can't hide.

[![CI](https://img.shields.io/github/actions/workflow/status/yasyf/cc-pane/ci.yml?branch=main&label=CI)](https://github.com/yasyf/cc-pane/actions/workflows/ci.yml)
[![License PolyForm-Noncommercial-1.0.0](https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg)](LICENSE)

## Get started

```bash
git clone https://github.com/yasyf/cc-pane && cd cc-pane && bun install
bun start
```

The full-screen dashboard opens (Ctrl+C exits).

```text
╭──────────────────────────────cc-pane───────────────────────────────╮
│No sessions yet. Backends (cmux, superset) land here.               │
│                                                                    │
│                                                                    │
│                                                                    │
╰────────────────────────────────────────────────────────────────────╯
```

Driving with an agent? Paste this:

```text
Set up cc-pane: run `git clone https://github.com/yasyf/cc-pane && cd cc-pane && bun install`, then launch the dashboard with `bun start`.
Confirm the full-screen cc-pane frame renders and Ctrl+C exits cleanly.
Then read src/app.ts and report where the first backend (cmux) session list would plug in.
```

---

## Use cases

### Spot the blocked session without cycling five terminal tabs

Five Claude Code sessions means five terminal tabs, and the one stuck on a permission prompt looks exactly like the four that are working. Its current task, pending review, and token burn live in transcripts and sidecar cc-* tools, not in its scrollback. Put every session in one pane:

```bash
bun start
```

One frame, every session, status first. Today that frame is the placeholder from Get started.

### Swap cmux for superset or tmux without relearning your cockpit

cmux, superset, and plain tmux each manage sessions their own way, so changing orchestrators normally means rebuilding your monitoring habits from scratch. cc-pane treats them as interchangeable backends behind one UI. A backend plugs its session list into the renderable tree in `src/app.ts`, and the frame it renders into is asserted headlessly.

```bash
bun test
```

```text
 1 pass
 0 fail
 2 expect() calls
```

The suite captures the char frame through OpenTUI's test renderer, so any backend that renders the same session list passes the same assertions.

---

A Bun + OpenTUI app. Each cc-* helper for reviews, transcripts, and pools plugs its per-session meta into the pane instead of shipping its own front end. The pane is the shared cockpit they all render into.

Still early days. Backend orchestration (cmux first) is milestone one.

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE).
