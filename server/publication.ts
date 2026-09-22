import { randomUUID } from "node:crypto";
import type { Runtime, Command, Extension } from "./runtime";
import { busy, localSnapshot } from "./automation";
export class Publications implements Extension {
  constructor(readonly runtime: Runtime) {}
  async tick() {
    // A crash while a remote write was in flight requires reconciliation by the user.
    for (const p of Object.values(this.runtime.state.publications))
      if (p.status === "publishing")
        await this.runtime.store!.update((s) => {
          s.publications[p.id].status = "attention";
          s.publications[p.id].error =
            "Publication outcome uncertain; inspect GitHub before publishing again";
        });
  }
  async command(input: Command) {
    const r = this.runtime;
    if (input.action === "prepare") {
      const task = r.state.tasks[input.taskId];
      if (!task || task.status !== "approval")
        throw new Error("Task has no completed result awaiting approval");
      if (task.kind === "review" && input.kind !== "review")
        throw new Error("Review tasks can only publish review results");
      const w = r.workspace(task.workspaceId);
      if (await busy(r, w)) throw new Error("Workspace has a running agent");
      const current = await r.github.read(r.pr(task.prId).repo, r.pr(task.prId).number);
      if (
        current.headSha !== task.sha ||
        current.baseSha !== task.baseSha ||
        current.state !== "open"
      )
        throw new Error("PR changed; review the new revision before publication");
      const local = await localSnapshot(r, w);
      if (local.sha !== task.sha)
        throw new Error("Local HEAD changed since this task; inspect commits before publishing");
      if (input.kind === "push" && !local.diff) throw new Error("No local changes to commit");
      if (!input.body.trim())
        throw new Error("Provide the exact comment, review, or commit message for approval");
      const id = randomUUID();
      await r.store!.update((s) => {
        for (const previous of Object.values(s.publications))
          if (previous.taskId === task.id && previous.status === "pending")
            previous.status = "stale";
        s.publications[id] = {
          id,
          taskId: task.id,
          kind: input.kind,
          prId: task.prId,
          workspaceId: w.id,
          sha: task.sha,
          baseSha: task.baseSha,
          localSha: local.sha,
          fingerprint: local.fingerprint,
          body: input.body,
          diff: local.diff,
          status: "pending",
        };
      });
      return "Publication prepared. Review the exact content and confirm below";
    }
    if (input.action !== "publish") return undefined;
    const publication = r.state.publications[input.publicationId];
    if (
      !publication ||
      publication.status !== "pending" ||
      r.state.tasks[publication.taskId]?.status !== "approval" ||
      publication.fingerprint !== input.fingerprint
    )
      throw new Error("Approval is no longer valid");
    const stored = r.workspace(publication.workspaceId);
    const w = await r.git.inspect(stored.id, stored.projectId, stored.directory, stored.name);
    if (w.operation || (await busy(r, w)))
      throw new Error("Wait for agents and Git operations to finish");
    const current = await r.github.read(r.pr(publication.prId).repo, r.pr(publication.prId).number);
    const local = await localSnapshot(r, w);
    if (
      current.headSha !== publication.sha ||
      current.baseSha !== publication.baseSha ||
      current.state !== "open" ||
      local.fingerprint !== publication.fingerprint
    ) {
      await r.store!.update((s) => {
        s.publications[publication.id].status = "stale";
      });
      throw new Error("PR or local files changed; prepare a fresh approval");
    }
    await r.store!.update((s) => {
      s.publications[publication.id].status = "publishing";
    });
    try {
      if (publication.kind === "push") {
        if (w.branch !== current.headRef || !current.headRepo)
          throw new Error("Checkout is not the PR source branch");
        await r.git.command(w.checkoutRoot, "add", "--all", "--", ".");
        const staged = await localSnapshot(r, w);
        if (staged.fingerprint !== publication.fingerprint)
          throw new Error("Files changed while staging; inspect the index");
        const approvedTree = await r.git.command(w.checkoutRoot, "write-tree");
        await r.git.command(w.checkoutRoot, "commit", "-s", "-m", publication.body);
        const actualTree = await r.git.command(w.checkoutRoot, "rev-parse", "HEAD^{tree}");
        const parent = await r.git.command(w.checkoutRoot, "rev-parse", "HEAD^");
        if (
          actualTree !== approvedTree ||
          parent !== publication.sha ||
          (await r.git.command(w.checkoutRoot, "status", "--porcelain"))
        )
          throw new Error("Commit hooks changed the approved tree; inspect before pushing");
        await r.git.command(
          w.directory,
          "push",
          `https://github.com/${current.headRepo}.git`,
          `HEAD:refs/heads/${current.headRef}`,
        );
      } else await r.github.publish(current, publication.kind, publication.body);
      await r.store!.update((s) => {
        s.publications[publication.id].status = "published";
        s.tasks[publication.taskId].status = "done";
      });
      return "Published";
    } catch (e) {
      await r.store!.update((s) => {
        s.publications[publication.id].status = "attention";
        s.publications[publication.id].error = String(e);
      });
      throw e;
    }
  }
}
