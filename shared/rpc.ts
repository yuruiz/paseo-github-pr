import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { State, Workspace, Policy, Config } from "./model";
export const snapshot = defineRpc({
  name: "github.snapshot",
  input: z.object({}),
  output: z.object({
    state: State,
    workspaces: z.array(Workspace),
    connected: z.boolean(),
    error: z.string().optional(),
  }),
});
export const command = defineRpc({
  name: "github.command",
  input: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("preparePRAction"),
      prId: z.string(),
      kind: z.enum(["comment", "close"]),
      body: z.string().max(65536),
    }),
    z.object({ action: z.literal("confirmPRAction"), id: z.string(), fingerprint: z.string() }),
    z.object({ action: z.literal("dismissPRAction"), id: z.string() }),
    z.object({
      action: z.literal("stack"),
      workspaceId: z.string(),
      prIds: z.array(z.string()).min(1),
    }),
    z.object({ action: z.literal("refresh") }),
    z.object({ action: z.literal("configure"), config: Config, revision: z.number() }),
    z.object({ action: z.literal("bind"), prId: z.string(), workspaceId: z.string() }),
    z.object({ action: z.literal("policy"), workspaceId: z.string(), policy: Policy }),
    z.object({
      action: z.literal("takeover"),
      prId: z.string(),
      repositoryPath: z.string(),
      clone: z.boolean().default(false),
    }),
    z.object({
      action: z.literal("review"),
      url: z.string(),
      repositoryPath: z.string(),
      provider: z.string(),
      mode: z.enum(["full", "incremental"]).default("full"),
      clone: z.boolean().default(false),
    }),
    z.object({
      action: z.literal("prepare"),
      taskId: z.string(),
      kind: z.enum(["push", "comment", "review"]),
      body: z.string(),
    }),
    z.object({ action: z.literal("publish"), publicationId: z.string(), fingerprint: z.string() }),
    z.object({ action: z.literal("retry"), taskId: z.string() }),
    z.object({ action: z.literal("resolve"), taskId: z.string() }),
    z.object({ action: z.literal("read"), prId: z.string() }),
  ]),
  output: z.object({ message: z.string() }),
});
