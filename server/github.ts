import type { PR, EventSignal } from "../shared/model";
import { run, type Runner } from "./process";

export function parseUrl(url: string): { repo: string; number: number } {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match) throw new Error("Use a GitHub.com pull request URL");
  return { repo: match[1], number: Number(match[2]) };
}
export class GitHub {
  constructor(private exec: Runner = run) {}
  async api<T>(endpoint: string): Promise<T> {
    return JSON.parse(await this.exec("gh", ["api", "--hostname", "github.com", endpoint]));
  }
  async pages<T>(endpoint: string, field?: string): Promise<T[]> {
    const pages: unknown[] = JSON.parse(
      await this.exec("gh", [
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        endpoint + (endpoint.includes("?") ? "&" : "?") + "per_page=100",
      ]),
    );
    return pages.flatMap((page) => (field ? (page as Record<string, T[]>)[field] : (page as T[])));
  }
  async discover(): Promise<{ account: string; urls: string[] }> {
    const query = `query($cursor:String){viewer{login pullRequests(first:100,states:OPEN,after:$cursor){nodes{url} pageInfo{hasNextPage endCursor}}}}`;
    let cursor: string | null = null;
    const urls: string[] = [];
    let account = "";
    do {
      const args = ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const result = JSON.parse(await this.exec("gh", args));
      if (result.errors) throw new Error(JSON.stringify(result.errors));
      const viewer = result.data.viewer;
      account = viewer.login;
      urls.push(...viewer.pullRequests.nodes.map((n: { url: string }) => n.url));
      cursor = viewer.pullRequests.pageInfo.hasNextPage
        ? viewer.pullRequests.pageInfo.endCursor
        : null;
    } while (cursor);
    return { account, urls };
  }
  async read(repo: string, number: number): Promise<PR> {
    const raw = await this.api<RawPR>(`repos/${repo}/pulls/${number}`);
    const prefix = `repos/${raw.base.repo.full_name}`;
    const [comments, inline, reviews, checks, statuses] = await Promise.all([
      this.pages<Comment>(`${prefix}/issues/${number}/comments`),
      this.pages<Comment>(`${prefix}/pulls/${number}/comments`),
      this.pages<Review>(`${prefix}/pulls/${number}/reviews`),
      this.pages<Check>(`${prefix}/commits/${raw.head.sha}/check-runs?filter=latest`, "check_runs"),
      this.pages<Status>(`${prefix}/commits/${raw.head.sha}/statuses`),
    ]);
    const signals: EventSignal[] = [];
    for (const [kind, list] of [
      ["comment", comments],
      ["inline", inline],
      ["review", reviews],
    ] as const)
      for (const c of list) {
        if (!(c.body ?? "").trim() || c.user?.login === raw.user.login) continue;
        signals.push({
          key: `${kind}:${c.id}:${"updated_at" in c ? c.updated_at : c.submitted_at}`,
          kind: "comment",
          sha: raw.head.sha,
          text: `${c.user?.login}: ${c.body}`,
          url: c.html_url,
        });
      }
    for (const check of checks)
      if (
        ["failure", "timed_out", "action_required", "startup_failure"].includes(
          check.conclusion ?? "",
        )
      )
        signals.push({
          key: `check:${raw.head.sha}:${check.id}:${check.completed_at}:${check.conclusion}`,
          kind: "ci",
          sha: raw.head.sha,
          text: `${check.name}: ${check.conclusion}\n${check.output?.title ?? ""}\n${check.output?.summary ?? ""}\n${check.output?.text ?? ""}`,
          url: check.html_url,
        });
    const latest = new Set<string>();
    for (const status of statuses) {
      if (latest.has(status.context)) continue;
      latest.add(status.context);
      if (["error", "failure"].includes(status.state))
        signals.push({
          key: `status:${raw.head.sha}:${status.id}`,
          kind: "ci",
          sha: raw.head.sha,
          text: `${status.context}: ${status.description}`,
          url: status.target_url ?? undefined,
        });
    }
    if (raw.mergeable === false)
      signals.push({
        key: `conflict:${raw.head.sha}:${raw.base.sha}`,
        kind: "conflict",
        sha: raw.head.sha,
        text: "GitHub reports conflicting changes",
      });
    signals.push({
      key: `head:${raw.head.sha}`,
      kind: "head",
      sha: raw.head.sha,
      text: "PR head updated",
    });
    return {
      id: raw.node_id,
      repoId: raw.base.repo.node_id,
      repo: raw.base.repo.full_name,
      number: raw.number,
      url: raw.html_url,
      title: raw.title,
      body: raw.body ?? "",
      author: raw.user.login,
      state: raw.merged ? "merged" : raw.state,
      headRepo: raw.head.repo?.full_name ?? null,
      headRef: raw.head.ref,
      headSha: raw.head.sha,
      baseRepo: raw.base.repo.full_name,
      baseRef: raw.base.ref,
      baseSha: raw.base.sha,
      trunk: raw.base.repo.default_branch,
      mergeable: raw.mergeable,
      signals,
      seen: [],
      initialized: false,
      unread: 0,
      updatedAt: raw.updated_at,
    };
  }
  async account(): Promise<string> {
    return (await this.api<{ login: string }>("user")).login;
  }
  async close(pr: PR): Promise<"closed" | "merged"> {
    const result = JSON.parse(
      await this.exec(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          `repos/${pr.repo}/pulls/${pr.number}`,
          "--method",
          "PATCH",
          "--input",
          "-",
        ],
        undefined,
        JSON.stringify({ state: "closed" }),
      ),
    ) as { state: string; merged: boolean };
    if (result.state !== "closed") throw new Error("GitHub did not confirm the PR was closed");
    return result.merged ? "merged" : "closed";
  }
  async publish(pr: PR, kind: "comment" | "review", body: string) {
    const endpoint =
      kind === "comment"
        ? `repos/${pr.repo}/issues/${pr.number}/comments`
        : `repos/${pr.repo}/pulls/${pr.number}/reviews`;
    const data = kind === "comment" ? { body } : { body, commit_id: pr.headSha, event: "COMMENT" };
    await this.exec(
      "gh",
      ["api", "--hostname", "github.com", endpoint, "--method", "POST", "--input", "-"],
      undefined,
      JSON.stringify(data),
    );
  }
}
type Repo = { full_name: string; node_id: string; default_branch: string };
type RawPR = {
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  user: { login: string };
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  updated_at: string;
  head: { repo: Repo | null; ref: string; sha: string };
  base: { repo: Repo; ref: string; sha: string };
};
type Comment = {
  id: number;
  body: string;
  updated_at: string;
  html_url: string;
  user: { login: string } | null;
};
type Review = Omit<Comment, "updated_at"> & { submitted_at: string };
type Check = {
  output?: { title?: string; summary?: string; text?: string };
  id: number;
  name: string;
  conclusion: string | null;
  completed_at: string;
  html_url: string;
};
type Status = {
  id: number;
  context: string;
  state: string;
  description: string;
  target_url: string | null;
};
