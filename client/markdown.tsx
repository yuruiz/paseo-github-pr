import { useMemo, useState, useEffect, type ReactNode } from "react";
import { Image, Linking, Text, View, type TextStyle } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { lexer, type Token, type MarkedToken, type Tokens } from "marked";
import { decodeHTML } from "entities";
import { markdownTarget, type MarkdownContext } from "./markdown-links";
export function Markdown({
  body,
  theme,
  context,
}: {
  body: string;
  theme: PluginTheme;
  context: MarkdownContext;
}) {
  const tokens = useMemo(() => lexer(body, { gfm: true, breaks: true }), [body]);
  const [error, setError] = useState("");
  const c = theme.colors;
  const text: TextStyle = { color: c.foreground, fontSize: 14, lineHeight: 23 };
  function open(url: string) {
    setError("");
    void Linking.openURL(url).catch((reason: unknown) =>
      setError(`Could not open link: ${String(reason)}`),
    );
  }
  function inline(list: Token[]): ReactNode[] {
    return list.map((source, i) => {
      // This lexer has no extensions; all tokens are Marked's built-in token types.
      const token = source as MarkedToken;
      switch (token.type) {
        case "strong":
          return (
            <Text key={i} style={{ fontWeight: "700" }}>
              {inline(token.tokens)}
            </Text>
          );
        case "em":
          return (
            <Text key={i} style={{ fontStyle: "italic" }}>
              {inline(token.tokens)}
            </Text>
          );
        case "del":
          return (
            <Text key={i} style={{ textDecorationLine: "line-through" }}>
              {inline(token.tokens)}
            </Text>
          );
        case "codespan":
          return (
            <Text key={i} style={{ fontFamily: "monospace", backgroundColor: c.surface2 }}>
              {token.text}
            </Text>
          );
        case "br":
          return "\n";
        case "link": {
          const url = markdownTarget(token.href, context);
          return url ? (
            <Text
              key={i}
              accessibilityRole="link"
              accessibilityLabel={decodeHTML(token.text)}
              onPress={() => open(url)}
              style={{ color: c.accent, textDecorationLine: "underline" }}
            >
              {inline(token.tokens)}
            </Text>
          ) : (
            <Text key={i}>{inline(token.tokens)}</Text>
          );
        }
        case "image": {
          const url = markdownTarget(token.href, context, true);
          return url ? (
            <Text
              key={i}
              accessibilityRole="link"
              onPress={() => open(url)}
              style={{ color: c.accent }}
            >
              {token.text || "Image"} ↗
            </Text>
          ) : (
            token.text
          );
        }
        case "text":
          return token.tokens ? (
            <Text key={i}>{inline(token.tokens)}</Text>
          ) : (
            decodeHTML(token.text)
          );
        case "escape":
          return token.text;
        case "html":
          return token.text.replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?\s*>/gi, "\n");
        default:
          return token.raw;
      }
    });
  }
  function paragraph(token: Tokens.Paragraph | Tokens.Text, key: number) {
    // Images need a block layout in React Native; split them out of the surrounding text.
    const groups: ReactNode[] = [];
    let run: Token[] = [];
    function flush() {
      if (run.length) {
        groups.push(
          <Text key={groups.length} selectable style={text}>
            {inline(run)}
          </Text>,
        );
        run = [];
      }
    }
    for (const child of token.tokens ?? [{ type: "text", raw: token.text, text: token.text }]) {
      if (child.type === "image") {
        flush();
        const image = child as Tokens.Image;
        const uri = markdownTarget(image.href, context, true);
        groups.push(
          <MarkdownImage
            key={`${groups.length}:${uri}`}
            uri={uri}
            alt={decodeHTML(image.text)}
            theme={theme}
          />,
        );
      } else run.push(child);
    }
    flush();
    return (
      <View key={key} style={{ gap: 8 }}>
        {groups}
      </View>
    );
  }
  function blocks(list: Token[]): ReactNode[] {
    return list.map((source, i) => {
      const token = source as MarkedToken;
      switch (token.type) {
        case "space":
        case "checkbox":
        case "def":
          return null;
        case "heading":
          return (
            <Text
              key={i}
              accessibilityRole="header"
              aria-level={token.depth}
              selectable
              style={{
                ...text,
                fontSize: token.depth === 1 ? 24 : token.depth === 2 ? 20 : 16,
                lineHeight: token.depth < 3 ? 30 : 24,
                fontWeight: "600",
                marginTop: 8,
              }}
            >
              {inline(token.tokens)}
            </Text>
          );
        case "paragraph":
        case "text":
          return paragraph(token, i);
        case "code":
          return (
            <View
              key={i}
              style={{ gap: 6, borderRadius: 8, backgroundColor: c.surface0, overflow: "hidden" }}
            >
              {!!token.lang && (
                <Text
                  style={{
                    color: c.foregroundMuted,
                    fontSize: 12,
                    paddingTop: 10,
                    paddingHorizontal: 12,
                  }}
                >
                  {token.lang}
                </Text>
              )}
              <ScrollView
                testID="markdown-code"
                horizontal
                style={{ flexGrow: 0, maxWidth: "100%" }}
                contentContainerStyle={{ padding: 12 }}
              >
                <Text
                  selectable
                  style={{ ...text, fontFamily: "monospace", fontSize: 13, lineHeight: 21 }}
                >
                  {token.text}
                </Text>
              </ScrollView>
            </View>
          );
        case "blockquote":
          return (
            <View
              key={i}
              style={{
                borderLeftWidth: 3,
                borderLeftColor: c.foregroundMuted,
                paddingLeft: 14,
                gap: 10,
              }}
            >
              {blocks(token.tokens)}
            </View>
          );
        case "list":
          return (
            <View key={i} style={{ gap: 6 }}>
              {token.items.map((item, index) => (
                <View key={index} style={{ flexDirection: "row", gap: 10 }}>
                  <Text
                    accessibilityRole={item.task ? "checkbox" : "text"}
                    aria-checked={item.task ? !!item.checked : undefined}
                    aria-disabled={item.task ? true : undefined}
                    accessibilityState={
                      item.task ? { checked: !!item.checked, disabled: true } : undefined
                    }
                    style={{
                      ...text,
                      color: item.task && item.checked ? c.accent : c.foregroundMuted,
                      minWidth: 20,
                    }}
                  >
                    {item.task
                      ? item.checked
                        ? "☑"
                        : "☐"
                      : token.ordered
                        ? `${Number(token.start) + index}.`
                        : "•"}
                  </Text>
                  <View style={{ flex: 1, minWidth: 0, gap: 8 }}>{blocks(item.tokens)}</View>
                </View>
              ))}
            </View>
          );
        case "table":
          return (
            <ScrollView
              key={i}
              testID="markdown-table"
              horizontal
              style={{ flexGrow: 0, maxWidth: "100%" }}
            >
              <View
                style={{
                  borderWidth: 1,
                  borderColor: c.surface2,
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                {[token.header, ...token.rows].map((row, index) => (
                  <View
                    key={index}
                    style={{
                      flexDirection: "row",
                      backgroundColor:
                        index === 0 ? c.surface2 : index % 2 ? c.surface0 : c.surface1,
                    }}
                  >
                    {row.map((cell, col) => (
                      <View key={col} style={{ width: 180, padding: 12 }}>
                        <Text
                          selectable
                          style={{
                            ...text,
                            fontWeight: index === 0 ? "600" : "400",
                            textAlign: token.align[col] ?? "left",
                          }}
                        >
                          {inline(cell.tokens)}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
        case "hr":
          return (
            <View key={i} style={{ height: 1, backgroundColor: c.surface2, marginVertical: 4 }} />
          );
        case "html": {
          const raw = token.text.replace(/<!--[\s\S]*?-->/g, "").trim();
          return raw ? (
            <Text key={i} selectable style={text}>
              {raw}
            </Text>
          ) : null;
        }
        default:
          return (
            <Text key={i} selectable style={text}>
              {inline([token])}
            </Text>
          );
      }
    });
  }
  return (
    <View style={{ gap: 12, minWidth: 0 }} testID="markdown-description">
      {blocks(tokens)}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
          {error}
        </Text>
      )}
    </View>
  );
}
function MarkdownImage({ uri, alt, theme }: { uri?: string; alt: string; theme: PluginTheme }) {
  const [ratio, setRatio] = useState(16 / 9);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (uri)
      Image.getSize(
        uri,
        (width, height) => {
          if (active && width > 0 && height > 0) setRatio(width / height);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, [uri]);
  if (!uri || failed)
    return (
      <Text selectable style={{ color: theme.colors.foregroundMuted }}>
        {alt || "Image unavailable"}
      </Text>
    );
  return (
    <Image
      accessible
      accessibilityLabel={alt || "PR image"}
      source={{ uri }}
      resizeMode="contain"
      onError={() => setFailed(true)}
      style={{ width: "100%", aspectRatio: ratio, maxHeight: 480 }}
    />
  );
}
