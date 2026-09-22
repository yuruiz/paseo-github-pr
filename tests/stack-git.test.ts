import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { Runtime } from "../server/runtime";
import { Git } from "../server/git";
import { GitHub } from "../server/github";
import { Store } from "../server/store";
import { Stacks } from "../server/stack";
import { Policy } from "../shared/model";
import { run } from "../server/process";
import { pr } from "./fixtures";
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(`${tmpdir()}/paseo-github-stack-`);
  dirs.push(root);
  const git = new Git();
  await git.command(root, "init", "-b", "one");
  await git.command(root, "config", "user.name", "Test");
  await git.command(root, "config", "user.email", "test@example.test");
  await writeFile(`${root}/file`, "one");
  await git.command(root, "add", ".");
  await git.command(root, "commit", "-m", "one");
  const oldSha = await git.command(root, "rev-parse", "HEAD");
  await git.command(root, "switch", "-c", "two");
  await writeFile(`${root}/file`, "two");
  await git.command(root, "commit", "-am", "two");
  const nextSha = await git.command(root, "rev-parse", "HEAD");
  await git.command(root, "update-ref", "refs/pull/2/head", nextSha);
  await git.command(root, "switch", "one");
  const next = pr({ id: "p2", number: 2, headRepo: "org/repo", headRef: "two", headSha: nextSha });
  const github = new GitHub();
  github.read = async () => next;
  const localGit = new Git(async (file, args, cwd, input) => {
    const mapped = args.map((v) => (v === "https://github.com/org/repo.git" ? root : v));
    return run(file, mapped, cwd, input);
  });
  const runtime = new Runtime(github, localGit);
  runtime.store = new Store(`${root}/../state-${root.split("/").pop()}`);
  dirs.push(runtime.store.directory);
  stores.push(runtime.store);
  await runtime.store.open();
  runtime.api = {
    agents: { list: async () => ({ entries: [], pageInfo: {} }) },
  } as unknown as PaseoApi;
  runtime.refreshWorkspaces = async () => {
    runtime.workspaces = [await localGit.inspect("w", "p", root, "Workspace")];
  };
  await runtime.refreshWorkspaces();
  await runtime.store.update((s) => {
    s.prs.p2 = next;
    s.bindings.w = {
      workspaceId: "w",
      prId: "p1",
      role: "author",
      policy: Policy.parse({}),
      stack: ["p1", "p2"],
    };
  });
  return { runtime, root, oldSha, nextSha, next, stack: new Stacks(runtime) };
}
test("real Git switch preserves Workspace identity and atomically advances binding", async () => {
  const f = await fixture();
  await f.stack.switchTo(f.runtime.workspace("w"), f.next, f.runtime.state.bindings.w);
  expect(await f.runtime.git.command(f.root, "branch", "--show-current")).toBe("two");
  expect(f.runtime.state.bindings.w.prId).toBe("p2");
  expect(f.runtime.state.bindings.w.rolling).toBeUndefined();
});
test("dirty worktree prevents switching and keeps pending changes", async () => {
  const f = await fixture();
  await writeFile(`${f.root}/file`, "unsaved");
  await expect(
    f.stack.switchTo(f.runtime.workspace("w"), f.next, f.runtime.state.bindings.w),
  ).rejects.toThrow("local changes");
  expect(await f.runtime.git.command(f.root, "branch", "--show-current")).toBe("one");
  expect(f.runtime.state.bindings.w.prId).toBe("p1");
});
test("restart after switch completes the journal without repeating Git mutation", async () => {
  const f = await fixture();
  await f.runtime.store!.update((s) => {
    s.bindings.w.rolling = { from: "p1", to: "p2", oldSha: f.oldSha };
  });
  await f.runtime.git.command(f.root, "switch", "two");
  await f.stack.switchTo(f.runtime.workspace("w"), f.next, f.runtime.state.bindings.w);
  expect(f.runtime.state.bindings.w.prId).toBe("p2");
  expect(f.runtime.state.bindings.w.rolling).toBeUndefined();
});
test("three-layer stack advances across consecutive merges and retains the Workspace", async () => {
  const f = await fixture();
  await f.runtime.git.command(f.root, "switch", "two");
  await f.runtime.git.command(f.root, "switch", "-c", "three");
  await writeFile(`${f.root}/file`, "three");
  await f.runtime.git.command(f.root, "commit", "-am", "three");
  const sha = await f.runtime.git.command(f.root, "rev-parse", "HEAD");
  await f.runtime.git.command(f.root, "update-ref", "refs/pull/3/head", sha);
  await f.runtime.git.command(f.root, "switch", "one");
  await f.runtime.refreshWorkspaces();
  const first = pr({
    id: "p1",
    number: 1,
    headRepo: "org/repo",
    headRef: "one",
    headSha: f.oldSha,
    state: "merged",
  });
  const second = { ...f.next, baseRef: "one" };
  const third = pr({
    id: "p3",
    number: 3,
    headRepo: "org/repo",
    headRef: "three",
    baseRef: "two",
    headSha: sha,
  });
  f.runtime.github.read = async (_, number) => f.runtime.pr(`p${number}`);
  await f.runtime.store!.update((s) => {
    s.prs = { p1: first, p2: second, p3: third };
    s.bindings.w.stack = ["p1", "p2", "p3"];
  });
  await f.stack.reconcile(f.runtime.state.bindings.w);
  expect(f.runtime.state.bindings.w.prId).toBe("p2");
  expect(f.runtime.workspace("w").directory).toBe(f.root);
  await f.runtime.store!.update((s) => {
    s.prs.p2.state = "merged";
    s.prs.p3.baseRef = "main";
  });
  await f.stack.reconcile(f.runtime.state.bindings.w);
  expect(f.runtime.state.bindings.w.prId).toBe("p3");
  expect(f.runtime.workspace("w").sha).toBe(sha);
  await f.runtime.store!.update((s) => {
    s.prs.p3.state = "merged";
  });
  await f.stack.reconcile(f.runtime.state.bindings.w);
  expect(f.runtime.state.bindings.w.blocked).toContain("complete");
  expect(f.runtime.workspace("w").id).toBe("w");
});
test("occupied target worktree blocks progression and retries after release", async () => {
  const f = await fixture();
  const other = await mkdtemp(`${tmpdir()}/paseo-github-occupied-`);
  dirs.push(other);
  await f.runtime.git.command(f.root, "worktree", "add", other, "two");
  await expect(
    f.stack.switchTo(f.runtime.workspace("w"), f.next, f.runtime.state.bindings.w),
  ).rejects.toThrow();
  expect(f.runtime.state.bindings.w.prId).toBe("p1");
  await f.runtime.git.command(other, "switch", "--detach");
  await f.stack.switchTo(f.runtime.workspace("w"), f.next, f.runtime.state.bindings.w);
  expect(f.runtime.state.bindings.w.prId).toBe("p2");
});
