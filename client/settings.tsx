import { useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import type { PluginTheme, RpcInput } from "@getpaseo/plugin";
import type { PluginState } from "../shared/model";
import { command } from "../shared/rpc";
export function PollSettings(props: {
  config: PluginState["config"];
  revision: number;
  theme: PluginTheme;
  pending: boolean;
  execute(input: RpcInput<typeof command>): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [discovery, setDiscovery] = useState(String(props.config.discoverySeconds));
  const [poll, setPoll] = useState(String(props.config.pollSeconds));
  const c = props.theme.colors;
  const valid =
    Number.isInteger(Number(discovery)) &&
    Number(discovery) >= 60 &&
    Number.isInteger(Number(poll)) &&
    Number(poll) >= 30;
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(!expanded)}
        style={{ padding: 10, backgroundColor: c.surface2 }}
      >
        <Text style={{ color: c.foreground }}>
          Polling settings · {props.config.discoverySeconds}s discovery / {props.config.pollSeconds}
          s tracking
        </Text>
      </Pressable>
      {expanded && (
        <>
          <Text style={{ color: c.foregroundMuted }}>Discovery interval (minimum 60 seconds)</Text>
          <TextInput
            accessibilityLabel="Discovery interval seconds"
            keyboardType="numeric"
            value={discovery}
            onChangeText={setDiscovery}
            style={{ color: c.foreground, backgroundColor: c.surface1, padding: 10 }}
          />
          <Text style={{ color: c.foregroundMuted }}>Tracked PR interval (minimum 30 seconds)</Text>
          <TextInput
            accessibilityLabel="Tracking interval seconds"
            keyboardType="numeric"
            value={poll}
            onChangeText={setPoll}
            style={{ color: c.foreground, backgroundColor: c.surface1, padding: 10 }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={props.pending || !valid}
            onPress={() =>
              void props.execute({
                action: "configure",
                revision: props.revision,
                config: { discoverySeconds: Number(discovery), pollSeconds: Number(poll) },
              })
            }
            style={{ padding: 10, backgroundColor: c.surface2, opacity: valid ? 1 : 0.5 }}
          >
            <Text style={{ color: c.foreground }}>Save polling settings</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
