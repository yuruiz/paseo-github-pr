import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { Runtime } from "../server/runtime";
import { Store } from "../server/store";
import { GitHub } from "../server/github";
import { Publications } from "../server/publication";
import { localSnapshot } from "../server/automation";
import { pr, workspace } from "./fixtures";
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(`${tmpdir()}/paseo-github-approval-`);
  dirs.push(root);
  const gh = new GitHub();
  let writes = 0;
  gh.publish = async () => {
    writes++;
  };
  const runtime = new Runtime(gh);
  await runtime.git.command(root, "init", "-b", "feature");
  await runtime.git.command(root, "config", "user.name", "Test");
  await runtime.git.command(root, "config", "user.email", "test@example.test");
  await writeFile(`${root}/file`, "original");
  await runtime.git.command(root, "add", ".");
  await runtime.git.command(root, "commit", "-m", "initial");
  const sha = await runtime.git.command(root, "rev-parse", "HEAD");
  const current = pr({ headSha: sha });
  gh.read = async () => current;
  const stateDir = await mkdtemp(`${tmpdir()}/paseo-github-approval-state-`);
  dirs.push(stateDir);
  runtime.store = new Store(stateDir);
  stores.push(runtime.store);
  await runtime.store.open();
  runtime.workspaces = [workspace({ directory: root, checkoutRoot: root, sha })];
  runtime.api = {
    agents: { list: async () => ({ entries: [], pageInfo: {} }) },
  } as unknown as PaseoApi;
  await runtime.store.update((s) => {
    s.prs[current.id] = current;
    s.tasks.t = {
      id: "t",
      workspaceId: "w1",
      prId: current.id,
      sha,
      baseSha: current.baseSha,
      kind: "repair",
      eventKeys: [],
      text: "",
      status: "approval",
      createdAt: 1,
      messageId: "m",
      result: "fixed",
    };
  });
  return { runtime, root, current, publications: new Publications(runtime), writes: () => writes };
}
test("changing files after preview invalidates approval without a remote call", async () => {
  const f = await setup();
  await f.publications.command({
    action: "prepare",
    taskId: "t",
    kind: "comment",
    body: "approved text",
  });
  const p = Object.values(f.runtime.state.publications)[0];
  await writeFile(`${f.root}/file`, "changed");
  await expect(
    f.publications.command({ action: "publish", publicationId: p.id, fingerprint: p.fingerprint }),
  ).rejects.toThrow("changed");
  expect(f.writes()).toBe(0);
  expect(f.runtime.state.publications[p.id].status).toBe("stale");
});
test("changing remote SHA invalidates review approval", async () => {
  const f = await setup();
  await f.publications.command({ action: "prepare", taskId: "t", kind: "comment", body: "text" });
  const p = Object.values(f.runtime.state.publications)[0];
  f.current.headSha = "c".repeat(40);
  await expect(
    f.publications.command({ action: "publish", publicationId: p.id, fingerprint: p.fingerprint }),
  ).rejects.toThrow("changed");
  expect(f.writes()).toBe(0);
});
test("a confirmed publication is not sent twice and replaces prior drafts", async () => {
  const f = await setup();
  await f.publications.command({ action: "prepare", taskId: "t", kind: "comment", body: "old" });
  const old = Object.values(f.runtime.state.publications)[0];
  await f.publications.command({ action: "prepare", taskId: "t", kind: "comment", body: "new" });
  expect(f.runtime.state.publications[old.id].status).toBe("stale");
  const p = Object.values(f.runtime.state.publications).find((p) => p.status === "pending")!;
  await f.publications.command({
    action: "publish",
    publicationId: p.id,
    fingerprint: p.fingerprint,
  });
  expect(f.writes()).toBe(1);
  await expect(
    f.publications.command({ action: "publish", publicationId: p.id, fingerprint: p.fingerprint }),
  ).rejects.toThrow("no longer valid");
  expect(f.writes()).toBe(1);
});
test("untracked file publication fingerprint is stable after staging", async () => {
  const f = await setup();
  await writeFile(`${f.root}/added`, "content");
  const w = f.runtime.workspace("w1");
  const before = await localSnapshot(f.runtime, w);
  await f.runtime.git.command(f.root, "add", ".");
  expect((await localSnapshot(f.runtime, w)).fingerprint).toBe(before.fingerprint);
});
test("confirmed diff commits and fast-forward pushes the exact tree to a local remote", async () => {
  const f = await setup();
  const remote = await mkdtemp(`${tmpdir()}/paseo-github-push-remote-`);
  dirs.push(remote);
  await f.runtime.git.command(remote, "init", "--bare");
  await f.runtime.git.command(f.root, "push", remote, "HEAD:refs/heads/feature");
  const original = f.runtime.git.command.bind(f.runtime.git);
  f.runtime.git.command = (cwd, ...args) =>
    original(cwd, ...args.map((a) => (a === "https://github.com/alice/repo.git" ? remote : a)));
  await writeFile(`${f.root}/file`, "approved change");
  await writeFile(`${f.root}/new-file`, "new content");
  await f.publications.command({
    action: "prepare",
    taskId: "t",
    kind: "push",
    body: "fix: approved changes",
  });
  const p = Object.values(f.runtime.state.publications)[0];
  await f.publications.command({
    action: "publish",
    publicationId: p.id,
    fingerprint: p.fingerprint,
  });
  const published = await original(remote, "rev-parse", "refs/heads/feature");
  expect(await original(f.root, "rev-parse", "HEAD")).toBe(published);
  expect(await original(remote, "show", "feature:new-file")).toBe("new content");
  expect(await original(remote, "rev-parse", "feature^")).toBe(f.current.headSha);
  expect(f.runtime.state.publications[p.id].status).toBe("published");
  expect(await original(f.root, "status", "--porcelain")).toBe("");
});
test("commit hook mutations cannot publish unapproved content", async () => {
  const f = await setup();
  await writeFile(`${f.root}/file`, "approved change");
  await writeFile(
    `${f.root}/.git/hooks/pre-commit`,
    "#!/bin/sh\nprintf unexpected > file\ngit add file\n",
    { mode: 0o755 },
  );
  await f.publications.command({
    action: "prepare",
    taskId: "t",
    kind: "push",
    body: "fix: approved changes",
  });
  const p = Object.values(f.runtime.state.publications)[0];
  let pushes = 0;
  const original = f.runtime.git.command.bind(f.runtime.git);
  f.runtime.git.command = (cwd, ...args) => {
    if (args[0] === "push") pushes++;
    return original(cwd, ...args);
  };
  await expect(
    f.publications.command({ action: "publish", publicationId: p.id, fingerprint: p.fingerprint }),
  ).rejects.toThrow("hooks changed");
  expect(pushes).toBe(0);
  expect(f.runtime.state.publications[p.id].status).toBe("attention");
});
