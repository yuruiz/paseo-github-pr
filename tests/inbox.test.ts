import { expect, test } from "vitest";
import { emptyState, Policy, type PluginState } from "../shared/model";
import { groupByRepository, inboxRows, matchesFilter, matchesSearch } from "../client/inbox";
import { pr, workspace } from "./fixtures";
function state(): PluginState {
  return emptyState();
}
test("approval and failures lead unread PRs; stale CI and unknown mergeability are not failures", () => {
  const s = state();
  s.prs = {
    unread: pr({ id: "unread", unread: 5 }),
    ci: pr({ id: "ci", signals: [{ key: "ci", kind: "ci", sha: "a".repeat(40), text: "fail" }] }),
    stale: pr({
      id: "stale",
      mergeable: null,
      signals: [{ key: "old", kind: "ci", sha: "old", text: "fail" }],
    }),
    conflict: pr({ id: "conflict", mergeable: false }),
    approval: pr({ id: "approval" }),
  };
  s.tasks.t = {
    id: "t",
    workspaceId: "w1",
    prId: "approval",
    sha: "a",
    baseSha: "b",
    kind: "repair",
    status: "approval",
    createdAt: 1,
    messageId: "m",
    eventKeys: [],
    text: "",
  };
  const rows = inboxRows(s, []);
  expect(rows.map((r) => r.pr.id)).toEqual(["approval", "conflict", "ci", "unread", "stale"]);
  expect(rows.filter((r) => matchesFilter(r, "attention"))).toHaveLength(4);
  expect(rows.at(-1)?.danger).toBeFalsy();
});
test("scope keeps Stack members but excludes other Workspace tasks and review bindings", () => {
  const s = state();
  s.prs = { first: pr({ id: "first" }), next: pr({ id: "next" }), other: pr({ id: "other" }) };
  s.bindings = {
    review: {
      workspaceId: "review",
      prId: "first",
      stack: [],
      role: "review",
      policy: Policy.parse({}),
    },
    w1: {
      workspaceId: "w1",
      prId: "first",
      stack: ["first", "next"],
      role: "author",
      policy: Policy.parse({}),
      blocked: "dirty",
    },
  };
  s.tasks.review = {
    id: "review",
    workspaceId: "review",
    prId: "first",
    sha: "a",
    baseSha: "b",
    kind: "review",
    status: "approval",
    createdAt: 1,
    messageId: "m",
    eventKeys: [],
    text: "",
  };
  const rows = inboxRows(s, [workspace()], "w1");
  expect(rows.map((r) => r.pr.id)).toEqual(["first", "next"]);
  expect(rows[0].binding?.role).toBe("author");
  expect(rows[0].tasks).toHaveLength(0);
  expect(rows[1].attention).toBe(false);
});
test("closed history suppresses old CI but preserves unresolved approvals", () => {
  const s = state();
  s.prs.old = pr({
    id: "old",
    state: "merged",
    unread: 3,
    mergeable: false,
    signals: [{ key: "ci", kind: "ci", sha: "a".repeat(40), text: "fail" }],
  });
  const [row] = inboxRows(s, []);
  expect(matchesFilter(row, "history")).toBe(true);
  expect(matchesFilter(row, "unmapped")).toBe(false);
  expect(row.attention).toBe(false);
  s.tasks.t = {
    id: "t",
    workspaceId: "w1",
    prId: "old",
    sha: "a",
    baseSha: "b",
    kind: "review",
    status: "approval",
    createdAt: 1,
    messageId: "m",
    eventKeys: [],
    text: "",
  };
  expect(inboxRows(s, [])[0].attention).toBe(true);
});
test("search matches title, qualified repo, branch, PR number and author", () => {
  const p = pr({ title: "Preserve reconnect ordering" });
  for (const query of [" RECONNECT ", "Org/Repo", "feature", "#1", "alice"])
    expect(matchesSearch(p, query)).toBe(true);
  expect(matchesSearch(p, "unrelated")).toBe(false);
});

test("manual approvals surface without an agent and stay scoped to the PR", () => {
  const s = state();
  s.prs.first = pr({ id: "first" });
  s.prs.other = pr({ id: "other" });
  s.prActions.a = {
    id: "a",
    prId: "first",
    repo: "org/repo",
    number: 1,
    url: "https://github.com/org/repo/pull/1",
    kind: "close",
    body: "",
    account: "alice",
    sha: "a",
    baseSha: "b",
    prState: "open",
    createdAt: 1,
    fingerprint: "f",
    status: "pending",
  };
  const rows = inboxRows(s, []);
  expect(rows.filter((r) => matchesFilter(r, "attention")).map((r) => r.pr.id)).toEqual(["first"]);
  expect(rows[0].prActions).toHaveLength(1);
  expect(rows[0].label).toBe("Approval needed");
  expect(rows[1].prActions).toHaveLength(0);
});

test("repository sections have stable full-name order and keep priority within the target repo", () => {
  const s = state();
  s.prs = {
    unread: pr({ id: "unread", unread: 2, repoId: "R_z", repo: "zeta/repo" }),
    alpha: pr({ id: "alpha", repoId: "R_a", repo: "Alpha/repo" }),
    conflict: pr({
      id: "conflict",
      mergeable: false,
      repoId: "R_z",
      repo: "zeta/repo",
      headRepo: "fork/repo",
    }),
    older: pr({
      id: "older",
      repoId: "R_a",
      repo: "Alpha/repo",
      updatedAt: "2025-01-01T00:00:00Z",
    }),
  };
  const sections = () =>
    groupByRepository(inboxRows(s, [])).map((g) => [g.repo, g.rows.map((r) => r.pr.id)]);
  const expected = [
    ["Alpha/repo", ["alpha", "older"]],
    ["zeta/repo", ["conflict", "unread"]],
  ];
  expect(sections()).toEqual(expected);
  s.prs = Object.fromEntries(Object.entries(s.prs).reverse());
  expect(sections()).toEqual(expected);
  s.prs.unread.unread = 0;
  expect(groupByRepository(inboxRows(s, [])).map((g) => g.repo)).toEqual([
    "Alpha/repo",
    "zeta/repo",
  ]);
});

test("repository groups follow search, filter and Workspace scope without empty headings", () => {
  const s = state();
  s.prs = {
    first: pr({ id: "first", title: "Fix cursor", unread: 1 }),
    next: pr({ id: "next", title: "Fix reconnect" }),
    closed: pr({ id: "closed", state: "closed" }),
    other: pr({ id: "other", repoId: "R_other", repo: "other/repo", unread: 1 }),
  };
  s.bindings.w1 = {
    workspaceId: "w1",
    prId: "first",
    stack: ["first", "next"],
    role: "author",
    policy: Policy.parse({}),
  };
  const rows = inboxRows(s, []);
  expect(
    groupByRepository(
      rows.filter((r) => matchesFilter(r, "open") && matchesSearch(r.pr, "Fix")),
    ).map((g) => [g.repo, g.rows.length]),
  ).toEqual([["org/repo", 2]]);
  expect(
    groupByRepository(rows.filter((r) => matchesFilter(r, "history"))).map((g) =>
      g.rows.map((r) => r.pr.id),
    ),
  ).toEqual([["closed"]]);
  expect(groupByRepository(inboxRows(s, [], "w1")).map((g) => g.rows.length)).toEqual([2]);
  expect(groupByRepository(rows.filter((r) => matchesSearch(r.pr, "absent")))).toEqual([]);
});
