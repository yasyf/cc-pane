// A centered single-line prompt: a bordered box wrapping one InputRenderable.
// open() focuses the input (self-subscribing to keys); close() blurs it. Enter submits.

import { BoxRenderable, InputRenderable, InputRenderableEvents, type RenderContext } from "@opentui/core"

const OVERLAY_ZINDEX = 100
const PROMPT_WIDTH = 64
const PROMPT_BG = "#161b22"
const PROMPT_BORDER = "#d29922"

export interface PromptOptions {
  readonly id: string
  readonly title: string
  readonly onSubmit: (value: string) => void
}

export class PromptRenderable extends BoxRenderable {
  private readonly input: InputRenderable

  constructor(ctx: RenderContext, options: PromptOptions) {
    super(ctx, {
      id: options.id,
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: OVERLAY_ZINDEX,
      backgroundColor: "transparent",
      justifyContent: "center",
      alignItems: "center",
    })
    const box = new BoxRenderable(ctx, {
      id: `${options.id}-box`,
      width: PROMPT_WIDTH,
      border: true,
      borderStyle: "rounded",
      borderColor: PROMPT_BORDER,
      backgroundColor: PROMPT_BG,
      title: options.title,
      padding: 1,
    })
    this.input = new InputRenderable(ctx, { id: `${options.id}-input`, placeholder: "type a message…" })
    this.input.on(InputRenderableEvents.ENTER, (value: string) => options.onSubmit(value))
    box.add(this.input)
    this.add(box)
  }

  get value(): string {
    return this.input.value
  }

  open(): void {
    this.input.focus()
  }

  close(): void {
    this.input.blur()
  }
}
