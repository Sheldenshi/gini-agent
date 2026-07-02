import { cn } from "@/lib/utils";
import { agentColor, agentInitial } from "@/lib/agent-visuals";

// Colored-initial square avatar for an agent. `seed` keys the hue (use the
// agent id so the color is stable); `name` provides the initial. Sizes match
// the design: 22px in the sidebar, 24px on message heads, 52px in the header.
export function AgentAvatar({
  name,
  seed,
  size = 24,
  initialColor = "#FFFFFF",
  className
}: {
  name: string;
  seed?: string;
  size?: number;
  initialColor?: string;
  className?: string;
}) {
  const color = agentColor(seed ?? name);
  // Initial scales with the square; the design uses ~26px text in the 52px
  // header avatar and ~12px in the 24px message-head avatar.
  const fontSize = Math.round(size * 0.46);
  const radius = size >= 40 ? 12 : size >= 28 ? 8 : 6;
  return (
    <div
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center font-bold leading-none select-none", className)}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        borderRadius: radius,
        color: initialColor,
        fontSize
      }}
    >
      {agentInitial(name)}
    </div>
  );
}
