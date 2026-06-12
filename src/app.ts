import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"

export function buildApp(renderer: CliRenderer): void {
  const frame = new BoxRenderable(renderer, {
    id: "frame",
    border: true,
    borderStyle: "rounded",
    title: "cc-pane",
    titleAlignment: "center",
    flexGrow: 1,
  })
  frame.add(
    new TextRenderable(renderer, {
      id: "placeholder",
      content: "No sessions yet. Backends (cmux, superset) land here.",
    }),
  )
  renderer.root.add(frame)
}
