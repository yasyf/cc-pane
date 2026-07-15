import { createCliRenderer } from "@opentui/core"

import { buildApp } from "./app.ts"

const renderer = await createCliRenderer({ exitOnCtrlC: true })
buildApp(renderer)
