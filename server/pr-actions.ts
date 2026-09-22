import { createHash, randomUUID } from "node:crypto";
import type { PRActionInfo } from "../shared/model";
import type { Runtime, Command, Extension } from "./runtime";
function fingerprint(action: Omit<PRActionInfo, "fingerprint" | "status" | "error">) {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}
export class PRActions implements Extension {
  constructor(readonly runtime: Runtime) {}
  async tick() {
    for (const action of Object.values(this.runtime.state.prActions)) {
      if (action.status === "executing")
        await this.runtime.store!.update((s) => {
          s.prActions[action.id].status = "attention";
          s.prActions[action.id].error =
            "The request may have reached GitHub. Inspect the PR before creating another action; it will not be retried automatically.";
        });
    }
  }
  async command(input: Command) {
    const r = this.runtime;
    if (input.action === "dismissPRAction") {
      const action = r.state.prActions[input.id];
      if (!action || !["pending", "stale", "attention"].includes(action.status))
        throw new Error("Action cannot be dismissed");
      await r.store!.update((s) => {
        s.prActions[action.id].status = "cancelled";
      });
      return "Action dismissed. No GitHub request sent.";
    }
    if (input.action === "preparePRAction") {
      if (input.kind === "comment" && !input.body.trim())
        throw new Error("Enter a comment before preparing it");
      if (input.kind === "close" && input.body)
        throw new Error("Closing and commenting are separate actions");
      if (
        Object.values(r.state.prActions).some(
          (a) =>
            a.prId === input.prId &&
            a.kind === input.kind &&
            ["executing", "attention"].includes(a.status),
        )
      )
        throw new Error(
          "Inspect the previous request on GitHub and dismiss its uncertain result first",
        );
      const stored = r.pr(input.prId);
      const account = await r.github.account();
      if (!account || account !== r.state.account)
        throw new Error("GitHub account changed; refresh tracking before preparing an action");
      const pr = await r.github.read(stored.repo, stored.number);
      if (pr.id !== stored.id) throw new Error("PR identity changed");
      if (input.kind === "close" && pr.state !== "open")
        throw new Error("Only an open PR can be closed");
      await r.ingest(pr);
      const content = {
        id: randomUUID(),
        prId: pr.id,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        kind: input.kind,
        body: input.body,
        account,
        sha: pr.headSha,
        baseSha: pr.baseSha,
        prState: pr.state,
        createdAt: Date.now(),
      };
      await r.store!.update((s) => {
        for (const previous of Object.values(s.prActions)) {
          if (
            previous.prId === pr.id &&
            previous.kind === input.kind &&
            previous.status === "pending"
          )
            previous.status = "stale";
        }
        s.prActions[content.id] = {
          ...content,
          fingerprint: fingerprint(content),
          status: "pending",
        };
      });
      return "Preview ready. Inspect the target and exact content, then confirm.";
    }
    if (input.action !== "confirmPRAction") return undefined;
    const action = r.state.prActions[input.id];
    if (!action || action.status !== "pending" || action.fingerprint !== input.fingerprint)
      throw new Error("Approval is no longer valid");
    const { fingerprint: saved, status: _status, error: _error, ...content } = action;
    if (fingerprint(content) !== saved)
      throw new Error("Approved content changed; prepare a new preview");
    const account = await r.github.account();
    const pr = await r.github.read(action.repo, action.number);
    if (
      account !== action.account ||
      account !== r.state.account ||
      pr.id !== action.prId ||
      pr.headSha !== action.sha ||
      pr.baseSha !== action.baseSha ||
      pr.state !== action.prState
    ) {
      await r.store!.update((s) => {
        s.prActions[action.id].status = "stale";
      });
      throw new Error("Account or PR changed; prepare a new preview");
    }
    // The runtime's exclusive queue holds through this durable intent and the remote request.
    await r.store!.update((s) => {
      s.prActions[action.id].status = "executing";
    });
    let closedState: "closed" | "merged" | undefined;
    try {
      if (action.kind === "close") closedState = await r.github.close(pr);
      else await r.github.publish(pr, "comment", action.body);
    } catch (error) {
      await r.store!.update((s) => {
        s.prActions[action.id].status = "attention";
        s.prActions[action.id].error =
          `${String(error)}. Inspect GitHub before retrying; no automatic retry will be made.`;
      });
      throw error;
    }
    await r.store!.update((s) => {
      s.prActions[action.id].status = "done";
      if (closedState) s.prs[action.prId].state = closedState;
    });
    // A failed refresh must never turn an acknowledged write into a retryable request.
    try {
      await r.ingest(await r.github.read(pr.repo, pr.number));
    } catch (error) {
      await r.store!.update((s) => {
        s.prActions[action.id].error =
          `Action succeeded; tracking refresh failed: ${String(error)}`;
      });
    }
    return action.kind === "close" ? "PR closed. Workspace retained." : "Comment posted on GitHub.";
  }
}
