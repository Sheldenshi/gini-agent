import { StyleSheet, Text, View } from "react-native";
import { family } from "@/src/theme";

// Rounded-square initial avatar used across the Channels list, agent
// header, and thread views. Colors come from a fixed brand-ish palette
// keyed deterministically off the agent name so the same agent always
// gets the same swatch (matches the Pencil reference: Atlas violet, Nova
// green, Sage indigo, Scout terracotta, …). One swatch is a light gray
// with dark text for the "no strong color" case.
const SWATCHES: { bg: string; fg: string }[] = [
  { bg: "#7B61FF", fg: "#FFFFFF" },
  { bg: "#10A37F", fg: "#FFFFFF" },
  { bg: "#4D6BFE", fg: "#FFFFFF" },
  { bg: "#D97757", fg: "#FFFFFF" },
  { bg: "#2F6BFF", fg: "#FFFFFF" },
  { bg: "#E16B2E", fg: "#FFFFFF" },
  { bg: "#E5E5E5", fg: "#1A1A1A" }
];

export function agentSwatch(name: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return SWATCHES[Math.abs(hash) % SWATCHES.length]!;
}

export function agentInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

export function AgentAvatar({
  name,
  size = 48,
  online = false
}: {
  name: string;
  size?: number;
  online?: boolean;
}) {
  const swatch = agentSwatch(name);
  // Radius scales with size but stays in the rounded-square family the
  // design uses (≈0.27 of the side) rather than a full circle.
  const radius = Math.round(size * 0.27);
  const dot = Math.max(11, Math.round(size * 0.27));
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: radius, backgroundColor: swatch.bg }
        ]}
      >
        <Text
          style={[
            styles.initial,
            { color: swatch.fg, fontSize: Math.round(size * 0.42) }
          ]}
        >
          {agentInitial(name)}
        </Text>
      </View>
      {online ? (
        <View
          style={[
            styles.onlineDot,
            { width: dot, height: dot, borderRadius: dot / 2 }
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center" },
  initial: { fontFamily: family("HankenGrotesk", 700) },
  onlineDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    backgroundColor: "#39C36E",
    borderWidth: 2.5,
    borderColor: "#FFFFFF"
  }
});
