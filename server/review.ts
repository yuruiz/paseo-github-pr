import { randomUUID } from "node:crypto";
import type { Runtime, Extension, Command } from "./runtime";
import type { PluginState, PR, EventSignal } from "../shared/model";
import { parseUrl } from "./github";
import { busy, safeAgentConfig, assertDaemonPolicy } from "./automation";
export class Reviews implements Extension {
  constructor(readonly runtime: Runtime) {}
  async tick() {}
  observed(state: PluginState, pr: PR, _fresh: EventSignal[]) {
    // New revisions invalidate old approvals, but never start a review by themselves.
    for (const task of Object.values(state.tasks))
      if (
        task.prId === pr.id &&
        task.kind === "review" &&
        ["approval", "queued"].includes(task.status) &&
        (task.sha !== pr.headSha || task.baseSha !== pr.baseSha || pr.state !== "open")
      )
        task.status = "obsolete";
    for (const publication of Object.values(state.publications))
      if (
        publication.prId === pr.id &&
        publication.status === "pending" &&
        (publication.sha !== pr.headSha ||
          publication.baseSha !== pr.baseSha ||
          pr.state !== "open")
      )
        publication.status = "stale";
  }
  async command(input: Command): Promise<string | undefined> {
    if (input.action !== "review") return undefined;
    const r = this.runtime;
    const key = parseUrl(input.url);
    const pr = await r.github.read(key.repo, key.number);
    if (pr.state !== "open") throw new Error("Only open PRs can start a tracked Review");
    // Validate the profile before creating anything.
    safeAgentConfig(input.provider, input.repositoryPath, true);
    await assertDaemonPolicy(r.api!);
    await r.ingest(pr);
    const created = await r.createWorkspace(pr, input.repositoryPath, "review", input.clone);
    const binding = r.state.bindings[created.workspaceId];
    const w = r.workspace(binding.workspaceId);
    if (binding.agentId && binding.policy.provider !== input.provider)
      throw new Error("Use the existing review agent's provider/model");
    if (
      Object.values(r.state.tasks).some(
        (t) =>
          t.workspaceId === w.id &&
          ["queued", "dispatching", "running", "attention", "approval"].includes(t.status),
      )
    )
      throw new Error("Resolve the existing review task before starting another");
    let actual = await r.git.inspect(w.id, w.projectId, w.directory, w.name);
    if (actual.dirty || actual.operation || (await busy(r, actual)))
      throw new Error("Review checkout is busy or contains changes");
    if (actual.sha !== pr.headSha) {
      await r.git.command(
        w.directory,
        "fetch",
        "--no-tags",
        `https://github.com/${pr.repo}.git`,
        `refs/pull/${pr.number}/head`,
      );
      if ((await r.git.command(w.directory, "rev-parse", "FETCH_HEAD")) !== pr.headSha)
        throw new Error("PR changed during fetch; retry review");
      const check = await r.git.inspect(w.id, w.projectId, w.directory, w.name);
      if (check.sha !== actual.sha || check.dirty || check.operation || (await busy(r, check)))
        throw new Error("Review checkout changed during fetch");
      // Preserve the old branch/commits, including after a force push.
      await r.git.command(w.directory, "switch", "--detach", pr.headSha);
    }
    await r.git.command(
      w.directory,
      "fetch",
      "--no-tags",
      `https://github.com/${pr.repo}.git`,
      pr.baseSha,
    );
    if (input.mode === "incremental") {
      if (!binding.lastReviewedSha)
        throw new Error("Run a full review before requesting an incremental review");
      await r.git.command(w.directory, "cat-file", "-e", `${binding.lastReviewedSha}^{commit}`);
    }
    actual = await r.git.inspect(w.id, w.projectId, w.directory, w.name);
    if (actual.sha !== pr.headSha || actual.dirty || actual.operation)
      throw new Error("Review checkout failed final verification");
    const id = randomUUID();
    await r.store!.update((s) => {
      s.bindings[w.id].policy.provider = input.provider;
      s.tasks[id] = {
        id,
        workspaceId: w.id,
        prId: pr.id,
        sha: pr.headSha,
        baseSha: pr.baseSha,
        kind: "review",
        eventKeys: [],
        text: pr.title,
        status: "queued",
        createdAt: Date.now(),
        messageId: `github-pr:${id}`,
        mode: input.mode,
        previousSha: input.mode === "incremental" ? binding.lastReviewedSha : undefined,
      };
    });
    await r.refreshWorkspaces();
    return "Review queued; later PR updates will only notify you";
  }
}
