import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Dashboard } from "./client/dashboard";
export default function contribute(client: PluginClientContext) {
  client.addSurface("inbox", Dashboard);
  client.addSidebarItem({
    id: "inbox",
    title: "GitHub PRs",
    icon: "GitPullRequest",
    surface: "inbox",
  });
  client.addWorkspacePanel({
    id: "pr",
    title: "GitHub PR",
    icon: "GitPullRequest",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: Dashboard,
  });
  client.addCommandCenterItem({
    id: "open",
    title: "Open GitHub PRs",
    icon: "GitPullRequest",
    context: "global",
    onSelect: ({ openSurface }) => openSurface("inbox"),
  });
  return () => {};
}
