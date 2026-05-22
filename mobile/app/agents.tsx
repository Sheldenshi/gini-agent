import { Link, router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/src/api";
import { relativeTime } from "@/src/format";
import {
  useAgents,
  useChats,
  useCreateChat,
  useUseAgent
} from "@/src/queries";
import { avatarColor, avatarInitial, theme } from "@/src/theme";
import type { AgentRecord, ChatSession } from "@/src/types";

// Combined home screen: vertical agent rail on the left, chat list for
// the selected agent on the right. Mirrors a Telegram-desktop layout but
// scoped to mobile dimensions — the rail stays narrow (64px) so the chat
// column reads as the primary content.
export default function AgentsScreen() {
  const agents = useAgents();
  const useAgent = useUseAgent();

  // The rail's selected agent is local state so taps respond instantly
  // even before the server-side /use POST resolves. Defaults to the
  // server's activeAgentId once the agents query lands. The /use mutation
  // still fires for parity with the other clients (CLI, web).
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // 401 redirect runs from an effect so all hooks below execute on the
  // unauthorized render (Rules of Hooks).
  const unauthorized =
    agents.error instanceof ApiError && agents.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const data = agents.data;
  const list = useMemo<AgentRecord[]>(() => data?.agents ?? [], [data]);
  const activeAgentId = data?.activeAgentId;

  // Seed local selection from the server's active agent on first load,
  // or after the active agent gets created elsewhere. We only sync when
  // the user hasn't picked anything yet — once they do, their pick wins
  // until the next mount.
  useEffect(() => {
    if (selectedAgentId) return;
    if (activeAgentId) {
      setSelectedAgentId(activeAgentId);
    } else if (list.length > 0) {
      setSelectedAgentId(list[0]!.id);
    }
  }, [selectedAgentId, activeAgentId, list]);

  const onPickAgent = useCallback(
    (agent: AgentRecord) => {
      // Update local selection immediately so the chat list switches
      // without waiting for the mutation. The mutation keeps the rest
      // of the system (web client, CLI) in sync — the gateway's GET
      // /api/chat is filtered client-side by ?agentId so the mobile
      // doesn't depend on the server-side active-agent state.
      setSelectedAgentId(agent.id);
      if (agent.id === activeAgentId) return;
      useAgent.mutate(agent.id);
    },
    [activeAgentId, useAgent]
  );

  const selectedAgent = useMemo(
    () => list.find((a) => a.id === selectedAgentId) ?? null,
    [list, selectedAgentId]
  );

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.split}>
        <AgentRail
          agents={list}
          selectedAgentId={selectedAgentId}
          onPick={onPickAgent}
          loading={agents.isLoading}
        />
        <ChatPane
          agent={selectedAgent}
          isAgentsLoading={agents.isLoading}
          isAgentsError={agents.isError}
          agentsError={agents.error}
          onRetryAgents={() => agents.refetch()}
          hasAgents={list.length > 0}
        />
      </View>
    </SafeAreaView>
  );
}

function AgentRail({
  agents,
  selectedAgentId,
  onPick,
  loading
}: {
  agents: AgentRecord[];
  selectedAgentId: string | null;
  onPick: (a: AgentRecord) => void;
  loading: boolean;
}) {
  return (
    <View style={styles.rail}>
      {loading && agents.length === 0 ? (
        <View style={styles.railLoading}>
          <ActivityIndicator color={theme.subtle} />
        </View>
      ) : (
        <FlatList
          style={styles.railList}
          data={agents}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.railListContent}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <AgentAvatar
              agent={item}
              selected={item.id === selectedAgentId}
              onPress={() => onPick(item)}
            />
          )}
        />
      )}

      <View style={styles.railFooter}>
        <Link href="/settings" asChild>
          <TouchableOpacity
            hitSlop={8}
            style={styles.settingsButton}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            {/* Plain unicode glyph — keeps us off any icon font dep. */}
            <Text style={styles.settingsGlyph}>⚙</Text>
          </TouchableOpacity>
        </Link>
      </View>
    </View>
  );
}

