import { StyleSheet, Text } from "react-native";
import { family, theme } from "@/src/theme";
import type { SystemNoteBlock } from "@/src/types";

// Centered muted italic note. Used for terminal flags (Cancelled,
// Failed: …) and other operator-attributed lines. Kept low-key so it
// doesn't pull focus away from the assistant's reply.
export function BlockSystemNote({ block }: { block: SystemNoteBlock }) {
  return <Text style={styles.text}>{block.text}</Text>;
}

const styles = StyleSheet.create({
  text: {
    alignSelf: "center",
    textAlign: "center",
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontStyle: "italic",
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 2
  }
});
