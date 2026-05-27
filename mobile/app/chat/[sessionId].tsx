import { Feather } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "@/src/api";
import { BlockRenderer } from "@/src/components/chat/BlockRenderer";
import { getCachedDeviceToken, refreshBadge, registerForPushAsync } from "@/src/push";
import {
  isTaskInFlight,
  useChatStream,
  useSendMessage
} from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { ChatBlock } from "@/src/types";

// Placeholder titles the runtime stamps on a freshly created session
// before the auto-rename runs. Mirrors DEFAULT_CHAT_TITLES in
// src/execution/chat.ts. When the session record carries one of these,
// the header falls back to the first user_text excerpt instead — a
// stable, conversation-derived label is more useful than "New chat" in
// the gap between the user's first send and the auto-rename completing.
const DEFAULT_TITLE_FALLBACKS = new Set<string>(["Untitled chat", "New chat"]);

// Three sections: a header with back arrow + centered title, the
// scrolling conversation, and the input bar (pill + circular send
// button). All chrome lives in this screen — the native stack header
// is hidden so the iOS-style centered title and equal-width edge spacers
// land exactly per the design.
export default function ChatDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const stream = useChatStream(sessionId ?? null);
  const send = useSendMessage(sessionId ?? null);

  const [text, setText] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);

  // 401 → setup. Effect-driven so all later hooks still run on the
  // unauthorized render (Rules of Hooks).
  const unauthorized =
    stream.error instanceof ApiError && stream.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  // Request APNs permission + register the device token the first time
  // the user lands on a chat detail screen. Asking here (vs. on app
  // launch) trades a few seconds of latency for noticeably higher
  // grant rates — the user is already invested in an actual
  // conversation, so the prompt reads as "Gini wants to let you know
  // when something needs your call" instead of unexplained chrome.
  // The module is idempotent across remounts and gates iOS-only
  // internally, so calling it unconditionally here is fine.
  useEffect(() => {
    void registerForPushAsync();
  }, []);

  const list = useMemo<ChatBlock[]>(() => stream.blocks ?? [], [stream.blocks]);

  // Mark the chat as read once we know which block id is latest.
  // Debounced by `lastReadBlockIdRef` — we only POST when the tail
  // block id changes, so streaming assistant_text deltas (which reuse
  // the same id but advance updatedAt) don't fire a request per token.
  // The badge refetch chases the write so the icon dot clears
  // immediately.
  const lastReadBlockIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    if (list.length === 0) return;
    const latestId = list[list.length - 1]!.id;
    if (lastReadBlockIdRef.current === latestId) return;
    lastReadBlockIdRef.current = latestId;
    // Read-state + badge are per-device on the gateway; the web target
    // (and any client that hasn't acquired an APNs token yet) has no
    // X-Device-Token header to send, so the call would just 400. Skip
    // the round-trip entirely until a token is cached.
    if (!getCachedDeviceToken()) return;
    void (async () => {
      try {
        await api(`/chat/${sessionId}/read`, {
          method: "POST",
          body: JSON.stringify({ lastReadBlockId: latestId })
        });
        await refreshBadge();
      } catch {
        // Best-effort — read state is rebuilt on the next navigation,
        // and refreshBadge has its own swallow. A failure here only
        // delays the badge clearing until the next event.
      }
    })();
  }, [list, sessionId]);

  // Phase blocks are transient indicators — only render the latest one,
  // and only while it's still active (non-terminal). Historical phase
  // markers in the persisted log would otherwise show "Thinking" /
  // "Completed" as permanent transcript items, which is noise.
  const visible = useMemo<ChatBlock[]>(() => {
    return list.filter((b, i) => {
      if (b.kind !== "phase") return true;
      const isLast = i === list.length - 1;
      if (!isLast) return false;
      return (
        b.label !== "Completed" &&
        b.label !== "Cancelled" &&
        b.label !== "Failed"
      );
    });
  }, [list]);

  // callId → tool_result lookup. The chat detail uses this so each
  // tool_call row can pull its own paired result for the expand-on-tap
  // affordance. tool_result blocks themselves never render standalone.
  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, Extract<ChatBlock, { kind: "tool_result" }>>();
    for (const b of list) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [list]);

  // Title source of truth is the session record — the gateway seeds it
  // in the initial REST fetch (in parallel with /blocks) and pushes
  // renames over the same /stream SSE connection thereafter. Until the
  // session record has actually loaded, the header stays on "Chat":
  // falling back to the first user_text excerpt during the loading
  // window would flash a wrong-looking title and then swap to the real
  // one a frame later, which is the bug this hook was rewritten to
  // avoid. Once the session is loaded and its title is a default
  // ("New chat" / "Untitled chat"), THEN the first user_text excerpt
  // takes over until the runtime's auto-rename emits the real title.
  const headerTitle = useMemo(() => {
    const session = stream.session;
    if (!session) return "Chat";
    const title = session.title?.trim();
    if (title && !DEFAULT_TITLE_FALLBACKS.has(title)) {
      return title.length > 40 ? `${title.slice(0, 40)}…` : title;
    }
    const firstUserText = list.find((b) => b.kind === "user_text");
    if (firstUserText && firstUserText.kind === "user_text") {
      const trimmed = firstUserText.text.trim();
      if (trimmed) return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
    }
    return "Chat";
  }, [list, stream.session]);

  const inFlight = useMemo(() => isTaskInFlight(list), [list]);

  // The most recent assistant_text block's updatedAt advances on every
  // streaming delta. Including it in the scroll dep array means the
  // ScrollView pins to the bottom as text accretes mid-stream, not just
  // on block count change.
  const lastAssistantUpdatedAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const b = list[i]!;
      if (b.kind === "assistant_text") return b.updatedAt;
    }
    return "";
  }, [list]);

  // Auto-scroll to bottom on new block arrival and on streaming text
  // accretion. The 50ms defer lets layout settle so the new content is
  // measured before the scroll request lands.
  useEffect(() => {
    const id = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      50
    );
    return () => clearTimeout(id);
  }, [list.length, sessionId, lastAssistantUpdatedAt]);

  const trimmed = text.trim();
  const showSendBusy = send.isPending || inFlight;
  const sendDisabled = !trimmed || showSendBusy || !sessionId;

  const submit = () => {
    // Hardware-keyboard onSubmitEditing can fire mid-task; `showSendBusy`
    // also covers in-flight assistant work, not just the mutation's own
    // pending state.
    if (sendDisabled) return;
    send.mutate(trimmed, {
      onSuccess: () => setText("")
    });
  };

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header — back arrow on the left, centered title, a transparent
          spacer on the right so the title's `textAlign: center` lines up
          visually even though the right edge has no icon. */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.headerIconButton}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="arrow-left" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {headerTitle}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}
        style={styles.flex}
      >
        {stream.isPending && !stream.blocks ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.muted} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
          >
            {visible.length > 0 ? (
              visible.map((block) => (
                <BlockRenderer
                  key={block.id}
                  block={block}
                  toolResult={
                    block.kind === "tool_call"
                      ? toolResultsByCallId.get(block.callId)
                      : undefined
                  }
                />
              ))
            ) : (
              <View style={styles.emptyChat}>
                <Text style={styles.emptyChatText}>What can I help with?</Text>
              </View>
            )}
          </ScrollView>
        )}

        {/* Input bar — pill input with a leading "+" affordance (no-op
            in v1) and a navy circular send button. The pill sits inside
            a white surface bar with a top hairline so the input feels
            anchored to the bottom edge. */}
        <View style={styles.inputBar}>
          <View style={styles.inputPill}>
            <Feather name="plus" size={24} color={theme.codeChipText} />
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message Gini..."
              placeholderTextColor={theme.inputPlaceholder}
              multiline
              editable={!!sessionId}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              style={styles.inputText}
              accessibilityLabel="Message input"
            />
            <Pressable
              onPress={submit}
              disabled={sendDisabled}
              style={[
                styles.sendButton,
                sendDisabled && styles.sendButtonDisabled
              ]}
              accessibilityRole="button"
              accessibilityLabel="Send"
            >
              {send.isPending ? (
                <ActivityIndicator color={theme.buttonText} />
              ) : (
                <Feather name="arrow-up" size={22} color={theme.buttonText} />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // Header. Equal-width edge boxes (icon + spacer) so the centered
  // title sits geometrically in the middle of the row.
  header: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
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
  headerSpacer: { width: 36, height: 36 },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 19
  },

  // Conversation — vertical block stream with consistent gap and outer
  // padding. The block components own their own bubble geometry.
  messages: {
    padding: 16,
    paddingTop: 18,
    paddingBottom: 24,
    gap: 16
  },
  emptyChat: {
    flex: 1,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center"
  },
  emptyChatText: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 18
  },

  // Input bar — sits at the bottom of the screen above the home
  // indicator (consumed by the SafeAreaView). White with a top
  // hairline; the pill itself is height 56 with a 28 corner radius.
  inputBar: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    backgroundColor: theme.bg,
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  inputPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    paddingLeft: 18,
    paddingRight: 8,
    paddingVertical: 4
  },
  inputText: {
    flex: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 17,
    paddingVertical: 8,
    // Cap the multiline input height so a long paste doesn't push the
    // composer up over the conversation.
    maxHeight: 120
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.button,
    alignItems: "center",
    justifyContent: "center"
  },
  sendButtonDisabled: { backgroundColor: theme.buttonDisabled }
});
