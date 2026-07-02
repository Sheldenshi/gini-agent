// Convert lightweight Markdown to Telegram MarkdownV2.
//
// Telegram's MarkdownV2 has two sharp edges:
//   1. Every special char outside a code span must be backslash-escaped,
//      even ones that look harmless (`.`, `-`, `!`). A single un-escaped
//      special anywhere in the body makes the API reject the message.
//   2. The set of recognized formatting markers differs from CommonMark:
//      bold is `*bold*` (single asterisk), not `**bold**`.
//
// We accept the common Markdown subset agents tend to produce — fenced
// code blocks, inline code, and `**bold**` — and convert just that.
// Italics are not auto-detected; a stray `*` or `_` is treated as a
// literal character and escaped. Anything more elaborate (headers,
// lists, links) gets escaped to literal text and rendered as plain
// prose.
//
// References:
//   https://core.telegram.org/bots/api#markdownv2-style

// MarkdownV2 specials per the spec.
const MDV2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

// Inside fenced and inline code spans only ` and \ need escaping.
const MDV2_CODE_SPECIALS = /[`\\]/g;

// Sentinel byte ranges used while shuffling code/bold tokens through the
// escape pass. These ASCII control codes (0x01–0x04) cannot appear in
// normal user input, so they round-trip cleanly through
// escapeMarkdownV2Literal (which only touches MDV2 specials).
const CODE_SENTINEL_OPEN = "";
const CODE_SENTINEL_CLOSE = "";
const BOLD_SENTINEL_OPEN = "";
const BOLD_SENTINEL_CLOSE = "";

export function escapeMarkdownV2Literal(text: string): string {
  return text.replace(MDV2_SPECIALS, (c) => `\\${c}`);
}

function escapeMarkdownV2InsideCode(text: string): string {
  return text.replace(MDV2_CODE_SPECIALS, (c) => `\\${c}`);
}

type CodeToken = { kind: "fence" | "inline"; inner: string };

// Pull out fenced and inline code spans first. Their inner content
// bypasses the MDV2 special-char escape pass entirely (only ` and \
// need escaping inside code), and the bold pre-pass needs them hidden
// so a bold run that wraps a code span (`**`cmd`**` from agents) is
// recognized as one span instead of two orphan `**` markers stranded
// on either side of the code.
function hideCodeSpans(input: string, tokens: CodeToken[]): string {
  return input.replace(/```([\s\S]*?)```|`([^`\n]*)`/g, (_match, fence, inline) => {
    tokens.push(
      fence !== undefined
        ? { kind: "fence", inner: fence }
        : { kind: "inline", inner: inline ?? "" }
    );
    return `${CODE_SENTINEL_OPEN}${tokens.length - 1}${CODE_SENTINEL_CLOSE}`;
  });
}

// Match `**X**` greedily after code spans have been replaced with
// placeholders. The inner content must not contain `*` or newlines —
// that constraint stays so we don't accidentally match across paragraph
// boundaries or eat literal asterisks.
function captureBold(input: string, runs: string[]): string {
  return input.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, (_m, inner: string) => {
    runs.push(inner);
    return `${BOLD_SENTINEL_OPEN}${runs.length - 1}${BOLD_SENTINEL_CLOSE}`;
  });
}

// Tokenize the input into code blocks, inline-code spans, and prose. Code
// regions are preserved (with their internal specials escaped); prose is
// transformed and escaped.
export function formatTelegramMarkdownV2(input: string): string {
  if (input.length === 0) return input;

  const codeTokens: CodeToken[] = [];
  const boldRuns: string[] = [];
  let work = hideCodeSpans(input, codeTokens);
  work = captureBold(work, boldRuns);
  work = escapeMarkdownV2Literal(work);

  // Restore bold runs. The original inner may itself contain a code
  // placeholder; we escape the prose parts but pass the placeholder
  // through so the code-span restore step below picks it up.
  //
  // Caveat: Telegram MDV2 does not reliably support inline code nested
  // inside bold. When a bold run wraps a single code token (with only
  // whitespace around it), we drop the bold markers entirely and let
  // the code span render on its own — that preserves the agent's
  // intent (highlight a command name) without provoking a malformed
  // MDV2 entity error from the API.
  work = work.replace(
    new RegExp(`${BOLD_SENTINEL_OPEN}(\\d+)${BOLD_SENTINEL_CLOSE}`, "g"),
    (_m, indexStr: string) => {
      const inner = boldRuns[Number(indexStr)] ?? "";
      const justCode = new RegExp(`^\\s*${CODE_SENTINEL_OPEN}\\d+${CODE_SENTINEL_CLOSE}\\s*$`).test(inner);
      if (justCode) return escapeBoldInner(inner);
      return `*${escapeBoldInner(inner)}*`;
    }
  );

  // Restore code spans after every other transform has settled. Doing
  // this last means the bold pass never sees raw backticks, and the
  // escape pass never touches the code interior.
  work = work.replace(
    new RegExp(`${CODE_SENTINEL_OPEN}(\\d+)${CODE_SENTINEL_CLOSE}`, "g"),
    (_m, indexStr: string) => {
      const tok = codeTokens[Number(indexStr)];
      if (!tok) return "";
      const inner = escapeMarkdownV2InsideCode(tok.inner);
      return tok.kind === "fence" ? "```" + inner + "```" : "`" + inner + "`";
    }
  );

  return work;
}

// Escape the inner content of a bold run while letting code placeholders
// pass through (the code-span restore step picks them up by sentinel).
function escapeBoldInner(text: string): string {
  // Split on code placeholders, escape the prose pieces, leave the
  // placeholders intact. Cheaper than running the full escape and then
  // trying to undo it where it touched the placeholder digits.
  const pieces = text.split(
    new RegExp(`(${CODE_SENTINEL_OPEN}\\d+${CODE_SENTINEL_CLOSE})`)
  );
  return pieces
    .map((piece) =>
      piece.startsWith(CODE_SENTINEL_OPEN) ? piece : escapeMarkdownV2Literal(piece)
    )
    .join("");
}
