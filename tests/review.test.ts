import { expect, test } from "vitest";
import { Reviews } from "../server/review";
import { Runtime } from "../server/runtime";
import { emptyState, Policy } from "../shared/model";
import { pr } from "./fixtures";
test("a new review head invalidates pending results and approvals without enqueuing work", () => {
  const state = emptyState();
  state.bindings.w = {
    workspaceId: "w",
    prId: "PR_1",
    role: "review",
    policy: Policy.parse({}),
    stack: [],
    lastReviewedSha: "old",
  };
  state.tasks.t = {
    id: "t",
    workspaceId: "w",
    prId: "PR_1",
    sha: "old",
    baseSha: "base",
    kind: "review",
    eventKeys: [],
    text: "review",
    status: "approval",
    createdAt: 1,
    messageId: "m",
    result: "finding",
  };
  state.publications.p = {
    id: "p",
    taskId: "t",
    workspaceId: "w",
    prId: "PR_1",
    sha: "old",
    baseSha: "base",
    localSha: "old",
    kind: "review",
    fingerprint: "hash",
    body: "finding",
    diff: "",
    status: "pending",
  };
  new Reviews(new Runtime()).observed(state, pr({ headSha: "new" }), []);
  expect(Object.keys(state.tasks)).toEqual(["t"]);
  expect(state.tasks.t.status).toBe("obsolete");
  expect(state.tasks.t.result).toBe("finding");
  expect(state.publications.p.status).toBe("stale");
  expect(state.bindings.w.lastReviewedSha).toBe("old");
});
test("new comments alone never start a review or discard a current result", () => {
  const state = emptyState();
  const current = pr();
  state.tasks.t = {
    id: "t",
    workspaceId: "w",
    prId: current.id,
    sha: current.headSha,
    baseSha: current.baseSha,
    kind: "review",
    eventKeys: [],
    text: "review",
    status: "approval",
    createdAt: 1,
    messageId: "m",
  };
  new Reviews(new Runtime()).observed(state, current, [
    { key: "comment:1", kind: "comment", sha: current.headSha, text: "please review" },
  ]);
  expect(Object.keys(state.tasks)).toEqual(["t"]);
  expect(state.tasks.t.status).toBe("approval");
});
