import { Feather } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { family, theme } from "@/src/theme";
import type { AgentRecord } from "@/src/types";

// Left slide-out agent switcher, matching the Pencil "Agents Drawer" frame
// (component k8an3b in "Mobile — Chat (New Model)"): a soft-gray panel with
// the "Agents" title, one row per agent (the active one a white pill with a
// blue left accent + check), and a "+ New Agent" footer. It's the mobile
// counterpart to the web sidebar's header dropdown — the home is scoped to a
// single active agent, and switching happens here.

// react-native-web has no native animated module, so the native driver warns
// there; keep it on device, off on web (mirrors AttachmentSheet).
const USE_NATIVE_DRIVER = Platform.OS !== "web";
const ANIM_DURATION = 220;

export function AgentsDrawer({
  visible,
  agents,
  archivedAgents,
  activeAgentId,
  defaultAgentId,
  restoringId,
  onSelect,
  onArchive,
  onRestore,
  onNewAgent,
  onClose
}: {
  visible: boolean;
  agents: AgentRecord[];
  archivedAgents: AgentRecord[];
  activeAgentId?: string;
  defaultAgentId?: string;
  restoringId?: string | null;
  onSelect: (agent: AgentRecord) => void;
  onArchive: (agent: AgentRecord) => void;
  onRestore: (agent: AgentRecord) => void;
  onNewAgent: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  // Panel width: a comfortable majority of the screen, leaving a sliver of
  // dimmed home on the right (the design's reveal). Capped so it doesn't grow
  // unboundedly on tablets.
  const panelWidth = Math.min(330, Math.round(Dimensions.get("window").width * 0.86));

  // `mounted` decouples render lifetime from `visible` so the exit slide runs
  // to completion before the Modal-less overlay unmounts. We render inline
  // (no <Modal>) because the drawer overlays this same screen — a left
  // slide-in over a dimmed home, not a separate native presentation.
  const [mounted, setMounted] = useState(visible);
  // Ref mirror of `mounted` so the effect can read mount state without
  // depending on it — otherwise the first open's false→true mount would
  // re-run the effect and restart the entrance mid-slide (cf. AttachmentSheet).
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const translateX = useRef(new Animated.Value(-panelWidth)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateX.setValue(-panelWidth);
      opacity.setValue(0);
      animRef.current = Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: ANIM_DURATION,
          useNativeDriver: USE_NATIVE_DRIVER
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: ANIM_DURATION,
          useNativeDriver: USE_NATIVE_DRIVER
        })
      ]);
      animRef.current.start();
      return () => animRef.current?.stop();
    }
    if (!mountedRef.current) return () => animRef.current?.stop();
    animRef.current = Animated.parallel([
      Animated.timing(translateX, {
        toValue: -panelWidth,
        duration: ANIM_DURATION,
        useNativeDriver: USE_NATIVE_DRIVER
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: ANIM_DURATION,
        useNativeDriver: USE_NATIVE_DRIVER
      })
    ]);
    animRef.current.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => animRef.current?.stop();
    // panelWidth is derived from a one-shot Dimensions read and stable for the
    // life of the screen, so it doesn't belong in the dependency list.
  }, [visible, translateX, opacity]);

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Scrim — fades in with the slide; tap to dismiss. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Dismiss agents"
      >
        <Animated.View style={[styles.scrim, { opacity }]} />
      </Pressable>

      <Animated.View
        style={[
          styles.panel,
          {
            width: panelWidth,
            paddingTop: insets.top + 16,
            transform: [{ translateX }]
          }
        ]}
      >
        <Text style={styles.title}>Agents</Text>

        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {agents.map((agent) => {
            const active = agent.id === activeAgentId;
            // The default agent can't be archived server-side, so it skips the
            // swipe wrapper — a guaranteed-fail swipe would be a dead affordance.
            if (active || agent.id === defaultAgentId) {
              return (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  active={active}
                  onPress={() => onSelect(agent)}
                />
              );
            }
            return (
              <SwipeableAgentRow
                key={agent.id}
                agent={agent}
                onPress={() => onSelect(agent)}
                onArchive={onArchive}
              />
            );
          })}

          {archivedAgents.length > 0 ? (
            <>
              <Text style={styles.archivedLabel}>Archived</Text>
              {archivedAgents.map((agent) => (
                <View key={agent.id} style={[styles.row, styles.archivedRow]}>
                  <Text style={styles.archivedName} numberOfLines={1}>
                    {agent.name}
                  </Text>
                  <TouchableOpacity
                    onPress={() => onRestore(agent)}
                    disabled={restoringId === agent.id}
                    hitSlop={8}
                    style={styles.restoreButton}
                    accessibilityRole="button"
                    accessibilityLabel={`Restore ${agent.name}`}
                  >
                    {restoringId === agent.id ? (
                      <ActivityIndicator size="small" color={theme.accent} />
                    ) : (
                      <Feather name="rotate-ccw" size={16} color={theme.accent} />
                    )}
                  </TouchableOpacity>
                </View>
              ))}
            </>
          ) : null}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <TouchableOpacity
            onPress={onNewAgent}
            style={styles.newAgent}
            accessibilityRole="button"
            accessibilityLabel="New agent"
          >
            <Feather name="plus" size={18} color={theme.mutedIcon} />
            <Text style={styles.newAgentLabel}>New Agent</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

