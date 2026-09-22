import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { GitHub } from "../server/github";
import { Runtime } from "../server/runtime";
import { Store } from "../server/store";
import { PullRequest } from "../shared/model";
import { pr } from "./fixtures";
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
test.each(["First paragraph\n\n## Validation\n```ts\nconst answer = 42;\n```\nLast line", null])(
  "GitHub retains the entire description and normalizes null: %s",
  async (body) => {
    const repo = { full_name: "org/repo", node_id: "R_1", default_branch: "main" };
    const raw = {
      node_id: "PR_1",
      number: 1,
      title: "Description",
      body,
      html_url: "https://github.com/org/repo/pull/1",
      user: { login: "alice" },
      state: "open",
      merged: false,
      mergeable: null,
      updated_at: "2026-09-18",
      head: { repo, ref: "feature", sha: "a" },
      base: { repo, ref: "main", sha: "b" },
    };
    const github = new GitHub(async (_, args) =>
      JSON.stringify(args.includes("--paginate") ? [] : raw),
    );
    expect((await github.read("org/repo", 1)).body).toBe(body ?? "");
  },
);
test("legacy descriptions stay distinguishable from empty descriptions and manually refresh for closed PRs", async () => {
  const dir = await mkdtemp(`${tmpdir()}/paseo-github-overview-`);
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  await store.open();
  const legacy = PullRequest.parse(pr({ state: "closed" }));
  expect(legacy.body).toBeUndefined();
  const github = new GitHub();
  let reads = 0;
  github.discover = async () => ({ account: "alice", urls: [] });
  github.read = async () => {
    reads++;
    return { ...legacy, body: "Complete historical description\nFinal line" };
  };
  const runtime = new Runtime(github);
  runtime.store = store;
  runtime.api = {
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
  } as unknown as PaseoApi;
  await store.update((s) => {
    s.account = "alice";
    s.prs[legacy.id] = legacy;
  });
  await runtime.tick();
  expect(reads).toBe(0);
  await runtime.tick(true);
  expect(reads).toBe(1);
  expect(store.state.prs.PR_1.body).toBe("Complete historical description\nFinal line");
  await store.close();
  await store.open();
  expect(store.state.prs.PR_1.body).toBe("Complete historical description\nFinal line");
  await runtime.tick(true);
  expect(reads).toBe(1);
});
