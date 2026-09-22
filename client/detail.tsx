import { useState } from "react";
import { Text, View, Pressable, Linking } from "react-native";
import type { PluginTheme, RpcInput } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginState, WorkspaceInfo } from "../shared/model";
import { candidates } from "../shared/mapping";
import { command } from "../shared/rpc";
import type { InboxRow } from "./inbox";
import { Action, Field, Section } from "./ui";
import { AutomationPanel, PolicyEditor } from "./automation";
import { Markdown } from "./markdown";
import { PRActions } from "./pr-actions";
import { ReviewForm } from "./review";
type Props = {
  row: InboxRow;
  state: PluginState;
  workspaces: WorkspaceInfo[];
  theme: PluginTheme;
  pending: boolean;
  execute(input: RpcInput<typeof command>): Promise<void>;
  navigation?: PluginSurfaceProps["navigation"];
  onSelect(id: string): void;
};
export function PRDetail(props: Props) {
  const { row, theme, pending, execute, state } = props;
  const { pr, binding, workspace } = row;
  const c = theme.colors;
  const [tab, setTab] = useState<"overview" | "activity" | "workspace" | "actions">("overview");
  const [linkError, setLinkError] = useState("");
  const [review, setReview] = useState(false);
  const [stackEdit, setStackEdit] = useState(false);
  const [stackUrls, setStackUrls] = useState(
    binding?.stack.map((id) => state.prs[id]?.url).join("\n") ?? "",
  );
  const [stackError, setStackError] = useState("");
  const [automation, setAutomation] = useState(false);
  const signals = pr.signals.filter(
    (signal) =>
      (signal.kind === "ci" || signal.kind === "conflict") &&
      signal.sha === pr.headSha &&
      pr.state === "open",
  );
  return (
    <View style={{ gap: 24 }}>
      <View style={{ gap: 12 }}>
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>
          {pr.repo} / #{pr.number} · {pr.state}
        </Text>
        <Text
          selectable
          style={{ color: c.foreground, fontSize: 22, fontWeight: "500", lineHeight: 30 }}
        >
          {pr.title}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
          by {pr.author}
          {binding?.role === "review" ? " · Code review" : ""}
        </Text>
        <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
          {binding && props.navigation && (
            <Action
              theme={theme}
              primary={row.rank > 1}
              onPress={() => props.navigation!.openWorkspace({ workspaceId: binding.workspaceId })}
            >
              Open Workspace
            </Action>
          )}
          {!binding && (
            <Action theme={theme} primary={row.rank > 1} onPress={() => setTab("workspace")}>
              Connect Workspace
            </Action>
          )}
          <Action
            theme={theme}
            onPress={() => {
              setLinkError("");
              void Linking.openURL(pr.url).catch((error: unknown) =>
                setLinkError(`Could not open GitHub: ${String(error)}`),
              );
            }}
          >
            Open on GitHub ↗
          </Action>
          {pr.unread > 0 && (
            <Action
              theme={theme}
              disabled={pending}
              onPress={() => void execute({ action: "read", prId: pr.id })}
            >
              Mark read
            </Action>
          )}
        </View>
        {!!linkError && (
          <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
            {linkError}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
        <Action theme={theme} selected={tab === "overview"} onPress={() => setTab("overview")}>
          Overview
        </Action>
        <Action
          theme={theme}
          selected={tab === "activity"}
          onPress={() => setTab("activity")}
        >{`Activity${row.tasks.length + row.publications.length ? ` (${row.tasks.length + row.publications.length})` : ""}`}</Action>
        <Action theme={theme} selected={tab === "workspace"} onPress={() => setTab("workspace")}>
          Workspace
        </Action>
        <Action theme={theme} selected={tab === "actions"} onPress={() => setTab("actions")}>
          Actions
        </Action>
      </View>
      {tab === "actions" && (
        <PRActions pr={pr} state={state} theme={theme} pending={pending} execute={execute} />
      )}
      {tab === "overview" && (
        <>
          <View style={{ padding: 18, borderRadius: 10, backgroundColor: c.surface0, gap: 10 }}>
            <Text
              style={{
                color: row.danger ? c.statusDanger : row.attention ? c.accent : c.foreground,
                fontSize: 16,
                fontWeight: "500",
              }}
            >
              {row.label}
            </Text>
            <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
              {row.rank === 0
                ? row.prActions.some((action) => action.status === "pending")
                  ? "A PR action is prepared. Inspect its target and exact content before confirming."
                  : "An agent result is ready. Inspect the result and exact publication before approving."
                : row.rank === 1
                  ? "An operation needs your input before work can continue."
                  : pr.error ||
                    (binding?.prId === pr.id && binding.blocked) ||
                    (pr.mergeable === false && pr.state === "open"
                      ? "Resolve conflicting changes before this PR can be merged."
                      : signals.length
                        ? "Check the failing runs below before continuing."
                        : pr.unread
                          ? "New activity has arrived on this pull request."
                          : pr.state !== "open"
                            ? "Tracking history and Workspace are preserved."
                            : pr.mergeable === null
                              ? "GitHub has not determined mergeability yet."
                              : "No outstanding alerts from the latest poll.")}
            </Text>
            {(row.rank < 2 || pr.unread > 0) && (
              <View style={{ alignItems: "flex-start" }}>
                <Action
                  theme={theme}
                  primary={row.rank < 2}
                  onPress={() =>
                    setTab(
                      row.prActions.some((action) =>
                        ["pending", "attention", "stale", "executing"].includes(action.status),
                      )
                        ? "actions"
                        : "activity",
                    )
                  }
                >
                  {row.rank === 0 ? "Inspect result →" : "View activity →"}
                </Action>
              </View>
            )}
          </View>
          <Section theme={theme} title="DESCRIPTION">
            {pr.body?.trim() ? (
              <Markdown
                body={pr.body}
                theme={theme}
                context={{ repo: pr.headRepo ?? pr.repo, sha: pr.headSha, prUrl: pr.url }}
              />
            ) : (
              <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 23 }}>
                {pr.body === undefined
                  ? "Description has not been loaded yet. Use Refresh to load it from GitHub."
                  : "No description provided."}
              </Text>
            )}
          </Section>
          {!!signals.length && (
            <Section theme={theme} title="CHECKS & CONFLICTS">
              {signals.map((signal) => (
                <View
                  key={signal.key}
                  style={{ gap: 10, padding: 16, backgroundColor: c.surface0, borderRadius: 8 }}
                >
                  <Text
                    selectable
                    style={{
                      color: c.statusDanger,
                      fontSize: 14,
                      fontWeight: "500",
                      lineHeight: 22,
                    }}
                  >
                    {signal.text.split("\n")[0]}
                  </Text>
                  {!!signal.text.split("\n").slice(1).join("\n").trim() && (
                    <Text selectable style={{ color: c.foreground, fontSize: 14, lineHeight: 22 }}>
                      {signal.text.split("\n").slice(1).join("\n")}
                    </Text>
                  )}
                  {!!signal.url && (
                    <View style={{ alignItems: "flex-start" }}>
                      <Action
                        theme={theme}
                        onPress={() => {
                          setLinkError("");
                          void Linking.openURL(signal.url!).catch((error: unknown) =>
                            setLinkError(`Could not open check: ${String(error)}`),
                          );
                        }}
                      >
                        Open check ↗
                      </Action>
                    </View>
                  )}
                </View>
              ))}
            </Section>
          )}
          {binding && binding.stack.length > 1 && (
            <Section theme={theme} title={`STACK · ${binding.stack.length} PULL REQUESTS`}>
              {binding.stack.map((id, i) => {
                const layer = state.prs[id];
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="button"
                    accessibilityLabel={`Stack PR ${layer?.number ?? id}`}
                    onPress={() => props.onSelect(id)}
                    style={{
                      flexDirection: "row",
                      gap: 12,
                      paddingVertical: 10,
                      alignItems: "flex-start",
                    }}
                  >
                    <Text
                      style={{
                        color: id === binding.prId ? c.accent : c.foregroundMuted,
                        fontSize: 13,
                      }}
                    >
                      {i + 1}
                    </Text>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={{ color: c.foreground, fontSize: 14 }} numberOfLines={2}>
                        #{layer?.number} {layer?.title ?? "Unavailable PR"}
                      </Text>
                      <Text
                        style={{
                          color: id === binding.prId ? c.accent : c.foregroundMuted,
                          fontSize: 12,
                        }}
                      >
                        {id === binding.prId
                          ? "Current Workspace target"
                          : (layer?.state ?? "Unknown")}
                        {id === pr.id ? " · Viewing" : ""}
                      </Text>
                    </View>
                    <Text style={{ color: c.foregroundMuted }}>›</Text>
                  </Pressable>
                );
              })}
            </Section>
          )}
          <Section theme={theme} title="WORKSPACE">
            <Text style={{ color: c.foreground, fontSize: 14 }}>
              {workspace?.name ?? (binding ? "Workspace unavailable" : "Not connected")}
            </Text>
            <Text style={{ color: c.foregroundMuted, lineHeight: 21 }}>
              {binding
                ? `${binding.role === "review" ? "Review Workspace" : binding.policy.enabled ? "Automatic responses enabled" : "Automatic responses off"}${workspace?.dirty ? " · Local changes" : ""}`
                : "Connect a Workspace to work on this PR locally."}
            </Text>
            <View style={{ alignItems: "flex-start" }}>
              <Action theme={theme} onPress={() => setTab("workspace")}>
                {binding ? "Workspace details →" : "Choose a Workspace →"}
              </Action>
            </View>
          </Section>
          <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {pr.url}
          </Text>
        </>
      )}
      {tab === "activity" && (
        <>
          <AutomationPanel
            state={state}
            theme={theme}
            pending={pending}
            execute={execute}
            prId={pr.id}
            taskIds={row.tasks.map((task) => task.id)}
            publicationIds={row.publications.map((pub) => pub.id)}
          />
          <Section theme={theme} title="GITHUB ACTIVITY">
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {pr.unread} unread updates · Latest comments and reviews
            </Text>
            {pr.signals
              .filter((s) => s.kind === "comment")
              .slice(-10)
              .reverse()
              .map((s) => (
                <Disclosure
                  key={s.key}
                  theme={theme}
                  title={s.text.split("\n")[0]}
                  body={s.text}
                  url={s.url}
                />
              ))}
            {!pr.signals.some((s) => s.kind === "comment") && (
              <Text style={{ color: c.foregroundMuted }}>No comments or reviews recorded.</Text>
            )}
            {pr.signals.filter((s) => s.kind === "comment").length > 10 && (
              <Text style={{ color: c.foregroundMuted }}>
                Showing the latest 10. Full discussion: {pr.url}
              </Text>
            )}
          </Section>
        </>
      )}
      {tab === "workspace" && (
        <>
          {!binding ? (
            <Mapping {...props} />
          ) : (
            <>
              <Section theme={theme} title="CONNECTED WORKSPACE">
                <Text style={{ color: c.foreground, fontSize: 16 }}>
                  {workspace?.name ?? "Unavailable"}
                </Text>
                <Text selectable style={{ color: c.foregroundMuted, lineHeight: 22 }}>
                  {workspace?.directory ?? binding.workspaceId}
                </Text>
                <Text selectable style={{ color: c.foregroundMuted, lineHeight: 22 }}>
                  PR branch: {pr.headRef}
                  {"\n"}Actual checkout: {workspace?.branch ?? "detached"}
                  {"\n"}Target: #{state.prs[binding.prId]?.number}
                  {workspace?.dirty ? " · Local changes" : ""}
                </Text>
                {binding.blocked && (
                  <Text style={{ color: c.statusDanger }}>{binding.blocked}</Text>
                )}
              </Section>
              {binding.role === "author" && (
                <Section theme={theme} title="AUTOMATIC RESPONSES">
                  <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
                    {binding.policy.enabled ? "Enabled" : "Off"} · Applies to the current Stack
                    target only. Publishing always requires approval.
                  </Text>
                  <Action
                    theme={theme}
                    selected={automation}
                    onPress={() => setAutomation(!automation)}
                  >
                    {automation ? "Close automation settings" : "Configure automation"}
                  </Action>
                  {automation && (
                    <PolicyEditor
                      key={binding.workspaceId}
                      state={state}
                      theme={theme}
                      pending={pending}
                      execute={execute}
                      binding={binding}
                    />
                  )}
                </Section>
              )}
              {binding.role === "review" && pr.state === "open" && (
                <Section theme={theme} title="CODE REVIEW">
                  <Text style={{ color: c.foregroundMuted }}>
                    New commits update tracking. Start the next review when you are ready.
                  </Text>
                  <Action theme={theme} selected={review} onPress={() => setReview(!review)}>
                    {review ? "Cancel new review" : "Start another review"}
                  </Action>
                  {review && (
                    <ReviewForm
                      theme={theme}
                      repositoryPath={workspace?.checkoutRoot ?? ""}
                      initialUrl={pr.url}
                      pending={pending}
                      execute={execute}
                    />
                  )}
                </Section>
              )}
              {binding.role === "author" && (
                <Section theme={theme} title="STACK MAPPING">
                  <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
                    Stack order is detected automatically. Override it only when the detected
                    mapping needs correction.
                  </Text>
                  <Action
                    theme={theme}
                    selected={stackEdit}
                    onPress={() => setStackEdit(!stackEdit)}
                  >
                    {stackEdit ? "Cancel Stack override" : "Override Stack order"}
                  </Action>
                  {stackEdit && (
                    <>
                      <Field
                        theme={theme}
                        label="Stack PR URLs in trunk-first order"
                        value={stackUrls}
                        onChange={setStackUrls}
                        multiline
                      />
                      {!!stackError && <Text style={{ color: c.statusDanger }}>{stackError}</Text>}
                      <Action
                        theme={theme}
                        disabled={pending}
                        onPress={() => {
                          const ids = stackUrls
                            .split(/\s+/)
                            .filter(Boolean)
                            .map((url) => Object.values(state.prs).find((p) => p.url === url)?.id);
                          if (!ids.length || ids.some((id) => !id)) {
                            setStackError("Every URL must identify a tracked PR.");
                            return;
                          }
                          setStackError("");
                          void execute({
                            action: "stack",
                            workspaceId: binding.workspaceId,
                            prIds: ids as string[],
                          });
                        }}
                      >
                        Save Stack mapping
                      </Action>
                    </>
                  )}
                </Section>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
function Disclosure({
  theme,
  title,
  body,
  url,
}: {
  theme: PluginTheme;
  title: string;
  body: string;
  url?: string;
}) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", gap: 10, paddingVertical: 8 }}
      >
        <Text style={{ color: c.foregroundMuted }}>{open ? "⌄" : "›"}</Text>
        <Text
          numberOfLines={open ? undefined : 2}
          style={{
            flex: 1,
            color: c.foreground,
            lineHeight: 22,
            fontSize: 14,
          }}
        >
          {title}
        </Text>
      </Pressable>
      {open && (
        <View style={{ gap: 10, paddingLeft: 20 }}>
          <Text selectable style={{ color: c.foregroundMuted, lineHeight: 22 }}>
            {body}
          </Text>
          {url && (
            <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {url}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
function Mapping(props: Props) {
  const { theme, row, workspaces, pending, execute } = props;
  const [mode, setMode] = useState<"bind" | "takeover">("bind");
  const [chosen, setChosen] = useState("");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [clone, setClone] = useState(false);
  const c = theme.colors;
  const matches = candidates(row.pr, workspaces);
  const visible = workspaces.filter((w) =>
    `${w.name} ${w.branch} ${w.directory}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <View style={{ gap: 20 }}>
      <Text style={{ color: c.foreground, fontSize: 18 }}>Connect a Workspace</Text>
      <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
        {matches.length > 1
          ? `${matches.length} possible matches. Choose the Workspace for this PR.`
          : "Choose an existing Workspace or create one from a local repository."}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <Action theme={theme} selected={mode === "bind"} onPress={() => setMode("bind")}>
          Use existing
        </Action>
        <Action theme={theme} selected={mode === "takeover"} onPress={() => setMode("takeover")}>
          Create Workspace
        </Action>
      </View>
      {mode === "bind" ? (
        <>
          <Field
            theme={theme}
            label="Find a Workspace"
            value={query}
            onChange={setQuery}
            placeholder="Name or branch"
          />
          {visible.map((w) => (
            <Pressable
              key={w.id}
              accessibilityRole="button"
              accessibilityLabel={`Choose Workspace ${w.name}`}
              accessibilityState={{ selected: chosen === w.id }}
              onPress={() => setChosen(w.id)}
              style={{
                backgroundColor: chosen === w.id ? c.surface2 : "transparent",
                padding: 12,
                borderRadius: 8,
                gap: 6,
              }}
            >
              <Text style={{ color: c.foreground }}>
                {chosen === w.id ? "✓ " : ""}
                {w.name}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {w.branch ?? "detached"} · {w.directory}
              </Text>
            </Pressable>
          ))}
          {!visible.length && (
            <Text style={{ color: c.foregroundMuted }}>No matching Workspaces.</Text>
          )}
          <Action
            theme={theme}
            primary
            disabled={pending || !chosen}
            onPress={() => void execute({ action: "bind", workspaceId: chosen, prId: row.pr.id })}
          >
            Connect selected Workspace
          </Action>
        </>
      ) : (
        <>
          <Field
            theme={theme}
            label="Repository path"
            value={path}
            onChange={(value) => {
              setPath(value);
              setClone(false);
            }}
            placeholder="/example/repository"
          />
          <Action
            theme={theme}
            primary
            disabled={pending || !path.trim()}
            onPress={() =>
              void execute({
                action: "takeover",
                prId: row.pr.id,
                repositoryPath: path,
                clone: false,
              })
            }
          >
            Create from local repository
          </Action>
          <Action theme={theme} disabled={!path.trim()} onPress={() => setClone(!clone)}>
            Repository missing? Prepare clone
          </Action>
          {clone && (
            <View style={{ gap: 12, backgroundColor: c.surface0, padding: 16, borderRadius: 8 }}>
              <Text selectable style={{ color: c.foreground, lineHeight: 22 }}>
                Clone {row.pr.repo} to {path}, then create a Workspace for this PR.
              </Text>
              <Action
                theme={theme}
                primary
                disabled={pending}
                onPress={() =>
                  void execute({
                    action: "takeover",
                    prId: row.pr.id,
                    repositoryPath: path,
                    clone: true,
                  })
                }
              >
                Confirm clone and takeover
              </Action>
            </View>
          )}
        </>
      )}
    </View>
  );
}
