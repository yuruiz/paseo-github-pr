import { access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PR, BindingInfo, WorkspaceInfo } from "../shared/model";
import type { Runtime, Extension, Command } from "./runtime";
import { busy } from "./automation";

export function inferChain(prs: PR[], seed: string): string[] {
  const start = prs.find((p) => p.id === seed);
  if (!start) throw new Error("Missing stack PR");
  const parents = (p: PR) =>
    prs.filter(
      (other) =>
        other.id !== p.id &&
        other.repoId === p.repoId &&
        other.headRepo?.toLowerCase() === p.baseRepo.toLowerCase() &&
        other.headRef === p.baseRef &&
        other.state !== "closed",
    );
  const children = (p: PR) =>
    prs.filter(
      (other) =>
        other.id !== p.id &&
        other.repoId === p.repoId &&
        p.headRepo?.toLowerCase() === other.baseRepo.toLowerCase() &&
        other.baseRef === p.headRef &&
        other.state !== "closed",
    );
  const chain = [start];
  const seen = new Set([start.id]);
  let current = start;
  for (;;) {
    const ps = parents(current);
    if (ps.length > 1) throw new Error("Ambiguous stack parent");
    if (!ps.length) break;
    current = ps[0];
    if (seen.has(current.id)) throw new Error("Cyclic stack");
    seen.add(current.id);
    chain.unshift(current);
  }
  current = start;
  for (;;) {
    const cs = children(current);
    if (cs.length > 1) throw new Error("Forked stack; select one linear chain");
    if (!cs.length) break;
    current = cs[0];
    if (seen.has(current.id)) throw new Error("Cyclic stack");
    seen.add(current.id);
    chain.push(current);
  }
  if (chain[0].baseRef !== chain[0].trunk)
    throw new Error(
      `Unknown stack parent ${chain[0].baseRef}; import its PR or define a gh-stack chain`,
    );
  return chain.map((p) => p.id);
}
export function nextInChain(chain: PR[]): PR | undefined {
  for (const pr of chain) {
    if (pr.state === "closed")
      throw new Error(`PR #${pr.number} closed without merging; progression paused`);
    if (pr.state === "open") return pr;
  }
  return undefined;
}
const Metadata = z.object({
  trunk: z.string(),
  branches: z.array(
    z.object({
      name: z.string(),
      pr: z.object({ number: z.number(), url: z.string(), state: z.string() }).optional(),
    }),
  ),
});
export class Stacks implements Extension {
  constructor(readonly runtime: Runtime) {}
  async command(input: Command): Promise<string | undefined> {
    if (input.action !== "stack") return undefined;
    const r = this.runtime;
    const w = r.workspace(input.workspaceId);
    const chain = input.prIds.map((id) => r.pr(id));
    if (
      new Set(input.prIds).size !== chain.length ||
      chain.some((p) => p.repoId !== chain[0].repoId)
    )
      throw new Error("Select unique PRs from one repository");
    if (!w.remotes.includes(chain[0].repo.toLowerCase()))
      throw new Error("Workspace repository mismatch");
    for (let i = 1; i < chain.length; i++)
      if (
        chain[i - 1].state === "open" &&
        (chain[i].baseRef !== chain[i - 1].headRef ||
          chain[i].baseRepo.toLowerCase() !== chain[i - 1].headRepo?.toLowerCase())
      )
        throw new Error("Selected order contradicts GitHub base branches");
    const affected = Object.values(r.state.bindings).filter(
      (b) => b.role === "author" && input.prIds.includes(b.prId),
    );
    if (r.state.bindings[w.id]?.role === "review")
      throw new Error("Review Workspace cannot own an author stack");
    if (
      Object.values(r.state.tasks).some(
        (t) =>
          affected.some((b) => b.workspaceId === t.workspaceId) &&
          !["done", "obsolete"].includes(t.status),
      )
    )
      throw new Error("Resolve existing tasks before changing stack ownership");
    const { Policy } = await import("../shared/model");
    await r.store!.update((s) => {
      const existing = s.bindings[w.id];
      for (const b of affected) if (b.workspaceId !== w.id) delete s.bindings[b.workspaceId];
      s.bindings[w.id] = {
        workspaceId: w.id,
        prId: existing?.prId && input.prIds.includes(existing.prId) ? existing.prId : chain[0].id,
        role: "author",
        policy: existing?.policy ?? Policy.parse({}),
        agentId: existing?.agentId,
        stack: input.prIds,
        manualStack: true,
      };
    });
    return "Primary Workspace and stack order saved";
  }
  async metadata(w: WorkspaceInfo, pr: PR): Promise<string[] | undefined> {
    try {
      await access(path.join(w.commonDir, "gh-stack"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const data = Metadata.parse(
      JSON.parse(await this.runtime.git.exec("gh", ["stack", "view", "--json"], w.directory)),
    );
    const urls = data.branches.flatMap((b) => (b.pr ? [b.pr.url] : []));
    if (!urls.includes(pr.url)) return;
    const ids: string[] = [];
    for (const branch of data.branches) {
      if (!branch.pr)
        throw new Error("Stack contains an unpublished layer; define its PR before progression");
      const url = new URL(branch.pr.url);
      const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url.pathname);
      if (
        url.hostname !== "github.com" ||
        !match ||
        match[1].toLowerCase() !== pr.repo.toLowerCase()
      )
        throw new Error("Stack metadata repository mismatch");
      let item = Object.values(this.runtime.state.prs).find((p) => p.url === branch.pr!.url);
      if (!item) {
        item = await this.runtime.github.read(match[1], Number(match[2]));
        await this.runtime.ingest(item);
      }
      if (item.headRef !== branch.name)
        throw new Error("Stack metadata branch disagrees with GitHub");
      ids.push(item.id);
    }
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate PR in stack metadata");
    // Current remote head/base edges must agree for adjacent unmerged layers.
    for (let i = 1; i < ids.length; i++) {
      const parent = this.runtime.pr(ids[i - 1]);
      const child = this.runtime.pr(ids[i]);
      if (
        parent.state === "open" &&
        child.state === "open" &&
        (child.baseRef !== parent.headRef ||
          child.baseRepo.toLowerCase() !== parent.headRepo?.toLowerCase())
      )
        throw new Error("gh-stack and GitHub dependency order disagree");
    }
    return ids;
  }
  async tick() {
    for (const binding of Object.values(this.runtime.state.bindings).filter(
      (b) => b.role === "author",
    )) {
      try {
        await this.reconcile(binding);
      } catch (e) {
        await this.runtime.store!.update((s) => {
          if (s.bindings[binding.workspaceId]) s.bindings[binding.workspaceId].blocked = String(e);
        });
      }
    }
  }
  async reconcile(binding: BindingInfo) {
    const r = this.runtime;
    const w = r.workspace(binding.workspaceId);
    const current = r.pr(binding.prId);
    let chain = binding.manualStack ? binding.stack : await this.metadata(w, current);
    if (!chain) {
      // Retain known merged edges: GitHub may retarget descendants to trunk on merge.
      if (binding.stack.length > 1) {
        chain = binding.stack;
        for (let i = 1; i < chain.length; i++) {
          const parent = r.pr(chain[i - 1]);
          const child = r.pr(chain[i]);
          if (
            parent.state === "open" &&
            child.state === "open" &&
            (child.baseRef !== parent.headRef ||
              child.baseRepo.toLowerCase() !== parent.headRepo?.toLowerCase())
          )
            throw new Error("Stack dependencies changed; refresh the binding manually");
        }
      } else chain = inferChain(Object.values(r.state.prs), current.id);
    }
    if (chain.length === 1 && !binding.rolling) {
      await r.store!.update((s) => {
        s.bindings[w.id].blocked = undefined;
      });
      return;
    }
    const duplicate = Object.values(r.state.bindings).find(
      (b) => b.workspaceId !== w.id && b.role === "author" && chain!.includes(b.prId),
    );
    if (duplicate)
      throw new Error(
        `Stack has multiple Workspace bindings (${duplicate.workspaceId}); choose its primary Workspace`,
      );
    const next = nextInChain(chain.map((id) => r.pr(id)));
    await r.store!.update((s) => {
      s.bindings[w.id].stack = chain!;
    });
    if (!next) {
      await r.store!.update((s) => {
        s.bindings[w.id].blocked = "Stack complete; Workspace retained";
      });
      return;
    }
    if (binding.rolling && binding.rolling.to !== next.id)
      throw new Error("Stack changed during progression; inspect before retrying");
    if (
      binding.prId === next.id &&
      w.branch === next.headRef &&
      w.sha === next.headSha &&
      !binding.rolling
    ) {
      await r.store!.update((s) => {
        s.bindings[w.id].blocked = undefined;
      });
      return;
    }
    if (binding.prId !== next.id && current.state === "closed")
      throw new Error("Current PR closed without merging; progression paused");
    await this.switchTo(w, next, binding);
  }
  async switchTo(w: WorkspaceInfo, next: PR, binding: BindingInfo) {
    const r = this.runtime;
    let actual = await r.git.inspect(w.id, w.projectId, w.directory, w.name);
    if (actual.dirty || actual.operation)
      throw new Error("Stack waiting: local changes or Git operation in progress");
    if (await busy(r, actual)) throw new Error("Stack waiting: agent active in checkout");
    if (
      Object.values(r.state.tasks).some(
        (t) =>
          t.workspaceId === w.id &&
          ["dispatching", "running", "attention", "approval"].includes(t.status),
      )
    )
      throw new Error("Stack waiting: resolve outstanding task first");
    if (
      binding.rolling &&
      actual.sha !== binding.rolling.oldSha &&
      !(actual.branch === next.headRef && actual.sha === next.headSha)
    )
      throw new Error("Checkout changed during progression; inspect before retrying");
    const latest = await r.github.read(next.repo, next.number);
    if (latest.state !== "open" || latest.headSha !== next.headSha)
      throw new Error("Next PR changed; refresh before progression");
    await r.git.command(actual.directory, "check-ref-format", "--branch", next.headRef);
    if (!binding.rolling)
      await r.store!.update((s) => {
        s.bindings[w.id].rolling = { from: binding.prId, to: next.id, oldSha: actual.sha };
      });
    if (actual.branch !== next.headRef || actual.sha !== next.headSha) {
      await r.git.command(
        actual.directory,
        "fetch",
        "--no-tags",
        `https://github.com/${next.repo}.git`,
        `refs/pull/${next.number}/head`,
      );
      if ((await r.git.command(actual.directory, "rev-parse", "FETCH_HEAD")) !== next.headSha)
        throw new Error("Remote changed during fetch");
      const existing = await r.git
        .command(actual.directory, "show-ref", "--verify", `refs/heads/${next.headRef}`)
        .then(
          () => true,
          () => false,
        );
      if (existing) {
        if (
          (await r.git.command(actual.directory, "rev-parse", `refs/heads/${next.headRef}`)) !==
          next.headSha
        )
          throw new Error("Next branch needs synchronization; no forced update performed");
      } else await r.git.command(actual.directory, "branch", next.headRef, next.headSha);
      actual = await r.git.inspect(w.id, w.projectId, w.directory, w.name);
      if (actual.dirty || actual.operation || (await busy(r, actual)))
        throw new Error("Workspace became busy during progression");
      const journal = r.state.bindings[w.id].rolling!;
      if (actual.sha !== journal.oldSha) throw new Error("Checkout changed before switch");
      await r.git.command(actual.directory, "switch", "--no-guess", next.headRef);
    }
    actual = await r.git.inspect(w.id, w.projectId, w.directory, w.name);
    if (
      actual.branch !== next.headRef ||
      actual.sha !== next.headSha ||
      actual.dirty ||
      actual.operation
    )
      throw new Error("Post-switch verification failed; binding unchanged");
    await r.store!.update((s) => {
      const b = s.bindings[w.id];
      b.prId = next.id;
      b.rolling = undefined;
      b.blocked = undefined;
      for (const t of Object.values(s.tasks))
        if (t.workspaceId === w.id && t.prId !== next.id && t.status === "queued")
          t.status = "obsolete";
    });
    await r.refreshWorkspaces();
  }
}
