# cc-pane

![cc-pane banner](docs/assets/readme-banner.webp)

[![CI](https://img.shields.io/github/actions/workflow/status/yasyf/cc-pane/ci.yml?branch=main&label=CI)](https://github.com/yasyf/cc-pane/actions/workflows/ci.yml)
[![License: PolyForm-Noncommercial-1.0.0](https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg)](https://github.com/yasyf/cc-pane/blob/main/LICENSE)

Single pane of glass for Claude Code and all the cc-* helpers.

I run a lot of Claude Code sessions, and each one trails its own constellation of cc-* helpers (reviews, transcripts, pools, skills) spread across terminal tabs. cc-pane is one full-screen TUI, built on OpenTUI and bun, that orchestrates session backends like cmux and superset and renders each session's meta — status, tasks, pending reviews — in a single view.

Early days: the dashboard renders a placeholder frame today; backend orchestration is the first milestone.

## Install

Clone and install with bun — there's no published package yet:

```bash
git clone https://github.com/yasyf/cc-pane && cd cc-pane && bun install
```

## Quickstart

Launch the dashboard:

```bash
bun start
```

A full-screen frame opens (Ctrl+C exits):

```
╭──────────────────────────────cc-pane───────────────────────────────╮
│No sessions yet. Backends (cmux, superset) land here.               │
│                                                                    │
│                                                                    │
╰────────────────────────────────────────────────────────────────────╯
```

## What problems does this solve?

- **Session sprawl.** Five Claude Code sessions means five terminal tabs to cycle through just to see who's blocked. cc-pane puts every session on one screen.
- **Invisible meta.** A session's interesting state — current task, pending review, token burn — lives in transcripts and sidecar tools, not in its terminal output. The per-session view surfaces that meta directly.
- **One backend per workflow.** cmux, superset, and plain tmux each manage sessions their own way. cc-pane treats them as interchangeable backends behind one UI, so switching orchestrators doesn't mean relearning your cockpit.
- **Helper fragmentation.** Each cc-* tool is its own CLI with its own invocation. The pane is the shared front end they plug into.

## License

PolyForm-Noncommercial-1.0.0. See [LICENSE](https://github.com/yasyf/cc-pane/blob/main/LICENSE).
