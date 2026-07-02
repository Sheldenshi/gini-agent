// Category tint for a generated file's icon swatch, keyed off the extension.
// Three buckets: docs/markdown/text → blue, code → green, everything else →
// purple. Light-theme tints (the mobile app is light), so these are softer
// than the web's dark-surface variants. Returned as { bg, fg } hex pairs so
// callers can apply them inline. Shared by the files card and the preview
// sheet; kept here (not in a component) to avoid a card↔sheet import cycle.
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

function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileAccent(path: string): { bg: string; fg: string } {
  const ext = extOf(path);
  if (DOC_EXTENSIONS.has(ext)) return { bg: "#EEF2FF", fg: "#3554D1" };
  if (CODE_EXTENSIONS.has(ext)) return { bg: "#E9F6EE", fg: "#1F9D55" };
  return { bg: "#F1ECFB", fg: "#7C3AED" };
}

export type PreviewKind = "markdown" | "image" | "pdf" | "csv" | "text";

// Pick the render strategy for a file from its extension. Markdown is rendered
// via the chat's markdown renderer; images decode through <Image>; csv/tsv
// become a table; pdf (and other binaries) fall back to a download/share
// notice; everything else renders as a monospace text block.
export function previewKind(filename: string): PreviewKind {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "text";
}
