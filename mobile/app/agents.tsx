import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
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

// Home screen: a full-width chat list for the currently selected agent.
// The agent picker lives in the native stack header — tapping the title
// opens a slide-up Modal listing every agent. Settings and "+" share the
// right side of the header.
export default function AgentsScreen() {
  const agents = useAgents();
  const useAgent = useUseAgent();

  // Local selection so the chat list flips instantly on tap. Default is
  // seeded from the server's activeAgentId once agents resolve; after
  // that, the user's pick wins — we don't override on poll cycles in
  // case another client switched the server-side active agent.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 401 redirect via effect so all hooks below execute on the
  // unauthorized render (Rules of Hooks).
  const unauthorized =
    agents.error instanceof ApiError && agents.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const data = agents.data;
  const list = useMemo<AgentRecord[]>(() => data?.agents ?? [], [data]);
  const activeAgentId = data?.activeAgentId;

  useEffect(() => {
    if (selectedAgentId) return;
    if (activeAgentId) {
      setSelectedAgentId(activeAgentId);
    } else if (list.length > 0) {
      setSelectedAgentId(list[0]!.id);
    }
  }, [selectedAgentId, activeAgentId, list]);

  const selectedAgent = useMemo(
    () => list.find((a) => a.id === selectedAgentId) ?? null,
    [list, selectedAgentId]
  );

  const onPickAgent = useCallback(
    (agent: AgentRecord) => {
      setSelectedAgentId(agent.id);
      setPickerOpen(false);
      // /use keeps web/CLI in sync with the mobile pick. The chat list
      // is already filtered by ?agentId client-side, so we don't strictly
      // need this for the mobile flow — but matching the other clients
      // avoids confusing cross-device state.
      if (agent.id !== activeAgentId) {
        useAgent.mutate(agent.id);
      }
    },
    [activeAgentId, useAgent]
  );

  // Chat list hooks run unconditionally; they no-op when agentId is
  // null because useChats / useCreateChat are gated on truthy id.
  const agentId = selectedAgent?.id ?? null;
  const chats = useChats(agentId);
  const createChat = useCreateChat(agentId);

  const chatsUnauthorized =
    chats.error instanceof ApiError && chats.error.status === 401;
  useEffect(() => {
    if (chatsUnauthorized) router.replace("/setup");
  }, [chatsUnauthorized]);

  const orderedChats = useMemo<ChatSession[]>(() => {
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

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: () => (
            <HeaderTitle
              agent={selectedAgent}
              hasAgents={list.length > 0}
              loading={agents.isLoading && list.length === 0}
              onPress={() => setPickerOpen(true)}
            />
          ),
          headerRight: () => (
            <HeaderActions
              canCreate={Boolean(agentId)}
              creating={createChat.isPending}
              onCreate={onNewChat}
            />
          )
        }}
      />

      <ChatList
        agents={list}
        agent={selectedAgent}
        chats={orderedChats}
        isAgentsLoading={agents.isLoading}
        isAgentsError={agents.isError}
        agentsError={agents.error}
        onRetryAgents={() => agents.refetch()}
        isChatsLoading={chats.isLoading}
        isChatsError={chats.isError}
        chatsError={chats.error}
        onRetryChats={() => chats.refetch()}
        isChatsFetching={chats.isFetching}
        onNewChat={onNewChat}
        creatingChat={createChat.isPending}
      />

      <AgentPickerModal
        visible={pickerOpen}
        agents={list}
        selectedAgentId={selectedAgentId}
        onPick={onPickAgent}
        onClose={() => setPickerOpen(false)}
      />
    </SafeAreaView>
  );
}

