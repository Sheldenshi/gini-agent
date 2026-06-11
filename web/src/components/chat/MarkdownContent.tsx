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
// was highlighted.
function hastText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | null;
  if (!n) return "";
  if (n.type === "text") return n.value ?? "";
  if (Array.isArray(n.children)) return n.children.map(hastText).join("");
  return "";
}

// Read the fenced-block language (```lang) from a hast <code> node's class list.
function fenceLang(codeNode: unknown): string | undefined {
  const classes = (codeNode as { properties?: { className?: unknown } } | null)?.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  const prefix = "language-";
  return classes
    .map(String)
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
}

const components = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
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

export const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
      {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
    </div>
  );
});
