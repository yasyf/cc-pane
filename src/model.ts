// Typed views of the cco fleet/capture and cc-notes graph payloads; parse* is the
// trust boundary — `unknown` in, narrowed view out, throw naming the bad field.

const AGENT_STATES = ["working", "idle", "awaiting-input", "unknown", "blocked", "stuck"] as const
const LIFECYCLE_STATUSES = ["active", "exited", "killed"] as const
const NOTES_EVENT_TYPES = [
  "created",
  "claimed",
  "reclaimed",
  "closed",
  "status",
  "branch_moved",
  "commit_linked",
  "edited",
  "verified",
  "superseded",
  "stale",
  "entry",
  "run_started",
  "run_finished",
] as const

export type AgentState = (typeof AGENT_STATES)[number]
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number]
export type NotesEventType = (typeof NOTES_EVENT_TYPES)[number]

export interface RepoView {
  readonly id: string
  readonly name: string
  readonly backend: string
  readonly cwd: string
  readonly status: LifecycleStatus
  readonly createdAt: string
}

export interface WorkstreamView {
  readonly id: string
  readonly repoId: string
  readonly name: string
  readonly backend: string
  readonly workspaceHandle: string
  readonly branch: string
  readonly worktree: string
  readonly isPrimary: boolean
  readonly ccnotesProject: string
  readonly status: LifecycleStatus
  readonly createdAt: string
}

export interface SprintView {
  readonly id: string
  readonly workstreamId: string
  readonly name: string
  readonly ccnotesSprint: string
  readonly status: LifecycleStatus
  readonly createdAt: string
}

export interface AgentView {
  readonly id: string
  readonly name: string
  readonly sprintId: string
  readonly backend: string
  readonly terminalHandle: string
  readonly status: LifecycleStatus
  readonly state: AgentState
  readonly activity: string
  readonly tokens: number
  readonly prompt: string
  readonly updatedAt: string
  readonly createdAt: string
  readonly sessionId: string
  readonly subjectId: string
  readonly scope: string
  readonly ccnotesTask: string
  readonly restartCount: number
  readonly lastRestartAt: string
}

// null fields are the daemon's dropped `omitempty` zeros; empty repoId = never activated.
export interface RegistryEntry {
  readonly relpath: string
  readonly path: string
  readonly origin: string | null
  readonly trunk: string | null
  readonly localOnly: boolean
  readonly repoId: string | null
}

export interface FleetStatus {
  readonly fleetSubject: string
  readonly seq: number
  readonly httpPort: number
  readonly repos: readonly RepoView[]
  readonly workstreams: readonly WorkstreamView[]
  readonly sprints: readonly SprintView[]
  readonly agents: readonly AgentView[]
  readonly registry: readonly RegistryEntry[]
}

export interface Capture {
  readonly id: string
  readonly content: string
  readonly capturedAt: string
}

export interface NotesEntity {
  readonly kind: string
  readonly id: string
  readonly short: string
  readonly title: string
}

export interface NotesEvent {
  readonly entity: NotesEntity
  readonly type: NotesEventType
  readonly time: number
  readonly branch: string
  readonly sha: string
  readonly detail: string
}

export interface NotesGraph {
  readonly events: readonly NotesEvent[]
}

export interface AgentRepoChain {
  readonly agent: AgentView
  readonly sprint: SprintView
  readonly workstream: WorkstreamView
  readonly repo: RepoView
}

// A fleet-view repo-list row keyed by on-disk path; kind marks its registry/DB origin.
export type RepoRow =
  | { readonly kind: "matched"; readonly key: string; readonly name: string; readonly registry: RegistryEntry; readonly repo: RepoView }
  | { readonly kind: "registry-only"; readonly key: string; readonly name: string; readonly registry: RegistryEntry }
  | { readonly kind: "db-only"; readonly key: string; readonly name: string; readonly repo: RepoView }

function typeName(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

function fail(ctx: string, detail: string): never {
  throw new Error(`${ctx}: ${detail}`)
}

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(ctx, `expected object, got ${typeName(v)}`)
  return v as Record<string, unknown>
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== "string") fail(ctx, `expected string, got ${typeName(v)}`)
  return v
}

function asNumber(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(ctx, `expected finite number, got ${typeName(v)}`)
  return v
}

function asBoolean(v: unknown, ctx: string): boolean {
  if (typeof v !== "boolean") fail(ctx, `expected boolean, got ${typeName(v)}`)
  return v
}

function asArray(v: unknown, ctx: string): readonly unknown[] {
  if (!Array.isArray(v)) fail(ctx, `expected array, got ${typeName(v)}`)
  return v
}

