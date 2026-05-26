import { Feather } from "@expo/vector-icons";
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
import { chatListTime } from "@/src/format";
import {
  useAgents,
  useChats,
  useCreateAgent,
  useCreateChat,
  useUseAgent
} from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { AgentRecord, ChatSession } from "@/src/types";

// Home screen: a full-width chat list for the currently selected agent.
// The header carries a hamburger button (drawer toggle), a centered
// agent-name title, and a "+" button that creates a new chat. The agent
// drawer slides in from the left and follows the iOS card layout —
// selected agent is a white card with a blue stripe + check, others are
// plain text rows. Footer pins a "+ New Agent" row above a divider.
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
  // New Agent", an inline name-entry form. Resets to "list" on close.
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

  const headerTitle =
    selectedAgent?.name ??
    (agents.isLoading && list.length === 0
      ? "Loading…"
      : list.length > 0
        ? "Select agent"
        : "No agents");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      {/* The native stack header is hidden via _layout.tsx so we draw
          our own header row here. This lets the menu icon, centered
          title, and plus icon sit at the exact tappable sizes the
          design calls for without fighting React Navigation's defaults. */}
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => setPickerOpen(true)}
          disabled={list.length === 0}
          hitSlop={8}
          style={styles.headerIconButton}
          accessibilityRole="button"
          accessibilityLabel="Open agent drawer"
        >
          <Feather name="menu" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {headerTitle}
        </Text>
        <TouchableOpacity
          onPress={onNewChat}
          disabled={!agentId || createChat.isPending}
          hitSlop={8}
          style={styles.headerIconButton}
          accessibilityRole="button"
          accessibilityLabel="New chat"
        >
          {createChat.isPending ? (
            <ActivityIndicator color={theme.text} />
          ) : (
            <Feather name="plus" size={22} color={theme.text} />
          )}
        </TouchableOpacity>
      </View>

      <ChatList
        agents={list}
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