function AgentAvatar({
  agent,
  selected,
  onPress
}: {
  agent: AgentRecord;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.avatarWrap}
      accessibilityRole="button"
      accessibilityLabel={`Select agent ${agent.name}`}
      accessibilityState={{ selected }}
    >
      <View
        style={[
          styles.avatarRing,
          selected
            ? { borderColor: theme.accent }
            : { borderColor: "transparent" }
        ]}
      >
        <View
          style={[
            styles.avatar,
            {
              backgroundColor: avatarColor(agent.id),
              opacity: selected ? 1 : 0.85
            }
          ]}
        >
          <Text style={styles.avatarText}>{avatarInitial(agent.name)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function ChatPane({
  agent,
  isAgentsLoading,
  isAgentsError,
  agentsError,
  onRetryAgents,
  hasAgents
}: {
  agent: AgentRecord | null;
  isAgentsLoading: boolean;
  isAgentsError: boolean;
  agentsError: unknown;
  onRetryAgents: () => void;
  hasAgents: boolean;
}) {
  // Hooks for the chat list run unconditionally — they no-op when
  // agent is null because useChats / useCreateChat are gated by the
  // agentId being truthy.
  const agentId = agent?.id ?? null;
  const chats = useChats(agentId);
  const createChat = useCreateChat(agentId);

  // The agents-level 401 check upstairs already redirected; we still
  // guard the chat-list 401 in case the agents call is cached but the
  // chat call rotates the token to 401 first.
  const unauthorized =
    chats.error instanceof ApiError && chats.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const ordered = useMemo<ChatSession[]>(() => {
    const all = chats.data ?? [];
    return [...all].sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
    );
  }, [chats.data]);

  const onNewChat = useCallback(() => {
    if (!agentId) return;
    createChat.mutate(undefined, {
      onSuccess: (session) => {
        router.push(`/chat/${session.id}`);
      }
    });
  }, [agentId, createChat]);

  // Loading the agent list itself takes precedence over the chat list —
  // we don't want to show "No chats" while we're still figuring out
  // which agent to select.
  if (isAgentsLoading && !hasAgents) {
    return (
      <View style={styles.pane}>
        <PaneHeader title="Loading" />
        <View style={styles.center}>
          <ActivityIndicator color={theme.subtle} />
        </View>
      </View>
    );
  }

  if (isAgentsError) {
    return (
      <View style={styles.pane}>
        <PaneHeader title="Agents" />
        <View style={styles.center}>
          <Text style={styles.error}>
            {agentsError instanceof Error
              ? agentsError.message
              : "Failed to load agents"}
          </Text>
          <TouchableOpacity onPress={onRetryAgents} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!hasAgents) {
    return (
      <View style={styles.pane}>
        <PaneHeader title="Agents" />
        <View style={styles.center}>
          <Text style={styles.empty}>No agents yet</Text>
          <Text style={styles.emptySub}>
            Create one from the web client or `gini agent new`.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.pane}>
      <PaneHeader
        title={agent?.name ?? "Chats"}
        right={
          agentId ? (
            <TouchableOpacity
              onPress={onNewChat}
              hitSlop={12}
              disabled={createChat.isPending}
              accessibilityRole="button"
              accessibilityLabel="New chat"
            >
              {createChat.isPending ? (
                <ActivityIndicator color={theme.subtle} />
              ) : (
                <Text style={styles.headerPlus}>＋</Text>
              )}
            </TouchableOpacity>
          ) : null
        }
      />

      {chats.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.subtle} />
        </View>
      ) : chats.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {chats.error instanceof Error
              ? chats.error.message
              : "Failed to load chats"}
          </Text>
          <TouchableOpacity onPress={() => chats.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : ordered.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No chats yet</Text>
          <TouchableOpacity
            onPress={onNewChat}
            disabled={createChat.isPending}
            style={[
              styles.newButton,
              createChat.isPending && { opacity: 0.6 }
            ]}
          >
            <Text style={styles.newButtonText}>Start a chat</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={ordered}
          keyExtractor={(s) => s.id}
          refreshControl={
            <RefreshControl
              refreshing={chats.isFetching && !chats.isLoading}
              onRefresh={() => chats.refetch()}
              tintColor={theme.subtle}
            />
          }
          ItemSeparatorComponent={ChatRowSeparator}
          renderItem={({ item }) => (
            <ChatRow session={item} agent={agent} />
          )}
        />
      )}
    </View>
  );
}

