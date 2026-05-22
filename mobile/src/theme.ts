// Shared dark palette inspired by Telegram desktop. Used as the visual
// default across all mobile screens. We expose a single `theme` object
// (rather than the older light/dark pair) because the brief currently
// ships dark as the only theme — adding light back later would mean
// reintroducing the pair, not unwinding this module.

export const theme = {
  // Surfaces. `bgRail` is the leftmost agent-rail column; `bg` is the
  // wider chat-list / detail area. `rowSelected` is the highlighted-row
  // tint used by the agent picker — a subtle step lighter than `bg` so
  // selection reads without competing with the row text.
  bg: "#17212B",
  bgRail: "#0E1621",
  rowBg: "#17212B",
  rowSelected: "#22303C",
  inputBg: "#242F3D",

  // Text.
  text: "#FFFFFF",
  subtle: "#7D8E98",

  // Lines, dividers, faint borders. Just a touch darker than the bg so
  // it reads as a separator without competing with the row text.
  border: "#0F1620",

  // Accents.
  accent: "#5288C1",
  danger: "#E55353",

  // Buttons.
  button: "#5288C1",
  buttonDisabled: "#3A4A5C",
  buttonText: "#FFFFFF",

  // Chat bubbles. User bubble uses the accent; assistant uses the input
  // surface so it sits clearly against the main bg.
  userBubble: "#2B5278",
  userBubbleText: "#FFFFFF",
  assistantBubble: "#242F3D",
  assistantBubbleText: "#FFFFFF",
  systemBubble: "#3A2E1E",
  systemBubbleText: "#F0C674"
} as const;

export type Theme = typeof theme;

// Deterministic avatar color from an agent id so the same agent always
// renders the same tint across sessions. Eight steps roughly matches
// the Telegram desktop accent set without being garish.
const AVATAR_COLORS = [
  "#E17076", // red
  "#EE7C2C", // orange
  "#FAA730", // yellow
  "#7BC862", // green
  "#6EC9CB", // cyan
  "#65AADD", // light blue
  "#A695E7", // purple
  "#EE7AAE" // pink
] as const;

export function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index]!;
}

// First non-whitespace letter of the agent name, uppercased. Falls back
// to "?" so an empty name still renders something instead of a blank
// circle.
export function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const ch = trimmed.charAt(0).toUpperCase();
  return ch;
}
