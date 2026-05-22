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
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/src/api";
import {
  useChatSession,
  useSendMessage,
  useSyncChatTask
} from "@/src/queries";
import { theme } from "@/src/theme";
import type { ChatMessage } from "@/src/types";

// Web parity: a paired assistant ChatMessage is only persisted once the
// task is terminal AND not waiting on approval. Until then, we render
// an ephemeral "thinking" / "working" placeholder driven by currentStep.
const TERMINAL_TASK_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled"
]);

export default function ChatDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const session = useChatSession(sessionId ?? null);
  const send = useSendMessage(sessionId ?? null);
  const sync = useSyncChatTask(sessionId ?? null);

  const [text, setText] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);
  // Tracks taskIds for which we've already issued a /sync POST so the
  // polling effect doesn't re-fire it every tick once the task is
  // terminal but the paired assistant message hasn't materialised yet.
  const syncedTaskIdsRef = useRef<Set<string>>(new Set());

  // Reset the "already synced" guard whenever the user navigates to a
  // different chat. Without this, stale ids from a previous session
  // would suppress legitimate sync calls.
  useEffect(() => {
    syncedTaskIdsRef.current = new Set();
  }, [sessionId]);

  // 401 → setup. Effect-driven so all later hooks still run on the
  // unauthorized render (Rules of Hooks).
  const unauthorized =
    session.error instanceof ApiError && session.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const messages = session.data?.messages;
  const tasks = session.data?.tasks;

  const tasksById = useMemo(
    () => new Map((tasks ?? []).map((t) => [t.id, t])),
    [tasks]
  );

  // Mirrors web/src/app/chat/page.tsx: the in-flight task is the latest
  // user message's task whose status is non-terminal. Stays set while
  // the assistant is producing partial output so the busy state and
  // phase indicator remain wired until the runtime declares it done.
  const inflightTaskId = useMemo<string | null>(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role === "user" && m.taskId) {
        const task = tasksById.get(m.taskId);
        if (task && TERMINAL_TASK_STATUSES.has(task.status)) return null;
        return m.taskId;
      }
    }
    return null;
  }, [messages, tasksById]);

  const pendingPhase = useMemo<string | null>(() => {
    if (!inflightTaskId) return null;
    const task = tasksById.get(inflightTaskId);
    if (!task) return "Thinking";
    if (task.currentStep === "Thinking") return "Thinking";
    if (task.currentStep === "Working") return "Working";
    if (task.currentStep === "Waiting for approval") return "Waiting for approval";
    if (task.status === "queued") return "Thinking";
    if (task.currentStep) return task.currentStep;
    return "Working";
  }, [inflightTaskId, tasksById]);

  // Auto-sync: once a user message's task is terminal but no paired
  // assistant message exists, POST /sync to materialise the assistant
  // record. The web client does the same.
  useEffect(() => {
    if (!messages || !tasks) return;
    const assistantTaskIds = new Set(
      messages
        .filter((m) => m.role === "assistant" && m.taskId)
        .map((m) => m.taskId as string)
    );
    for (const message of messages) {
      if (message.role !== "user" || !message.taskId) continue;
      if (assistantTaskIds.has(message.taskId)) continue;
      if (syncedTaskIdsRef.current.has(message.taskId)) continue;
      const task = tasks.find((t) => t.id === message.taskId);
      if (!task || !TERMINAL_TASK_STATUSES.has(task.status)) continue;
      syncedTaskIdsRef.current.add(message.taskId);
      sync.mutate(message.taskId);
    }
  }, [messages, tasks, sync]);

  // Scroll to bottom on new message arrival or on first render of a
  // session. Behavior matches the web's `scrollIntoView` on
  // messages.length and selected change.
  useEffect(() => {
    // setTimeout 0 defers to after layout so the new bubble is measured
    // before we ask the ScrollView to scroll.
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(id);
  }, [messages?.length, sessionId, pendingPhase]);

  const showSendBusy = Boolean(inflightTaskId) || send.isPending;
  const headerTitle = session.data?.title?.trim() || "New chat";

  const submit = () => {
    const trimmed = text.trim();
    // Hardware-keyboard onSubmitEditing can fire mid-task; `showSendBusy`
    // also covers the in-flight assistant work, not just the mutation's
    // own pending state.
    if (!trimmed || showSendBusy || !sessionId) return;
    send.mutate(trimmed, {
      onSuccess: () => setText("")
    });
  };

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerStyle: { backgroundColor: theme.bg },
          headerTitleStyle: { color: theme.text },
          headerTintColor: theme.accent
        }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}
        style={styles.flex}
      >
        {!session.data ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.subtle} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
          >
            {messages && messages.length > 0 ? (
              messages.map((m) => <Bubble key={m.id} message={m} />)
            ) : (
              <View style={styles.emptyChat}>
                <Text style={styles.emptyChatText}>What can I help with?</Text>
              </View>
            )}
            {inflightTaskId && !hasPendingAssistantBubble(messages, inflightTaskId) ? (
              <Phase label={pendingPhase ?? "Working"} />
            ) : null}
          </ScrollView>
        )}

        <View style={styles.composerWrap}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={theme.subtle}
            multiline
            editable={!!sessionId}
            onSubmitEditing={submit}
            blurOnSubmit={false}
            style={styles.composerInput}
          />
          <Pressable
            onPress={submit}
            disabled={!text.trim() || showSendBusy}
            style={[
              styles.sendButton,
              {
                backgroundColor:
                  !text.trim() || showSendBusy
                    ? theme.buttonDisabled
                    : theme.button
              }
            ]}
          >
            {send.isPending ? (
              <ActivityIndicator color={theme.buttonText} />
            ) : (
              <Text style={styles.sendText}>Send</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function hasPendingAssistantBubble(
  messages: ChatMessage[] | undefined,
  inflightTaskId: string | null
): boolean {
  if (!messages || !inflightTaskId) return false;
  return messages.some((m) => m.role === "assistant" && m.taskId === inflightTaskId);
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const bg = isUser
    ? theme.userBubble
    : isSystem
      ? theme.systemBubble
      : theme.assistantBubble;
  const color = isUser
    ? theme.userBubbleText
    : isSystem
      ? theme.systemBubbleText
      : theme.assistantBubbleText;
  const align = isUser ? "flex-end" : "flex-start";
  return (
    <View style={{ alignSelf: align, maxWidth: "85%" }}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: bg,
            borderTopRightRadius: isUser ? 4 : 16,
            borderTopLeftRadius: isUser ? 16 : 4
          }
        ]}
      >
        <Text style={[styles.bubbleText, { color }]} selectable>
          {message.content}
        </Text>
      </View>
    </View>
  );
}

function Phase({ label }: { label: string }) {
  return (
    <View style={{ alignSelf: "flex-start", maxWidth: "85%" }}>
      <View
        style={[
          styles.bubble,
          styles.phase,
          {
            backgroundColor: theme.assistantBubble,
            borderTopLeftRadius: 4
          }
        ]}
      >
        <ActivityIndicator size="small" color={theme.subtle} />
        <Text style={[styles.bubbleText, styles.phaseLabel]}>{label}…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  messages: { padding: 16, gap: 10, paddingBottom: 24 },
  emptyChat: { flex: 1, minHeight: 240, alignItems: "center", justifyContent: "center" },
  emptyChatText: { fontSize: 18, fontWeight: "500", color: theme.subtle },
  bubble: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16
  },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  phase: { flexDirection: "row", alignItems: "center", gap: 8 },
  phaseLabel: { color: theme.subtle, fontStyle: "italic" },
  composerWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.bg
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    fontSize: 16,
    color: theme.text,
    backgroundColor: theme.inputBg,
    borderColor: theme.border
  },
  sendButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center"
  },
  sendText: { fontSize: 15, fontWeight: "600", color: theme.buttonText }
});
