import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "@/src/api";
import { clearCredentials } from "@/src/auth";
import { AgentAvatar } from "@/src/components/chat/AgentAvatar";
import { NewAgentSheet } from "@/src/components/NewAgentSheet";
import { chatListTime, jobCadence } from "@/src/format";
import {
  useAgents,
  useArchiveAgent,
  useChannels,
  useCreateAgent,
  useJobs,
  useUnarchiveAgent,
  useUnreadCounts
} from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { AgentRecord, ChatSession, JobRecord } from "@/src/types";

// Channels — the redesigned home. Two sections: "Agents" (each agent is
// a DM with its single canonical chat) and "Recurring Jobs" (channels =
// job-derived sessions). A header inbox icon routes to the cross-agent
// Threads Inbox. Tapping an agent resolves its one chat and pushes into
// the chat detail; tapping a channel pushes directly into that session.
export default function ChannelsScreen() {
  const agents = useAgents();
  const channels = useChannels();
  const jobs = useJobs("all");
  const createAgent = useCreateAgent();
  const archiveMutation = useArchiveAgent();
  const unarchiveMutation = useUnarchiveAgent();
  const unreadCountsQuery = useUnreadCounts();
  const unreadCounts = unreadCountsQuery.data ?? {};

  // Index jobs by their delivery channel so each channel row can show the
  // job's schedule + next-run (the design's "Every day · 9:00 AM" / "2h").
  const jobBySessionId = useMemo(() => {
    const map = new Map<string, JobRecord>();
    for (const job of jobs.data ?? []) {
      if (job.chatSessionId) map.set(job.chatSessionId, job);
    }
    return map;
  }, [jobs.data]);

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentError, setNewAgentError] = useState<string | null>(null);
  // Resolving an agent's canonical chat is a network hop; track which
  // agent row is mid-resolve so its tap shows a spinner instead of a
  // dead press. The ref is the actual re-entrancy guard — state alone
  // would re-create openAgent and weaken a synchronous double-tap.
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(null);
  const openingRef = useRef(false);
  // Each home section collapses independently. Agents and Recurring Jobs
  // open by default (the primary content); Archived stays closed — it's a
  // tucked-away dropdown beneath the active agent list.
  const [agentsCollapsed, setAgentsCollapsed] = useState(false);
  const [jobsCollapsed, setJobsCollapsed] = useState(false);
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  const unauthorized =
    agents.error instanceof ApiError && agents.error.status === 401;
  useEffect(() => {
    if (!unauthorized) return;
    // A 401 means the stored token is dead (revoked/expired). Drop it before
    // redirecting so the next cold start goes straight to /setup instead of
    // optimistically routing here, 401-ing, and bouncing — the cold-start flash.
    void clearCredentials();
    router.replace("/setup");
  }, [unauthorized]);

  const agentList = useMemo<AgentRecord[]>(() => agents.data?.agents ?? [], [agents.data]);
  const channelList = channels.data ?? [];
  const defaultAgentId = agents.data?.defaultAgentId;

  // `archivedAt` is a soft-delete marker orthogonal to `status`. Archived
  // agents leave the main "Agents" list and render in their own section, so
  // the main list and its search filter operate on the active set only.
  const activeAgents = useMemo(
    () => agentList.filter((a) => !a.archivedAt),
    [agentList]
  );
  const archivedAgents = useMemo(
    () => agentList.filter((a) => a.archivedAt),
    [agentList]
  );

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activeAgents;
    return activeAgents.filter((a) => a.name.toLowerCase().includes(q));
  }, [activeAgents, query]);

  // Confirm before archiving — it stops the agent and moves it out of the
  // main list. The default agent never reaches here (its row is unswipeable),
  // matching the server guard that refuses to archive it.
  const confirmArchive = useCallback(
    (agent: AgentRecord) => {
      Alert.alert(
        `Archive ${agent.name}?`,
        `${agent.name} will move to your Archived section and stop running.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Archive",
            style: "destructive",
            onPress: () =>
              archiveMutation.mutate(agent.id, {
                onError: (err) =>
                  Alert.alert("Couldn't archive", err.message || "Please try again.")
              })
          }
        ]
      );
    },
    [archiveMutation]
  );

  const restoreAgent = useCallback(
    (agent: AgentRecord) => {
      unarchiveMutation.mutate(agent.id, {
        onError: (err) =>
          Alert.alert("Couldn't restore", err.message || "Please try again.")
      });
    },
    [unarchiveMutation]
  );

  // Open an agent's single chat. The resolver is idempotent server-side;
  // we fetch the session id directly here (rather than via the cached
  // hook) so the push targets the right route even on the first tap.
  const openAgent = useCallback(async (agent: AgentRecord) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpeningAgentId(agent.id);
    try {
      const session = await api<ChatSession>(`/agents/${agent.id}/chat`);
      router.push(`/chat/${session.id}`);
    } catch {
      // A failed resolve is rare (agent just deleted on another device);
      // leave the user on the list rather than pushing a dead route.
    } finally {
      openingRef.current = false;
      setOpeningAgentId(null);
    }
  }, []);

  const onSubmitNewAgent = useCallback(() => {
    const trimmed = newAgentName.trim();
    if (!trimmed) return;
    setNewAgentError(null);
    createAgent.mutate(trimmed, {
      onSuccess: () => {
        setCreateOpen(false);
        setNewAgentName("");
      },
      onError: (err) => setNewAgentError(err.message || "Failed to create agent")
    });
  }, [createAgent, newAgentName]);

  if (unauthorized) return null;

  const refreshing =
    (agents.isFetching && agentList.length > 0) ||
    (channels.isFetching && channelList.length > 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header — brand title left, inbox + compose icons right. The
          inbox icon routes to the cross-agent Threads Inbox. */}
      <View style={styles.header}>
        <Text style={styles.brand}>Gini</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => router.push("/threads/inbox")}
            hitSlop={8}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel="Open threads inbox"
          >
            <Feather name="inbox" size={22} color={theme.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setNewAgentError(null);
              setNewAgentName("");
              setCreateOpen(true);
            }}
            hitSlop={8}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel="New agent"
          >
            <Feather name="edit" size={20} color={theme.text} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchPill}>
          <Feather name="search" size={16} color={theme.placeholder} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search agents"
            placeholderTextColor={theme.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={styles.searchInput}
            accessibilityLabel="Search agents"
          />
        </View>
      </View>

      {agents.isLoading && agentList.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.muted} />
        </View>
      ) : agents.isError && agentList.length === 0 ? (
        // Only commandeer the screen with the error + Retry when there's
        // nothing cached to show. A background poll failure (the 30s
        // refetch) with a populated list keeps rendering the cached agents
        // and chats — the next poll or a pull-to-refresh recovers quietly —
        // rather than blowing a usable list away with a full-screen error.
        <View style={styles.center}>
          <Text style={styles.error}>
            {agents.error instanceof Error ? agents.error.message : "Failed to load agents"}
          </Text>
          <TouchableOpacity onPress={() => agents.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                agents.refetch();
                channels.refetch();
              }}
              tintColor={theme.muted}
            />
          }
        >
          {/* Agents section — collapsible. Active agents render here; the
              Archived dropdown nests beneath them. */}
          <TouchableOpacity
            style={styles.sectionHeader}
            onPress={() => setAgentsCollapsed((v) => !v)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={agentsCollapsed ? "Expand agents" : "Collapse agents"}
          >
            <View style={styles.sectionHeaderLeft}>
              <Feather
                name={agentsCollapsed ? "chevron-right" : "chevron-down"}
                size={16}
                color="#8A8A90"
              />
              <Text style={styles.sectionLabel}>Agents</Text>
            </View>
            <Text style={styles.sectionCount}>{filteredAgents.length}</Text>
          </TouchableOpacity>
          {!agentsCollapsed ? (
            <>
              {filteredAgents.length === 0 ? (
                <Text style={styles.emptySub}>
                  {query.trim() ? `No agents match “${query}”` : "No agents yet"}
                </Text>
              ) : (
                filteredAgents.map((agent) =>
                  // The default agent can't be archived server-side, so it renders
                  // as a plain row — offering a guaranteed-fail swipe would be a
                  // dead affordance.
                  agent.id === defaultAgentId ? (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      opening={openingAgentId === agent.id}
                      onPress={() => void openAgent(agent)}
                    />
                  ) : (
                    <SwipeableAgentRow
                      key={agent.id}
                      agent={agent}
                      opening={openingAgentId === agent.id}
                      onPress={() => void openAgent(agent)}
                      onArchive={confirmArchive}
                    />
                  )
                )
              )}

              {/* Archived dropdown — soft-deleted agents, tucked under the
                  active list and collapsed by default. Rendered only when at
                  least one agent is archived. */}
              {archivedAgents.length > 0 ? (
                <>
                  <TouchableOpacity
                    style={[styles.sectionHeader, styles.archivedHeader]}
                    onPress={() => setArchivedCollapsed((v) => !v)}
                    activeOpacity={0.6}
                    accessibilityRole="button"
                    accessibilityLabel={
                      archivedCollapsed ? "Expand archived" : "Collapse archived"
                    }
                  >
                    <View style={styles.sectionHeaderLeft}>
                      <Feather
                        name={archivedCollapsed ? "chevron-right" : "chevron-down"}
                        size={14}
                        color="#8A8A90"
                      />
                      <Text style={styles.archivedLabel}>Archived</Text>
                    </View>
                    <Text style={styles.sectionCount}>{archivedAgents.length}</Text>
                  </TouchableOpacity>
                  {!archivedCollapsed
                    ? archivedAgents.map((agent) => (
                        <ArchivedAgentRow
                          key={agent.id}
                          agent={agent}
                          restoring={
                            unarchiveMutation.isPending &&
                            unarchiveMutation.variables === agent.id
                          }
                          onRestore={() => restoreAgent(agent)}
                        />
                      ))
                    : null}
                </>
              ) : null}
            </>
          ) : null}

          {/* Recurring Jobs section — collapsible channels. */}
          {channelList.length > 0 ? (
            <>
              <TouchableOpacity
                style={[styles.sectionHeader, styles.jobsHeader]}
                onPress={() => setJobsCollapsed((v) => !v)}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={
                  jobsCollapsed ? "Expand recurring jobs" : "Collapse recurring jobs"
                }
              >
                <View style={styles.sectionHeaderLeft}>
                  <Feather
                    name={jobsCollapsed ? "chevron-right" : "chevron-down"}
                    size={14}
                    color="#8A8A90"
                  />
                  <Text style={styles.sectionLabel}>Recurring Jobs</Text>
                </View>
                <Text style={styles.sectionCount}>{channelList.length}</Text>
              </TouchableOpacity>
              {!jobsCollapsed
                ? channelList.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      job={jobBySessionId.get(channel.id)}
                      unreadCount={unreadCounts[channel.id] ?? 0}
                    />
                  ))
                : null}
            </>
          ) : null}
        </ScrollView>
      )}

      <NewAgentSheet
        visible={createOpen}
        name={newAgentName}
        error={newAgentError}
        creating={createAgent.isPending}
        onChangeName={setNewAgentName}
        onSubmit={onSubmitNewAgent}
        onCancel={() => setCreateOpen(false)}
      />
    </SafeAreaView>
  );
}

function AgentRow({
  agent,
  opening,
  onPress
}: {
  agent: AgentRecord;
  opening: boolean;
  onPress: () => void;
}) {
  // The agent list isn't backed by per-agent last-message previews on
  // this screen (those live on the canonical chat session, which we don't
  // pre-resolve for every row), so the preview line shows the agent's
  // runtime status text as a stable, cheap subtitle. The detail screen
  // surfaces the real conversation once opened.
  const online = agent.status === "ready" || agent.status === "active";
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.agentRow}
      accessibilityRole="button"
      accessibilityLabel={`Open ${agent.name}`}
    >
      <AgentAvatar name={agent.name} size={48} online={online} />
      <View style={styles.agentBody}>
        <View style={styles.agentTop}>
          <Text style={styles.agentName} numberOfLines={1}>
            {agent.name}
          </Text>
          {opening ? <ActivityIndicator size="small" color={theme.muted} /> : null}
        </View>
        <Text style={styles.agentPreview} numberOfLines={1}>
          {agent.model ? `${agent.providerName ?? "model"} · ${agent.model}` : agent.status}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// AgentRow wrapped in a left-swipe-to-archive gesture. A left swipe reveals
// a red Archive action (renderRightActions); tapping it closes the swipeable
// and hands off to the confirm dialog. The default agent skips this wrapper
// (see the list render) since it can't be archived.
function SwipeableAgentRow({
  agent,
  opening,
  onPress,
  onArchive
}: {
  agent: AgentRecord;
  opening: boolean;
  onPress: () => void;
  onArchive: (agent: AgentRecord) => void;
}) {
  const swipeRef = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <TouchableOpacity
          onPress={() => {
            swipeRef.current?.close();
            onArchive(agent);
          }}
          activeOpacity={0.8}
          style={styles.archiveAction}
          accessibilityRole="button"
          accessibilityLabel={`Archive ${agent.name}`}
        >
          <Feather name="archive" size={20} color="#FFFFFF" />
          <Text style={styles.archiveActionLabel}>Archive</Text>
        </TouchableOpacity>
      )}
    >
      <AgentRow agent={agent} opening={opening} onPress={onPress} />
    </ReanimatedSwipeable>
  );
}

// Dimmed archived-agent row: avatar + name + a one-tap Restore control.
// Restore is a direct, no-confirm action (mirrors the web's one-click
// restore); the row stays tappable so the chat history is still reachable.
function ArchivedAgentRow({
  agent,
  restoring,
  onRestore
}: {
  agent: AgentRecord;
  restoring: boolean;
  onRestore: () => void;
}) {
  return (
    <View style={[styles.agentRow, styles.archivedRow]}>
      <AgentAvatar name={agent.name} size={48} online={false} />
      <View style={styles.agentBody}>
        <Text style={styles.agentName} numberOfLines={1}>
          {agent.name}
        </Text>
        <Text style={styles.agentPreview} numberOfLines={1}>
          Archived
        </Text>
      </View>
      <TouchableOpacity
        onPress={onRestore}
        disabled={restoring}
        hitSlop={8}
        style={styles.restoreButton}
        accessibilityRole="button"
        accessibilityLabel={`Restore ${agent.name}`}
      >
        {restoring ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <Feather name="rotate-ccw" size={18} color={theme.accent} />
        )}
      </TouchableOpacity>
    </View>
  );
}

function ChannelRow({
  channel,
  job,
  unreadCount
}: {
  channel: ChatSession;
  job?: JobRecord;
  unreadCount: number;
}) {
  const title = job?.name?.trim() || channel.title?.trim() || "Channel";
  // Prefer the job's schedule (the design's "Every day · 9:00 AM"); fall
  // back to the channel's last-delivery preview when there's no paired
  // job record.
  const schedule =
    job
      ? jobCadence(job)
      : channel.lastMessagePreview?.trim() || channel.summary?.trim() || "Recurring delivery";
  // Next-run time when paired with a job; otherwise the channel's last
  // activity time.
  const time = chatListTime(job?.nextRunAt ?? channel.updatedAt ?? channel.createdAt);
  const isUnread = unreadCount > 0;
  return (
    <TouchableOpacity
      onPress={() => router.push(`/chat/${channel.id}`)}
      activeOpacity={0.7}
      style={styles.channelRow}
      accessibilityRole="button"
      accessibilityLabel={`Open channel ${title}`}
    >
      <View style={styles.channelIcon}>
        <Feather name="clock" size={18} color={theme.placeholder} />
      </View>
      <View style={styles.channelBody}>
        <Text style={styles.channelName} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.channelSchedule}>
          <Feather name="repeat" size={11} color="#B0B0B6" />
          <Text style={styles.channelCadence} numberOfLines={1}>
            {schedule}
          </Text>
        </View>
      </View>
      {isUnread ? (
        <View style={styles.channelBadge}>
          <Text style={styles.channelBadgeText}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </Text>
        </View>
      ) : (
        <Text style={styles.channelNext}>{time}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  brand: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 19
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 18 },
  headerIconButton: { alignItems: "center", justifyContent: "center" },

  searchWrap: { paddingHorizontal: 12, paddingVertical: 10 },
  searchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: theme.searchBg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9
  },
  searchInput: {
    flex: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 15,
    padding: 0
  },

  content: { paddingHorizontal: 16, paddingBottom: 24 },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 12,
    paddingBottom: 8
  },
  jobsHeader: { paddingTop: 18 },
  sectionHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Nested under the active agent list — indented and lighter so it reads as
  // a sub-dropdown of Agents rather than a top-level section.
  archivedHeader: { paddingLeft: 8, paddingTop: 6 },
  sectionLabel: {
    color: "#6A6A70",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 13,
    letterSpacing: 0.3
  },
  archivedLabel: {
    color: "#8A8A90",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12,
    letterSpacing: 0.3
  },
  sectionCount: {
    color: "#B6B6BC",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },

  // Agent row — avatar + name/preview + time/badge.
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  agentBody: { flex: 1, gap: 5 },
  agentTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8
  },
  agentName: {
    flex: 1,
    color: "#0A0A0A",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  agentPreview: {
    color: "#3A3A3A",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 18
  },

  // Left-swipe Archive action revealed behind an active agent row.
  archiveAction: {
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 20
  },
  archiveActionLabel: {
    color: "#FFFFFF",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },

  // Archived agent row — dimmed, with a Restore control on the right.
  archivedRow: { opacity: 0.6 },
  restoreButton: { padding: 8 },

  // Channel row — timer tile + name/schedule + next-run.
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F2F2F2"
  },
  channelIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: "#F2F2F2",
    alignItems: "center",
    justifyContent: "center"
  },
  channelBody: { flex: 1, gap: 2 },
  channelName: {
    color: "#3A3A3A",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  channelSchedule: { flexDirection: "row", alignItems: "center", gap: 5 },
  channelCadence: {
    flex: 1,
    color: theme.placeholder,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  channelNext: {
    color: "#B6B6BC",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  channelBadge: {
    minWidth: 20,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "#2F6BFF",
    alignItems: "center",
    justifyContent: "center"
  },
  channelBadgeText: {
    color: "#FFFFFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 12
  },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  emptySub: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    paddingVertical: 12
  },
  error: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    textAlign: "center"
  },
  retry: { padding: 8 },
  retryText: {
    color: theme.accent,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14
  }
});