function oneOf<T extends string>(values: readonly T[], v: unknown, ctx: string): T {
  if (typeof v === "string" && (values as readonly string[]).includes(v)) return v as T
  fail(ctx, `expected one of ${values.join("|")}, got ${typeof v === "string" ? JSON.stringify(v) : typeName(v)}`)
}

function optionalString(v: unknown, ctx: string): string | null {
  if (v === undefined) return null
  return asString(v, ctx)
}

function optionalBoolean(v: unknown, ctx: string): boolean {
  if (v === undefined) return false
  return asBoolean(v, ctx)
}

function parseRepo(raw: unknown, ctx: string): RepoView {
  const o = asObject(raw, ctx)
  return {
    id: asString(o.id, `${ctx}.id`),
    name: asString(o.name, `${ctx}.name`),
    backend: asString(o.backend, `${ctx}.backend`),
    cwd: asString(o.cwd, `${ctx}.cwd`),
    status: oneOf(LIFECYCLE_STATUSES, o.status, `${ctx}.status`),
    createdAt: asString(o.created_at, `${ctx}.created_at`),
  }
}

function parseWorkstream(raw: unknown, ctx: string): WorkstreamView {
  const o = asObject(raw, ctx)
  return {
    id: asString(o.id, `${ctx}.id`),
    repoId: asString(o.repo_id, `${ctx}.repo_id`),
    name: asString(o.name, `${ctx}.name`),
    backend: asString(o.backend, `${ctx}.backend`),
    workspaceHandle: asString(o.workspace_handle, `${ctx}.workspace_handle`),
    branch: asString(o.branch, `${ctx}.branch`),
    worktree: asString(o.worktree, `${ctx}.worktree`),
    isPrimary: asBoolean(o.is_primary, `${ctx}.is_primary`),
    ccnotesProject: asString(o.ccnotes_project, `${ctx}.ccnotes_project`),
    status: oneOf(LIFECYCLE_STATUSES, o.status, `${ctx}.status`),
    createdAt: asString(o.created_at, `${ctx}.created_at`),
  }
}

function parseSprint(raw: unknown, ctx: string): SprintView {
  const o = asObject(raw, ctx)
  return {
    id: asString(o.id, `${ctx}.id`),
    workstreamId: asString(o.workstream_id, `${ctx}.workstream_id`),
    name: asString(o.name, `${ctx}.name`),
    ccnotesSprint: asString(o.ccnotes_sprint, `${ctx}.ccnotes_sprint`),
    status: oneOf(LIFECYCLE_STATUSES, o.status, `${ctx}.status`),
    createdAt: asString(o.created_at, `${ctx}.created_at`),
  }
}

function parseAgent(raw: unknown, ctx: string): AgentView {
  const o = asObject(raw, ctx)
  return {
    id: asString(o.id, `${ctx}.id`),
    name: asString(o.name, `${ctx}.name`),
    sprintId: asString(o.sprint_id, `${ctx}.sprint_id`),
    backend: asString(o.backend, `${ctx}.backend`),
    terminalHandle: asString(o.terminal_handle, `${ctx}.terminal_handle`),
    status: oneOf(LIFECYCLE_STATUSES, o.status, `${ctx}.status`),
    state: oneOf(AGENT_STATES, o.state, `${ctx}.state`),
    activity: asString(o.activity, `${ctx}.activity`),
    tokens: asNumber(o.tokens, `${ctx}.tokens`),
    prompt: asString(o.prompt, `${ctx}.prompt`),
    updatedAt: asString(o.updated_at, `${ctx}.updated_at`),
    createdAt: asString(o.created_at, `${ctx}.created_at`),
    sessionId: asString(o.session_id, `${ctx}.session_id`),
    subjectId: asString(o.subject_id, `${ctx}.subject_id`),
    scope: asString(o.scope, `${ctx}.scope`),
    ccnotesTask: asString(o.ccnotes_task, `${ctx}.ccnotes_task`),
    restartCount: asNumber(o.restart_count, `${ctx}.restart_count`),
    lastRestartAt: asString(o.last_restart_at, `${ctx}.last_restart_at`),
  }
}

function parseRegistryEntry(raw: unknown, ctx: string): RegistryEntry {
  const o = asObject(raw, ctx)
  return {
    relpath: asString(o.relpath, `${ctx}.relpath`),
    path: asString(o.path, `${ctx}.path`),
    origin: optionalString(o.origin, `${ctx}.origin`),
    trunk: optionalString(o.trunk, `${ctx}.trunk`),
    localOnly: optionalBoolean(o.local_only, `${ctx}.local_only`),
    repoId: optionalString(o.repo_id, `${ctx}.repo_id`),
  }
}

