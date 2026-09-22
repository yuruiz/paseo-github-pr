import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, Pressable, TextInput } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import {
  useRpc,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import { snapshot, command } from "../shared/rpc";
import { PollSettings } from "./settings";
import { ReviewForm } from "./review";
import { PRDetail } from "./detail";
import { Action, Field } from "./ui";
import { groupByRepository, inboxRows, matchesFilter, matchesSearch, type Filter } from "./inbox";
const filters: [Filter, string][] = [
  ["attention", "Attention"],
  ["open", "All open"],
  ["review", "Reviews"],
  ["unmapped", "Unmapped"],
  ["history", "History"],
];
export function Dashboard(props: PluginSurfaceProps | PluginWorkspacePanelProps) {
  const get = useRpc(snapshot);
  const act = useRpc(command);
  const [data, setData] = useState<z.output<typeof snapshot.output>>();
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<Filter>("attention");
  const [query, setQuery] = useState("");
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>();
  const [page, setPage] = useState<"inbox" | "review" | "settings">("inbox");
  const [width, setWidth] = useState(0);
  const workspaceId = "workspaceId" in props ? props.workspaceId : undefined;
  const compact = props.layout.compact || (width > 0 && width < 800);
  const refresh = useCallback(async () => {
    try {
      setData(await get({}));
      setLoadError("");
    } catch (e) {
      setLoadError(String(e));
    }
  }, [get]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function execute(input: RpcInput<typeof command>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      setMessage((await act(input)).message);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const c = props.theme.colors;
  const rows = data ? inboxRows(data.state, data.workspaces, workspaceId) : [];
  const filtered = rows.filter((row) => matchesFilter(row, filter) && matchesSearch(row.pr, query));
  const repositories = groupByRepository(filtered);
  const chosen =
    rows.find((row) => row.pr.id === selected) ??
    (workspaceId && selected !== null
      ? rows.find((row) => row.binding?.prId === row.pr.id)
      : undefined);
  const active = chosen ?? (!compact ? repositories[0]?.rows[0] : undefined);
  const notice = error || loadError || data?.error || data?.state.lastError;
  const showList = page === "inbox" && (!compact || !active);
  const showDetail = page !== "inbox" || !!active;
  function select(id: string) {
    setSelected(id);
    setError("");
    setMessage("");
  }
  const body =
    page === "review" ? (
      <NewReview key="new-review" {...props} pending={pending} execute={execute} />
    ) : page === "settings" && data ? (
      <View style={{ gap: 24 }}>
        <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "500" }}>
          Tracking settings
        </Text>
        <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
          Discovery finds your open PRs. Tracking checks existing PRs for changes, even when the app
          is closed.
        </Text>
        <PollSettings
          theme={props.theme}
          config={data.state.config}
          revision={data.state.revision}
          pending={pending}
          execute={execute}
        />
      </View>
    ) : active && data ? (
      <PRDetail
        key={active.pr.id}
        row={active}
        state={data.state}
        workspaces={data.workspaces}
        theme={props.theme}
        pending={pending}
        execute={execute}
        navigation={props.navigation}
        onSelect={select}
      />
    ) : (
      <View style={{ padding: 32, gap: 10 }}>
        <Text style={{ color: c.foreground, fontSize: 18 }}>Select a pull request</Text>
        <Text style={{ color: c.foregroundMuted }}>
          Its status, activity and Workspace will appear here.
        </Text>
      </View>
    );
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}
    >
      <View style={{ paddingHorizontal: compact ? 16 : 24, paddingVertical: 16, gap: 12 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <View style={{ gap: 4 }}>
            <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "500" }}>GitHub PRs</Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {data
                ? `${data.state.account || "GitHub"} · ${data.connected ? "Tracking" : "Disconnected"}${pending ? " · Working…" : ""}`
                : "Connecting…"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 2, flexWrap: "wrap" }}>
            <Action
              theme={props.theme}
              onPress={() => void execute({ action: "refresh" })}
              disabled={pending}
            >
              Refresh
            </Action>
            <Action
              theme={props.theme}
              selected={page === "settings"}
              onPress={() => setPage("settings")}
            >
              Settings
            </Action>
            <Action
              theme={props.theme}
              selected={page === "review"}
              onPress={() => setPage("review")}
            >
              New review
            </Action>
          </View>
        </View>
        {!!notice && (
          <Text
            accessibilityRole="alert"
            selectable
            style={{ color: c.statusDanger, fontSize: 13 }}
          >
            {notice}
          </Text>
        )}
        {!!message && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              accessibilityLiveRegion="polite"
              style={{ flex: 1, color: c.foregroundMuted, fontSize: 13 }}
            >
              {message}
            </Text>
            <Action theme={props.theme} onPress={() => setMessage("")}>
              Dismiss
            </Action>
          </View>
        )}
      </View>
      {!data ? (
        <View style={{ padding: 24 }}>
          <Text style={{ color: c.foregroundMuted }}>
            {loadError
              ? "Unable to load pull requests. Retry with Refresh."
              : "Loading pull requests…"}
          </Text>
        </View>
      ) : (
        <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
          {showList && (
            <View
              style={{
                width: compact ? "100%" : 360,
                flexShrink: 0,
                minHeight: 0,
                backgroundColor: c.surface0,
              }}
            >
              <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 14 }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "500" }}>
                    {filter === "attention"
                      ? "Needs your attention"
                      : filters.find(([key]) => key === filter)?.[1]}
                  </Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{filtered.length}</Text>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2 }}>
                  {filters.map(([id, label]) => (
                    <Action
                      key={id}
                      theme={props.theme}
                      selected={filter === id}
                      label={`${label} filter`}
                      onPress={() => {
                        setFilter(id);
                        setSelected(null);
                      }}
                    >{`${label} ${rows.filter((row) => matchesFilter(row, id)).length}`}</Action>
                  ))}
                </View>
                <TextInput
                  accessibilityLabel="Search pull requests"
                  placeholder="Search PRs or repositories…"
                  placeholderTextColor={c.foregroundMuted}
                  value={query}
                  onChangeText={(value) => {
                    setQuery(value);
                    setSelected(null);
                  }}
                  style={{
                    backgroundColor: c.surface1,
                    color: c.foreground,
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 11,
                    fontSize: 13,
                  }}
                />
              </View>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24, gap: 20 }}
              >
                {repositories.map((repository) => (
                  <View key={repository.id} testID="repository-group" style={{ gap: 8 }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${collapsedRepos.has(repository.id) ? "Expand" : "Collapse"} ${repository.repo}`}
                      accessibilityState={{ expanded: !collapsedRepos.has(repository.id) }}
                      aria-expanded={!collapsedRepos.has(repository.id)}
                      onPress={() =>
                        setCollapsedRepos((current) => {
                          const next = new Set(current);
                          if (next.has(repository.id)) next.delete(repository.id);
                          else next.add(repository.id);
                          return next;
                        })
                      }
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        minHeight: 44,
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                        borderBottomWidth: 1,
                        borderBottomColor: c.border,
                      }}
                    >
                      <Text aria-hidden style={{ color: c.foregroundMuted, fontSize: 12 }}>
                        {collapsedRepos.has(repository.id) ? "▸" : "▾"}
                      </Text>
                      <Text
                        accessibilityRole="header"
                        style={{
                          flex: 1,
                          color: c.foreground,
                          fontSize: 13,
                          fontWeight: "600",
                          lineHeight: 20,
                        }}
                      >
                        {repository.repo}
                      </Text>
                      <Text
                        accessibilityLabel={`${repository.rows.length} pull requests`}
                        style={{ color: c.foregroundMuted, fontSize: 12 }}
                      >
                        {repository.rows.length}
                      </Text>
                    </Pressable>
                    {!collapsedRepos.has(repository.id) &&
                      repository.rows.map((row) => (
                        <Pressable
                          key={row.pr.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${row.pr.repo}#${row.pr.number}`}
                          accessibilityState={{ selected: active?.pr.id === row.pr.id }}
                          onPress={() => select(row.pr.id)}
                          style={{
                            padding: 16,
                            gap: 8,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: active?.pr.id === row.pr.id ? c.accent : c.border,
                            backgroundColor: active?.pr.id === row.pr.id ? c.surface2 : c.surface1,
                          }}
                        >
                          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                            <Text
                              numberOfLines={1}
                              style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}
                            >
                              #{row.pr.number}
                            </Text>
                            <Text
                              style={{
                                color: row.danger
                                  ? c.statusDanger
                                  : row.attention
                                    ? c.accent
                                    : c.foregroundMuted,
                                fontSize: 12,
                              }}
                            >
                              {row.label}
                            </Text>
                          </View>
                          <Text
                            numberOfLines={2}
                            style={{
                              color: c.foreground,
                              fontSize: 14,
                              fontWeight: "500",
                              lineHeight: 21,
                            }}
                          >
                            {row.pr.title}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={{ color: c.foregroundMuted, fontSize: 12 }}
                          >
                            {row.workspace?.name ??
                              (row.binding ? "Workspace unavailable" : "No Workspace")}
                            {row.binding?.role === "review"
                              ? " · Review"
                              : row.binding && row.binding.stack.length > 1
                                ? ` · Stack ${row.binding.stack.indexOf(row.pr.id) + 1}/${row.binding.stack.length}`
                                : ""}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                ))}
                {!filtered.length && (
                  <View style={{ padding: 20, gap: 12 }}>
                    <Text style={{ color: c.foreground, fontSize: 15 }}>
                      {query
                        ? "No matching pull requests"
                        : filter === "attention"
                          ? "You're all caught up"
                          : "No pull requests here"}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, lineHeight: 22 }}>
                      {query
                        ? "Try a title, repository or PR number."
                        : filter === "attention"
                          ? "PRs with new activity, failures or pending approvals will appear here."
                          : "Choose another view to see your tracked PRs."}
                    </Text>
                    {filter !== "open" && (
                      <Action
                        theme={props.theme}
                        onPress={() => {
                          setFilter("open");
                          setQuery("");
                        }}
                      >
                        View all open PRs
                      </Action>
                    )}
                  </View>
                )}
              </ScrollView>
            </View>
          )}
          {(!compact || showDetail) && (
            <View style={{ flex: 1, minWidth: 0, backgroundColor: c.surface1 }}>
              {(compact || page !== "inbox") && (
                <View style={{ paddingHorizontal: 12, paddingTop: 8, alignItems: "flex-start" }}>
                  <Action
                    theme={props.theme}
                    onPress={() => {
                      setSelected(null);
                      setPage("inbox");
                    }}
                  >
                    ← Back to PRs
                  </Action>
                </View>
              )}
              <ScrollView
                key={page === "inbox" ? (active?.pr.id ?? "empty") : page}
                style={{ flex: 1 }}
                contentContainerStyle={{
                  padding: compact ? 20 : 32,
                  width: "100%",
                  maxWidth: 760,
                  alignSelf: "center",
                }}
              >
                {body}
              </ScrollView>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
function NewReview(
  props: Pick<PluginSurfaceProps, "theme"> & {
    pending: boolean;
    execute(input: RpcInput<typeof command>): Promise<void>;
  },
) {
  const [path, setPath] = useState("");
  return (
    <View style={{ gap: 24 }}>
      <Text style={{ color: props.theme.colors.foreground, fontSize: 20, fontWeight: "500" }}>
        New code review
      </Text>
      <Text style={{ color: props.theme.colors.foregroundMuted, lineHeight: 22 }}>
        Review a pull request in a dedicated Workspace. Results stay local until you approve
        publication.
      </Text>
      <Field
        theme={props.theme}
        label="Repository path"
        value={path}
        onChange={setPath}
        placeholder="/example/repository"
      />
      <ReviewForm {...props} repositoryPath={path} />
    </View>
  );
}
