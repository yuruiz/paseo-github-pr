import { realpath, access } from "node:fs/promises";
import path from "node:path";
import { run, type Runner } from "./process";
import { dataPath } from "./store";
import type { WorkspaceInfo } from "../shared/model";
export function githubRepo(remote: string): string | null {
  return (
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/
      .exec(remote)?.[1]
      .toLowerCase() ?? null
  );
}
export class Git {
  constructor(readonly exec: Runner = run) {}
  async command(cwd: string, ...args: string[]) {
    return this.exec("git", args, cwd);
  }
  async inspect(
    id: string,
    projectId: string,
    directory: string,
    name: string,
  ): Promise<WorkspaceInfo> {
    await dataPath(directory);
    const cwd = await realpath(directory);
    const branch = await this.command(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(
      () => "",
    );
    const [sha, status, commonDir, remoteText] = await Promise.all([
      this.command(cwd, "rev-parse", "HEAD"),
      this.command(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
      this.command(cwd, "rev-parse", "--git-common-dir"),
      this.command(cwd, "remote", "-v"),
    ]);
    const remotes = [
      ...new Set(
        remoteText
          .split("\n")
          .filter((l) => l.endsWith("(fetch)"))
          .map((l) => githubRepo(l.split(/\s+/)[1]))
          .filter((r): r is string => !!r),
      ),
    ];
    const upstream = branch
      ? await this.command(cwd, "config", "--get", `branch.${branch}.remote`).catch(() => "")
      : "";
    const headRemote =
      upstream && upstream !== "."
        ? githubRepo(await this.command(cwd, "remote", "get-url", upstream))
        : null;
    const gitDir = await this.command(cwd, "rev-parse", "--absolute-git-dir");
    const markers = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "index.lock",
    ];
    const operation = (
      await Promise.all(
        markers.map((marker) =>
          access(path.join(gitDir, marker)).then(
            () => true,
            () => false,
          ),
        ),
      )
    ).some(Boolean);
    return {
      id,
      projectId,
      directory: cwd,
      name,
      branch,
      sha,
      remotes,
      headRemote,
      dirty: !!status,
      operation,
      commonDir: await realpath(path.resolve(cwd, commonDir)),
      checkoutRoot: await realpath(await this.command(cwd, "rev-parse", "--show-toplevel")),
    };
  }
  async clone(repo: string, destination: string) {
    await dataPath(destination);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
    await this.exec("git", ["clone", "--", `https://github.com/${repo}.git`, destination]);
  }
}
export { candidates } from "../shared/mapping";
