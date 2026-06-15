"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";
import { EmailDraftCard } from "./EmailDraftCard";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

// Reconstruct the original fenced-block source from a hast node. rehype-highlight
// wraps code text in <span> tokens, so we collect text descendants rather than
// reading a single string child — this stays correct whether or not the language
// was highlighted. Exported so tests can pin the non-element folds (null,
// childless nodes) that never occur in rendered markdown.
export function hastText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | null;
  if (!n) return "";
  if (n.type === "text") return n.value ?? "";
  if (Array.isArray(n.children)) return n.children.map(hastText).join("");
  return "";
}

// Read the fenced-block language (```lang) from a hast <code> node's class list.
// Exported for the same direct-fold tests as hastText.
export function fenceLang(codeNode: unknown): string | undefined {
  const classes = (codeNode as { properties?: { className?: unknown } } | null)?.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  const prefix = "language-";
  return classes
    .map(String)
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
}

// Resolve a markdown link's href for rendering. When `base` is set (the doc
// viewer passes the doc's own hosted URL), doc-relative targets — sibling
// `foo.md`, `../adr/bar.md`, and bare `#anchor` fragments — are resolved
// ABSOLUTE against that base so a click lands on the real hosted doc instead of
// 404-ing against the current app route (e.g. `/settings/codex.md`). Absolute
// URLs (http/https/mailto/protocol-relative) pass through untouched. Without a
// base (chat, skills) every href is left exactly as authored.
export function resolveDocHref(href: string | undefined, base?: string): string | undefined {
  if (!href || !base) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function makeComponents(linkBaseUrl?: string) {
  return {
    a: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a {...props} href={resolveDocHref(href, linkBaseUrl)} target="_blank" rel="noopener noreferrer" />
    ),
    // A ```email-draft fenced block renders as an inline draft card instead of a
    // code block. `node` is destructured out so it isn't spread onto the DOM <pre>.
    pre: ({ node, className, ...props }: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) => {
      const codeNode = (node as { children?: unknown[] } | undefined)?.children?.[0];
      if (codeNode && fenceLang(codeNode) === "email-draft") {
        return <EmailDraftCard raw={hastText(codeNode)} />;
      }
      return <pre {...props} className={cn("hljs", className)} />;
    }
  };
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming,
  linkBaseUrl
}: {
  text: string;
  streaming?: boolean;
  // When set, doc-relative links resolve absolute against this URL (the doc
  // viewer passes the doc's hosted URL); omit it for chat/skills rendering.
  linkBaseUrl?: string;
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={makeComponents(linkBaseUrl)}
      >
        {text}
      </ReactMarkdown>
      {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
    </div>
  );
});
