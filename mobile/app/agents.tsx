import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions
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
import { theme } from "@/src/theme";
import type { AgentRecord, ChatSession } from "@/src/types";

// Home screen: a full-width chat list for the currently selected agent.
// The agent picker lives in the native stack header — tapping the title
// opens a Slack-style left-drawer Modal listing every agent. The "+ new
// chat" icon and "Settings" text label share the right side of the
// header.
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
            <View style={styles.headerPlus}>
              <Text style={styles.headerPlusText}>+</Text>
            </View>
          )}
        </TouchableOpacity>
      ) : null}
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

  return (
    <TouchableOpacity
      onPress={() => router.push(`/chat/${session.id}`)}
      activeOpacity={0.7}
      style={styles.chatRow}
    >
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

// Width of the exposed strip on the right side of the screen where the
// previous screen peeks through; tapping this strip dismisses the picker.
// Mirrors Slack's workspace-switcher behavior. Kept small so the picker
// itself has room for the agent list — 40px is enough to read as a
// dismiss target without the panel feeling cramped.
const PICKER_DISMISS_STRIP = 40;
// Slide animation duration in ms. Matches the React Native iOS sheet
// animation feel.
const PICKER_ANIM_DURATION = 220;

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
  // Slack-style left drawer: full-height panel that slides in from the
  // left edge. We drive the slide ourselves with Animated.View so we can
  // reveal a thin strip of the previous screen on the right that doubles
  // as a tap-to-dismiss target — `Modal animationType="slide"` doesn't
  // support horizontal animation directly. The Modal itself uses
  // `animationType="none"` and we control the open/close transitions.
  //
  // `mounted` decouples render lifetime from `visible` so the close
  // animation can run to completion before the Modal unmounts. When
  // `visible` flips true we mount immediately, snap to the off-screen
  // position, then animate to 0. When `visible` flips false we animate
  // back to the off-screen position and only set `mounted=false` once
  // the animation finishes.
  const { width: screenWidth } = useWindowDimensions();
  const panelWidth = Math.max(0, screenWidth - PICKER_DISMISS_STRIP);
  // Initial value is the off-screen position so first-render's slide-in
  // starts from the left edge. The Animated.Value is created once via
  // useRef; subsequent updates flow through setValue / Animated.timing.
  const translateX = useRef(new Animated.Value(-panelWidth)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      // Mount the panel (no-op if already mounted) and slide it in. We
      // snap to the off-screen position first so a re-open from
      // mid-close starts cleanly from the left edge rather than jumping
      // from wherever the close animation paused.
      setMounted(true);
      translateX.setValue(-panelWidth);
      const anim = Animated.timing(translateX, {
        toValue: 0,
        duration: PICKER_ANIM_DURATION,
        useNativeDriver: true
      });
      anim.start();
      return () => {
        anim.stop();
      };
    }
    // Slide out, then unmount on completion. Animating from the current
    // value (which may be 0 or mid-slide) means the close picks up
    // smoothly even if the user dismisses mid-open.
    const anim = Animated.timing(translateX, {
      toValue: -panelWidth,
      duration: PICKER_ANIM_DURATION,
      useNativeDriver: true
    });
    anim.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => {
      anim.stop();
    };
  }, [visible, panelWidth, translateX]);

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.modalRoot}>
        <Animated.View
          style={[
            styles.modalPanel,
            { width: panelWidth, transform: [{ translateX }] }
          ]}
        >
          <SafeAreaView edges={["top", "bottom"]} style={styles.modalSheetInner}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {mode === "list" ? "Agents" : "New agent"}
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
              <>
                <FlatList
                  data={agents}
                  keyExtractor={(a) => a.id}
                  style={styles.pickerList}
                  contentContainerStyle={styles.pickerListContent}
                  renderItem={({ item }) => (
                    <AgentPickerRow
                      agent={item}
                      selected={item.id === selectedAgentId}
                      onPress={() => onPick(item)}
                    />
                  )}
                  ItemSeparatorComponent={PickerRowSpacer}
                />
                <View style={styles.pickerFooterDivider} />
                <NewAgentFooterRow onPress={onStartNewAgent} />
              </>
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
        </Animated.View>
        <Pressable
          onPress={onClose}
          style={[styles.modalDismissStrip, { width: PICKER_DISMISS_STRIP }]}
          accessibilityRole="button"
          accessibilityLabel="Close agent picker"
        />
      </View>
    </Modal>
  );
}

