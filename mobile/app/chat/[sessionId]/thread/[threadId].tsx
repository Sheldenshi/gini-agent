import { Feather } from "@expo/vector-icons";
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
import { ApiError, uploadImage, type UploadRef } from "@/src/api";
import { AttachmentSheet } from "@/src/components/AttachmentSheet";
import { AgentAvatar, agentSwatch } from "@/src/components/chat/AgentAvatar";
import { BlockRenderer } from "@/src/components/chat/BlockRenderer";
import { GeneratedFilesCard } from "@/src/components/chat/GeneratedFilesCard";
import { groupExchanges, type ChatRenderItem } from "@/src/group-exchanges";
import {
  useAgents,
  useChatStream,
  useReplyToThread,
  useThreads
} from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { ChatBlock } from "@/src/types";

interface PendingAttachment {
  localId: string;
  kind: "image" | "file";
  previewUri?: string;
  filename: string;
  mimeType: string;
  size?: number;
  status: "uploading" | "ready" | "error";
  ref?: UploadRef;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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

// Slack-style Thread View, pushed as a card over the chat detail. The
// pinned parent message (the main-chat assistant block the thread
// branched from) sits above an "N replies" divider; the reply list reuses
// the main chat's block pipeline so tool calls / generated-file cards
// still render inside a thread. The composer carries an "Also send to
// main chat" checkbox wired to the reply endpoint's `alsoToMain`.
export default function ThreadViewScreen() {
  const { sessionId, threadId, parentBlockId, rootPreview } = useLocalSearchParams<{
    sessionId: string;
    threadId: string;
    // Present only when starting a brand-new thread off an assistant reply:
    // the thread has no blocks yet, so the parent block id + its text come in
    // as route params to seed the pinned parent and the first reply's root.
    parentBlockId?: string;
    rootPreview?: string;
  }>();
  const stream = useChatStream(sessionId ?? null, threadId ?? null);
  const threads = useThreads(sessionId ?? null);
  const agents = useAgents();
  const reply = useReplyToThread(sessionId ?? null, threadId ?? null);

  const [text, setText] = useState("");
  const [alsoToMain, setAlsoToMain] = useState(false);
  const [images, setImages] = useState<PendingAttachment[]>([]);
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const pinnedToBottomRef = useRef<boolean>(true);
  // State mirror of pinnedToBottomRef for the "jump to latest" button (the ref
  // drives auto-scroll without a re-render; the button's visibility needs one).
  const [atBottom, setAtBottom] = useState(true);

  const unauthorized =
    stream.error instanceof ApiError && stream.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const summary = useMemo(
    () => (threads.data ?? []).find((t) => t.threadId === threadId),
    [threads.data, threadId]
  );

  // The parent message the thread roots at. An existing thread carries it on
  // its summary; a brand-new one (no summary yet) gets it from the route
  // params passed when the user tapped "Reply in thread".
  const parentBlock = summary?.parentBlockId ?? parentBlockId;
  const rootPreviewText = summary?.rootPreview ?? rootPreview;

  const agent = useMemo(() => {
    const agentId = summary?.agentId ?? stream.session?.agentId;
    if (!agentId) return undefined;
    return agents.data?.agents.find((a) => a.id === agentId);
  }, [agents.data, summary, stream.session]);
  const agentName = agent?.name ?? stream.session?.title?.trim() ?? "Agent";
  const swatch = agentSwatch(agentName);

  const list = useMemo<ChatBlock[]>(() => stream.blocks ?? [], [stream.blocks]);

  // Drop transient terminal phase markers from the thread transcript the
  // same way the main chat does.
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

  const replyCount = summary?.replyCount ?? visible.length;

  const lastUpdatedAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const b = list[i]!;
      if (b.kind === "assistant_text") return b.updatedAt;
    }
    return "";
  }, [list]);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const id = setTimeout(() => {
      if (!pinnedToBottomRef.current) return;
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(id);
  }, [list.length, lastUpdatedAt]);

  // When the keyboard opens, the composer rises above it and the reply
  // viewport shrinks from the bottom, covering the latest replies. Follow the
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
    () => images.filter((i) => i.status === "ready" && i.ref).map((i) => i.ref!),
    [images]
  );
  const anyUploading = images.some((i) => i.status === "uploading");
  const sendDisabled =
    (!trimmed && readyImages.length === 0) ||
    reply.isPending ||
    anyUploading ||
    !sessionId ||
    !threadId;

  const submit = () => {
    if (sendDisabled) return;
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    reply.mutate(
      {
        content: trimmed,
        images: readyImages,
        alsoToMain,
        // Carry the parent on every reply. A brand-new thread needs it to
        // root; an existing thread inherits it server-side and ignores this.
        ...(parentBlock ? { parentBlockId: parentBlock } : {})
      },
      {
        onSuccess: () => {
          setText("");
          setImages([]);
        },
        onError: (err) => Alert.alert("Reply failed", err.message)
      }
    );
  };

  const beginUpload = async (asset: ImagePicker.ImagePickerAsset): Promise<void> => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { filename, mimeType } = describeAsset(asset);
    setImages((prev) => [
      ...prev,
      { localId, kind: "image", previewUri: asset.uri, filename, mimeType, size: asset.fileSize, status: "uploading" }
    ]);
    try {
      const ref = await uploadImage({ uri: asset.uri, name: filename, mimeType });
      setImages((prev) =>
        prev.map((i) => (i.localId === localId ? { ...i, status: "ready", ref } : i))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImages((prev) =>
        prev.map((i) => (i.localId === localId ? { ...i, status: "error" } : i))
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
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      for (const asset of result.assets) void beginFileUpload(asset);
    } catch (err) {
      Alert.alert("Couldn't open Files", err instanceof Error ? err.message : String(err));
    } finally {
      pickingFileRef.current = false;
    }
  };

  const beginFileUpload = async (asset: DocumentPicker.DocumentPickerAsset): Promise<void> => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mimeType = asset.mimeType ?? "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    setImages((prev) => [
      ...prev,
      { localId, kind: isImage ? "image" : "file", previewUri: isImage ? asset.uri : undefined, filename: asset.name, mimeType, size: asset.size, status: "uploading" }
    ]);
    try {
      const ref = await uploadImage({ uri: asset.uri, name: asset.name, mimeType });
      setImages((prev) => prev.map((a) => (a.localId === localId ? { ...a, status: "ready", ref } : a)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImages((prev) => prev.map((a) => (a.localId === localId ? { ...a, status: "error" } : a)));
      Alert.alert("Upload failed", message);
    }
  };

  const pickFromLibrary = async (): Promise<void> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photo access required", "Enable photo library access in Settings to attach images.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.85 });
    if (result.canceled) return;
    for (const asset of result.assets) void beginUpload(asset);
  };

  const takePhoto = async (): Promise<void> => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera access required", "Enable camera access in Settings to capture photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 });
    if (result.canceled) return;
    for (const asset of result.assets) void beginUpload(asset);
  };

  const removeImage = (localId: string): void => {
    setImages((prev) => prev.filter((i) => i.localId !== localId));
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

      {/* Header — "Thread" title with an agent dot + name subtitle. */}
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
        <View style={styles.headerTitleGroup}>
          <Text style={styles.headerTitle}>Thread</Text>
          <View style={styles.headerSubtitle}>
            <View style={[styles.subtitleDot, { backgroundColor: swatch.bg }]} />
            <Text style={styles.subtitleText}>{agentName}</Text>
          </View>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.flex}
      >
        <View style={styles.messagesArea}>
        {stream.isPending && !stream.blocks ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.muted} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            scrollEventThrottle={16}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const distanceFromBottom =
                contentSize.height - (contentOffset.y + layoutMeasurement.height);
              const pinned = distanceFromBottom < 40;
              pinnedToBottomRef.current = pinned;
              setAtBottom(pinned);
            }}
          >
            {/* Pinned parent message — the main-chat block the thread
                branched from (from the summary, or the route params when
                the thread is brand-new). */}
            {rootPreviewText ? (
              <View style={styles.parent}>
                <AgentAvatar name={agentName} size={38} />
                <View style={styles.parentRight}>
                  <View style={styles.parentNameRow}>
                    <Text style={styles.parentName}>{agentName}</Text>
                    <View style={styles.parentPush} />
                    <Feather name="bookmark" size={14} color="#B6B6BC" />
                  </View>
                  <Text style={styles.parentBody}>{rootPreviewText}</Text>
                </View>
              </View>
            ) : null}

            {/* "N replies" divider. */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerLabel}>
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Reply list — reuses the main chat block pipeline so tool
                calls and generated-file cards render inside the thread. */}
            <View style={styles.replies}>
              {renderItems.length > 0 ? (
                renderItems.map((item) => {
                  if (item.kind === "tool_group") {
                    // tool_group items only appear after groupExchanges
                    // folds a completed exchange; replay the process
                    // inline — tool calls via BlockRenderer, the model's
                    // pre-tool narration as a muted line — to keep the
                    // thread surface simple.
                    return item.steps.map((step) =>
                      step.kind === "tool_call" ? (
                        <BlockRenderer
                          key={step.block.id}
                          block={step.block}
                          toolResult={toolResultsByCallId.get(step.block.callId)}
                        />
                      ) : (
                        <Text key={step.block.id} style={styles.threadNarration}>
                          {step.block.text}
                        </Text>
                      )
                    );
                  }
                  if (item.kind === "file_artifact") {
                    return <GeneratedFilesCard key={item.id} files={item.files} />;
                  }
                  return (
                    <BlockRenderer
                      key={item.block.id}
                      block={item.block}
                      toolResult={
                        item.block.kind === "tool_call"
                          ? toolResultsByCallId.get(item.block.callId)
                          : undefined
                      }
                    />
                  );
                })
              ) : (
                <Text style={styles.repliesEmpty}>
                  No replies yet. Start the thread below.
                </Text>
              )}
            </View>
          </ScrollView>
        )}
        {/* Floating "jump to latest" button — shown once the user scrolls up
            off the bottom. It lives inside the message area (a flex child that
            shrinks with the keyboard), so it floats just above the composer
            whether the keyboard is up or down. */}
        {!atBottom ? (
          <TouchableOpacity
            onPress={scrollToBottom}
            activeOpacity={0.85}
            style={styles.jumpToBottom}
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest replies"
          >
            <Feather name="chevron-down" size={24} color={theme.text} />
          </TouchableOpacity>
        ) : null}
        </View>

        {/* Composer — "Also send to main chat" toggle + reply pill. */}
        <View style={styles.composer}>
          <TouchableOpacity
            onPress={() => setAlsoToMain((v) => !v)}
            activeOpacity={0.7}
            style={styles.alsoRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: alsoToMain }}
            accessibilityLabel="Also send to main chat"
          >
            <View style={[styles.checkbox, alsoToMain && styles.checkboxChecked]}>
              {alsoToMain ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
            </View>
            <Text style={styles.alsoLabel}>Also send to main chat</Text>
          </TouchableOpacity>

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
                  <View key={image.localId} style={[styles.thumb, image.status === "error" && styles.thumbError]}>
                    <Image source={{ uri: image.previewUri }} style={styles.thumbImage} />
                    {image.status === "uploading" ? (
                      <View style={styles.thumbOverlay}>
                        <ActivityIndicator color={theme.buttonText} />
                      </View>
                    ) : null}
                    <TouchableOpacity
                      onPress={() => removeImage(image.localId)}
                      style={styles.thumbRemove}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Remove attachment"
                    >
                      <Feather name="x" size={12} color={theme.buttonText} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View key={image.localId} style={[styles.fileChip, image.status === "error" && styles.thumbError]}>
                    <Feather name="file" size={20} color={theme.subtle} />
                    <View style={styles.fileChipBody}>
                      <Text style={styles.fileChipName} numberOfLines={1}>{image.filename}</Text>
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
                      onPress={() => removeImage(image.localId)}
                      style={styles.thumbRemove}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Remove attachment"
                    >
                      <Feather name="x" size={12} color={theme.buttonText} />
                    </TouchableOpacity>
                  </View>
                )
              )}
            </ScrollView>
          ) : null}

          <View style={styles.pill}>
            <TouchableOpacity
              onPress={() => setAttachMenuVisible(true)}
              hitSlop={8}
              style={styles.plusButton}
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
            >
              <Feather name="plus" size={22} color={theme.codeChipText} />
            </TouchableOpacity>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Reply…"
              placeholderTextColor={theme.inputPlaceholder}
              multiline
              editable={Boolean(sessionId && threadId)}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              style={styles.input}
              accessibilityLabel="Thread reply input"
            />
            <Pressable
              onPress={submit}
              disabled={sendDisabled}
              style={[styles.send, sendDisabled && styles.sendDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Send reply"
            >
              {reply.isPending ? (
                <ActivityIndicator color={theme.buttonText} />
              ) : (
                <Feather name="arrow-up" size={20} color={theme.buttonText} />
              )}
            </Pressable>
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  headerBack: { width: 26, alignItems: "flex-start", justifyContent: "center" },
  headerTitleGroup: { flex: 1, gap: 2 },
  headerTitle: {
    color: "#0A0A0A",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  headerSubtitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  subtitleDot: { width: 7, height: 7, borderRadius: 3.5 },
  subtitleText: {
    color: "#6A6A70",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  headerSpacer: { width: 26 },

  scrollContent: { paddingBottom: 12 },

  // Pinned parent message.
  parent: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#F7F8FA",
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  parentRight: { flex: 1, gap: 7 },
  parentNameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  parentName: {
    color: "#0A0A0A",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 15
  },
  parentPush: { flex: 1 },
  parentBody: {
    color: "#2A2A2E",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 15,
    lineHeight: 21
  },

  // Replies divider.
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: theme.border },
  dividerLabel: {
    color: "#6A6A70",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },

  replies: { paddingHorizontal: 14, paddingBottom: 8, gap: 12 },
  // Pre-tool narration rendered muted so it reads as process, not a
  // standalone reply, mirroring the collapsed tool group's narration.
  threadNarration: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 20
  },
  repliesEmpty: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 24
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

  // Composer.
  composer: {
    backgroundColor: theme.bg,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  alsoRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 2 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#C2C2C8",
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center"
  },
  checkboxChecked: { backgroundColor: theme.accent, borderColor: theme.accent },
  alsoLabel: {
    color: "#6A6A70",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13
  },

  thumbTray: { maxHeight: 76 },
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

  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 52,
    borderRadius: 28,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 4
  },
  plusButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  input: {
    flex: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    paddingVertical: 8,
    maxHeight: 120
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.button,
    alignItems: "center",
    justifyContent: "center"
  },
  sendDisabled: { backgroundColor: theme.buttonDisabled }
});
