import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "../client/dashboard";
import { pr, workspace } from "../tests/fixtures";
import { Policy, emptyState } from "../shared/model";
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const theme = {
  colors: {
    foreground: dark ? "#ededed" : "#202124",
    foregroundMuted: dark ? "#aaaeb8" : "#606572",
    surface0: dark ? "#17191f" : "#f6f7f9",
    surface1: dark ? "#20232b" : "#ffffff",
    surface2: dark ? "#303642" : "#e8ebf1",
    border: dark ? "#424958" : "#d4d9e2",
    statusDanger: dark ? "#ff9393" : "#b42318",
    accent: dark ? "#91b3ff" : "#3d5eb7",
    accentForeground: dark ? "#182540" : "#ffffff",
  },
};
const first = pr({
  title: "Preserve event ordering during reconnect",
  unread: 2,
  signals: [
    {
      key: "comment:1",
      kind: "comment",
      sha: "a".repeat(40),
      text: "sam: Can we preserve the cursor across reconnects?\nThe replay should not deliver the previous event twice.",
    },
  ],
});
const second = pr({
  id: "PR_2",
  number: 2,
  url: "https://github.com/org/repo/pull/2",
  title: "Add incremental review results",
  headRef: "feature/review",
  author: "another-author",
});
const third = pr({
  id: "PR_3",
  number: 3,
  url: "https://github.com/org/repo/pull/3",
  title: "Handle missing repository mappings",
  body: [
    "## Repository mappings",
    "Keep **Workspace bindings** tied to the repository identity, with `headSha` verification.",
    "A branch name alone is not sufficient: forks can use *identical names*.",
    "### Validation",
    "- [x] Preserve the project when reusing a Workspace.\n- [ ] Keep ambiguous matches unbound.\n  - Match repository and branch identities.",
    "> Reuse the Workspace only after checking its actual checkout.",
    '```ts\nconst target = resolveWorkspace(pr.headSha);\nconst diagnostic = "' +
      "repository/".repeat(30) +
      '";\n```',
    "| Check | Expected | Result |\n| --- | --- | --- |\n| Fork identity | Exact match | Passed |\n| Head revision | Current SHA | Pending |",
    "[PR discussion](https://github.com/org/repo/pull/3)",
    "![Mapping diagram](https://images.example.test/mapping.png)",
    "<!-- hidden template instructions -->",
    "Complete description ends here.",
  ].join("\n\n"),
  headRef: "feature/unmapped",
  signals: [
    {
      key: "ci:1",
      kind: "ci",
      sha: "a".repeat(40),
      text: "integration: failure\nRegression in the reconnect test. Expected the persisted cursor; received the initial cursor.",
    },
  ],
});
const fourth = pr({
  id: "PR_4",
  number: 4,
  title: "Keep workspace state after daemon restart",
  mergeable: false,
});
const fifth = pr({
  id: "PR_5",
  number: 5,
  title: "Reconcile subscriptions after reconnect",
  headRef: "feature/next",
});
const state = emptyState();
state.account = "alice";
state.prs = Object.fromEntries(
  [
    first,
    second,
    third,
    fourth,
    fifth,
    ...Array.from({ length: 7 }, (_, i) =>
      pr({
        id: `PR_${i + 6}`,
        number: i + 6,
        repo: i % 2 === 0 ? "alpha/repo" : "org/storage",
        repoId: i % 2 === 0 ? "R_alpha" : "R_storage",
        unread: i === 0 ? 1 : 0,
        title: [
          "Document repository discovery",
          "Preserve fork remote identity",
          "Improve Workspace navigation",
          "Persist review history",
          "Reduce duplicate GitHub requests",
          "Expose incremental review mode",
          "Handle interrupted branch switches",
        ][i],
        headRef: `feature/maintenance-${i}`,
        state: i > 4 ? "merged" : "open",
      }),
    ),
  ].map((p) => [p.id, { ...p, url: `https://github.com/${p.repo}/pull/${p.number}` }]),
);
state.bindings = {
  w1: {
    workspaceId: "w1",
    prId: first.id,
    role: "author",
    policy: Policy.parse({ provider: "codex/gpt-5.4-mini" }),
    stack: [first.id, fifth.id],
  },
  w2: {
    workspaceId: "w2",
    prId: second.id,
    role: "review",
    policy: Policy.parse({}),
    stack: [second.id],
  },
};
state.tasks = {
  review: {
    id: "review",
    workspaceId: "w2",
    prId: second.id,
    sha: second.headSha,
    baseSha: second.baseSha,
    kind: "review",
    eventKeys: [],
    text: "",
    status: "approval",
    createdAt: Date.parse("2026-09-18T02:30:00Z"),
    messageId: "m",
    result:
      "[P2] src/reconnect.ts:42 — Preserve the cursor before reconnecting. The replay path currently processes the last event twice.",
  },
};
state.publications = {
  publication: {
    id: "publication",
    taskId: "review",
    kind: "review",
    prId: second.id,
    workspaceId: "w2",
    sha: second.headSha,
    baseSha: second.baseSha,
    localSha: second.headSha,
    fingerprint: "fixture-exact",
    body: "Preserve the cursor before reconnecting.",
    diff: "@@ src/reconnect.ts:42 @@\n- cursor = 0\n+ cursor = lastCursor",
    status: "pending",
  },
};
window.fixture = window.liveSnapshot ?? {
  connected: true,
  state,
  workspaces: [
    workspace({ name: "Reconnect reliability" }),
    workspace({ id: "w2", name: "Review incremental results" }),
  ],
};
window.fixtureCommand = (input) => {
  const s = window.fixture.state;
  if (input.action === "preparePRAction") {
    const p = s.prs[input.prId];
    const id = `manual-${Object.keys(s.prActions).length + 1}`;
    s.prActions[id] = {
      id,
      prId: p.id,
      repo: p.repo,
      number: p.number,
      url: p.url,
      kind: input.kind,
      body: input.body,
      account: s.account,
      sha: p.headSha,
      baseSha: p.baseSha,
      prState: p.state,
      fingerprint: `exact-${id}`,
      createdAt: Date.now(),
      status: "pending",
    };
  }
  if (input.action === "confirmPRAction") {
    const a = s.prActions[input.id];
    a.status = "done";
    if (a.kind === "close") s.prs[a.prId].state = "closed";
  }
  if (input.action === "dismissPRAction") s.prActions[input.id].status = "cancelled";
};
window.commands = [];
createRoot(document.getElementById("root")!).render(
  <Dashboard
    theme={theme as never}
    layout={{ compact: innerWidth < 600 } as never}
    navigation={{ openWorkspace: () => {} } as never}
    {...(params.has("workspace") ? { workspaceId: "w1" } : {})}
  />,
);