function PickerRowSpacer() {
  return <View style={styles.pickerRowSpacer} />;
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

// The "+ New agent" row mirrors AgentPickerRow's shape (same height,
// padding, and corner radius) so the pinned footer reads as part of the
// same row family — just with an accent color and a leading "+". It sits
// below a divider rather than being part of the FlatList itself, which
// is what keeps it visually anchored to the bottom of the panel.
function NewAgentFooterRow({ onPress }: { onPress: () => void }) {
  return (
    <View style={styles.pickerFooterContainer}>
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
  // WeChat-style circle-plus icon used for "new chat". The thin stroke
  // and matching accent color keep it visually quiet next to the
  // "Settings" text label that still lives in the header.
  headerPlus: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: theme.accent,
    alignItems: "center",
    justifyContent: "center"
  },
  headerPlusText: {
    color: theme.accent,
    fontSize: 18,
    lineHeight: 18,
    fontWeight: "400",
    // Optical centering: the "+" glyph carries slightly more bottom
    // bearing than top in most system fonts, so a tiny negative top
    // margin pulls it into the geometric center of the circle. Without
    // this it visually sits a hair low.
    marginTop: -1
  },

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
  // Separator starts at the row's horizontal padding (16) since rows
  // no longer have a leading avatar column.
  chatRowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginLeft: 16
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

  // Modal — Slack-style left-edge drawer. `modalRoot` lays out the
  // animated panel (full height, almost-full width) and a thin
  // tap-to-dismiss strip on the right that lets the previous screen
  // peek through. The inner SafeAreaView consumes both the top notch
  // inset and the bottom home-indicator inset so neither the title nor
  // the pinned footer collides with system chrome.
  modalRoot: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row"
  },
  modalPanel: {
    height: "100%",
    backgroundColor: theme.bg
  },
  modalDismissStrip: {
    height: "100%"
  },
  modalSheetInner: { flex: 1 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16
  },
  modalTitle: { flex: 1, color: theme.text, fontSize: 28, fontWeight: "700" },
  modalClose: { paddingHorizontal: 4, paddingVertical: 4 },
  modalCloseText: { color: theme.accent, fontSize: 15, fontWeight: "500" },

  // Agent picker rows — tall, breathy rows like Slack's workspace list.
  // Selected row gets a card-like rounded outline + filled background
  // so it reads as the active card without dominating the list. Row
  // text aligns with the title's left edge: header padding 24 ==
  // row marginHorizontal 4 + row paddingHorizontal 20.
  pickerList: { flex: 1 },
  pickerListContent: { paddingVertical: 4 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 18,
    marginHorizontal: 4,
    minHeight: 72,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "transparent"
  },
  pickerRowSelected: {
    backgroundColor: theme.rowSelected,
    borderColor: theme.border
  },
  pickerRowSpacer: { height: 4 },
  pickerBody: { flex: 1, gap: 4 },
  pickerTitle: { color: theme.text, fontSize: 17, fontWeight: "700" },
  pickerSubtitle: { color: theme.subtle, fontSize: 14 },
  pickerFooterDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border
  },
  pickerFooterContainer: { paddingVertical: 4 },
  pickerNewAgentText: { color: theme.accent, fontSize: 17, fontWeight: "600" },

  // New-agent inline form. Sits inside the same full-height panel as
  // the list, so it gets generous top padding to balance the header.
  newAgentForm: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 12 },
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
