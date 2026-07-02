import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { family, theme } from "@/src/theme";
import type { PhaseBlock } from "@/src/types";

// Phase indicator driven by the block's `label`. The runtime owns the
// vocabulary ("Thinking", "Working: <tool>", "Waiting for approval",
// "Completed", "Cancelled", "Failed") so the renderer stays dumb —
// whatever string the block carries is what shows up next to the dots.
//
// The bouncing-dots animation only renders for non-terminal phases. A
// completed/cancelled/failed phase is a historical marker that should
// sit quietly in the transcript without pulling the eye — though the
// chat detail screen filters those out at the parent level anyway, so
// in practice this component renders only for in-flight phases.
const TERMINAL_LABELS = new Set<string>(["Completed", "Cancelled", "Failed"]);

export function BlockPhase({ block }: { block: PhaseBlock }) {
  const isTerminal = TERMINAL_LABELS.has(block.label);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{block.label}</Text>
      {isTerminal ? null : <Dots />}
    </View>
  );
}

function Dots() {
  return (
    <View style={styles.dots}>
      <Dot delay={0} />
      <Dot delay={150} />
      <Dot delay={300} />
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, {
          toValue: 1,
          duration: 400,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(v, {
          toValue: 0,
          duration: 400,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [v, delay]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] });
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  return (
    <Animated.View
      style={[styles.dot, { transform: [{ translateY }], opacity }]}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
    paddingVertical: 4
  },
  label: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13
  },
  dots: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: theme.muted
  }
});
