import {
  BookOpen,
  FilePenLine,
  FileText,
  Globe,
  Package,
  Search,
  SquareCheck,
  Terminal,
  type LucideIcon
} from "lucide-react";

export function iconForTool(toolName: string): LucideIcon {
  const name = toolName.toLowerCase();
  if (name === "file_write" || name === "file_patch") return FilePenLine;
  if (name === "file_search" || name === "search_history" || name === "web_search") return Search;
  if (name === "file_read" || name === "file_list") return FileText;
  if (name === "read_skill") return BookOpen;
  if (name === "terminal_exec" || name === "code_exec") return Terminal;
  if (name === "spawn_subagent") return SquareCheck;
  if (name.startsWith("browser_") || name === "web_fetch") return Globe;
  return Package;
}
