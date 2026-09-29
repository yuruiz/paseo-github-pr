# GitHub PR for Paseo

A Paseo plugin for monitoring GitHub pull requests, binding them to workspaces, running local repairs, and preparing reviews. The inbox groups PRs by repository and shows checks, comments, tasks, and approval previews.

## Requirements

- Linux, Node.js 22, Git, and `flock` (util-linux).
- Paseo daemon and app **0.8.0 or later**. The manifest declares the minimum API version without a release whitelist, so upgrades do not need a manifest edit. Future breaking API changes may still require a plugin update; accepting a version does not mean that release has been tested.
- GitHub CLI (`gh`) authenticated to GitHub.com on the daemon machine. Repository access follows that account's permissions.
- Enable plugins in Paseo Settings. Plugins run trusted code with your local user's access.

## Install

Clone and install from the daemon machine:

```sh
git clone https://github.com/yuruiz/paseo-github-pr.git
cd paseo-github-pr
paseo plugin install "$PWD"
```

After installation, open **GitHub PRs** in the sidebar or **Open GitHub PRs** in the Command Center. The plugin also contributes a workspace panel. Source updates require `paseo plugin reload github-pr`; a daemon restart is not required. Configure Git HTTPS authentication, for example with `gh auth setup-git`, before confirming pushes.

No bootstrap file is required. The plugin discovers the installing daemon's address and creates private runtime storage under `$PASEO_HOME/plugin-data/github-pr` (`~/.paseo/plugin-data/github-pr` by default). Installation runs the dependency build declared in the plugin manifest. Monitoring starts in the background without opening the panel and resumes after reload or daemon restart.

For password-protected daemons, the plugin uses the daemon's existing `PASEO_PASSWORD` environment variable. A password stored only as a hash in Paseo settings cannot be recovered; that deployment must provide `PASEO_PASSWORD` to the daemon for unattended connections. Automatic discovery currently supports TCP listeners, including wildcard bind addresses, and verifies the daemon identity before using the SDK.

Existing `PASEO_GITHUB_CONFIG` and default-location bootstrap files remain supported, including their data directory and password environment settings. Leave them in place when upgrading to retain tracked PRs, approvals, and preferences.

## Using the inbox

The inbox groups PRs by their target repository, ordered alphabetically by owner/name. Click a repository heading to collapse or expand its PRs; the count stays visible. Collapse choices survive polling, search and filter changes while the panel is open. Each heading shows the number of PRs matching the current search and filter. Within each repository, approvals come first, then failed tasks, conflicts, CI failures and unread updates; equally urgent PRs show the most recently updated first. The inbox opens on **Attention**. **All open**, **Reviews**, **Unmapped** and **History** narrow the list; search matches titles, repositories, branches, authors and PR numbers. Unknown mergeability and failures from old commits are not presented as current CI failures.

Select a PR to see its overview. **Open on GitHub ↗** beside the Workspace action opens that PR in your browser. Desktop shows list and detail side by side; compact and narrow Workspace panels open one view at a time with **Back to PRs**. The Workspace panel scopes the inbox to its own Stack and initially shows the current target.

- **Overview** explains what needs attention, renders the full PR description as Markdown (headings, emphasis, lists, task lists, quotes, code, tables, links and images), shows complete check/conflict messages, then shows the Stack. Wide code blocks and tables scroll within their own region. Description text and check messages are selectable and are not shortened or collapsed. Markdown links open externally; relative file and image links use the PR head repository and revision. HTML comments are hidden, and other raw HTML is shown as text rather than executed. Use **Refresh** to load descriptions from older snapshots, including tracked closed PRs whose descriptions have not been loaded yet.
- **Activity** contains only this PR's tasks, publication previews and recent comments. Expand a result or preview to inspect it; publication still requires explicit confirmation of the exact content.
- **Workspace** contains binding, checkout information, automation preferences and Stack overrides. Forms open only when requested.
- **Actions** lets you write a comment or close an open PR using the current `gh` account. These actions work without a Workspace or agent task. Prepare the preview, inspect the target and exact body, then confirm. Closing retains the Workspace and local branches; it does not merge or advance a Stack.

