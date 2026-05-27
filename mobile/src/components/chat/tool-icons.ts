import type { Feather } from "@expo/vector-icons";

// Mobile uses `Feather` everywhere already; the family parameter is
// kept on the return type so a future caller can switch to a richer
// vector set (e.g. MaterialIcons) without rewriting every site.
type FeatherName = React.ComponentProps<typeof Feather>["name"];

export interface ToolIcon {
  name: FeatherName;
  family: "Feather";
}

// `toolName` → category icon. Mirrors web/src/components/chat/tool-icons.ts
// so the iOS chat surface shows the same category icon set as the web app
// (translated from Lucide to the closest Feather glyph — Feather doesn't
// ship a 1:1 for every Lucide icon used on web).
export function iconForTool(toolName: string): ToolIcon {
  const name = toolName.toLowerCase();
  if (name === "file_write" || name === "file_patch") return { name: "edit-3", family: "Feather" };
  if (name === "file_search" || name === "search_history") return { name: "search", family: "Feather" };
  if (name === "file_read" || name === "file_list") return { name: "file-text", family: "Feather" };
  if (name === "read_skill") return { name: "book-open", family: "Feather" };
  if (name === "terminal_exec" || name === "code_exec") return { name: "terminal", family: "Feather" };
  if (name === "spawn_subagent") return { name: "check-square", family: "Feather" };
  if (name.startsWith("browser_") || name === "web_fetch") return { name: "globe", family: "Feather" };
  return { name: "package", family: "Feather" };
}
