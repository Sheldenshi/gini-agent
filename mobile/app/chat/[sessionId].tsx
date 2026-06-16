import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
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
import { api, ApiError, uploadImage, type UploadRef } from "@/src/api";
import { clearCredentials } from "@/src/auth";
import { AttachmentSheet } from "@/src/components/AttachmentSheet";
import { AgentAvatar } from "@/src/components/chat/AgentAvatar";
import { BlockRenderer } from "@/src/components/chat/BlockRenderer";
import { BlockToolCallsCollapsed } from "@/src/components/chat/BlockToolCallsCollapsed";
import { GeneratedFilesCard } from "@/src/components/chat/GeneratedFilesCard";
import { QueuedMessages } from "@/src/components/chat/QueuedMessages";
import { ReplyInThreadPill, ThreadRepliesChip } from "@/src/components/chat/ThreadChip";
import { VoiceRecorder, type VoiceRef } from "@/src/components/chat/VoiceRecorder";
import { chatListTime, jobCadence, relativeTime } from "@/src/format";
import { groupExchanges, type ChatRenderItem } from "@/src/group-exchanges";
import { getCachedDeviceToken, refreshBadge, registerForPushAsync } from "@/src/push";
import {
  isTaskInFlight,
  useAgents,
  useCancelTask,
  useChatStream,
  useJobs,
  useRemovePendingChatMessage,
  useSendMessage,
  useThreads,
  useVoiceStatus
} from "@/src/queries";
import { indexThreadsByParentBlock } from "@/src/thread-routing";
import { family, theme } from "@/src/theme";
import type { ChatBlock, JobRecord, ThreadSummary } from "@/src/types";

type ChatTab = "messages" | "threads" | "jobs";

interface PendingAttachment {
  localId: string;
  kind: "image" | "file";
  // Set only for images — the tray renders a thumbnail from it. Non-image
  // files render a chip instead and carry no preview.
  previewUri?: string;
  filename: string;
  mimeType: string;
  size?: number;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
  ref?: UploadRef;
}

// B / KB / MB for a file chip's size line. Files can be anything (PDF,
// CSV, logs), so the tray shows a human-readable byte count.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Pull a reasonable filename + mime from the picker asset. iOS hands us
// the original photo extension (.HEIC/.jpg/...) when available; when it
// doesn't, we fall back to .jpg since the picker re-encodes HEIC for us
// only on explicit request. `mediaTypes: ["images"]` already guarantees
// the asset is an image, so a defaulted image/jpeg type is safe enough
// for the gateway's mime-prefix guard.
function describeAsset(asset: ImagePicker.ImagePickerAsset): {
  filename: string;
  mimeType: string;
} {
  const uriName = asset.fileName ?? asset.uri.split("/").pop() ?? "image.jpg";
  const filename = uriName.includes(".") ? uriName : `${uriName}.jpg`;
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeFromExt =
    ext === "png"
      ? "image/png"
      : ext === "gif"
        ? "image/gif"
        : ext === "webp"
          ? "image/webp"
          : ext === "heic" || ext === "heif"
            ? "image/heic"
            : "image/jpeg";
  return { filename, mimeType: asset.mimeType ?? mimeFromExt };
}

const TERMINAL_PHASE_LABELS = new Set<string>(["Completed", "Cancelled", "Failed"]);