function ChatRowSeparator() {
  return <View style={styles.chatRowSeparator} />;
}

function ChatRow({
  session,
  agent
}: {
  session: ChatSession;
  agent: AgentRecord | null;
}) {
  const title = session.title?.trim() || "New chat";
  // Without a previewable last-message field on the wire, the cleanest
  // secondary line is the agent name (matches Telegram's group-name
  // subtitle convention) — falling back to the session summary if
  // present, which the runtime fills in for some flows.
  const subtitle = session.summary?.trim() || agent?.name || "";
  const time = relativeTime(session.updatedAt ?? session.createdAt);

  return (
    <TouchableOpacity
      onPress={() => router.push(`/chat/${session.id}`)}
      activeOpacity={0.7}
      style={styles.chatRow}
    >
      <View style={styles.chatRowAvatar}>
        {agent ? (
          <View
            style={[
              styles.chatAvatar,
              { backgroundColor: avatarColor(agent.id) }
            ]}
          >
            <Text style={styles.chatAvatarText}>
              {avatarInitial(agent.name)}
            </Text>
          </View>
        ) : (
          <View style={[styles.chatAvatar, { backgroundColor: theme.inputBg }]} />
        )}
      </View>
      <View style={styles.chatRowBody}>
        <View style={styles.chatRowTopLine}>
          <Text style={styles.chatRowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.chatRowTime} numberOfLines={1}>
            {time}
          </Text>
        </View>
        {subtitle ? (
          <Text style={styles.chatRowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function PaneHeader({
  title,
  right
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.paneHeader}>
      <Text style={styles.paneTitle} numberOfLines={1}>
        {title}
      </Text>
      {right ? <View style={styles.paneHeaderRight}>{right}</View> : null}
    </View>
  );
}

const RAIL_WIDTH = 64;
const AVATAR_SIZE = 44;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  split: { flex: 1, flexDirection: "row" },
  rail: {
    width: RAIL_WIDTH,
    backgroundColor: theme.bgRail,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.border
  },
  railLoading: { flex: 1, alignItems: "center", justifyContent: "center" },
  railList: { flex: 1 },
  railListContent: { paddingVertical: 12, gap: 12 },
  railFooter: {
    paddingVertical: 12,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border
  },
  settingsButton: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    alignItems: "center",
    justifyContent: "center"
  },
  settingsGlyph: { color: theme.subtle, fontSize: 24 },
  avatarWrap: { alignItems: "center" },
  // 2px ring around the avatar when selected. Always present at the same
  // size so unselected avatars don't shift position when selection
  // changes.
  avatarRing: {
    width: AVATAR_SIZE + 6,
    height: AVATAR_SIZE + 6,
    borderRadius: (AVATAR_SIZE + 6) / 2,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center"
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: { color: "#FFFFFF", fontSize: 18, fontWeight: "600" },

  pane: { flex: 1, backgroundColor: theme.bg },
  paneHeader: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  paneTitle: { flex: 1, color: theme.text, fontSize: 18, fontWeight: "600" },
  paneHeaderRight: { marginLeft: 8 },
  headerPlus: { color: theme.accent, fontSize: 26, fontWeight: "600" },

  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 12
  },
  chatRowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginLeft: 12 + 44 + 12 // align with title text, past the avatar
  },
  chatRowAvatar: { width: 44 },
  chatAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center"
  },
  chatAvatarText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  chatRowBody: { flex: 1, gap: 2 },
  chatRowTopLine: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8
  },
  chatRowTitle: { flex: 1, color: theme.text, fontSize: 16, fontWeight: "600" },
  chatRowTime: { color: theme.subtle, fontSize: 12 },
  chatRowSubtitle: { color: theme.subtle, fontSize: 13 },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  empty: { color: theme.text, fontSize: 18, fontWeight: "600" },
  emptySub: { color: theme.subtle, fontSize: 14, textAlign: "center" },
  error: { color: theme.danger, fontSize: 14, textAlign: "center" },
  retry: { padding: 8 },
  retryText: { color: theme.accent, fontSize: 14 },
  newButton: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: theme.accent
  },
  newButtonText: { color: theme.buttonText, fontSize: 15, fontWeight: "600" }
});
