import type { PR, WorkspaceInfo } from "./model";
export function candidates(pr: PR, workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  return workspaces.filter(
    (w) =>
      !w.error &&
      w.branch === pr.headRef &&
      !!pr.headRepo &&
      w.remotes.includes(pr.repo.toLowerCase()) &&
      (w.headRemote === pr.headRepo.toLowerCase() ||
        (!w.headRemote && w.remotes.includes(pr.headRepo.toLowerCase()) && w.sha === pr.headSha)),
  );
}