Use **New review** for a dedicated review form and **Settings** for polling intervals. Neither form occupies the inbox. Configuration and drafts are local to the opened form; polling does not reset them.

Manual action previews and results survive reloads. Changing the account, PR state or head/base commits invalidates an approval. An uncertain remote result requires inspection on GitHub and explicit dismissal before another attempt; the plugin never retries it automatically. Successful writes remain successful even if the subsequent tracking refresh fails. GitHub enforces the signed-in account's permissions. Closing uses the [PR update endpoint](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request); manual comments use [issue comments](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment). These endpoints have no atomic expected-head condition, so a preflight check cannot exclude a concurrent external change after the check.

## Automation and publication

Enable event types per authored Workspace, then choose `codex/<model-id>`. This release only accepts Codex for unattended work: it applies workspace/read-only sandboxing, disables network and web search, and never grants escalations. Other providers remain unavailable until equivalent enforcement is implemented. Paseo MCP injection must be disabled globally (`mcp.injectIntoAgents: false`) or for Codex (`providers.codex.paseoTools.enabled: false`). The plugin checks this before enabling or dispatching, and verifies the dedicated agent's persisted native policy before each send. It does not change host settings. Keep this dedicated agent's permissions managed by the plugin. Read the target repository's build requirements; a blocked dependency download or container command must be resolved by a person, not by weakening the agent sandbox.

Use **Settings → Polling settings** to change discovery and tracked-PR intervals. The plugin queues fresh events only. A failed CI check becoming successful before execution is discarded. Tasks never overlap in one checkout; unsaved changes and running agents block dispatch. An uncertain send or publish is shown for inspection rather than retried. Use **Recheck agent delivery** to reconcile an agent; **finish locally** acknowledges a result while preserving files.

Publication is separate: prepare an exact commit message/comment/review, inspect the preview, then confirm. Changed GitHub SHAs or local files invalidate approval. Commits are signed off and use the repository's hooks. Push is fast-forward only. A failed push may leave a local commit; the UI records the failure for manual recovery. This plugin is trusted code, and provider sandboxing is not isolation from other software running as your user.

## Stack progression

The panel shows the complete trunk-first chain and its active PR. Local gh-stack metadata is checked against GitHub head/base identities. Without metadata, only an unambiguous branch chain reaching the repository's default branch is inferred. Missing, forked, cyclic, or contradictory chains pause automation. For an ambiguous chain, open a bound PR’s **Workspace → Override Stack order** and paste the tracked PR URLs in trunk-first order. The plugin validates the chosen order and removes competing author bindings only after their tasks are resolved.

On merge, the plugin journals the old HEAD and next PR, fetches that PR, switches without force, verifies the result, and only then updates the binding. A restart after the switch resumes the same journal. A dirty checkout, outstanding task, busy agent, occupied branch, or diverged local branch remains visible as a blocker. Closed-but-unmerged PRs do not advance. Existing branches needing rebase or synchronization must be handled separately. Workspaces, branches, and worktrees are never deleted by progression.

## Reviewing another PR

Open **New review**, paste its GitHub URL, select a repository path and Codex model, then start a full review. If the repository is missing, use the separate clone preview and confirm the destination. A dedicated plugin-owned worktree is registered under the existing Project when available. Starting another review reuses its Workspace; it never archives someone else's worktree.

Review runs use a read-only profile and pin both base and head commits. New commits, comments, and CI results update the inbox only. Start a full or incremental follow-up manually. A new head/base makes pending results obsolete while preserving their text. Incremental review uses the last completed review's head SHA. Publication creates a GitHub review containing the approved report and its exact file/line references; it does not automatically approve or request changes on the PR.

## Verification

See [VALIDATION.md](VALIDATION.md) for the pinned host, targeted checks, integration fixtures, browser evidence, and verification limits. No production daemon restart or GitHub publication is needed to run those checks.

## Development

See [VALIDATION.md](VALIDATION.md) for checks and isolated integration fixtures. Runtime data, credentials, local snapshots, and generated reports must stay outside this repository.
