// Category tint for a generated file's icon swatch, keyed off the extension.
// Three buckets: docs/markdown/text → blue, code → green, everything else →
// purple. Returned as { bg, fg } hex pairs so callers can apply them inline,
// matching the chat components' hardcoded-hex style.
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "yaml",
  "yml",
  "py",
  "go",
  "rs",
  "sh",
  "css",
  "html"
]);
const DOC_EXTENSIONS = new Set(["md", "markdown", "txt", "text"]);

export function fileAccent(path: string): { bg: string; fg: string } {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (DOC_EXTENSIONS.has(ext)) return { bg: "#1B2638", fg: "#4277FB" };
  if (CODE_EXTENSIONS.has(ext)) return { bg: "#19281F", fg: "#4DC97E" };
  return { bg: "#241B36", fg: "#A78BFA" };
}