// A single agent row. The active agent reads as a white pill with a blue left
// accent and a check; inactive agents are plain text rows.
function AgentRow({
  agent,
  active,
  onPress
}: {
  agent: AgentRecord;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.row, active && styles.rowActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Switch to ${agent.name}`}
    >
      {active ? <View style={styles.activeAccent} /> : null}
      <Text
        style={[styles.name, active && styles.nameActive]}
        numberOfLines={1}
      >
        {agent.name}
      </Text>
      {active ? (
        <View style={styles.checkCircle}>
          <Feather name="check" size={14} color={theme.accent} />
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// Inactive agent row wrapped in a left-swipe-to-archive gesture, mirroring the
// chat/agent list pattern: a left swipe reveals a red Archive action that
// closes the swipeable and hands off to the parent's confirm flow.
function SwipeableAgentRow({
  agent,
  onPress,
  onArchive
}: {
  agent: AgentRecord;
  onPress: () => void;
  onArchive: (agent: AgentRecord) => void;
}) {
  const swipeRef = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <TouchableOpacity
          onPress={() => {
            swipeRef.current?.close();
            onArchive(agent);
          }}
          activeOpacity={0.8}
          style={styles.archiveAction}
          accessibilityRole="button"
          accessibilityLabel={`Archive ${agent.name}`}
        >
          <Feather name="archive" size={18} color="#FFFFFF" />
        </TouchableOpacity>
      )}
    >
      <AgentRow agent={agent} active={false} onPress={onPress} />
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.32)" },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: theme.bgDrawer,
    paddingHorizontal: 12,
    shadowColor: "#000",
    shadowOffset: { width: 6, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 16
  },
  title: {
    color: theme.textDrawer,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 30,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 18
  },
  list: { flex: 1 },
  listContent: { paddingBottom: 12, gap: 2 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: 16,
    borderRadius: 14
  },
  // Active row: white pill lifted off the gray panel, blue left accent + check.
  rowActive: {
    backgroundColor: theme.bg,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 1
  },
  activeAccent: {
    position: "absolute",
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: theme.accent
  },
  name: {
    flex: 1,
    color: theme.textDrawer,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 17
  },
  nameActive: { fontFamily: family("HankenGrotesk", 700) },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#DCE9FF",
    alignItems: "center",
    justifyContent: "center"
  },

  // Left-swipe Archive action revealed behind an inactive agent row.
  archiveAction: {
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    marginVertical: 2,
    borderRadius: 14
  },

  archivedLabel: {
    color: theme.mutedFooter,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12,
    letterSpacing: 0.3,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4
  },
  archivedRow: { opacity: 0.6, justifyContent: "space-between" },
  archivedName: {
    flex: 1,
    color: theme.textDrawer,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 17
  },
  restoreButton: { padding: 6 },

  footer: {
    borderTopWidth: 1,
    borderTopColor: theme.borderStrong,
    paddingTop: 12
  },
  newAgent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 6
  },
  newAgentLabel: {
    color: theme.mutedFooter,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  }
});
