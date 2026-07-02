// Deterministic colored-initial avatars for agents, matching the Chats
// redesign. The design assigns each agent a colored square with its first
// initial (Nova=#10A37F, Sage=#4D6BFE, Scout=#D97757, Atlas=#7B61FF, …); we
// hash the agent id to one of those hues so the same agent always renders the
// same color across the sidebar, header, chips, and thread cards.

const AGENT_COLORS = [
  "#10A37F",
  "#4D6BFE",
  "#D97757",
  "#7B61FF",
  "#4277FB",
  "#E5736B",
  "#2BB6A3",
  "#C77DFF"
] as const;

export function agentColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AGENT_COLORS.length;
  return AGENT_COLORS[index]!;
}

export function agentInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}
