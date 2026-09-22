import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme, RpcInput } from "@getpaseo/plugin";
import type { PluginState, PR } from "../shared/model";
import { command } from "../shared/rpc";
import { Action, Field, Section } from "./ui";
export function PRActions(props: {
  pr: PR;
  state: PluginState;
  theme: PluginTheme;
  pending: boolean;
  execute(input: RpcInput<typeof command>): Promise<void>;
}) {
  const { pr, state, theme, pending, execute } = props;
  const c = theme.colors;
  const [mode, setMode] = useState<"comment" | "close" | null>(null);
  const [body, setBody] = useState("");
  const [history, setHistory] = useState(false);
  const actions = Object.values(state.prActions)
    .filter((a) => a.prId === pr.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const active = actions.filter((a) => !["done", "cancelled"].includes(a.status));
  const completed = actions.filter((a) => ["done", "cancelled"].includes(a.status));
  return (
    <View style={{ gap: 24 }}>
      <Section theme={theme} title="PR ACTIONS">
        <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
          Act as {state.account || "the signed-in GitHub account"}. Prepare a preview before sending
          anything to GitHub.
        </Text>
        <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
          <Action
            theme={theme}
            selected={mode === "comment"}
            disabled={pending}
            onPress={() => setMode("comment")}
          >
            Add comment
          </Action>
          {pr.state === "open" && (
            <Action
              theme={theme}
              destructive
              selected={mode === "close"}
              disabled={pending}
              onPress={() => setMode("close")}
            >
              Close PR…
            </Action>
          )}
        </View>
        {mode === "comment" && (
          <>
            <Field
              theme={theme}
              label="Comment body"
              multiline
              value={body}
              onChange={setBody}
              placeholder="Write a comment… Markdown is supported."
            />
            <View style={{ flexDirection: "row", gap: 4 }}>
              <Action
                theme={theme}
                primary
                disabled={pending || !body.trim()}
                onPress={() => {
                  void execute({ action: "preparePRAction", prId: pr.id, kind: "comment", body });
                  setMode(null);
                }}
              >
                Preview comment
              </Action>
              <Action theme={theme} onPress={() => setMode(null)}>
                Cancel
              </Action>
            </View>
          </>
        )}
        {mode === "close" && (
          <View style={{ gap: 12 }}>
            <Text style={{ color: c.foreground, lineHeight: 22 }}>
              Close {pr.repo}#{pr.number} without merging. The local Workspace and branches will be
              retained. A closed Stack layer will not advance to the next PR.
            </Text>
            <View style={{ flexDirection: "row", gap: 4 }}>
              <Action
                theme={theme}
                disabled={pending}
                onPress={() => {
                  void execute({ action: "preparePRAction", prId: pr.id, kind: "close", body: "" });
                  setMode(null);
                }}
              >
                Review close action
              </Action>
              <Action theme={theme} onPress={() => setMode(null)}>
                Cancel
              </Action>
            </View>
          </View>
        )}
      </Section>
      {active.map((action) => (
        <View
          key={action.id}
          style={{ gap: 12, padding: 16, borderRadius: 8, backgroundColor: c.surface0 }}
        >
          <Text
            style={{
              color: action.kind === "close" ? c.statusDanger : c.foreground,
              fontWeight: "500",
            }}
          >
            {action.kind === "close" ? "Close PR" : "Post comment"} · {action.status}
          </Text>
          <Text selectable style={{ color: c.foregroundMuted, lineHeight: 22 }}>
            Target: {action.url}
            {"\n"}Account: {action.account}
            {"\n"}HEAD: {action.sha.slice(0, 12)}
          </Text>
          {action.kind === "comment" ? (
            <Text selectable style={{ color: c.foreground, lineHeight: 22 }}>
              {action.body}
            </Text>
          ) : (
            <Text style={{ color: c.foreground, lineHeight: 22 }}>
              This closes the PR without merging. Workspace and local branches are retained.
            </Text>
          )}
          {!!action.error && (
            <Text selectable style={{ color: c.statusDanger, lineHeight: 22 }}>
              {action.error}
            </Text>
          )}
          {action.status === "stale" && (
            <Text style={{ color: c.foregroundMuted }}>
              This preview is outdated. Prepare a new action to continue.
            </Text>
          )}
          {action.status === "pending" && (
            <Action
              theme={theme}
              primary
              destructive={action.kind === "close"}
              disabled={
                pending || (mode === "comment" && action.kind === "comment" && body !== action.body)
              }
              onPress={() =>
                void execute({
                  action: "confirmPRAction",
                  id: action.id,
                  fingerprint: action.fingerprint,
                })
              }
            >
              {action.kind === "close" ? "Confirm close PR" : "Confirm post comment"}
            </Action>
          )}
          {["pending", "stale", "attention"].includes(action.status) && (
            <Action
              theme={theme}
              disabled={pending}
              onPress={() => void execute({ action: "dismissPRAction", id: action.id })}
            >
              {action.status === "attention" ? "I checked GitHub · dismiss" : "Discard preview"}
            </Action>
          )}
        </View>
      ))}
      {!!completed.length && (
        <Section theme={theme} title="RECENT ACTIONS">
          <Action theme={theme} selected={history} onPress={() => setHistory(!history)}>
            {history ? "Hide action history" : `Show action history (${completed.length})`}
          </Action>
          {history &&
            completed.map((action) => (
              <View key={action.id} style={{ gap: 8, paddingVertical: 8 }}>
                <Text style={{ color: c.foreground }}>
                  {action.kind === "comment" ? "Comment" : "Close PR"} · {action.status} ·{" "}
                  {new Date(action.createdAt).toLocaleString()}
                </Text>
                {!!action.body && (
                  <Text selectable style={{ color: c.foregroundMuted }}>
                    {action.body}
                  </Text>
                )}
                {!!action.error && <Text style={{ color: c.statusDanger }}>{action.error}</Text>}
              </View>
            ))}
        </Section>
      )}
    </View>
  );
}
