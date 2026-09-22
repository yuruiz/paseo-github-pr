import { useState } from "react";
import { Text, TextInput, View, Pressable, Switch } from "react-native";
import type { PluginTheme, RpcInput } from "@getpaseo/plugin";
import { command } from "../shared/rpc";
export function ReviewForm({
  theme,
  repositoryPath,
  initialUrl,
  pending,
  execute,
}: {
  theme: PluginTheme;
  repositoryPath: string;
  initialUrl?: string;
  pending: boolean;
  execute(input: RpcInput<typeof command>): Promise<void>;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [provider, setProvider] = useState("");
  const [incremental, setIncremental] = useState(false);
  const [confirmClone, setConfirmClone] = useState(false);
  const c = theme.colors;
  const style = { color: c.foreground, padding: 10, backgroundColor: c.surface2 };
  return (
    <View style={{ gap: 16 }}>
      <Text style={{ color: c.foreground, fontSize: 13 }}>Pull request URL</Text>
      <TextInput
        accessibilityLabel="Review PR URL"
        placeholder="https://github.com/owner/repo/pull/42"
        placeholderTextColor={c.foregroundMuted}
        value={url}
        onChangeText={(value) => {
          setUrl(value);
          setConfirmClone(false);
        }}
        style={style}
      />
      <Text style={{ color: c.foreground, fontSize: 13 }}>Agent provider / model</Text>
      <TextInput
        accessibilityLabel="Review provider/model"
        placeholder="codex/model"
        placeholderTextColor={c.foregroundMuted}
        value={provider}
        onChangeText={setProvider}
        style={style}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Switch
          accessibilityLabel="Incremental review"
          value={incremental}
          onValueChange={setIncremental}
        />
        <Text style={{ color: c.foreground }}>Incremental since the last completed review</Text>
      </View>
      <Text selectable style={{ color: c.foregroundMuted }}>
        Repository: {repositoryPath || "Choose the local repository path above"}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={pending || !url.trim() || !provider.trim() || !repositoryPath.trim()}
        onPress={() =>
          void execute({
            action: "review",
            url,
            repositoryPath,
            provider,
            mode: incremental ? "incremental" : "full",
            clone: false,
          })
        }
        style={{ padding: 10, backgroundColor: c.surface2 }}
      >
        <Text style={{ color: c.foreground }}>Start review using local repository</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={pending || !url.trim() || !provider.trim() || !repositoryPath.trim()}
        onPress={() => setConfirmClone(!confirmClone)}
        style={{ padding: 10, backgroundColor: c.surface2 }}
      >
        <Text style={{ color: c.foreground }}>Repository missing? Prepare clone</Text>
      </Pressable>
      {confirmClone && (
        <View style={{ gap: 8 }}>
          <Text selectable style={{ color: c.foreground }}>
            Clone the base repository of {url} to {repositoryPath}, create a Review Workspace, and
            start the selected agent.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={pending || !url.trim() || !provider.trim() || !repositoryPath.trim()}
            onPress={() => {
              setConfirmClone(false);
              void execute({
                action: "review",
                url,
                repositoryPath,
                provider,
                mode: incremental ? "incremental" : "full",
                clone: true,
              });
            }}
            style={{ padding: 10, backgroundColor: c.accent }}
          >
            <Text style={{ color: c.accentForeground }}>Confirm clone and review</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
