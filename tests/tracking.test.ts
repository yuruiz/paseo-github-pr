import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { Store, dataPath } from "../server/store";
import { candidates, githubRepo } from "../server/git";
import { GitHub, parseUrl } from "../server/github";
import { Runtime } from "../server/runtime";
import { pr, workspace } from "./fixtures";
const directories: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true });
});
async function store() {
  const d = await mkdtemp(`${tmpdir()}/paseo-github-tracking-`);
  directories.push(d);
  const s = new Store(d);
  stores.push(s);
  await s.open();
  return s;
}
test("fork identity disambiguates same branch names and multiple matches remain explicit", () => {
  expect(
    candidates(pr(), [
      workspace(),
      workspace({ id: "wrong", headRemote: "bob/repo" }),
      workspace({ id: "other", remotes: ["org/other"], headRemote: "alice/other" }),
    ]).map((w) => w.id),
  ).toEqual(["w1"]);
  expect(candidates(pr(), [workspace(), workspace({ id: "w2" })]).length).toBe(2);
  expect(githubRepo("git@github.com:Org/Repo.git")).toBe("org/repo");
  expect(githubRepo("https://evil.test/org/repo")).toBeNull();
  expect(() => parseUrl("https://evil.test/org/repo/pull/1")).toThrow();
});
test("atomic state survives restart; live lock excludes a second writer", async () => {
  const s = await store();
  await s.update((v) => {
    v.account = "alice";
  });
  expect(JSON.parse(await readFile(path.join(s.directory, "state.json"), "utf8")).account).toBe(
    "alice",
  );
  const competing = new Store(s.directory);
  await expect(competing.open()).rejects.toThrow("locked");
  await s.close();
  const next = new Store(s.directory);
  stores.push(next);
  await next.open();
  expect(next.state.account).toBe("alice");
});
test("failed transaction does not corrupt state and subsequent updates work", async () => {
  const s = await store();
  await expect(
    s.update((v) => {
      v.account = "wrong";
      throw new Error("interrupted");
    }),
  ).rejects.toThrow("interrupted");
  await s.update((v) => {
    v.account = "correct";
  });
  expect(s.state.account).toBe("correct");
  await expect(dataPath("relative/path")).rejects.toThrow("absolute path");
  await expect(dataPath(path.parse(s.directory).root)).rejects.toThrow("filesystem root");
  await expect(dataPath(path.join(s.directory, "new", "state"))).resolves.toBe(
    path.join(s.directory, "new", "state"),
  );
});
test("baseline and repeated poll do not replay comments", async () => {
  const runtime = new Runtime();
  runtime.store = await store();
  const old = { key: "comment:1:v1", kind: "comment" as const, sha: "a", text: "old" };
  await runtime.ingest(pr({ signals: [old], initialized: false }));
  expect(runtime.state.prs.PR_1.unread).toBe(0);
  const fresh = { ...old, key: "comment:2:v1", text: "new" };
  await runtime.ingest(pr({ signals: [old, fresh] }));
  await runtime.ingest(pr({ signals: [old, fresh] }));
  expect(runtime.state.prs.PR_1.unread).toBe(1);
});
test("GitHub discovery paginates without a search result cap", async () => {
  const calls: string[][] = [];
  const gh = new GitHub(async (_, args) => {
    calls.push(args);
    const pullRequests = {
      nodes: [{ url: calls.length === 1 ? "one" : "two" }],
      pageInfo: { hasNextPage: calls.length === 1, endCursor: "next" },
    };
    return JSON.stringify({ data: { viewer: { login: "alice", pullRequests } } });
  });
  expect(await gh.discover()).toEqual({ account: "alice", urls: ["one", "two"] });
  expect(calls[1]).toContain("cursor=next");
});
test("REST connections flatten all pages", async () => {
  const gh = new GitHub(async () =>
    JSON.stringify([{ check_runs: [{ id: 1 }] }, { check_runs: [{ id: 2 }] }]),
  );
  expect(await gh.pages("repos/org/repo/commits/sha/check-runs", "check_runs")).toEqual([
    { id: 1 },
    { id: 2 },
  ]);
});

test("two PRs matching one checkout remain unbound instead of picking the first", async () => {
  const runtime = new Runtime();
  runtime.store = await store();
  runtime.workspaces = [workspace()];
  await runtime.store.update((s) => {
    s.account = "alice";
    s.prs.first = pr({ id: "first" });
    s.prs.second = pr({ id: "second", number: 2 });
  });
  await runtime.autoBind();
  expect(runtime.state.bindings).toEqual({});
});
test("no-op reconciliation does not churn durable revisions", async () => {
  const s = await store();
  const revision = s.state.revision;
  await s.update(() => {});
  expect(s.state.revision).toBe(revision);
});