export function parseFleetStatus(raw: unknown): FleetStatus {
  const o = asObject(raw, "fleetStatus")
  return {
    fleetSubject: asString(o.fleet_subject, "fleetStatus.fleet_subject"),
    seq: asNumber(o.seq, "fleetStatus.seq"),
    httpPort: asNumber(o.http_port, "fleetStatus.http_port"),
    repos: asArray(o.repos, "fleetStatus.repos").map((r, i) => parseRepo(r, `fleetStatus.repos[${i}]`)),
    workstreams: asArray(o.workstreams, "fleetStatus.workstreams").map((r, i) => parseWorkstream(r, `fleetStatus.workstreams[${i}]`)),
    sprints: asArray(o.sprints, "fleetStatus.sprints").map((r, i) => parseSprint(r, `fleetStatus.sprints[${i}]`)),
    agents: asArray(o.agents, "fleetStatus.agents").map((r, i) => parseAgent(r, `fleetStatus.agents[${i}]`)),
    registry: asArray(o.registry, "fleetStatus.registry").map((r, i) => parseRegistryEntry(r, `fleetStatus.registry[${i}]`)),
  }
}

export function parseCapture(raw: unknown): Capture {
  const o = asObject(raw, "capture")
  return {
    id: asString(o.id, "capture.id"),
    content: asString(o.content, "capture.content"),
    capturedAt: asString(o.captured_at, "capture.captured_at"),
  }
}

function parseNotesEntity(raw: unknown, ctx: string): NotesEntity {
  const o = asObject(raw, ctx)
  return {
    kind: asString(o.kind, `${ctx}.kind`),
    id: asString(o.id, `${ctx}.id`),
    short: asString(o.short, `${ctx}.short`),
    title: asString(o.title, `${ctx}.title`),
  }
}

function parseNotesEvent(raw: unknown, ctx: string): NotesEvent {
  const o = asObject(raw, ctx)
  return {
    entity: parseNotesEntity(o.entity, `${ctx}.entity`),
    type: oneOf(NOTES_EVENT_TYPES, o.type, `${ctx}.type`),
    time: asNumber(o.time, `${ctx}.time`),
    branch: asString(o.branch, `${ctx}.branch`),
    sha: asString(o.sha, `${ctx}.sha`),
    detail: asString(o.detail, `${ctx}.detail`),
  }
}

export function parseNotesGraph(raw: unknown): NotesGraph {
  const o = asObject(raw, "notesGraph")
  if (!("events" in o)) fail("notesGraph", "missing events")
  // A nil events slice marshals to JSON null; null and [] both mean no events.
  if (o.events === null) return { events: [] }
  return {
    events: asArray(o.events, "notesGraph.events").map((e, i) => parseNotesEvent(e, `notesGraph.events[${i}]`)),
  }
}

export function agentRepoChain(fleet: FleetStatus, agentId: string): AgentRepoChain {
  const agent = fleet.agents.find((a) => a.id === agentId)
  if (!agent) fail("agentRepoChain", `no agent with id ${agentId}`)
  const sprint = fleet.sprints.find((s) => s.id === agent.sprintId)
  if (!sprint) fail("agentRepoChain", `agent ${agentId} has dangling sprint_id ${agent.sprintId}`)
  const workstream = fleet.workstreams.find((w) => w.id === sprint.workstreamId)
  if (!workstream) fail("agentRepoChain", `sprint ${sprint.id} has dangling workstream_id ${sprint.workstreamId}`)
  const repo = fleet.repos.find((r) => r.id === workstream.repoId)
  if (!repo) fail("agentRepoChain", `workstream ${workstream.id} has dangling repo_id ${workstream.repoId}`)
  return { agent, sprint, workstream, repo }
}

function registryMatches(entry: RegistryEntry, repo: RepoView): boolean {
  return (entry.repoId !== null && entry.repoId === repo.id) || entry.path === repo.cwd
}

export function repoRows(fleet: FleetStatus): readonly RepoRow[] {
  const matchedRepoIds = new Set<string>()
  const registryRows = fleet.registry.map<RepoRow>((entry) => {
    const repo = fleet.repos.find((r) => registryMatches(entry, r))
    if (repo) {
      matchedRepoIds.add(repo.id)
      return { kind: "matched", key: entry.path, name: entry.relpath, registry: entry, repo }
    }
    return { kind: "registry-only", key: entry.path, name: entry.relpath, registry: entry }
  })
  const dbOnlyRows = fleet.repos
    .filter((r) => !matchedRepoIds.has(r.id))
    .map<RepoRow>((repo) => ({ kind: "db-only", key: repo.cwd, name: repo.name, repo }))
  return [...registryRows, ...dbOnlyRows]
}
