import { z } from "zod";

export const Signal = z.object({
  key: z.string(),
  kind: z.enum(["comment", "ci", "conflict", "head"]),
  sha: z.string(),
  text: z.string(),
  url: z.string().optional(),
});
export const PullRequest = z.object({
  id: z.string(),
  repoId: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  body: z.string().optional(),
  author: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  headRepo: z.string().nullable(),
  headRef: z.string(),
  headSha: z.string(),
  baseRepo: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  trunk: z.string(),
  mergeable: z.boolean().nullable(),
  signals: z.array(Signal),
  seen: z.array(z.string()),
  initialized: z.boolean(),
  unread: z.number(),
  updatedAt: z.string(),
  error: z.string().optional(),
});
export type PR = z.infer<typeof PullRequest>;
export type EventSignal = z.infer<typeof Signal>;
export const Workspace = z.object({
  id: z.string(),
  projectId: z.string(),
  directory: z.string(),
  name: z.string(),
  branch: z.string(),
  sha: z.string(),
  remotes: z.array(z.string()),
  headRemote: z.string().nullable(),
  dirty: z.boolean(),
  operation: z.boolean(),
  commonDir: z.string(),
  checkoutRoot: z.string(),
  error: z.string().optional(),
});
export type WorkspaceInfo = z.infer<typeof Workspace>;
export const Policy = z.object({
  enabled: z.boolean().default(false),
  comments: z.boolean().default(false),
  ci: z.boolean().default(false),
  conflict: z.boolean().default(false),
  provider: z.string().default(""),
  hourlyLimit: z.number().int().min(1).max(20).default(3),
});
export const Binding = z.object({
  workspaceId: z.string(),
  prId: z.string(),
  role: z.enum(["author", "review"]),
  policy: Policy,
  agentId: z.string().optional(),
  stack: z.array(z.string()).default([]),
  manualStack: z.boolean().optional(),
  blocked: z.string().optional(),
  rolling: z.object({ from: z.string(), to: z.string(), oldSha: z.string() }).optional(),
  lastReviewedSha: z.string().optional(),
});
export type BindingInfo = z.infer<typeof Binding>;
export const Task = z.object({
  id: z.string(),
  workspaceId: z.string(),
  prId: z.string(),
  sha: z.string(),
  baseSha: z.string(),
  kind: z.enum(["repair", "review"]),
  eventKeys: z.array(z.string()),
  text: z.string(),
  status: z.enum([
    "queued",
    "dispatching",
    "running",
    "attention",
    "approval",
    "done",
    "obsolete",
    "failed",
  ]),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  retryAt: z.number().optional(),
  agentId: z.string().optional(),
  messageId: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  mode: z.enum(["full", "incremental"]).optional(),
  previousSha: z.string().optional(),
});
export type TaskInfo = z.infer<typeof Task>;
export const Publication = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["push", "comment", "review"]),
  prId: z.string(),
  workspaceId: z.string(),
  sha: z.string(),
  baseSha: z.string(),
  localSha: z.string(),
  fingerprint: z.string(),
  body: z.string(),
  diff: z.string(),
  status: z.enum(["pending", "publishing", "published", "stale", "attention"]),
  error: z.string().optional(),
});
export type PublicationInfo = z.infer<typeof Publication>;
export const PRAction = z.object({
  id: z.string(),
  prId: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  kind: z.enum(["comment", "close"]),
  body: z.string(),
  account: z.string(),
  sha: z.string(),
  baseSha: z.string(),
  prState: z.enum(["open", "closed", "merged"]),
  fingerprint: z.string(),
  createdAt: z.number(),
  status: z.enum(["pending", "executing", "done", "stale", "attention", "cancelled"]),
  error: z.string().optional(),
});
export type PRActionInfo = z.infer<typeof PRAction>;
export const Config = z.object({
  discoverySeconds: z.number().int().min(60).default(300),
  pollSeconds: z.number().int().min(30).default(60),
});
export const State = z.object({
  version: z.literal(1),
  revision: z.number(),
  config: Config,
  account: z.string(),
  prs: z.record(z.string(), PullRequest),
  bindings: z.record(z.string(), Binding),
  tasks: z.record(z.string(), Task),
  publications: z.record(z.string(), Publication),
  prActions: z.record(z.string(), PRAction).default({}),
  discoveryAt: z.number(),
  pollAt: z.number(),
  lastError: z.string().optional(),
});
export type PluginState = z.infer<typeof State>;
export function emptyState(): PluginState {
  return State.parse({
    version: 1,
    revision: 0,
    config: {},
    account: "",
    prs: {},
    bindings: {},
    tasks: {},
    publications: {},
    discoveryAt: 0,
    pollAt: 0,
  });
}