// Mint a thread id and open the Thread View for a brand-new thread the user
// is starting off an assistant message. The thread doesn't exist yet (no
// blocks), so the parent block id + its text ride along as route params; the
// Thread View renders them as the pinned parent and the first reply (carrying
// parentBlockId) brings the thread into existence. crypto.randomUUID isn't
// available under Hermes, so the id is timestamp + random.
function openNewThread(
  sessionId: string,
  block: Extract<ChatBlock, { kind: "assistant_text" }>
): void {
  const threadId = `thread_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  router.push({
    pathname: "/chat/[sessionId]/thread/[threadId]",
    params: {
      sessionId,
      threadId,
      parentBlockId: block.id,
      rootPreview: block.text
    }
  });
}

function findInFlightTaskId(blocks: ChatBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]!;
    if (b.kind === "phase") {
      if (TERMINAL_PHASE_LABELS.has(b.label)) return null;
      return b.taskId ?? null;
    }
    if (b.kind === "setup_requested" || b.kind === "authorization_requested") {
      return b.taskId ?? null;
    }
    if (b.kind === "tool_call" && b.status === "running") {
      return b.taskId ?? null;
    }
  }
  return null;
}

// Single-agent chat: an agent header, a Messages / Threads / Jobs tab
// bar, and the active tab's content. Messages reuses the existing block
// pipeline (filtered to the main chat — threaded blocks live in the
// Thread View) and attaches inline thread chips to the assistant blocks
// that host a thread. Threads lists the session's threads; Jobs lists
// the agent's recurring jobs. The composer stays mounted under every tab.
export default function ChatDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const stream = useChatStream(sessionId ?? null);
  const threads = useThreads(sessionId ?? null);
  const send = useSendMessage(sessionId ?? null);
  const voice = useVoiceStatus();
  const cancel = useCancelTask();
  const removePending = useRemovePendingChatMessage(sessionId ?? null);
  const agents = useAgents();
  const qc = useQueryClient();

  const [tab, setTab] = useState<ChatTab>("messages");
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingAttachment[]>([]);
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const [voicePending, setVoicePending] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const pinnedToBottomRef = useRef<boolean>(true);
  // Mirrors pinnedToBottomRef as state so the "jump to latest" button can show
  // when the user has scrolled up. The ref drives auto-scroll (no re-render);
  // this drives the button's visibility (needs a re-render).
  const [atBottom, setAtBottom] = useState(true);

  const unauthorized =
    stream.error instanceof ApiError && stream.error.status === 401;
  useEffect(() => {
    // Clear the dead token (revoked/expired) before redirecting so a cold start
    // doesn't replay route-to-app → 401 → setup (the cold-start flash).
    if (unauthorized) {
      void clearCredentials();
      router.replace("/setup");
    }
  }, [unauthorized]);

  useEffect(() => {
    void registerForPushAsync();
  }, []);

  const list = useMemo<ChatBlock[]>(() => stream.blocks ?? [], [stream.blocks]);

  // Resolve the owning agent so the header shows the right name + avatar.
  const agent = useMemo(() => {
    const agentId = stream.session?.agentId;
    if (!agentId) return undefined;
    return agents.data?.agents.find((a) => a.id === agentId);
  }, [agents.data, stream.session]);
  const agentName = agent?.name ?? stream.session?.title?.trim() ?? "Chat";
  const agentOnline = agent?.status === "ready" || agent?.status === "active";

  // The Jobs tab is per-agent; gate the fetch on the resolved agent id so
  // it doesn't run before the session record loads.
  const jobs = useJobs(agent?.id ?? null);

  const threadSummaries = threads.data ?? [];
  // Index threads by the main-chat block they branched from so the
  // Messages tab can attach a "N replies" chip under that assistant
  // block. parentBlockId is the assistant_text the thread roots at.
  const threadByParentBlock = useMemo(
    () => indexThreadsByParentBlock(threadSummaries),
    [threadSummaries]
  );

  // Mark the chat as read once we know which block id is latest.
  const lastReadBlockIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    if (list.length === 0) return;
    const latestId = list[list.length - 1]!.id;
    if (lastReadBlockIdRef.current === latestId) return;
    lastReadBlockIdRef.current = latestId;
    if (!getCachedDeviceToken()) return;
    void (async () => {
      try {
        await api(`/chat/${sessionId}/read`, {
          method: "POST",
          body: JSON.stringify({ lastReadBlockId: latestId })
        });
        await refreshBadge();
        qc.invalidateQueries({ queryKey: ["unread"] });
      } catch {
        // Best-effort — read state is rebuilt on the next navigation.
      }
    })();
  }, [list, sessionId, qc]);

  // Phase blocks are transient — only render the latest active one.
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

  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, Extract<ChatBlock, { kind: "tool_result" }>>();
    for (const b of list) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [list]);

  const renderItems = useMemo<ChatRenderItem[]>(
    () => groupExchanges(visible),
    [visible]
  );

  const inFlight = useMemo(() => isTaskInFlight(list), [list]);
  const inFlightTaskId = useMemo(() => findInFlightTaskId(list), [list]);

  // Server-side queue of follow-up messages submitted while a turn is in
  // flight. Delivered live on the session record via the chat_session SSE
  // frame (applySession) and reset with the session on switch. The pill above
  // the composer renders from this; it drains FIFO one-per-turn server-side.
  const pendingMessages = useMemo(
    () => stream.session?.pendingMessages ?? [],
    [stream.session]
  );

  const lastAssistantUpdatedAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const b = list[i]!;
      if (b.kind === "assistant_text") return b.updatedAt;
    }
    return "";
  }, [list]);

  // Auto-scroll only on the Messages tab (the other tabs are short lists
  // that don't stream). Skipped when the user has scrolled up.
  useEffect(() => {
    if (tab !== "messages") return;
    if (!pinnedToBottomRef.current) return;
    const id = setTimeout(() => {
      if (!pinnedToBottomRef.current) return;
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(id);
  }, [list.length, sessionId, lastAssistantUpdatedAt, voicePending, tab]);

  useEffect(() => {
    pinnedToBottomRef.current = true;
    setAtBottom(true);
  }, [sessionId]);

  // When the keyboard opens, the composer rises above it and the message
  // viewport shrinks from the bottom, covering the latest messages. Follow the
  // user down only if they were already reading at the bottom; if they'd
  // scrolled up, leave their position so they stay on what they're looking at.
  // keyboardDidShow (not willShow) fires after KeyboardAvoidingView's padding
  // animation settles, so scrollToEnd lands on the true, shrunk-viewport bottom.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      if (!pinnedToBottomRef.current) return;
      scrollRef.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  const trimmed = text.trim();
  const readyImages = useMemo(
    () => images.filter((image) => image.status === "ready" && image.ref).map((image) => image.ref!),
    [images]
  );
  const anyUploading = images.some((image) => image.status === "uploading");
  const showSendBusy = send.isPending || inFlight;
  const hasContent = Boolean(trimmed) || readyImages.length > 0;
  // Submission is allowed even while a turn is in flight — the message is
  // queued server-side (ADR chat-message-queue.md). It gates only on having
  // content, nothing uploading, a session, and no voice recording in progress.
  const canSubmit = hasContent && !anyUploading && !!sessionId && !voiceBusy;
  // The Send button only shows/enables when idle; it stays gated on content.
  const sendDisabled = !canSubmit || showSendBusy;
  const canStop = Boolean(inFlightTaskId) && !cancel.isPending;

  const submit = () => {
    // Don't gate on busy: successive submits while a turn runs each POST so they
    // queue in order server-side (the server serializes run-vs-queue).
    if (!canSubmit) return;
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    send.mutate(
      { content: trimmed, images: readyImages },
      {
        onSuccess: () => {
          setText("");
          setImages([]);
        }
      }
    );
  };

  const sendVoice = (audio: VoiceRef): void => {
    if (!sessionId) return;
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    setVoicePending(true);
    send.mutate(
      { content: "", audio },
      {
        onError: (err) => {
          Alert.alert("Voice message failed", err.message);
        },
        onSettled: () => {
          setVoicePending(false);
        }
      }
    );
  };

  const stopTask = () => {
    if (!inFlightTaskId || cancel.isPending) return;
    cancel.mutate(inFlightTaskId, {
      onError: (err) => {
        Alert.alert("Stop failed", err.message);
      }
    });
  };

  const beginUpload = async (asset: ImagePicker.ImagePickerAsset): Promise<void> => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { filename, mimeType } = describeAsset(asset);
    setImages((prev) => [
      ...prev,
      {
        localId,
        kind: "image",
        previewUri: asset.uri,
        filename,
        mimeType,
        size: asset.fileSize,
        status: "uploading"
      }
    ]);
    try {
      const ref = await uploadImage({ uri: asset.uri, name: filename, mimeType });
      setImages((prev) =>
        prev.map((image) =>
          image.localId === localId ? { ...image, status: "ready", ref } : image
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImages((prev) =>
        prev.map((image) =>
          image.localId === localId
            ? { ...image, status: "error", errorMessage: message }
            : image
        )
      );
      Alert.alert("Upload failed", message);
    }
  };

  const pickingFileRef = useRef(false);

  const pickFile = async (): Promise<void> => {
    if (pickingFileRef.current) return;
    pickingFileRef.current = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true
      });
      if (result.canceled) return;
      for (const asset of result.assets) void beginFileUpload(asset);
    } catch (err) {
      Alert.alert("Couldn't open Files", err instanceof Error ? err.message : String(err));
    } finally {
      pickingFileRef.current = false;
    }
  };

  const beginFileUpload = async (
    asset: DocumentPicker.DocumentPickerAsset
  ): Promise<void> => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mimeType = asset.mimeType ?? "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    setImages((prev) => [
      ...prev,
      {
        localId,
        kind: isImage ? "image" : "file",
        previewUri: isImage ? asset.uri : undefined,
        filename: asset.name,
        mimeType,
        size: asset.size,
        status: "uploading"
      }
    ]);
    try {
      const ref = await uploadImage({ uri: asset.uri, name: asset.name, mimeType });
      setImages((prev) =>
        prev.map((a) => (a.localId === localId ? { ...a, status: "ready", ref } : a))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImages((prev) =>
        prev.map((a) =>
          a.localId === localId ? { ...a, status: "error", errorMessage: message } : a
        )
      );
      Alert.alert("Upload failed", message);
    }
  };

  const pickFromLibrary = async (): Promise<void> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photo access required",
        "Enable photo library access in Settings to attach images."
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.85
    });
    if (result.canceled) return;
    for (const asset of result.assets) void beginUpload(asset);
  };

  const takePhoto = async (): Promise<void> => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Camera access required",
        "Enable camera access in Settings to capture photos."
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.85
    });
    if (result.canceled) return;
    for (const asset of result.assets) void beginUpload(asset);
  };

  const openAttachmentMenu = (): void => {
    Keyboard.dismiss();
    setAttachMenuVisible(true);
  };

  const removeImage = (localId: string): void => {
    setImages((prev) => prev.filter((image) => image.localId !== localId));
  };

  const scrollToBottom = (): void => {
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Agent header — back arrow, avatar, name + status, search/more. */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.headerBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={26} color={theme.text} />
        </TouchableOpacity>
        <AgentAvatar name={agentName} size={38} />
        <View style={styles.headerText}>
          <Text style={styles.headerName} numberOfLines={1}>
            {agentName}
          </Text>
          <View style={styles.headerStatusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: agentOnline ? "#34C759" : "#C7C7CC" }
              ]}
            />
            <Text style={styles.headerStatus}>{agentOnline ? "Ready" : "Idle"}</Text>
          </View>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {/* Tab bar — Messages / Threads (count) / Jobs (count). */}
      <View style={styles.tabBar}>
        <TabButton
          label="Messages"
          active={tab === "messages"}
          onPress={() => setTab("messages")}
        />
        <TabButton
          label="Threads"
          active={tab === "threads"}
          count={threadSummaries.length}
          onPress={() => setTab("threads")}
        />
        <TabButton
          label="Jobs"
          active={tab === "jobs"}
          count={jobs.data?.length ?? 0}
          onPress={() => setTab("jobs")}
        />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.flex}
      >
        {tab === "messages" ? (
          <View style={styles.messagesArea}>
          {stream.isPending && !stream.blocks ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.muted} />
            </View>
          ) : (
            <ScrollView
              ref={scrollRef}
              contentContainerStyle={styles.messages}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={16}
              onScroll={(e) => {
                const { contentOffset, contentSize, layoutMeasurement } =
                  e.nativeEvent;
                const distanceFromBottom =
                  contentSize.height -
                  (contentOffset.y + layoutMeasurement.height);
                const pinned = distanceFromBottom < 40;
                pinnedToBottomRef.current = pinned;
                setAtBottom(pinned);
              }}
            >
              {visible.length > 0 ? (
                renderItems.map((item) => {
                  if (item.kind === "tool_group") {
                    return (
                      <BlockToolCallsCollapsed
                        key={item.id}
                        calls={item.calls}
                        resultsByCallId={toolResultsByCallId}
                      />
                    );
                  }
                  if (item.kind === "file_artifact") {
                    return <GeneratedFilesCard key={item.id} files={item.files} />;
                  }
                  // A thread can branch off either an assistant reply (the
                  // user's own "Reply in thread") or the user's message (an
                  // agent-routed turn), so look up a chip for both. Render the
                  // block then the inline "N replies" chip beneath it. A
                  // finished assistant reply with no thread yet shows the
                  // "Reply in thread" pill so the user can start one.
                  const block = item.block;
                  const thread =
                    block.kind === "assistant_text" || block.kind === "user_text"
                      ? threadByParentBlock.get(block.id)
                      : undefined;
                  const canStartThread =
                    block.kind === "assistant_text" && !block.streaming && !thread;
                  return (
                    <View key={block.id}>
                      <BlockRenderer
                        block={block}
                        toolResult={
                          block.kind === "tool_call"
                            ? toolResultsByCallId.get(block.callId)
                            : undefined
                        }
                      />
                      {thread ? (
                        <View style={styles.threadChipWrap}>
                          <ThreadRepliesChip
                            replyCount={thread.replyCount}
                            lastReplyAt={thread.lastReplyAt}
                            // User messages are right-aligned, so align the
                            // chip to the message it branched from.
                            align={block.kind === "user_text" ? "end" : "start"}
                            onPress={() =>
                              router.push(
                                `/chat/${sessionId}/thread/${thread.threadId}`
                              )
                            }
                          />
                        </View>
                      ) : canStartThread ? (
                        <View style={styles.threadChipWrap}>
                          <ReplyInThreadPill
                            onPress={() => openNewThread(sessionId, block)}
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })
              ) : !voicePending ? (
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>What can I help with?</Text>
                </View>
              ) : null}
              {voicePending ? (
                <View style={styles.voicePendingRow}>
                  <View style={styles.voicePendingBubble}>
                    <ActivityIndicator color={theme.muted} size="small" />
                    <Text style={styles.voicePendingText}>
                      {voice.data?.ready === false
                        ? "Setting up voice messages — first time only, this can take a minute."
                        : "Transcribing…"}
                    </Text>
                  </View>
                </View>
              ) : null}
            </ScrollView>
          )}
          {/* Floating "jump to latest" button — shown once the user scrolls
              up off the bottom. It lives inside the message area (a flex child
              that shrinks with the keyboard), so it floats just above the
              composer whether the keyboard is up or down. */}
          {!atBottom && visible.length > 0 ? (
            <TouchableOpacity
              onPress={scrollToBottom}
              activeOpacity={0.85}
              style={styles.jumpToBottom}
              accessibilityRole="button"
              accessibilityLabel="Scroll to latest messages"
            >
              <Feather name="chevron-down" size={24} color={theme.text} />
            </TouchableOpacity>
          ) : null}
          </View>
        ) : tab === "threads" ? (
          <ThreadsTab
            sessionId={sessionId ?? null}
            threads={threadSummaries}
            loading={threads.isLoading}
          />
        ) : (
          <JobsTab jobs={jobs.data ?? []} loading={jobs.isLoading} />
        )}

        {/* Composer — shared across tabs; sending always posts to the
            main chat. */}
        <View style={styles.inputBar}>
          <QueuedMessages
            pending={pendingMessages}
            onRemove={(pendingId) =>
              removePending.mutate(pendingId, {
                onError: (err) => {
                  Alert.alert("Couldn't remove", err.message);
                }
              })
            }
          />
          {images.length > 0 ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              style={styles.thumbTray}
              contentContainerStyle={styles.thumbTrayContent}
            >
              {images.map((image) =>
                image.kind === "image" ? (
                  <View
                    key={image.localId}
                    style={[
                      styles.thumb,
                      image.status === "error" && styles.thumbError
                    ]}
                  >
                    <Image source={{ uri: image.previewUri }} style={styles.thumbImage} />
                    {image.status === "uploading" ? (
                      <View style={styles.thumbOverlay}>
                        <ActivityIndicator color={theme.buttonText} />
                      </View>
                    ) : null}
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Remove attachment"
                      onPress={() => removeImage(image.localId)}
                      style={styles.thumbRemove}
                      hitSlop={6}
                    >
                      <Feather name="x" size={12} color={theme.buttonText} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View
                    key={image.localId}
                    style={[
                      styles.fileChip,
                      image.status === "error" && styles.thumbError
                    ]}
                  >
                    <Feather name="file" size={20} color={theme.subtle} />
                    <View style={styles.fileChipBody}>
                      <Text style={styles.fileChipName} numberOfLines={1}>
                        {image.filename}
                      </Text>
                      <Text style={styles.fileChipMeta} numberOfLines={1}>
                        {image.size !== undefined ? formatBytes(image.size) : image.mimeType}
                      </Text>
                    </View>
                    {image.status === "uploading" ? (
                      <View style={styles.thumbOverlay}>
                        <ActivityIndicator color={theme.buttonText} />
                      </View>
                    ) : null}
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Remove attachment"
                      onPress={() => removeImage(image.localId)}
                      style={styles.thumbRemove}
                      hitSlop={6}
                    >
                      <Feather name="x" size={12} color={theme.buttonText} />
                    </TouchableOpacity>
                  </View>
                )
              )}
            </ScrollView>
          ) : null}
          <View style={styles.inputPill}>
            <TouchableOpacity
              onPress={openAttachmentMenu}
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
              hitSlop={8}
              style={styles.plusButton}
            >
              <Feather name="plus" size={24} color={theme.codeChipText} />
            </TouchableOpacity>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={`Message ${agentName}…`}
              placeholderTextColor={theme.inputPlaceholder}
              multiline
              editable={!!sessionId}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              style={styles.inputText}
              accessibilityLabel="Message input"
            />
            {canStop ? (
              <Pressable
                onPress={stopTask}
                disabled={cancel.isPending}
                style={[
                  styles.sendButton,
                  styles.stopButton,
                  cancel.isPending && styles.sendButtonDisabled
                ]}
                accessibilityRole="button"
                accessibilityLabel="Stop response"
              >
                {cancel.isPending ? (
                  <ActivityIndicator color={theme.buttonText} />
                ) : (
                  <Feather name="square" size={16} color={theme.buttonText} />
                )}
              </Pressable>
            ) : !voiceBusy && (trimmed || readyImages.length > 0 || Platform.OS !== "ios") ? (
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
            ) : (
              <VoiceRecorder
                disabled={!sessionId || showSendBusy || anyUploading}
                onSend={sendVoice}
                onBusyChange={setVoiceBusy}
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
      <AttachmentSheet
        visible={attachMenuVisible}
        sources={[
          { key: "camera", label: "Camera", icon: "camera", onPress: () => void takePhoto() },
          { key: "photos", label: "Photos", icon: "image", onPress: () => void pickFromLibrary() },
          { key: "files", label: "Files", icon: "file-plus", onPress: () => void pickFile() }
        ]}
        onClose={() => setAttachMenuVisible(false)}
      />
    </SafeAreaView>
  );
}

function TabButton({
  label,
  active,
  count,
  onPress
}: {
  label: string;
  active: boolean;
  count?: number;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      <View style={[styles.tabRow, active && styles.tabRowActive]}>
        <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
        {count && count > 0 ? (
          <View style={styles.tabCount}>
            <Text style={styles.tabCountText}>{count}</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// Threads tab — a list of the session's threads. Each row opens the
// Slack-style Thread View.
function ThreadsTab({
  sessionId,
  threads,
  loading
}: {
  sessionId: string | null;
  threads: ThreadSummary[];
  loading: boolean;
}) {
  if (loading && threads.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }
  if (threads.length === 0) {
    return (
      <View style={styles.tabEmpty}>
        <Feather name="message-square" size={28} color={theme.placeholder} />
        <Text style={styles.tabEmptyText}>No threads yet</Text>
        <Text style={styles.tabEmptySub}>
          Threads branch off the agent&apos;s replies for deeper back-and-forth.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.tabListContent}>
      {threads.map((thread) => (
        <TouchableOpacity
          key={thread.threadId}
          onPress={() => router.push(`/chat/${sessionId}/thread/${thread.threadId}`)}
          activeOpacity={0.7}
          style={styles.threadRow}
          accessibilityRole="button"
          accessibilityLabel={`Open thread, ${thread.replyCount} replies`}
        >
          <Text style={styles.threadRowPreview} numberOfLines={2}>
            {thread.rootPreview?.trim() || thread.lastReplyPreview?.trim() || "Thread"}
          </Text>
          <View style={styles.threadRowFooter}>
            <Text style={styles.threadRowReplies}>
              {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
            </Text>
            <Text style={styles.threadRowSep}>·</Text>
            <Text style={styles.threadRowLast}>
              last reply {relativeTime(thread.lastReplyAt)}
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// Jobs tab — the agent's recurring jobs, mirroring the channel rows on
// the Channels screen.
function JobsTab({ jobs, loading }: { jobs: JobRecord[]; loading: boolean }) {
  if (loading && jobs.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }
  if (jobs.length === 0) {
    return (
      <View style={styles.tabEmpty}>
        <Feather name="clock" size={28} color={theme.placeholder} />
        <Text style={styles.tabEmptyText}>No jobs yet</Text>
        <Text style={styles.tabEmptySub}>
          Recurring jobs run on a schedule and deliver to a channel.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.tabListContent}>
      {jobs.map((job) => (
        <View key={job.id} style={styles.jobRow}>
          <View style={styles.jobIcon}>
            <Feather name="clock" size={18} color={theme.placeholder} />
          </View>
          <View style={styles.jobBody}>
            <Text style={styles.jobName} numberOfLines={1}>
              {job.name}
            </Text>
            <View style={styles.jobSchedule}>
              <Feather name="repeat" size={11} color="#B0B0B6" />
              <Text style={styles.jobCadence} numberOfLines={1}>
                {jobCadence(job)}
              </Text>
            </View>
          </View>
          <Text style={styles.jobNext}>
            {job.nextRunAt ? chatListTime(job.nextRunAt) : ""}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // Agent header.
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  headerBack: { width: 28, alignItems: "flex-start", justifyContent: "center" },
  headerText: { flex: 1, gap: 3 },
  headerName: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  headerStatusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  headerStatus: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  headerSpacer: { width: 4 },

  // Tab bar.
  tabBar: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  tab: { alignItems: "center" },
  tabRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    borderBottomColor: "transparent"
  },
  tabRowActive: { borderBottomColor: theme.text },
  tabLabel: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14
  },
  tabLabelActive: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700)
  },
  tabCount: {
    backgroundColor: "#EAEAEA",
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 1
  },
  tabCountText: {
    color: "#5A5A5A",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 11
  },

  // Messages.
  messages: {
    padding: 16,
    paddingTop: 18,
    paddingBottom: 24,
    gap: 16
  },
  threadChipWrap: { marginTop: 8 },
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

  // Threads / Jobs tab shared list.
  tabListContent: { paddingVertical: 4 },
  tabEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10
  },
  tabEmptyText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  tabEmptySub: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20
  },

  // Thread list row.
  threadRow: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  threadRowPreview: {
    color: "#2A2A2C",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 15,
    lineHeight: 21
  },
  threadRowFooter: { flexDirection: "row", alignItems: "center", gap: 6 },
  threadRowReplies: {
    color: "#2F6BFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 13
  },
  threadRowSep: {
    color: "#AEBBE8",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  threadRowLast: {
    color: "#7A86A8",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },

  // Job list row.
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F2F2F2"
  },
  jobIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: "#F2F2F2",
    alignItems: "center",
    justifyContent: "center"
  },
  jobBody: { flex: 1, gap: 2 },
  jobName: {
    color: "#3A3A3A",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  jobSchedule: { flexDirection: "row", alignItems: "center", gap: 5 },
  jobCadence: {
    flex: 1,
    color: theme.placeholder,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  jobNext: {
    color: "#B6B6BC",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },

  // Message area — wraps the transcript ScrollView so the floating jump
  // button can be absolutely positioned relative to it. As a flex child it
  // shrinks when the keyboard opens, keeping the button above the composer.
  messagesArea: { flex: 1 },

  // Floating "jump to latest" button, anchored to the bottom-right of the
  // message area (just above the composer).
  jumpToBottom: {
    position: "absolute",
    right: 16,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3
  },

  // Composer (unchanged geometry from the prior chat detail).
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
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 4
  },
  plusButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center"
  },
  thumbTray: { marginBottom: 10, maxHeight: 76 },
  thumbTrayContent: { gap: 8, paddingRight: 4 },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: theme.codeChipBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    position: "relative"
  },
  thumbError: { borderColor: theme.danger },
  thumbImage: { width: "100%", height: "100%" },
  thumbOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center"
  },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center"
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    width: 180,
    height: 64,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: theme.codeChipBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    position: "relative"
  },
  fileChipBody: { flex: 1 },
  fileChipName: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14
  },
  fileChipMeta: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    marginTop: 2
  },
  inputText: {
    flex: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 17,
    paddingVertical: 8,
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
  sendButtonDisabled: { backgroundColor: theme.buttonDisabled },
  stopButton: { backgroundColor: theme.danger },

  voicePendingRow: { alignSelf: "flex-end", maxWidth: "80%" },
  voicePendingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.codeChipBg,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  voicePendingText: {
    flex: 1,
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 19
  }
});
