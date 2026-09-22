import type { ReactNode } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, TextInput, View } from "react-native";
export type ThemeProps = { theme: PluginTheme };
export function Action({
  theme,
  children,
  onPress,
  disabled,
  primary,
  destructive,
  selected,
  label,
}: ThemeProps & {
  children: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  destructive?: boolean;
  selected?: boolean;
  label?: string;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? children}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 40,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        justifyContent: "center",
        backgroundColor:
          destructive && primary
            ? c.statusDanger
            : primary
              ? c.accent
              : selected
                ? c.surface2
                : "transparent",
        borderWidth: destructive && !primary ? 1 : 0,
        borderColor: destructive ? c.statusDanger : "transparent",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        style={{
          color: primary
            ? c.accentForeground
            : destructive
              ? c.statusDanger
              : selected
                ? c.foreground
                : c.foregroundMuted,
          fontSize: 13,
          fontWeight: selected || primary || destructive ? "500" : "400",
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
export function Section({
  theme,
  title,
  children,
}: ThemeProps & { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "500",
          letterSpacing: 0.5,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
export function Field({
  theme,
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: ThemeProps & {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground, fontSize: 13 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: c.foreground,
          backgroundColor: c.surface2,
          padding: 12,
          borderRadius: 8,
          fontSize: 14,
          minHeight: multiline ? 100 : 44,
          textAlignVertical: "top",
        }}
      />
    </View>
  );
}
