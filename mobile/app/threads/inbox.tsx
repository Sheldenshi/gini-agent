import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { agentInitial, agentSwatch } from "@/src/components/chat/AgentAvatar";
import { relativeTime } from "@/src/format";
import { useThreadsInbox, useUnreadCounts } from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { InboxThreadSummary } from "@/src/types";

type InboxFilter = "all" | "unread";

// Cross-agent Threads Inbox. The header carries an All / Unread segmented
// control; each card shows the owning agent chip, the thread preview,
// stacked "You + agent" avatars, the reply count, and a blue "N new"
// badge when the thread has unseen agent replies. Tapping a card opens
// the Slack-style Thread View for that thread.
export default function ThreadsInboxScreen() {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const inbox = useThreadsInbox(filter);
  const unreadCountsQuery = useUnreadCounts();
  const unreadCounts = unreadCountsQuery.data ?? {};

  const threads = inbox.data ?? [];

  // "N new" is computed client-side: a thread reads as unread when its
  // owning session has unread blocks for this device AND the last reply
  // came from the agent (the user's own reply isn't "new" to them). The
  // count is the session's unread total — a coarse but honest signal
  // until per-thread read-state lands on the gateway.
  const unreadByThread = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of threads) {
      const sessionUnread = unreadCounts[t.sessionId] ?? 0;
      if (sessionUnread > 0 && t.lastReplyAuthor === "agent") {
        map.set(t.threadId, sessionUnread);
      }
    }
    return map;
  }, [threads, unreadCounts]);

  const filtered = useMemo(() => {
    if (filter === "all") return threads;
    return threads.filter((t) => unreadByThread.has(t.threadId));
  }, [threads, filter, unreadByThread]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header — title + All/Unread segmented control. */}
      <View style={styles.header}>
        <Text style={styles.title}>Threads</Text>
        <View style={styles.segment}>
          <SegmentButton
            label="All"
            active={filter === "all"}
            onPress={() => setFilter("all")}
          />
          <SegmentButton
            label="Unread"
            active={filter === "unread"}
            onPress={() => setFilter("unread")}
          />
        </View>
      </View>

      {inbox.isLoading && threads.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.muted} />
        </View>
      ) : inbox.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {inbox.error instanceof Error ? inbox.error.message : "Failed to load threads"}
          </Text>
          <TouchableOpacity onPress={() => inbox.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <Feather name="check-circle" size={28} color={theme.placeholder} />
          <Text style={styles.emptyText}>
            {filter === "unread" ? "All caught up" : "No threads yet"}
          </Text>
          <Text style={styles.emptySub}>
            {filter === "unread"
              ? "You're up to date on every thread."
              : "Threads branch off agent replies for deeper back-and-forth."}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={inbox.isFetching && threads.length > 0}
              onRefresh={() => inbox.refetch()}
              tintColor={theme.muted}
            />
          }
        >
          {filtered.map((thread) => (
            <ThreadCard
              key={thread.threadId}
              thread={thread}
              newCount={unreadByThread.get(thread.threadId) ?? 0}
              onPress={() =>
                router.push(`/chat/${thread.sessionId}/thread/${thread.threadId}`)
              }
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function SegmentButton({
  label,
  active,
  onPress
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[styles.segmentButton, active && styles.segmentButtonActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label} threads`}
    >
      <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ThreadCard({
  thread,
  newCount,
  onPress
}: {
  thread: InboxThreadSummary;
  newCount: number;
  onPress: () => void;
}) {
  const agentName = thread.agentName ?? "Agent";
  const swatch = agentSwatch(agentName);
  const preview =
    thread.rootPreview?.trim() || thread.lastReplyPreview?.trim() || "Thread";
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open ${agentName} thread, ${thread.replyCount} replies`}
    >
      {/* Meta row — agent chip + time on the left, "N new" badge right. */}
      <View style={styles.metaRow}>
        <View style={styles.metaLeft}>
          <View style={[styles.chip, { backgroundColor: tint(swatch.bg) }]}>
            <View style={[styles.chipDot, { backgroundColor: swatch.bg }]} />
            <Text style={[styles.chipName, { color: darken(swatch.bg) }]}>
              {agentName}
            </Text>
          </View>
          <Text style={styles.metaSep}>·</Text>
          <Text style={styles.metaTime}>{relativeTime(thread.lastReplyAt)}</Text>
        </View>
        {newCount > 0 ? (
          <View style={styles.newBadge}>
            <Text style={styles.newBadgeText}>{newCount > 99 ? "99+" : newCount} new</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.preview} numberOfLines={2}>
        {preview}
      </Text>

      {/* Footer — stacked You + agent avatars, reply count, last reply. */}
      <View style={styles.footer}>
        <View style={styles.avatars}>
          <View style={[styles.miniAvatar, styles.miniYou]}>
            <Text style={styles.miniAvatarText} allowFontScaling={false}>Y</Text>
          </View>
          <View
            style={[styles.miniAvatar, styles.miniAgent, { backgroundColor: swatch.bg }]}
          >
            <Text style={[styles.miniAvatarText, { color: swatch.fg }]} allowFontScaling={false}>
              {agentInitial(agentName)}
            </Text>
          </View>
        </View>
        <Text style={styles.footerReplies}>
          {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
        </Text>
        <Text style={styles.footerSep}>·</Text>
        <Text style={styles.footerLast}>
          Last reply {relativeTime(thread.lastReplyAt)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// Light tint of an agent swatch for the chip background (≈12% alpha).
function tint(hex: string): string {
  return `${normalizeHex(hex)}1F`;
}
// Darker variant of the swatch for the chip label text. We can't compute
// a true shade without a color lib, so reuse the base swatch — it reads
// fine against the tinted background in the light palette.
function darken(hex: string): string {
  return normalizeHex(hex);
}
function normalizeHex(hex: string): string {
  // Accept #RGB / #RRGGBB; strip any existing alpha so tint() can append.
  if (hex.length === 4) {
    const r = hex[1];
    const g = hex[2];
    const b = hex[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex.slice(0, 7);
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
  title: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 19
  },
  segment: {
    flexDirection: "row",
    gap: 2,
    backgroundColor: "#EFEFF1",
    borderRadius: 9,
    padding: 2
  },
  segmentButton: {
    borderRadius: 7,
    paddingVertical: 5,
    paddingHorizontal: 13
  },
  segmentButtonActive: {
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 2,
    elevation: 1
  },
  segmentLabel: {
    color: "#8A8A8E",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  segmentLabelActive: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700)
  },

  listContent: { paddingHorizontal: 16 },

  card: {
    paddingVertical: 15,
    gap: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8
  },
  metaLeft: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 7,
    paddingVertical: 3,
    paddingHorizontal: 9
  },
  chipDot: { width: 7, height: 7, borderRadius: 3.5 },
  chipName: { fontFamily: family("HankenGrotesk", 700), fontSize: 12 },
  metaSep: {
    color: "#C7C7CC",
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13
  },
  metaTime: {
    color: "#8A8A8E",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  newBadge: {
    backgroundColor: "#2F6BFF",
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 8
  },
  newBadgeText: {
    color: "#FFFFFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 11
  },

  preview: {
    color: "#2A2A2C",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 15,
    lineHeight: 21
  },

  footer: { flexDirection: "row", alignItems: "center", gap: 9 },
  avatars: { flexDirection: "row", width: 36, height: 22 },
  miniAvatar: {
    width: 22,
    height: 22,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF"
  },
  miniYou: { backgroundColor: "#1A1A1A" },
  miniAgent: { marginLeft: -8 },
  miniAvatarText: {
    color: "#FFFFFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 11
  },
  footerReplies: {
    color: "#3A3A3C",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  footerSep: {
    color: "#C7C7CC",
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13
  },
  footerLast: {
    color: "#8A8A8E",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10
  },
  emptyText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  emptySub: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20
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
