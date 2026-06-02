import { Feather } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { authHeader, uploadUrl } from "@/src/api";
import { useImagePreview } from "@/src/components/ImagePreview";
import { family, theme } from "@/src/theme";
import type { AudioAttachment, UserTextBlock } from "@/src/types";
import { SelectableBlockText } from "./SelectableBlockText";

// Right-aligned dark bubble. The asymmetric corner geometry has a
// sharper bottom-left so the bubble visually "points" toward the
// user-bubble corner of the conversation (which is the closest edge to
// the input bar). No author/time header — the design uses alignment
// and color alone as the role signal.
//
// Attached images render as a wrapped grid of thumbnails above the
// bubble. The bubble itself is omitted when the user only sent images
// (no text), so an image-only message doesn't show an empty pill.
export function BlockUserText({ block }: { block: UserTextBlock }) {
  const images = block.images ?? [];
  const hasText = block.text.length > 0;
  // Gateway uploads require the same bearer token the SSE / REST paths
  // use; <Image> on RN supports a headers prop on its source object.
  const headers = authHeader();
  const { open } = useImagePreview();
  return (
    <View style={styles.row}>
      {images.length > 0 ? (
        <View style={styles.imageGrid}>
          {images.map((image) => {
            const uri = uploadUrl(image.id);
            return (
              <Pressable
                key={image.id}
                style={styles.imageWrapper}
                onPress={() => open({ uri, headers })}
                accessibilityRole="button"
                accessibilityLabel="Open image"
              >
                <Image
                  source={{ uri, headers }}
                  style={styles.image}
                  resizeMode="cover"
                />
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {block.audio ? <VoiceBubble audio={block.audio} /> : null}
      {hasText ? (
        <View style={styles.bubble}>
          <SelectableBlockText style={styles.text}>
            {block.text}
          </SelectableBlockText>
        </View>
      ) : null}
    </View>
  );
}

// Telegram-style playable voice bubble. The recording is streamed from
// the gateway, which requires the same bearer header the <Image> path
// uses — expo-audio's remote AudioSource accepts a `headers` map. The
// track fills as playback advances; tapping play after the clip finishes
// restarts it from the beginning.
function VoiceBubble({ audio }: { audio: AudioAttachment }) {
  const player = useAudioPlayer({ uri: uploadUrl(audio.id), headers: authHeader() });
  const status = useAudioPlayerStatus(player);

  // Prefer the decoded duration once it's known; fall back to the
  // client-measured length so the m:ss reads correctly before load.
  const durationMs =
    status.duration > 0 ? status.duration * 1000 : (audio.durationMs ?? 0);
  const positionMs = status.currentTime * 1000;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const remainingMs = status.playing ? Math.max(0, durationMs - positionMs) : durationMs;

  const toggle = (): void => {
    if (status.playing) {
      player.pause();
    } else {
      if (status.didJustFinish || status.currentTime >= status.duration) {
        void player.seekTo(0);
      }
      player.play();
    }
  };

  return (
    <View style={styles.voiceBubble}>
      <Pressable
        onPress={toggle}
        hitSlop={8}
        style={styles.voicePlay}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause voice message" : "Play voice message"}
      >
        <Feather
          name={status.playing ? "pause" : "play"}
          size={16}
          color={theme.userBubbleText}
        />
      </Pressable>
      <View style={styles.voiceTrack}>
        <View style={[styles.voiceProgress, { width: `${progress * 100}%` }]} />
      </View>
      <Text style={styles.voiceDuration}>{formatDuration(remainingMs)}</Text>
    </View>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    alignItems: "flex-end",
    gap: 6
  },
  bubble: {
    backgroundColor: theme.userBubble,
    paddingVertical: 12,
    paddingHorizontal: 16,
    // RN takes the four corner radii individually — top-left, top-right,
    // bottom-right, bottom-left. The bottom-right corner is the sharp
    // one for the user bubble (mirrors the Pencil design).
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  text: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    lineHeight: 22
  },
  // Voice control reuses the user-bubble color + corner geometry so it
  // reads as part of the same right-aligned message.
  voiceBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 200,
    backgroundColor: theme.userBubble,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  voicePlay: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center"
  },
  voiceTrack: {
    flex: 1,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: "rgba(255,255,255,0.3)",
    overflow: "hidden"
  },
  voiceProgress: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: theme.userBubbleText
  },
  voiceDuration: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13,
    minWidth: 34,
    textAlign: "right"
  },
  imageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6
  },
  imageWrapper: {
    width: 160,
    height: 160,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.codeChipBg
  },
  image: {
    width: "100%",
    height: "100%"
  }
});
