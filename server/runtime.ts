import { readFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPaseoClient, type PaseoApi, type PaseoClient } from "@getpaseo/client";
import { type RpcInput } from "@getpaseo/plugin";
import { command } from "../shared/rpc";
import { Policy, emptyState, type WorkspaceInfo, type PR, type PluginState } from "../shared/model";
import { configureProcesses } from "./process";
import { Store, dataPath } from "./store";
import { Git, candidates } from "./git";
import { GitHub, parseUrl } from "./github";
import { resolveSetup, resolveConnection, verifyHost, type Setup } from "./setup";

export type Command = RpcInput<typeof command>;
export type Extension = {
  tick(): Promise<void>;
  command(input: Command): Promise<string | undefined>;
  observed?(state: PluginState, pr: PR, fresh: PR["signals"]): void;
};
export class Runtime {
  store?: Store;
  api?: PaseoApi;
  client?: PaseoClient;
  workspaces: WorkspaceInfo[] = [];
  error?: string;
  connected = false;
  stopped = false;
  private readonly controller = new AbortController();
  extensions: Extension[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();
  private backoff = 0;
  private setup?: Setup;
  constructor(
    readonly github = new GitHub(),
    readonly git = new Git(),
  ) {}
  get state(): PluginState {
    return this.store?.state ?? emptyState();
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(fn);
    this.tail = job.catch(() => {});
    return job;
  }
  async start() {
    try {
      const config = await resolveSetup();
      this.store = new Store(await dataPath(config.dataDir));
      await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await this.store.open();
      const temporary = path.join(config.dataDir, "tmp");
      const cache = path.join(config.dataDir, "cache");
      await mkdir(temporary, { recursive: true });
      await mkdir(cache, { recursive: true });
      configureProcesses(this.controller.signal, temporary, cache);
      const endpointFile = path.join(config.dataDir, "endpoint.json");
      try {
        if (JSON.parse(await readFile(endpointFile, "utf8")).url !== config.identity)
          throw new Error("Data directory belongs to a different daemon endpoint");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const { writeFile } = await import("node:fs/promises");
        await writeFile(endpointFile, JSON.stringify({ url: config.identity }), {
          flag: "wx",
          mode: 0o600,
        });
      }
      this.setup = config;
      this.schedule(0);
    } catch (error) {
      this.error = String(error);
      await this.store?.close();
      this.store = undefined;
    }
  }
  private schedule(delay: number) {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        void this.exclusive(() => this.tick()).finally(() =>
          this.schedule(Math.max(5000, this.backoff)),
        );
      }, delay);
  }
  async tick(force = false) {
    if (this.stopped || !this.store) return;
    try {
      if (!this.connected && this.setup) {
        await this.client?.close();
        this.client = undefined;
        this.api = undefined;
        const connection = await resolveConnection(this.setup);
        await verifyHost(this.setup, connection, this.controller.signal);
        if (this.stopped) return;
        this.client = createPaseoClient({
          ...connection,
          appVersion: "0.8.0",
          reconnect: { enabled: false },
          connectTimeoutMs: 5000,
        });
        this.api = this.client;
        await this.client.connect();
      }
      if (!this.api) return;
      this.connected = false;
      await this.refreshWorkspaces();
      this.connected = true;
      const now = Date.now();
      if (force || now - this.state.discoveryAt > this.state.config.discoverySeconds * 1000) {
        const discovered = await this.github.discover();
        if (this.state.account && this.state.account !== discovered.account)
          throw new Error("gh account changed; use a separate data directory for another account");
        for (const url of discovered.urls) {
          const key = parseUrl(url);
          if (
            !Object.values(this.state.prs).some(
              (pr) =>
                pr.repo.toLowerCase() === key.repo.toLowerCase() &&
                pr.number === key.number &&
                pr.state === "open",
            )
          )
            await this.ingest(await this.github.read(key.repo, key.number));
        }
        await this.store.update((s) => {
          s.account = discovered.account;
          s.discoveryAt = now;
        });
      }
      if (force || now - this.state.pollAt > this.state.config.pollSeconds * 1000) {
        const errors: string[] = [];
        for (const pr of Object.values(this.state.prs).filter(
          (p) => p.state === "open" || (force && p.body === undefined),
        )) {
          try {
            await this.ingest(await this.github.read(pr.repo, pr.number));
          } catch (e) {
            errors.push(`${pr.repo}#${pr.number}: ${String(e)}`);
            await this.store.update((s) => {
              s.prs[pr.id].error = String(e);
            });
            if (/rate limit|secondary limit|HTTP 429/i.test(String(e))) break;
          }
        }
        await this.store.update((s) => {
          s.pollAt = now;
          s.lastError = errors.length ? errors.join("\n") : undefined;
        });
        if (errors.length) throw new Error(errors.join("\n"));
      }
      await this.autoBind();
      for (const extension of this.extensions) {
        if (this.stopped) break;
        await extension.tick();
      }
      this.error = undefined;
      this.backoff = 0;
    } catch (error) {
      this.error = String(error);
      this.backoff = Math.min(3600_000, Math.max(60_000, this.backoff * 2));
    }
  }
  async ingest(next: PR) {
    await this.store!.update((s) => {
      const previous = s.prs[next.id];
      const seen = new Set(previous?.seen ?? []);
      const fresh = next.signals.filter((event) => !seen.has(event.key));
      // Only delivery/queue code consumes newly observed signals. Keep historical keys across SHA changes.
      s.prs[next.id] = {
        ...next,
        initialized: previous?.initialized ?? false,
        seen: [...new Set([...seen, ...next.signals.map((e) => e.key)])],
        unread: (previous?.unread ?? 0) + (previous?.initialized ? fresh.length : 0),
      };
      if (previous?.initialized)
        for (const extension of this.extensions) extension.observed?.(s, s.prs[next.id], fresh);
      if (!previous?.initialized) {
        s.prs[next.id].seen = next.signals.map((e) => e.key);
        s.prs[next.id].initialized = true;
      }
    });
  }
  async refreshWorkspaces() {
    const all: WorkspaceInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api!.workspaces.list({ page: { limit: 100, cursor } });
      for (const w of page.entries) {
        if (w.archivingAt || !w.workspaceDirectory) continue;
        try {
          all.push(await this.git.inspect(w.id, w.projectId, w.workspaceDirectory, w.name));
        } catch (e) {
          all.push({
            id: w.id,
            projectId: w.projectId,
            directory: w.workspaceDirectory,
            name: w.name,
            branch: "",
            sha: "",
            remotes: [],
            headRemote: null,
            dirty: false,
            operation: false,
            commonDir: "",
            checkoutRoot: "",
            error: String(e),
          });
        }
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    this.workspaces = all;
  }
  async autoBind() {
    const eligible = Object.values(this.state.prs).filter(
      (pr) =>
        pr.author === this.state.account &&
        pr.state === "open" &&
        !Object.values(this.state.bindings).some(
          (b) => b.prId === pr.id || b.stack.includes(pr.id),
        ),
    );
    const matches = eligible.map((pr) => ({ pr, candidates: candidates(pr, this.workspaces) }));
    await this.store!.update((s) => {
      for (const entry of matches) {
        if (entry.candidates.length !== 1) continue;
        const workspace = entry.candidates[0];
        if (
          s.bindings[workspace.id] ||
          matches.some(
            (other) =>
              other.pr.id !== entry.pr.id && other.candidates.some((w) => w.id === workspace.id),
          )
        )
          continue;
        s.bindings[workspace.id] = {
          workspaceId: workspace.id,
          prId: entry.pr.id,
          role: "author",
          policy: Policy.parse({}),
          stack: [],
        };
      }
    });
  }
  workspace(id: string) {
    const w = this.workspaces.find((w) => w.id === id);
    if (!w || w.error) throw new Error(w?.error ?? "Workspace unavailable or archived");
    return w;
  }
  pr(id: string) {
    const pr = this.state.prs[id];
    if (!pr) throw new Error("PR not tracked");
    return pr;
  }
  async createWorkspace(pr: PR, repositoryPath: string, role: "author" | "review", clone: boolean) {
    const old = Object.values(this.state.bindings).find((b) => b.prId === pr.id && b.role === role);
    if (old && this.workspaces.some((w) => w.id === old.workspaceId && !w.error)) return old;
    const root = await dataPath(repositoryPath);
    try {
      await access(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!clone) throw new Error(`Repository missing. Confirm cloning ${pr.repo} to ${root}`);
      await this.git.clone(pr.repo, root);
    }
    const info = await this.git.inspect("", "", root, "");
    if (!info.remotes.includes(pr.repo.toLowerCase()))
      throw new Error("Selected repository does not match the PR base repository");
    const projects = await this.api!.projects.list();
    const project = projects.projects.find((p) => p.projectRootPath === root);
    const key = createHash("sha256").update(pr.id).digest("hex").slice(0, 16);
    const directory = path.join(this.store!.directory, "worktrees", `${role}-${key}`);
    await dataPath(directory);
    await mkdir(path.dirname(directory), { recursive: true });
    const branch = role === "review" ? `paseo-review/${key}` : pr.headRef;
    await this.git.command(root, "check-ref-format", "--branch", branch);
    try {
      await access(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await this.git.command(
        root,
        "fetch",
        "--no-tags",
        `https://github.com/${pr.repo}.git`,
        `refs/pull/${pr.number}/head`,
      );
      if ((await this.git.command(root, "rev-parse", "FETCH_HEAD")) !== pr.headSha)
        throw new Error("PR changed while creating workspace; refresh and retry");
      const exists = await this.git
        .command(root, "show-ref", "--verify", `refs/heads/${branch}`)
        .then(
          () => true,
          () => false,
        );
      if (exists) {
        if ((await this.git.command(root, "rev-parse", `refs/heads/${branch}`)) !== pr.headSha)
          throw new Error("Existing local branch differs from PR; reconcile it before takeover");
        await this.git.command(root, "worktree", "add", directory, branch);
      } else await this.git.command(root, "worktree", "add", "-b", branch, directory, pr.headSha);
    }
    const check = await this.git.inspect("", "", directory, "");
    if (check.commonDir !== info.commonDir || check.sha !== pr.headSha || check.branch !== branch)
      throw new Error("Existing worktree does not match this PR");
    const existing = this.workspaces.find((w) => w.directory === directory);
    const workspace = existing
      ? this.api!.workspaces.ref(existing.id)
      : await this.api!.workspaces.create({
          source: {
            kind: "directory",
            path: directory,
            ...(project ? { projectId: project.projectId } : {}),
          },
          title: `${role === "review" ? "Review" : "PR"} ${pr.repo}#${pr.number}`,
        });
    const binding = {
      workspaceId: workspace.id,
      prId: pr.id,
      role,
      policy: Policy.parse({}),
      stack: [],
    };
    await this.store!.update((s) => {
      s.bindings[workspace.id] = binding;
    });
    await this.refreshWorkspaces();
    return binding;
  }
  async execute(input: Command): Promise<string> {
    if (!this.store || !this.api || !this.connected)
      throw new Error(this.error ?? "Background SDK is not connected");
    if (input.action === "refresh") {
      await this.tick(true);
      if (this.error) throw new Error(this.error);
      return "Refreshed";
    }
    if (input.action === "configure") {
      await this.store.update((s) => {
        if (s.revision !== input.revision)
          throw new Error("Configuration changed; reload and retry");
        s.config = input.config;
      });
      return "Settings saved";
    }
    if (input.action === "read") {
      await this.store.update((s) => {
        s.prs[input.prId].unread = 0;
      });
      return "Marked read";
    }
    if (input.action === "bind") {
      const pr = this.pr(input.prId);
      const w = this.workspace(input.workspaceId);
      if (pr.author !== this.state.account)
        throw new Error("Use Review to manage another author's PR");
      if (!w.remotes.includes(pr.repo.toLowerCase()))
        throw new Error("Workspace repository does not match PR");
      if (this.state.bindings[w.id]?.prId === pr.id) return "Workspace already bound";
      if (this.state.bindings[w.id] && this.state.bindings[w.id].prId !== pr.id)
        throw new Error("Workspace already belongs to another PR");
      await this.store.update((s) => {
        s.bindings[w.id] = {
          workspaceId: w.id,
          prId: pr.id,
          role: "author",
          policy: Policy.parse({}),
          stack: [],
        };
      });
      return "Workspace bound";
    }
    if (input.action === "takeover") {
      const pr = this.pr(input.prId);
      if (pr.author !== this.state.account)
        throw new Error("Use Review to manage another author's PR");
      await this.createWorkspace(pr, input.repositoryPath, "author", input.clone);
      return "Workspace ready";
    }
    for (const extension of this.extensions) {
      const message = await extension.command(input);
      if (message !== undefined) return message;
    }
    throw new Error("Action unavailable in this plugin version");
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
    await this.client?.close();
    await this.tail;
    await this.store?.close();
  }
}
