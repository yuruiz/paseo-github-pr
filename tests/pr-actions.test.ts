import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { Runtime } from "../server/runtime";
import { Store } from "../server/store";
import { PRActions } from "../server/pr-actions";
import { GitHub } from "../server/github";
import { State, emptyState, type PRActionInfo } from "../shared/model";
import { pr } from "./fixtures";
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(`${tmpdir()}/paseo-github-pr-actions-`);
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  await store.open();
  const github = new GitHub();
  const current = pr();
  const writes: { kind: string; body?: string }[] = [];
  github.account = async () => "alice";
  github.read = async () => structuredClone(current);
  github.publish = async (_, kind, body) => {
    writes.push({ kind, body });
  };
  github.close = async () => {
    writes.push({ kind: "close" });
    current.state = "closed";
    return "closed";
  };
  const runtime = new Runtime(github);
  runtime.store = store;
  await store.update((s) => {
    s.account = "alice";
    s.prs[current.id] = structuredClone(current);
  });
  const extension = new PRActions(runtime);
  const command = (input: Parameters<PRActions["command"]>[0]) =>
    runtime.exclusive(() => extension.command(input));
  const prepare = async (
    kind: "comment" | "close" = "comment",
    body = kind === "comment" ? "Exact **comment**\nsecond line" : "",
  ) => {
    await command({ action: "preparePRAction", prId: current.id, kind, body });
    return Object.values(store.state.prActions).find((a) => a.status === "pending")!;
  };
  const confirm = (a: PRActionInfo) =>
    command({ action: "confirmPRAction", id: a.id, fingerprint: a.fingerprint });
  return { store, runtime, github, current, writes, prepare, confirm, command, extension };
}
test("manual comments need no Workspace or agent; preparation is read-only, concurrent confirmation posts once", async () => {
  const f = await setup();
  const a = await f.prepare();
  expect(f.writes).toEqual([]);
  expect(f.runtime.workspaces).toEqual([]);
  const results = await Promise.allSettled([f.confirm(a), f.confirm(a)]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(f.writes).toEqual([{ kind: "comment", body: "Exact **comment**\nsecond line" }]);
  expect(f.store.state.prActions[a.id].status).toBe("done");
});
test("cancel, blank body, and obsolete previews cannot publish", async () => {
  const f = await setup();
  await expect(f.prepare("comment", " ")).rejects.toThrow("Enter a comment");
  const first = await f.prepare();
  const replacement = await f.prepare("comment", "changed body");
  await expect(f.confirm(first)).rejects.toThrow("Approval");
  await f.command({ action: "dismissPRAction", id: replacement.id });
  await expect(f.confirm(replacement)).rejects.toThrow("Approval");
  expect(f.writes).toEqual([]);
});
test.each(["head", "base", "state", "account"])(
  "%s changes invalidate approval before a remote write",
  async (change) => {
    const f = await setup();
    const a = await f.prepare();
    if (change === "head") f.current.headSha = "new";
    if (change === "base") f.current.baseSha = "new";
    if (change === "state") f.current.state = "merged";
    if (change === "account") f.github.account = async () => "bob";
    await expect(f.confirm(a)).rejects.toThrow("changed");
    expect(f.store.state.prActions[a.id].status).toBe("stale");
    expect(f.writes).toEqual([]);
  },
);
test("mutating prepared content cannot reuse a previous fingerprint", async () => {
  const f = await setup();
  const a = await f.prepare();
  await f.store.update((s) => {
    s.prActions[a.id].body = "different";
  });
  await expect(f.confirm(a)).rejects.toThrow("content changed");
  expect(f.writes).toEqual([]);
});
test("pending close survives reopening the store and confirms once without merging", async () => {
  const f = await setup();
  const a = await f.prepare("close");
  expect(f.current.state).toBe("open");
  await f.store.close();
  await f.store.open();
  await f.confirm(f.store.state.prActions[a.id]);
  expect(f.writes).toEqual([{ kind: "close" }]);
  expect(f.store.state.prs.PR_1.state).toBe("closed");
  await expect(f.confirm(a)).rejects.toThrow("Approval");
  await expect(f.prepare("close")).rejects.toThrow("Only an open PR");
});
test("uncertain delivery is not resent and requires inspection before a new action", async () => {
  const f = await setup();
  const a = await f.prepare();
  f.github.publish = async () => {
    f.writes.push({ kind: "comment" });
    throw new Error("connection lost after send");
  };
  await expect(f.confirm(a)).rejects.toThrow("connection lost");
  await expect(f.confirm(a)).rejects.toThrow("Approval");
  await expect(f.prepare()).rejects.toThrow("uncertain");
  await f.extension.tick();
  expect(f.writes).toHaveLength(1);
  expect(f.store.state.prActions[a.id].status).toBe("attention");
  await f.command({ action: "dismissPRAction", id: a.id });
  await f.prepare();
  expect(f.writes).toHaveLength(1);
});
test("an interrupted executing record recovers to attention, never automatic retry", async () => {
  const f = await setup();
  const a = await f.prepare("close");
  await f.store.update((s) => {
    s.prActions[a.id].status = "executing";
  });
  await f.store.close();
  await f.store.open();
  await f.extension.tick();
  expect(f.store.state.prActions[a.id].status).toBe("attention");
  expect(f.writes).toEqual([]);
});
test("refresh failure after acknowledged success does not allow a duplicate", async () => {
  const f = await setup();
  const a = await f.prepare();
  f.github.publish = async () => {
    f.writes.push({ kind: "comment" });
    f.github.read = async () => {
      throw new Error("offline");
    };
  };
  await f.confirm(a);
  expect(f.store.state.prActions[a.id].status).toBe("done");
  expect(f.store.state.prActions[a.id].error).toContain("Action succeeded");
  await expect(f.confirm(a)).rejects.toThrow("Approval");
  expect(f.writes).toHaveLength(1);
});
test("previous state snapshots load with an empty action journal", () => {
  const { prActions: _, ...old } = emptyState();
  expect(State.parse(old).prActions).toEqual({});
});
test("GitHub requests use exact JSON input and close changes only PR state", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const gh = new GitHub(async (_, args, _cwd, input) => {
    calls.push({ args, input });
    return args.includes("PATCH") ? '{"state":"closed","merged":false}' : "{}";
  });
  const p = pr();
  const body = 'exact "quote"\n$(literal)';
  await gh.publish(p, "comment", body);
  await gh.close(p);
  expect(calls[0].args).toContain("repos/org/repo/issues/1/comments");
  expect(JSON.parse(calls[0].input!)).toEqual({ body });
  expect(calls[1].args).toContain("PATCH");
  expect(calls[1].args).toContain("repos/org/repo/pulls/1");
  expect(JSON.parse(calls[1].input!)).toEqual({ state: "closed" });
});
