import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  FadeIn,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Source shape mirrors what a react-native <Image> accepts: a uri plus
// the optional auth headers the gateway requires for upload URLs. The
// preview reuses whatever the thumbnail used so an authenticated image
// renders identically full-screen.
export interface PreviewSource {
  uri: string;
  headers?: Record<string, string>;
}

interface ImagePreviewContextValue {
  open: (source: PreviewSource) => void;
}

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);

export function useImagePreview(): ImagePreviewContextValue {
  const ctx = useContext(ImagePreviewContext);
  if (!ctx) {
    throw new Error("useImagePreview must be used within an ImagePreviewProvider");
  }
  return ctx;
}

// Dismiss is decided by the *release motion* (iOS Photos style): a downward
// release flings the photo off; reversing upward snaps it back even when
// it's still below center; a near-stationary release falls back to how far
// it was dragged (DISMISS_THRESHOLD). RELEASE_SLOP is the |velocityY| (px/s)
// under which a release counts as stationary rather than up/down.
const DISMISS_THRESHOLD = 8;
const RELEASE_SLOP = 100;

// Mounts a single full-screen viewer above the rest of the app and hands
// children an `open()` to summon it. Rendering one overlay at the root
// (rather than per-thumbnail) keeps the gesture surface and z-order
// simple and lets any nested image trigger the same preview.
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<PreviewSource | null>(null);
  const open = useCallback((next: PreviewSource) => setSource(next), []);
  const value = useMemo<ImagePreviewContextValue>(() => ({ open }), [open]);
  return (
    <ImagePreviewContext.Provider value={value}>
      {children}
      {source ? (
        // Key by uri so opening a different image remounts with fresh
        // shared values instead of inheriting the last drag offset.
        <FullScreenImagePreview
          key={source.uri}
          source={source}
          onClose={() => setSource(null)}
        />
      ) : null}
    </ImagePreviewContext.Provider>
  );
}

function FullScreenImagePreview({
  source,
  onClose
}: {
  source: PreviewSource;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const close = useCallback(() => onClose(), [onClose]);

  // Pan drives the dismiss: the photo tracks the finger, and onEnd either
  // flings it the rest of the way off-screen (then closes) or springs it
  // back to center. Distance OR velocity can trigger the dismiss so a
  // short, fast flick feels as responsive as a long, slow drag.
  const pan = Gesture.Pan()
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
    })
    .onEnd((event) => {
      // Decide on the release motion, not net distance. Reversing upward
      // (you changed your mind mid-drag and want to keep looking) snaps the
      // photo back even if it's still below center. A downward release
      // flings it off, continuing the horizontal direction it was heading.
      // A near-stationary release falls back to how far it was dragged.
      const movingUp = event.velocityY < -RELEASE_SLOP;
      const movingDown = event.velocityY > RELEASE_SLOP;
      const dismiss = movingUp
        ? false
        : movingDown
          ? true
          : event.translationY > DISMISS_THRESHOLD;
      if (dismiss) {
        translateX.value = withTiming(event.translationX + event.velocityX * 0.1, {
          duration: 220
        });
        translateY.value = withTiming(height + 200, { duration: 220 }, (finished) => {
          if (finished) runOnJS(close)();
        });
      } else {
        translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
        translateY.value = withSpring(0, { damping: 20, stiffness: 200 });
      }
    });

  // A clean tap (no drag) also closes — the pan wins when there's
  // movement, the tap only fires on a still press.
  const tap = Gesture.Tap().onEnd(() => {
    runOnJS(close)();
  });

  const gesture = Gesture.Exclusive(pan, tap);

  const backdropStyle = useAnimatedStyle(() => {
    // Fade with total displacement so a diagonal drag dims the backdrop
    // just like a straight one.
    const distance = Math.sqrt(
      translateX.value * translateX.value + translateY.value * translateY.value
    );
    return {
      opacity: interpolate(distance, [0, height * 0.5], [1, 0], Extrapolation.CLAMP)
    };
  });

  const imageStyle = useAnimatedStyle(() => {
    const distance = Math.sqrt(
      translateX.value * translateX.value + translateY.value * translateY.value
    );
    const scale = interpolate(distance, [0, height * 0.6], [1, 0.7], Extrapolation.CLAMP);
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale }
      ]
    };
  });

  return (
    <View style={[StyleSheet.absoluteFill, styles.overlay]}>
      <Animated.View
        entering={FadeIn.duration(160)}
        style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}
      />
      <GestureDetector gesture={gesture}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, imageStyle]}>
          <Image
            source={source}
            style={{ width, height }}
            resizeMode="contain"
            accessibilityLabel="Full screen image"
          />
        </Animated.View>
      </GestureDetector>
      <Pressable
        onPress={close}
        style={[styles.closeButton, { top: insets.top + 8 }]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close image"
      >
        <Text style={styles.closeIcon}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    // Sit above the navigation stack and any screen chrome.
    zIndex: 1000,
    elevation: 1000
  },
  backdrop: {
    backgroundColor: "#000000"
  },
  center: {
    alignItems: "center",
    justifyContent: "center"
  },
  closeButton: {
    position: "absolute",
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)"
  },
  closeIcon: {
    color: "#FFFFFF",
    fontSize: 18,
    lineHeight: 20,
    fontWeight: "600"
  }
});
