import { Feather } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { family, theme } from "@/src/theme";

// "Attachments" bottom sheet built on <Modal> + the legacy Animated API,
// matching the Pencil "Add to Chat" design (grabber, header with close +
// title, source tiles). Renders on all platforms — the source tiles below
// the header host Camera / Photos.

// react-native-web warns when useNativeDriver is true (no native animated
// module on web), so opt out there while keeping the native driver on device.
const USE_NATIVE_DRIVER = Platform.OS !== "web";
const ANIM_DURATION = 220;
// Initial off-screen translate before the sheet has measured its own height;
// the entrance/exit use the cached measured height once it's known.
const FALLBACK_OFFSCREEN = 800;

// Slide the sheet up from `fromHeight` to its rest position while fading the
// backdrop in. Callers park translateY at `fromHeight` and opacity at 0 first.
function startEntrance(
  translateY: Animated.Value,
  opacity: Animated.Value,
  fromHeight: number
) {
  translateY.setValue(fromHeight);
  const anim = Animated.parallel([
    Animated.timing(translateY, {
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
  anim.start();
  return anim;
}

export interface AttachmentSource {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  onPress: () => void;
}

export function AttachmentSheet({
  visible,
  title = "Attachments",
  sources,
  onClose
}: {
  visible: boolean;
  title?: string;
  sources: AttachmentSource[];
  onClose: () => void;
}) {
  // Read insets from context rather than wrapping in <SafeAreaView>: the
  // sheet renders inside a <Modal> (separate native hierarchy on iOS), so
  // context-provided insets are the reliable measured values here.
  const insets = useSafeAreaInsets();
  // `mounted` decouples render lifetime from `visible` so the exit
  // animation runs to completion before the Modal unmounts.
  const [mounted, setMounted] = useState(visible);
  // Ref mirror of `mounted` so the effect can read mount state without
  // depending on it (which would re-run the effect on every mount toggle).
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const translateY = useRef(new Animated.Value(FALLBACK_OFFSCREEN)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  // Cache the measured sheet height so entrance/exit always travel exactly
  // the sheet's own height. 0 means "not yet measured"; `onLayout` fills it.
  const sheetHeight = useRef(0);
  // True while an open is in progress but the entrance slide hasn't started
  // yet — i.e. we're waiting on the first `onLayout` to learn the height.
  // Lets `onLayout` start the entrance exactly once per open.
  const enteringRef = useRef(false);
  // The animation currently in flight (entrance or exit), wherever it was
  // started — including the deferred entrance kicked off from `onLayout`.
  // The effect cleanup stops it on unmount or when `visible` changes.
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  // The selected source's action, deferred until the sheet unmounts. Firing
  // it while the Modal is still presented/dismissing is the iOS "present
  // while dismissing" hazard (the picker presents a native VC); we run it
  // only after the Modal is gone.
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (visible) {
      // A fresh open invalidates any action stored on a prior close that was
      // never consumed, so it can't fire when this open later dismisses.
      pendingActionRef.current = null;
      // Mount first and park the sheet fully off-screen with the backdrop
      // transparent, so nothing flashes at the rest position before measuring.
      setMounted(true);
      const offscreen = sheetHeight.current || FALLBACK_OFFSCREEN;
      translateY.setValue(offscreen);
      opacity.setValue(0);
      if (sheetHeight.current > 0) {
        // Re-open: height is already known, run the entrance now.
        enteringRef.current = false;
        animRef.current = startEntrance(translateY, opacity, sheetHeight.current);
      } else {
        // First open: defer the entrance to `onLayout`, once we know the height.
        enteringRef.current = true;
      }
      // Stop whatever animation is in flight on unmount or when `visible`
      // changes — covers the re-open entrance above and the deferred
      // entrance that `onLayout` starts on first open.
      return () => {
        animRef.current?.stop();
      };
    }
    enteringRef.current = false;
    // Nothing is mounted (e.g. the initial render with visible=false), so
    // skip the exit animation — there's no rendered sheet to slide away.
    if (!mountedRef.current) return () => {
      animRef.current?.stop();
    };
    const anim = Animated.parallel([
      Animated.timing(translateY, {
        toValue: sheetHeight.current || FALLBACK_OFFSCREEN,
        duration: ANIM_DURATION,
        useNativeDriver: USE_NATIVE_DRIVER
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: ANIM_DURATION,
        useNativeDriver: USE_NATIVE_DRIVER
      })
    ]);
    animRef.current = anim;
    anim.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => {
      animRef.current?.stop();
    };
  }, [visible, translateY, opacity]);

  // Once the sheet has fully unmounted (Modal gone), run the selected
  // source's action — so the picker's native view controller presents
  // cleanly instead of while the Modal is still dismissing.
  useEffect(() => {
    if (!mounted && pendingActionRef.current) {
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      action();
    }
  }, [mounted]);

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss attachments"
        >
          <Animated.View style={[styles.backdrop, { opacity }]} />
        </Pressable>
        <Animated.View
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height;
            if (height <= 0) return;
            sheetHeight.current = height;
            // First open deferred its entrance until the height was known.
            // Start it now, exactly once, from the measured height.
            if (enteringRef.current) {
              enteringRef.current = false;
              animRef.current = startEntrance(translateY, opacity, height);
            }
          }}
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + 20,
              transform: [{ translateY }]
            }
          ]}
        >
          <View style={styles.grabberRow}>
            <View style={styles.grabber} />
          </View>
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={18} color={theme.text} />
            </Pressable>
            <Text style={styles.title}>{title}</Text>
            <View style={styles.headerSpacer} />
          </View>
          <View style={styles.sourceRow}>
            {sources.map((source) => (
              <Pressable
                key={source.key}
                onPress={() => {
                  pendingActionRef.current = source.onPress;
                  onClose();
                }}
                style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel={source.label}
              >
                <Feather name={source.icon} size={26} color={theme.text} />
                <Text style={styles.tileLabel}>{source.label}</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: theme.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingHorizontal: 20,
    paddingTop: 10
  },
  grabberRow: { height: 14, alignItems: "center", justifyContent: "center" },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.borderStrong
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6,
    paddingBottom: 18
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.bgDrawer
  },
  title: {
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17,
    color: theme.text
  },
  headerSpacer: { width: 32, height: 32 },
  sourceRow: { flexDirection: "row", gap: 12 },
  tile: {
    flex: 1,
    height: 96,
    borderRadius: 18,
    backgroundColor: theme.bgDrawer,
    alignItems: "center",
    justifyContent: "center",
    gap: 10
  },
  tileLabel: {
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15,
    color: theme.text
  }
});
