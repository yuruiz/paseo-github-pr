import { useState } from "react";
import { Text, TextInput, View, Pressable, Switch } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginState, BindingInfo, TaskInfo } from "../shared/model";
import type { RpcInput } from "@getpaseo/plugin";
import { command } from "../shared/rpc";
type Props = {
  state: PluginState;
  theme: PluginTheme;
  pending: boolean;
  prId?: string;
  taskIds?: string[];
  publicationIds?: string[];
  execute(input: RpcInput<typeof command>): Promise<void>;
};
export function PolicyEditor({ binding, ...props }: Props & { binding: BindingInfo }) {
  const [policy, setPolicy] = useState(binding.policy);
  const c = props.theme.colors;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground }}>Response preferences</Text>
      <TextInput
        accessibilityLabel="Agent provider/model"
        style={{ color: c.foreground, backgroundColor: c.surface2, padding: 10 }}
        placeholder="codex/model"
        placeholderTextColor={c.foregroundMuted}
        value={policy.provider}
        onChangeText={(provider) => setPolicy({ ...policy, provider })}
      />
      {(["enabled", "comments", "ci", "conflict"] as const).map((key) => (
        <View key={key} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Switch
            accessibilityLabel={key}
            value={policy[key]}
            onValueChange={(value) => setPolicy({ ...policy, [key]: value })}
          />
          <Text style={{ color: c.foreground }}>{key}</Text>
        </View>
      ))}
      <Text style={{ color: c.foregroundMuted }}>
        At most {policy.hourlyLimit} automatic runs/hour. Local edits only; publication needs
        approval.
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={props.pending}
        onPress={() =>
          void props.execute({ action: "policy", workspaceId: binding.workspaceId, policy })
        }
        style={{ padding: 10, backgroundColor: c.surface2 }}
      >
        <Text style={{ color: c.foreground }}>Save automation</Text>
      </Pressable>
    </View>
  );
}
function TaskCard({ task, ...props }: Props & { task: TaskInfo }) {
  const [body, setBody] = useState("");
  const [expanded, setExpanded] = useState(false);
  const c = props.theme.colors;
  const button = (label: string, input: RpcInput<typeof command>) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      disabled={props.pending}
      onPress={() => void props.execute(input)}
      style={{ padding: 10, backgroundColor: c.surface2 }}
    >
      <Text style={{ color: c.foreground }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 8, padding: 16, backgroundColor: c.surface0, borderRadius: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Inspect ${task.kind} task`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ gap: 8, paddingVertical: 8 }}
      >
        <Text style={{ color: c.foreground, fontWeight: "500" }}>
          {task.kind === "review" ? "Code review" : "Automatic response"} · {task.status}{" "}
          {expanded ? "⌄" : "›"}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Commit {task.sha.slice(0, 10)} · {new Date(task.createdAt).toLocaleString()}
        </Text>
      </Pressable>
      {expanded && (
        <>
          {!!task.error && (
            <Text selectable style={{ color: c.statusDanger }}>
              {task.error}
            </Text>
          )}
          {!!task.result && (
            <Text selectable style={{ color: c.foreground }}>
              {task.result}
            </Text>
          )}
          {task.status === "approval" && (
            <>
              <TextInput
                accessibilityLabel="Publication text"
                multiline
                placeholder="Exact review, comment, or commit message"
                placeholderTextColor={c.foregroundMuted}
                value={body}
                onChangeText={setBody}
                style={{
                  color: c.foreground,
                  backgroundColor: c.surface2,
                  padding: 10,
                  minHeight: 80,
                }}
              />
              {task.kind === "review" ? (
                button("Prepare review for approval", {
                  action: "prepare",
                  taskId: task.id,
                  kind: "review",
                  body: body || task.result || "",
                })
              ) : (
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  {button("Prepare commit and push", {
                    action: "prepare",
                    taskId: task.id,
                    kind: "push",
                    body,
                  })}
                  {button("Prepare comment", {
                    action: "prepare",
                    taskId: task.id,
                    kind: "comment",
                    body,
                  })}
                </View>
              )}
            </>
          )}
          {task.status === "attention" &&
            button("Recheck agent delivery", { action: "retry", taskId: task.id })}
          {["approval", "attention", "failed"].includes(task.status) &&
            button("I inspected this task · finish locally", {
              action: "resolve",
              taskId: task.id,
            })}
        </>
      )}
    </View>
  );
}
export function AutomationPanel(props: Props) {
  const c = props.theme.colors;
  const match = (id: string) => !props.prId || props.prId === id;
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "500" }}>
        AGENT TASKS & APPROVALS
      </Text>
      {!Object.values(props.state.tasks).some(
        (t) => match(t.prId) && (!props.taskIds || props.taskIds.includes(t.id)),
      ) &&
        !Object.values(props.state.publications).some(
          (p) => match(p.prId) && (!props.publicationIds || props.publicationIds.includes(p.id)),
        ) && <Text style={{ color: c.foregroundMuted }}>No agent tasks for this PR yet.</Text>}
      {Object.values(props.state.tasks)
        .filter((t) => match(t.prId) && (!props.taskIds || props.taskIds.includes(t.id)))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((t) => (
          <TaskCard key={t.id} {...props} task={t} />
        ))}
      {Object.values(props.state.publications)
        .filter(
          (p) => match(p.prId) && (!props.publicationIds || props.publicationIds.includes(p.id)),
        )
        .map((p) => (
          <PublicationCard key={p.id} {...props} publicationId={p.id} />
        ))}
    </View>
  );
}

function PublicationCard(props: Props & { publicationId: string }) {
  const [expanded, setExpanded] = useState(false);
  const p = props.state.publications[props.publicationId]!;
  const c = props.theme.colors;
  return (
    <View style={{ gap: 12, padding: 16, backgroundColor: c.surface0, borderRadius: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Inspect ${p.kind} publication`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ paddingVertical: 8, gap: 8 }}
      >
        <Text
          style={{ color: p.status === "pending" ? c.accent : c.foreground, fontWeight: "500" }}
        >
          {p.kind === "push"
            ? "Commit and push"
            : p.kind === "review"
              ? "Publish review"
              : "Post comment"}{" "}
          · {p.status} {expanded ? "⌄" : "›"}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Inspect exact content before publishing
        </Text>
      </Pressable>
      {expanded && (
        <>
          <Text selectable style={{ color: c.foregroundMuted }}>
            Target: {props.state.prs[p.prId]?.url}
            {"\n"}PR HEAD: {p.sha}
            {"\n"}Local commit: {p.localSha}
          </Text>
          <Text selectable style={{ color: c.foreground, lineHeight: 22 }}>
            {p.body}
          </Text>
          {!!p.diff && (
            <Text
              selectable
              style={{
                color: c.foregroundMuted,
                fontSize: 12,
                fontFamily: "monospace",
                lineHeight: 19,
              }}
            >
              {p.diff}
            </Text>
          )}
          {!!p.error && <Text style={{ color: c.statusDanger }}>{p.error}</Text>}
          {p.status === "pending" && (
            <Pressable
              accessibilityRole="button"
              disabled={props.pending}
              onPress={() =>
                void props.execute({
                  action: "publish",
                  publicationId: p.id,
                  fingerprint: p.fingerprint,
                })
              }
              style={{ padding: 12, backgroundColor: c.accent, borderRadius: 8 }}
            >
              <Text style={{ color: c.accentForeground }}>Confirm this exact publication</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}
