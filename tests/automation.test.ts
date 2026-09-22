import { tmpdir } from "node:os";
import { expect, test, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { enqueueEvents, safeAgentConfig, localSnapshot, transcript } from "../server/automation";
import { emptyState, Policy } from "../shared/model";
import { Runtime } from "../server/runtime";
import { run } from "../server/process";
import type { PaseoAgentHandle } from "@getpaseo/client";
import { pr, workspace } from "./fixtures";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
test("events coalesce within 30 seconds; review bindings never auto-run", () => {
  const state = emptyState();
  state.bindings.w1 = {
    workspaceId: "w1",
    prId: "PR_1",
    role: "author",
    policy: Policy.parse({ enabled: true, ci: true }),
    stack: [],
  };
  const e = { key: "check:sha:1", kind: "ci" as const, sha: "a", text: "failed" };
  enqueueEvents(state, pr(), [e], 1000);
  enqueueEvents(state, pr(), [{ ...e, key: "check:sha:2" }], 2000);
  expect(Object.values(state.tasks).map((t) => t.eventKeys)).toEqual([[e.key, "check:sha:2"]]);
  state.bindings.w1.role = "review";
  enqueueEvents(state, pr(), [e], 60000);
  expect(Object.keys(state.tasks)).toHaveLength(1);
});
test("unsupported providers cannot silently run without the publication boundary", () => {
  expect(() => safeAgentConfig("claude/model", "/example/repo")).toThrow("enforced sandbox");
  expect(safeAgentConfig("codex/model", "/example/repo").options).toMatchObject({
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: { network_access: false, exclude_slash_tmp: true },
    web_search: "disabled",
  });
  expect(safeAgentConfig("codex/model", "/example/repo", true).options).toMatchObject({
    sandbox_mode: "read-only",
  });
});
test("publication fingerprint survives staging new files but detects content changes", async () => {
  const root = await mkdtemp(`${tmpdir()}/paseo-github-publication-`);
  dirs.push(root);
  await mkdir(root, { recursive: true });
  await run("git", ["init", "-b", "main"], root);
  await run(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    root,
  );
  await writeFile(`${root}/new.txt`, "approved\n");
  const runtime = new Runtime();
  const w = workspace({ directory: root, checkoutRoot: root });
  const before = await localSnapshot(runtime, w);
  await run("git", ["add", "."], root);
  expect((await localSnapshot(runtime, w)).fingerprint).toBe(before.fingerprint);
  await writeFile(`${root}/new.txt`, "changed\n");
  expect((await localSnapshot(runtime, w)).fingerprint).not.toBe(before.fingerprint);
});
test("recovery finds sent messages across pages and does not assign unrelated outputs", async () => {
  let calls = 0;
  const agent = {
    timeline: {
      refetch: async () => {
        calls++;
        return {
          entries:
            calls === 1
              ? [{ item: { type: "assistant_message", text: "answer" } }]
              : [{ item: { type: "user_message", clientMessageId: "job" } }],
          hasOlder: calls === 1,
          startCursor: { seq: 1, epoch: "e" },
          error: null,
        };
      },
    },
  } as unknown as PaseoAgentHandle;
  expect(await transcript(agent, "job")).toEqual({ found: true, result: "answer" });
  expect(calls).toBe(2);
  const other = {
    timeline: {
      refetch: async () => ({
        entries: [
          { item: { type: "user_message", clientMessageId: "job" } },
          { item: { type: "user_message", clientMessageId: "other" } },
          { item: { type: "assistant_message", text: "other answer" } },
        ],
        hasOlder: false,
        error: null,
      }),
    },
  } as unknown as PaseoAgentHandle;
  expect(await transcript(other, "job")).toEqual({ found: true, result: undefined });
});
test("daemon MCP injection and changed native permissions block unattended execution", async () => {
  const { assertDaemonPolicy, assertSessionPolicy } = await import("../server/automation");
  const api = (injected: boolean, disabled = false) =>
    ({
      config: {
        get: async () => ({
          config: {
            mcp: { injectIntoAgents: injected },
            providers: disabled ? { codex: { paseoTools: { enabled: false } } } : {},
          },
        }),
      },
    }) as unknown as import("@getpaseo/client").PaseoApi;
  await expect(assertDaemonPolicy(api(true))).rejects.toThrow("MCP injection");
  await expect(assertDaemonPolicy(api(false))).resolves.toBeUndefined();
  await expect(assertDaemonPolicy(api(true, true))).resolves.toBeUndefined();
  const expected = safeAgentConfig("codex/model", "/example/repo");
  const metadata = { providerOptions: expected.options, mcpServers: {} };
  const handle = { current: () => ({ persistence: { metadata } }) } as unknown as PaseoAgentHandle;
  expect(() => assertSessionPolicy(handle, expected)).not.toThrow();
  metadata.providerOptions = { ...expected.options, sandbox_mode: "danger-full-access" };
  expect(() => assertSessionPolicy(handle, expected)).toThrow("permissions changed");
  metadata.providerOptions = expected.options;
  metadata.providerOptions = {
    ...expected.options,
    features: { multi_agent_v2: false, network_proxy: true },
  };
  expect(() => assertSessionPolicy(handle, expected)).toThrow("permissions changed");
});
