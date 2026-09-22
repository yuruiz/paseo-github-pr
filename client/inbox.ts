import type { PluginState, PR, WorkspaceInfo } from "../shared/model";
export type Filter = "attention" | "open" | "review" | "unmapped" | "history";
export function inboxRows(state: PluginState, workspaces: WorkspaceInfo[], workspaceId?: string) {
  return Object.values(state.prs)
    .flatMap((pr) => {
      const binding = Object.values(state.bindings).find(
        (b) =>
          (!workspaceId || b.workspaceId === workspaceId) &&
          (b.prId === pr.id || b.stack.includes(pr.id)),
      );
      if (workspaceId && !binding) return [];
      const tasks = Object.values(state.tasks).filter(
        (t) => t.prId === pr.id && (!workspaceId || t.workspaceId === workspaceId),
      );
      const publications = Object.values(state.publications).filter(
        (p) => p.prId === pr.id && (!workspaceId || p.workspaceId === workspaceId),
      );
      const prActions = Object.values(state.prActions).filter((action) => action.prId === pr.id);
      const approval =
        prActions.some((action) => action.status === "pending") ||
        publications.some((p) => p.status === "pending") ||
        tasks.some((t) => t.status === "approval");
      const issue =
        prActions.some((action) => ["attention", "stale"].includes(action.status)) ||
        tasks.some((t) => ["failed", "attention"].includes(t.status)) ||
        publications.some((p) => ["attention", "stale"].includes(p.status));
      const ci =
        pr.state === "open" && pr.signals.some((s) => s.kind === "ci" && s.sha === pr.headSha);
      const conflict = pr.state === "open" && pr.mergeable === false;
      const blocked = pr.state === "open" && binding?.prId === pr.id && !!binding.blocked;
      const error = !!pr.error;
      const unread = pr.state === "open" && pr.unread > 0;
      const rank = approval
        ? 0
        : issue
          ? 1
          : conflict
            ? 2
            : ci
              ? 3
              : blocked || error
                ? 4
                : unread
                  ? 5
                  : 6;
      const label = approval
        ? "Approval needed"
        : issue
          ? "Task needs attention"
          : conflict
            ? "Merge conflict"
            : ci
              ? "CI failed"
              : error
                ? "Tracking error"
                : blocked
                  ? "Workspace blocked"
                  : unread
                    ? `${pr.unread} unread updates`
                    : pr.state === "merged"
                      ? "Merged"
                      : pr.state === "closed"
                        ? "Closed"
                        : "No alerts";
      return [
        {
          pr,
          binding,
          workspace: workspaces.find((w) => w.id === binding?.workspaceId),
          tasks,
          publications,
          prActions,
          rank,
          label,
          danger: issue || conflict || ci || error || blocked,
          attention: rank < 6,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.pr.updatedAt.localeCompare(a.pr.updatedAt) ||
        a.pr.id.localeCompare(b.pr.id),
    );
}
export type InboxRow = ReturnType<typeof inboxRows>[number];
export function groupByRepository(rows: InboxRow[]) {
  const groups = new Map<string, { id: string; repo: string; rows: InboxRow[] }>();
  for (const row of rows) {
    // Group by the PR's target repository, including PRs opened from forks.
    const id = row.pr.repoId;
    let group = groups.get(id);
    if (!group) {
      group = { id, repo: row.pr.repo, rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.repo.toLowerCase().localeCompare(b.repo.toLowerCase(), "en") ||
      a.id.localeCompare(b.id, "en"),
  );
}
export function matchesFilter(row: InboxRow, filter: Filter) {
  switch (filter) {
    case "attention":
      return row.attention;
    case "open":
      return row.pr.state === "open";
    case "review":
      return row.binding?.role === "review" && row.pr.state === "open";
    case "unmapped":
      return !row.binding && row.pr.state === "open";
    case "history":
      return row.pr.state !== "open";
  }
}
export function matchesSearch(pr: PR, query: string) {
  return `${pr.title} ${pr.repo} #${pr.number} ${pr.headRef} ${pr.author}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}
