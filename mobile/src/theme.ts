// Single light iOS-style palette. The dark theme is gone — every screen
// uses the same surface stack, so callers reference these tokens by role
// (bg, text, etc.) instead of branching on `useColorScheme`.

export const theme = {
  // Surfaces. `bg` is the white chat / detail surface; `bgDrawer` is the
  // soft gray panel behind the agent drawer.
  bg: "#FFFFFF",
  bgDrawer: "#F2F2F7",
  surface: "#FFFFFF",
  searchBg: "#F0F0F0",
  inputBg: "#FFFFFF",
  codeChipBg: "#E8E8ED",

  // Text. `text` is the primary chat color; `textDrawer` is the
  // drawer-specific primary (closer to true black). `subtle` is the
  // secondary body color; `muted` is timestamps; `mutedFooter` is the
  // drawer footer label; `mutedIcon` is the drawer "+" glyph color.
  text: "#1A1A1A",
  textDrawer: "#1C1C1E",
  subtle: "#5A5A5A",
  muted: "#8A8A8A",
  mutedFooter: "#6E6E73",
  mutedIcon: "#8E8E93",
  placeholder: "#9A9A9A",
  inputPlaceholder: "#9A9AA0",
  codeChipText: "#3A3A3C",
  toolIcon: "#4B4B4B",

  // Lines. `border` is the row divider used between chat list rows and
  // around input pills. `borderStrong` is the drawer footer divider.
  border: "#ECECEC",
  borderStrong: "#D1D1D6",
  inputBorder: "#E2E2E5",

  // Accents.
  accent: "#007AFF",
  danger: "#FF3B30",

  // Buttons. Send button is the navy circle; disabled state is a
  // lower-opacity tint so the user still sees the icon.
  button: "#0A1A3F",
  buttonDisabled: "#B8BBC7",
  buttonText: "#FFFFFF",

  // Chat bubbles. User bubble is near-black, agent bubble is the iOS
  // light gray; corner geometry is owned by each block component.
  userBubble: "#0A0A0A",
  userBubbleText: "#FFFFFF",
  assistantBubble: "#E9E9EB",
  assistantBubbleText: "#1A1A1A"
} as const;

export type Theme = typeof theme;

// `@expo-google-fonts/*` exports loaded faces named like `Inter_500Medium`,
// `HankenGrotesk_700Bold`, `JetBrainsMono_400Regular`. React Native's
// `fontFamily` style takes one of these face names directly; setting
// `fontWeight` alongside doesn't switch the face for custom fonts, so
// callers have to pick the right face string up front. `family()` is the
// single source of truth for that mapping — pass the family + weight,
// get back the loaded face name.
type FamilyName = "Inter" | "HankenGrotesk" | "JetBrainsMono";
type Weight = 400 | 500 | 600 | 700;

export function family(name: FamilyName, weight: Weight = 400): string {
  if (name === "Inter") {
    switch (weight) {
      case 700:
        return "Inter_700Bold";
      case 600:
        return "Inter_600SemiBold";
      case 500:
        return "Inter_500Medium";
      default:
        return "Inter_400Regular";
    }
  }
  if (name === "HankenGrotesk") {
    switch (weight) {
      case 700:
        return "HankenGrotesk_700Bold";
      case 600:
        return "HankenGrotesk_600SemiBold";
      case 500:
        return "HankenGrotesk_500Medium";
      default:
        return "HankenGrotesk_400Regular";
    }
  }
  // JetBrainsMono — only Regular is loaded; ignore weight.
  return "JetBrainsMono_400Regular";
}

// Deterministic avatar color from an agent id. Kept around because a few
// places import it defensively; the iOS-style design doesn't surface
// avatars at the moment, but we leave the helpers in place rather than
// chase imports across the tree.
const AVATAR_COLORS = [
  "#E17076",
  "#EE7C2C",
  "#FAA730",
  "#7BC862",
  "#6EC9CB",
  "#65AADD",
  "#A695E7",
  "#EE7AAE"
] as const;

export function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index]!;
}

export function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}