function HeaderTitle({
  agent,
  hasAgents,
  loading,
  onPress
}: {
  agent: AgentRecord | null;
  hasAgents: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const label = agent?.name ?? (loading ? "Loading…" : hasAgents ? "Select agent" : "No agents");
  return (
    <Pressable
      onPress={onPress}
      disabled={!hasAgents}
      hitSlop={8}
      style={({ pressed }) => [
        styles.headerTitle,
        pressed && hasAgents && { opacity: 0.7 }
      ]}
      accessibilityRole="button"
      accessibilityLabel="Switch agent"
    >
      <Text style={styles.headerTitleText} numberOfLines={1}>
        {label}
      </Text>
      {hasAgents ? (
        <Text style={styles.headerChevron}>▾</Text>
      ) : null}
    </Pressable>
  );
}

function HeaderActions({
  canCreate,
  creating,
  onCreate
}: {
  canCreate: boolean;
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <View style={styles.headerActions}>
      {canCreate ? (
        <TouchableOpacity
          onPress={onCreate}
          disabled={creating}
          hitSlop={8}
          style={styles.headerAction}
          accessibilityRole="button"
          accessibilityLabel="New chat"
        >
          {creating ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <Text style={styles.headerPlus}>＋</Text>
          )}
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        onPress={() => router.push("/settings")}
        hitSlop={8}
        style={styles.headerAction}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Text style={styles.headerGlyph}>⚙</Text>
      </TouchableOpacity>
    </View>
  );
}

function ChatList({
  agents,
  agent,
  chats,
  isAgentsLoading,
  isAgentsError,
  agentsError,
  onRetryAgents,
  isChatsLoading,
  isChatsError,
  chatsError,
  onRetryChats,
  isChatsFetching,
  onNewChat,
  creatingChat
}: {
  agents: AgentRecord[];
  agent: AgentRecord | null;
  chats: ChatSession[];
  isAgentsLoading: boolean;
  isAgentsError: boolean;
  agentsError: unknown;
  onRetryAgents: () => void;
  isChatsLoading: boolean;
  isChatsError: boolean;
  chatsError: unknown;
  onRetryChats: () => void;
  isChatsFetching: boolean;
  onNewChat: () => void;
  creatingChat: boolean;
}) {
  if (isAgentsLoading && agents.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.subtle} />
      </View>
    );
  }

  if (isAgentsError) {
    return (
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
    );
  }

  if (agents.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No agents yet</Text>
        <Text style={styles.emptySub}>
          Create one from the web client or `gini agent new`.
        </Text>
      </View>
    );
  }

  if (isChatsLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.subtle} />
      </View>
    );
  }

  if (isChatsError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>
          {chatsError instanceof Error
            ? chatsError.message
            : "Failed to load chats"}
        </Text>
        <TouchableOpacity onPress={onRetryChats} style={styles.retry}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (chats.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No chats yet</Text>
        <TouchableOpacity
          onPress={onNewChat}
          disabled={creatingChat}
          style={[styles.newButton, creatingChat && { opacity: 0.6 }]}
        >
          <Text style={styles.newButtonText}>Start a chat</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      data={chats}
      keyExtractor={(s) => s.id}
      refreshControl={
        <RefreshControl
          refreshing={isChatsFetching && !isChatsLoading}
          onRefresh={onRetryChats}
          tintColor={theme.subtle}
        />
      }
      ItemSeparatorComponent={ChatRowSeparator}
      renderItem={({ item }) => <ChatRow session={item} agent={agent} />}
    />
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

function AgentPickerModal({
  visible,
  agents,
  selectedAgentId,
  onPick,
  onClose
}: {
  visible: boolean;
  agents: AgentRecord[];
  selectedAgentId: string | null;
  onPick: (agent: AgentRecord) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Backdrop closes the sheet on tap; the sheet itself is a sibling
          Pressable so taps inside don't bubble back to the backdrop. */}
      <Pressable
        style={styles.modalBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close agent picker"
      />
      <View style={styles.modalSheet}>
        <SafeAreaView edges={["bottom"]} style={styles.modalSheetInner}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Switch agent</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.modalClose}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={agents}
            keyExtractor={(a) => a.id}
            ItemSeparatorComponent={ChatRowSeparator}
            renderItem={({ item }) => (
              <AgentPickerRow
                agent={item}
                selected={item.id === selectedAgentId}
                onPress={() => onPick(item)}
              />
            )}
          />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function AgentPickerRow({
  agent,
  selected,
  onPress
}: {
  agent: AgentRecord;
  selected: boolean;
  onPress: () => void;
}) {
  // Subtitle prefers provider/model when present and falls back to the
  // status string so the row always has a useful secondary line.
  const subtitleParts: string[] = [];
  if (agent.providerName) subtitleParts.push(agent.providerName);
  if (agent.model) subtitleParts.push(agent.model);
  const subtitle = subtitleParts.join(" · ") || agent.status;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.pickerRow}
      accessibilityRole="button"
      accessibilityLabel={`Select agent ${agent.name}`}
      accessibilityState={{ selected }}
    >
      <View
        style={[
          styles.pickerAvatar,
          { backgroundColor: avatarColor(agent.id) }
        ]}
      >
        <Text style={styles.pickerAvatarText}>{avatarInitial(agent.name)}</Text>
      </View>
      <View style={styles.pickerBody}>
        <Text style={styles.pickerTitle} numberOfLines={1}>
          {agent.name}
        </Text>
        {subtitle ? (
          <Text style={styles.pickerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {selected ? <Text style={styles.pickerCheck}>✓</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },

  // Header.
  headerTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 220
  },
  headerTitleText: {
    color: theme.text,
    fontSize: 17,
    fontWeight: "600",
    flexShrink: 1
  },
  headerChevron: { color: theme.subtle, fontSize: 14 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  headerAction: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center"
  },
  headerPlus: { color: theme.accent, fontSize: 26, fontWeight: "600" },
  headerGlyph: { color: theme.subtle, fontSize: 22 },

  // Chat rows.
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12
  },
  chatRowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginLeft: 16 + 44 + 12 // align with title text, past the avatar
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
  chatRowTopLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  chatRowTitle: { flex: 1, color: theme.text, fontSize: 16, fontWeight: "600" },
  chatRowTime: { color: theme.subtle, fontSize: 12 },
  chatRowSubtitle: { color: theme.subtle, fontSize: 13 },

  // Generic states.
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
  newButtonText: { color: theme.buttonText, fontSize: 15, fontWeight: "600" },

  // Modal — slide-up sheet with a dim backdrop. The sheet itself sits at
  // the bottom and consumes its own safe-area inset so the close row sits
  // above the home indicator on iOS.
  modalBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)"
  },
  modalSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "75%",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border
  },
  modalSheetInner: { paddingBottom: 8 },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.subtle,
    opacity: 0.5,
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 4
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  modalTitle: { flex: 1, color: theme.text, fontSize: 17, fontWeight: "600" },
  modalClose: { paddingHorizontal: 4, paddingVertical: 4 },
  modalCloseText: { color: theme.accent, fontSize: 15, fontWeight: "500" },

  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12
  },
  pickerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center"
  },
  pickerAvatarText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  pickerBody: { flex: 1, gap: 2 },
  pickerTitle: { color: theme.text, fontSize: 16, fontWeight: "600" },
  pickerSubtitle: { color: theme.subtle, fontSize: 13 },
  pickerCheck: { color: theme.accent, fontSize: 20, fontWeight: "600" }
});
