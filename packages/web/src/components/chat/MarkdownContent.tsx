"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ImageIcon, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadInlineUrl, uploadUrl } from "@/lib/api";
import { defaultUrlTransform } from "react-markdown";
import { uploadIdFromRef, UPLOAD_REF_SCHEME } from "@/lib/upload-ref";
import { EmailDraftCard } from "./EmailDraftCard";
import { CalendarView } from "./CalendarView";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

// react-markdown's default urlTransform sanitizes any non-safe-protocol URL
// (anything with a colon outside the http/https/mailto/… allowlist) to empty
// BEFORE the img/a component sees it — which would strip our gini-upload://
// scheme. Let upload refs pass through untouched so the img/a overrides can
// rewrite them to the BFF URL; defer to the default sanitizer for all other
// URLs (so a foreign javascript:/data: src is still neutralized).
function uploadAwareUrlTransform(url: string): string {
  if (url.startsWith(UPLOAD_REF_SCHEME)) return url;
  return defaultUrlTransform(url);
}

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

// The host of an http(s) URL (e.g. "cataas.com"), shown on the foreign-image
// chip so the reader can see where a dropped image points. Returns null for a
// non-http(s) or unparseable URL — the caller then renders nothing, so a
// `javascript:`/`data:` src can never become a chip.
export function webHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.host;
  } catch {
    return null;
  }
}

function makeComponents(linkBaseUrl?: string, dropForeignImages = false) {
  return {
    // An agent-produced attachment is authored as a `gini-upload://<id>` ref →
    // an inline <img> served from the BFF (which injects the bearer).
    //
    // For a NON-upload `src`: in `dropForeignImages` mode (model-authored chat /
    // thinking) the bytes are NOT auto-fetched — that allowlist closes the SSRF
    // / tracking-pixel surface that arbitrary model-authored image URLs would
    // open. Instead of dropping it silently (a blank gap the reader can't
    // explain), render an inert chip naming the image + host that only loads on
    // an explicit click — mirroring how a foreign text link already behaves. A
    // non-http(s) src (webHost returns null) is dropped entirely. For trusted
    // doc/file/skill markdown (the default) an ordinary image renders normally;
    // `uploadAwareUrlTransform` has already neutralized any `javascript:`/`data:`
    // src via react-markdown's default sanitizer. See ADR
    // outbound-chat-attachments.md.
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const id = uploadIdFromRef(typeof src === "string" ? src : undefined);
      if (!id) {
        if (typeof src !== "string" || src.length === 0) return null;
        if (dropForeignImages) {
          const host = webHost(src);
          if (!host) return null;
          // A SPAN, not an <a>: markdown can nest an image inside a link
          // (`[![alt](img)](target)`), and an <a> chip there would produce an
          // invalid nested anchor. The span opens the URL on explicit click via
          // window.open (noopener) — nothing fetches at render time.
          return (
            <span
              role="link"
              tabIndex={0}
              title={src}
              // preventDefault + stopPropagation so the chip OWNS the
              // activation: when it's nested inside a linked image's outer <a>
              // (`[![](img)](target)`), a bare window.open would still let the
              // click bubble to that anchor and navigate there too — one click,
              // two model-authored destinations. Stopping here keeps it to one.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(src, "_blank", "noopener,noreferrer");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  window.open(src, "_blank", "noopener,noreferrer");
                }
              }}
              className="my-1 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-sm hover:bg-accent"
            >
              <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{alt || "Image"}</span>
              <span className="shrink-0 text-muted-foreground">{host}</span>
            </span>
          );
        }
        return (
          <img
            {...props}
            src={src}
            alt={alt ?? ""}
            className="my-1 block max-h-80 max-w-full rounded-lg border object-contain"
          />
        );
      }
      return (
        <a href={uploadUrl(id)} target="_blank" rel="noopener noreferrer" className="block">
          <img
            {...props}
            src={uploadUrl(id)}
            alt={alt ?? "attachment"}
            className="my-1 block max-h-80 max-w-full rounded-lg border object-contain"
          />
        </a>
      );
    },
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      // A `gini-upload://<id>` link is a non-image attachment — render a
      // chip that opens the upload as an inline PREVIEW in a new tab (PDFs and
      // images render in the browser's viewer; .md/.csv/.json/.txt show as raw
      // text; unsafe types fall back to a download server-side). Foreign links
      // keep the standard doc-href resolution below.
      const uploadId = uploadIdFromRef(href);
      if (uploadId) {
        return (
          <a
            href={uploadInlineUrl(uploadId)}
            target="_blank"
            rel="noopener noreferrer"
            className="my-1 inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{children ?? "attachment"}</span>
          </a>
        );
      }
      return (
        <a {...props} href={resolveDocHref(href, linkBaseUrl)} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    // A ```email-draft fenced block renders as an inline draft card, and a
    // ```calendar fence renders as an inline calendar preview, instead of a code
    // block. `node` is destructured out so it isn't spread onto the DOM <pre>.
    pre: ({ node, className, ...props }: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) => {
      const codeNode = (node as { children?: unknown[] } | undefined)?.children?.[0];
      if (codeNode && fenceLang(codeNode) === "email-draft") {
        return <EmailDraftCard raw={hastText(codeNode)} />;
      }
      if (codeNode && fenceLang(codeNode) === "calendar") {
        return <CalendarView raw={hastText(codeNode)} />;
      }
      return <pre {...props} className={cn("hljs", className)} />;
    }
  };
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming,
  linkBaseUrl,
  dropForeignImages
}: {
  text: string;
  streaming?: boolean;
  // When set, doc-relative links resolve absolute against this URL (the doc
  // viewer passes the doc's hosted URL); omit it for chat/skills rendering.
  linkBaseUrl?: string;
  // When true, only `gini-upload://` image refs render inline; a foreign http(s)
  // image is NOT auto-fetched (the SSRF / tracking-pixel guard for UNTRUSTED
  // model-authored chat/thinking text) but renders an inert chip that loads only
  // on explicit click, and a non-http(s) src is dropped entirely. Leave unset for
  // trusted doc/file/skill markdown so ordinary images render. See ADR
  // outbound-chat-attachments.md.
  dropForeignImages?: boolean;
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={uploadAwareUrlTransform}
        components={makeComponents(linkBaseUrl, dropForeignImages)}
      >
        {text}
      </ReactMarkdown>
      {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
    </div>
  );
});
