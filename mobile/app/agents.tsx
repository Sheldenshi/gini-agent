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
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/src/api";
import { relativeTime } from "@/src/format";
import {
  useAgents,
  useChats,
  useCreateAgent,
  useCreateChat,
  useUseAgent
} from "@/src/queries";
import { avatarColor, avatarInitial, theme } from "@/src/theme";
import type { AgentRecord, ChatSession } from "@/src/types";

// Home screen: a full-width chat list for the currently selected agent.
// The agent picker lives in the native stack header — tapping the title
// opens a slide-up Modal listing every agent. The "New" and "Settings"
// text actions share the right side of the header.
export default function AgentsScreen() {
  const agents = useAgents();
  const useAgent = useUseAgent();
  const createAgent = useCreateAgent();

  // Local selection so the chat list flips instantly on tap. Default is
  // seeded from the server's activeAgentId once agents resolve; after
  // that, the user's pick wins — we don't override on poll cycles in
  // case another client switched the server-side active agent.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The picker either shows the agent list or, after the user taps "+
  // New agent", an inline name-entry form. Resets to "list" on close.
  const [pickerMode, setPickerMode] = useState<"list" | "create">("list");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentError, setNewAgentError] = useState<string | null>(null);

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

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    // Reset the inner form on close so re-opening lands back on the
    // agent list instead of leaving the user mid-create.
    setPickerMode("list");
    setNewAgentName("");
    setNewAgentError(null);
  }, []);

  const onStartNewAgent = useCallback(() => {
    setNewAgentError(null);
    setNewAgentName("");
    setPickerMode("create");
  }, []);

  const onCancelNewAgent = useCallback(() => {
    setPickerMode("list");
    setNewAgentName("");
    setNewAgentError(null);
  }, []);

  const onSubmitNewAgent = useCallback(() => {
    const trimmed = newAgentName.trim();
    if (!trimmed) return;
    setNewAgentError(null);
    createAgent.mutate(trimmed, {
      onSuccess: (created) => {
        // Pivot selection to the new agent so the chat list reloads
        // against it, and keep the runtime's active-agent state in
        // sync (matches what tapping an existing row does).
        setSelectedAgentId(created.id);
        useAgent.mutate(created.id);
        closePicker();
      },
      onError: (err) => {
        setNewAgentError(err.message || "Failed to create agent");
      }
    });
  }, [closePicker, createAgent, newAgentName, useAgent]);

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
        mode={pickerMode}
        newAgentName={newAgentName}
        newAgentError={newAgentError}
        creating={createAgent.isPending}
        onPick={onPickAgent}
        onStartNewAgent={onStartNewAgent}
        onChangeNewAgentName={setNewAgentName}
        onSubmitNewAgent={onSubmitNewAgent}
        onCancelNewAgent={onCancelNewAgent}
        onClose={closePicker}
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
            <Text style={styles.headerActionText}>New</Text>
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
        <Text style={styles.headerActionText}>Settings</Text>
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
  // Hooks run unconditionally so the loading / error / empty branches
  // below don't break Rules of Hooks. Filter is empty by default; we
  // fall back to "New chat" for untitled sessions so empty-title rows
  // remain reachable via search.
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((s) => {
      const t = (s.title?.trim() || "New chat").toLowerCase();
      return t.includes(q);
    });
  }, [chats, query]);

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
    <View style={{ flex: 1 }}>
      <View style={styles.searchBarContainer}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={theme.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={styles.searchBarInput}
          accessibilityLabel="Search chats"
        />
      </View>
      <FlatList
        data={filtered}
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
        ListEmptyComponent={
          query.trim() ? (
            <View style={styles.searchEmpty}>
              <Text style={styles.emptySub}>No chats match “{query}”</Text>
            </View>
          ) : null
        }
      />
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
  const initial = avatarInitial(title);
  const bg = avatarColor(session.id);

  return (
    <TouchableOpacity
      onPress={() => router.push(`/chat/${session.id}`)}
      activeOpacity={0.7}
      style={styles.chatRow}
    >
      <View style={[styles.chatRowAvatar, { backgroundColor: bg }]}>
        <Text style={styles.chatRowAvatarText}>{initial}</Text>
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
  mode,
  newAgentName,
  newAgentError,
  creating,
  onPick,
  onStartNewAgent,
  onChangeNewAgentName,
  onSubmitNewAgent,
  onCancelNewAgent,
  onClose
}: {
  visible: boolean;
  agents: AgentRecord[];
  selectedAgentId: string | null;
  mode: "list" | "create";
  newAgentName: string;
  newAgentError: string | null;
  creating: boolean;
  onPick: (agent: AgentRecord) => void;
  onStartNewAgent: () => void;
  onChangeNewAgentName: (value: string) => void;
  onSubmitNewAgent: () => void;
  onCancelNewAgent: () => void;
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
            <Text style={styles.modalTitle}>
              {mode === "list" ? "Switch agent" : "New agent"}
            </Text>
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
          {mode === "list" ? (
            <FlatList
              data={agents}
              keyExtractor={(a) => a.id}
              renderItem={({ item }) => (
                <AgentPickerRow
                  agent={item}
                  selected={item.id === selectedAgentId}
                  onPress={() => onPick(item)}
                />
              )}
              ListFooterComponent={
                <NewAgentFooterRow onPress={onStartNewAgent} />
              }
            />
          ) : (
            <NewAgentForm
              name={newAgentName}
              error={newAgentError}
              creating={creating}
              onChangeName={onChangeNewAgentName}
              onSubmit={onSubmitNewAgent}
              onCancel={onCancelNewAgent}
            />
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function NewAgentForm({
  name,
  error,
  creating,
  onChangeName,
  onSubmit,
  onCancel
}: {
  name: string;
  error: string | null;
  creating: boolean;
  onChangeName: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const trimmed = name.trim();
  const submitDisabled = creating || trimmed.length === 0;
  return (
    <View style={styles.newAgentForm}>
      <TextInput
        value={name}
        onChangeText={onChangeName}
        placeholder="Agent name"
        placeholderTextColor={theme.subtle}
        autoFocus
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => {
          if (!submitDisabled) onSubmit();
        }}
        editable={!creating}
        style={styles.newAgentInput}
        accessibilityLabel="Agent name"
      />
      {error ? (
        <Text style={styles.newAgentError}>{error}</Text>
      ) : null}
      <View style={styles.newAgentActions}>
        <TouchableOpacity
          onPress={onCancel}
          disabled={creating}
          style={[
            styles.newAgentButton,
            styles.newAgentCancel,
            creating && styles.newAgentButtonDisabled
          ]}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={styles.newAgentCancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onSubmit}
          disabled={submitDisabled}
          style={[
            styles.newAgentButton,
            styles.newAgentSubmit,
            submitDisabled && styles.newAgentButtonDisabled
          ]}
          accessibilityRole="button"
          accessibilityLabel="Create agent"
        >
          {creating ? (
            <ActivityIndicator color={theme.buttonText} />
          ) : (
            <Text style={styles.newAgentSubmitText}>Create</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
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
      style={[styles.pickerRow, selected && styles.pickerRowSelected]}
      accessibilityRole="button"
      accessibilityLabel={`Select agent ${agent.name}`}
      accessibilityState={{ selected }}
    >
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
    </TouchableOpacity>
  );
}

function NewAgentFooterRow({ onPress }: { onPress: () => void }) {
  return (
    <View>
      <View style={styles.pickerFooterDivider} />
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={styles.pickerRow}
        accessibilityRole="button"
        accessibilityLabel="Create new agent"
      >
        <Text style={styles.pickerNewAgentText}>+ New agent</Text>
      </TouchableOpacity>
    </View>
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
    height: 36,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  headerActionText: { color: theme.accent, fontSize: 15, fontWeight: "500" },

  // Search bar — pill-shaped TextInput above the chat list.
  searchBarContainer: { paddingHorizontal: 12, paddingVertical: 8 },
  searchBarInput: {
    backgroundColor: theme.inputBg,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12
  },
  searchEmpty: { padding: 24, alignItems: "center" },

  // Chat rows.
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12
  },
  // Separator starts at the title's left edge so the avatar column
  // stays uninterrupted: 16 (row padding) + 48 (avatar) + 12 (gap).
  chatRowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginLeft: 76
  },
  chatRowAvatar: {
    width: 48,
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  chatRowAvatarText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700"
  },
  chatRowBody: { flex: 1, gap: 2 },
  chatRowTopLine: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  chatRowTitle: { flex: 1, color: theme.text, fontSize: 16, fontWeight: "700" },
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
    minHeight: 64
  },
  pickerRowSelected: { backgroundColor: theme.rowSelected },
  pickerBody: { flex: 1, gap: 2 },
  pickerTitle: { color: theme.text, fontSize: 16, fontWeight: "700" },
  pickerSubtitle: { color: theme.subtle, fontSize: 13 },
  pickerFooterDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border
  },
  pickerNewAgentText: { color: theme.accent, fontSize: 16, fontWeight: "600" },

  // New-agent inline form.
  newAgentForm: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 12 },
  newAgentInput: {
    backgroundColor: theme.inputBg,
    color: theme.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10
  },
  newAgentError: { color: theme.danger, fontSize: 13 },
  newAgentActions: { flexDirection: "row", gap: 8 },
  newAgentButton: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  newAgentCancel: { backgroundColor: theme.inputBg },
  newAgentCancelText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  newAgentSubmit: { backgroundColor: theme.button },
  newAgentSubmitText: { color: theme.buttonText, fontSize: 15, fontWeight: "600" },
  newAgentButtonDisabled: { opacity: 0.5 }
});