function ChatList({
  agents,
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
  // User-initiated pull-to-refresh state. `isChatsFetching` from React
  // Query also flips during the 3s background poll, so binding the
  // RefreshControl to it directly makes the spinner pop at the top of
  // the list on every poll tick — looks like the chat is "pulling down"
  // by itself. Track the user's gesture separately and clear it when
  // the in-flight fetch settles.
  const [pulling, setPulling] = useState(false);
  useEffect(() => {
    if (pulling && !isChatsFetching) setPulling(false);
  }, [pulling, isChatsFetching]);
  const onPullToRefresh = useCallback(() => {
    setPulling(true);
    onRetryChats();
  }, [onRetryChats]);
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
        <ActivityIndicator color={theme.muted} />
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
        <ActivityIndicator color={theme.muted} />
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

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <View style={styles.searchPill}>
          <Feather name="search" size={16} color={theme.placeholder} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={styles.searchInput}
            accessibilityLabel="Search chats"
          />
        </View>
      </View>
      {chats.length === 0 ? (
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
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.chatListContent}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={onPullToRefresh}
              tintColor={theme.muted}
            />
          }
          renderItem={({ item }) => <ChatRow session={item} />}
          ListEmptyComponent={
            query.trim() ? (
              <View style={styles.searchEmpty}>
                <Text style={styles.emptySub}>No chats match “{query}”</Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

function ChatRow({ session }: { session: ChatSession }) {
  const title = session.title?.trim() || "New chat";
  // Excerpt: the server-supplied `lastMessagePreview` is the latest
  // user_text / assistant_text content for the session (already
  // truncated runtime-side). Falls back to the older summary field
  // for legacy sessions that predate the protocol.
  const subtitle =
    session.lastMessagePreview?.trim() || session.summary?.trim() || "";
  const time = chatListTime(session.updatedAt ?? session.createdAt);

  return (
    <TouchableOpacity
      onPress={() => router.push(`/chat/${session.id}`)}
      activeOpacity={0.7}
      style={styles.chatRow}
    >
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
// Max panel width per the design — narrower phones clamp to
// (screenWidth - DISMISS_STRIP), wider devices cap at 360 so the panel
// doesn't stretch across an iPad in landscape.
const PICKER_MAX_WIDTH = 360;

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
  // Slide animation driven by Animated.Value so we can reveal a thin
  // strip of the previous screen on the right that doubles as a
  // tap-to-dismiss target. The Modal itself uses `animationType="none"`
  // and we control the open/close transitions ourselves.
  //
  // `mounted` decouples render lifetime from `visible` so the close
  // animation can run to completion before the Modal unmounts.
  const { width: screenWidth } = useWindowDimensions();
  const panelWidth = Math.max(
    0,
    Math.min(PICKER_MAX_WIDTH, screenWidth - PICKER_DISMISS_STRIP)
  );
  const translateX = useRef(new Animated.Value(-panelWidth)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
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
            {mode === "list" ? (
              <>
                <View style={styles.drawerHeader}>
                  <Text style={styles.drawerTitle}>Agents</Text>
                  {/* Gear icon takes the user to the settings screen.
                      The Pencil reference doesn't show it, but Settings
                      has to live somewhere reachable — the drawer title
                      row is the iOS-conventional spot for a sidebar's
                      meta entry. */}
                  <TouchableOpacity
                    onPress={() => {
                      onClose();
                      router.push("/settings");
                    }}
                    hitSlop={8}
                    style={styles.drawerHeaderAction}
                    accessibilityRole="button"
                    accessibilityLabel="Open settings"
                  >
                    <Feather name="settings" size={22} color={theme.mutedIcon} />
                  </TouchableOpacity>
                </View>
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
                <View style={styles.drawerFooter}>
                  <View style={styles.drawerFooterDivider} />
                  <NewAgentFooterRow onPress={onStartNewAgent} />
                </View>
              </>
            ) : (
              <>
                <View style={styles.drawerHeader}>
                  <Text style={styles.drawerTitle}>New agent</Text>
                </View>
                <NewAgentForm
                  name={newAgentName}
                  error={newAgentError}
                  creating={creating}
                  onChangeName={onChangeNewAgentName}
                  onSubmit={onSubmitNewAgent}
                  onCancel={onCancelNewAgent}
                />
              </>
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
        placeholderTextColor={theme.placeholder}
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
      {error ? <Text style={styles.newAgentError}>{error}</Text> : null}
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
  // Selected row gets the white card treatment: rounded background, a
  // 4px blue stripe on the left (drawn with a `View` rather than a
  // border so it sits flush with the card's rounded edge), and a small
  // check icon on the right. Other rows are plain — just text aligned
  // to the card's leftmost text position.
  if (selected) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        style={styles.pickerCardWrap}
        accessibilityRole="button"
        accessibilityLabel={`Selected: ${agent.name}`}
        accessibilityState={{ selected: true }}
      >
        <View style={styles.pickerCard}>
          <View style={styles.pickerCardStripe} />
          <Text style={styles.pickerCardName} numberOfLines={1}>
            {agent.name}
          </Text>
          <Feather
            name="check-circle"
            size={20}
            color={theme.accent}
            style={styles.pickerCardCheck}
          />
        </View>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.pickerPlainRow}
      accessibilityRole="button"
      accessibilityLabel={`Select agent ${agent.name}`}
    >
      <Text style={styles.pickerPlainName} numberOfLines={1}>
        {agent.name}
      </Text>
    </TouchableOpacity>
  );
}

// "+ New Agent" footer row. Sits below a horizontal rule so it reads as
// an action distinct from the agent list rather than a list row itself.
// Mirrors the design: leading `plus` icon, label in the drawer's
// secondary text color.
function NewAgentFooterRow({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.drawerFooterRow}
      accessibilityRole="button"
      accessibilityLabel="Create new agent"
    >
      <Feather name="plus" size={20} color={theme.mutedIcon} />
      <Text style={styles.drawerFooterText}>New Agent</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },

  // Header — hamburger / centered title / plus. The title is `flex: 1`
  // with `textAlign: "center"` so it stays visually centered even though
  // the icon containers on either side aren't guaranteed to be equal
  // width.
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  headerIconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center"
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 19
  },

  // Search pill — slate-gray rounded pill with a leading search icon
  // and a transparent TextInput.
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
  searchEmpty: { padding: 24, alignItems: "center" },

  // Chat rows. Title + day/time on the top line, single-line subtitle
  // below. Bottom border on each row matches the design's hairline
  // dividers.
  chatListContent: { paddingHorizontal: 16, paddingTop: 4 },
  chatRow: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    gap: 6
  },
  chatRowTopLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  chatRowTitle: {
    flex: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 18
  },
  chatRowTime: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  chatRowSubtitle: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    lineHeight: 18
  },

  // Generic states.
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12
  },
  empty: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 18
  },
  emptySub: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    textAlign: "center"
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
  },
  newButton: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: theme.accent
  },
  newButtonText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },

  // Modal — left-edge drawer over a tap-to-dismiss strip.
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
    backgroundColor: theme.bgDrawer,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
    // Subtle drop shadow on the right edge of the panel so the
    // tap-to-dismiss strip reads as another layer rather than a flat
    // continuation of the panel.
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 8
  },
  modalDismissStrip: { height: "100%" },
  modalSheetInner: { flex: 1, paddingHorizontal: 20 },

  // Drawer header — large "Agents" title flush left, gear icon on the
  // right. Generous top padding so it clears the status bar even on a
  // notched device.
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 24,
    paddingBottom: 24
  },
  drawerTitle: {
    flex: 1,
    color: theme.textDrawer,
    fontFamily: family("Inter", 700),
    fontSize: 34
  },
  drawerHeaderAction: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center"
  },

  // Agent list.
  pickerList: { flex: 1 },
  pickerListContent: { paddingBottom: 16 },
  pickerRowSpacer: { height: 6 },

  // Selected agent card.
  pickerCardWrap: {
    // Outer wrap holds the iOS-style drop shadow so it isn't clipped by
    // the card's own overflow.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2
  },
  pickerCard: {
    backgroundColor: theme.bg,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    paddingLeft: 16 + 4, // leave room for the 4px stripe inside
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden"
  },
  pickerCardStripe: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: theme.accent
  },
  pickerCardName: {
    flex: 1,
    color: theme.textDrawer,
    fontFamily: family("Inter", 500),
    fontSize: 17
  },
  pickerCardCheck: { marginLeft: 8 },

  // Plain (non-selected) row.
  pickerPlainRow: {
    paddingVertical: 16,
    paddingHorizontal: 20
  },
  pickerPlainName: {
    color: theme.textDrawer,
    fontFamily: family("Inter", 500),
    fontSize: 17
  },

  // Drawer footer.
  drawerFooter: { paddingBottom: 8 },
  drawerFooterDivider: {
    height: 1,
    backgroundColor: theme.borderStrong,
    marginBottom: 8
  },
  drawerFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 18
  },
  drawerFooterText: {
    color: theme.mutedFooter,
    fontFamily: family("Inter", 500),
    fontSize: 17
  },

  // New-agent inline form. Generous top padding to balance the title.
  newAgentForm: { paddingTop: 8, paddingBottom: 24, gap: 12 },
  newAgentInput: {
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.inputBorder
  },
  newAgentError: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13
  },
  newAgentActions: { flexDirection: "row", gap: 8 },
  newAgentButton: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  newAgentCancel: { backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.inputBorder },
  newAgentCancelText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  newAgentSubmit: { backgroundColor: theme.accent },
  newAgentSubmitText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  newAgentButtonDisabled: { opacity: 0.5 }
});
