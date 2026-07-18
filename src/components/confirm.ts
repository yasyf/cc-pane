// A centered confirm modal: pure display, no key handling — the app's router drives y/n.
// Mounted over the live view via renderer.root.add/remove so polls repaint beneath it.

import { BoxRenderable, StyledText, TextRenderable, dim, type RenderContext } from "@opentui/core"

const OVERLAY_ZINDEX = 100
const MODAL_WIDTH = 46
const MODAL_BG = "#161b22"
const MODAL_BORDER = "#d29922"
const CONFIRM_HINT = "y confirm · n cancel"

export interface ConfirmModalOptions {
  readonly id: string
  readonly title: string
  readonly message: string
}

export class ConfirmModal extends BoxRenderable {
  constructor(ctx: RenderContext, options: ConfirmModalOptions) {
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
    const modal = new BoxRenderable(ctx, {
      id: `${options.id}-box`,
      width: MODAL_WIDTH,
      border: true,
      borderStyle: "rounded",
      borderColor: MODAL_BORDER,
      backgroundColor: MODAL_BG,
      title: options.title,
      flexDirection: "column",
      padding: 1,
    })
    modal.add(new TextRenderable(ctx, { id: `${options.id}-message`, content: options.message }))
    modal.add(new TextRenderable(ctx, { id: `${options.id}-hint`, content: new StyledText([dim(CONFIRM_HINT)]) }))
    this.add(modal)
  }
}
