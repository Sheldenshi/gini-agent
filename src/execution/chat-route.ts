// Chat intake router (ADR chat-topics-tasks-subagents.md — Routing section,
// Resolved decisions 1 & 2).
//
// When a user posts in their Chat (a kind:"agent" session), this classifies the
// message at INTAKE — before any context loads, because the decision selects
// which transcript loads — into one of three routes:
//   - "chat"           trivial/conversational → answer in Chat as today.
//   - "new_topic"      a new substantive subject → mint a Topic, run the turn there.
//   - "existing_topic" continues an ongoing subject → run the turn in that Topic.
//
// The mechanism is a structured classifier (a small generateStructured call,
// modeled on generateChatTitleFromBlocks), NOT mid-turn agent control tools: a
// forced structured output is more reliable than hoping the agent calls a tool,
// and the decision must precede context loading. The new-vs-existing-vs-inline
// bias lives entirely in this router's own prompt.

import { generateStructured } from "../provider";
import { cosineSimilarity, getEmbeddingProvider } from "../embeddings";
import { readState, recordUsage } from "../state";
import type { ChatSessionRecord, RuntimeConfig } from "../types";
import { providerOverrideForRuntime } from "./effective-context";

export type RouteDecision =
  | { decision: "chat" }
  | { decision: "new_topic"; title: string }
  | { decision: "existing_topic"; topicId: string };

// A Topic the router can route into, surfaced to the model in the prompt.
interface RouteCandidate {
  topicId: string;
  title: string;
  topicSummary?: string;
}

// Pass every candidate to the model when there are at most this many topics.
// Beyond it, an embedding pre-filter narrows to the top-K most similar before
// the structured call so the prompt stays bounded.
const MAX_ROUTE_CANDIDATES = 12;

export async function routeChatMessage(
  config: RuntimeConfig,
  chatSessionId: string,
  content: string
): Promise<RouteDecision> {
  const state = readState(config.instance);
  const chatSession = state.chatSessions.find((item) => item.id === chatSessionId);
  if (!chatSession) return { decision: "chat" };
  const agentId = chatSession.agentId;

  const topics = state.chatSessions.filter(
    (session) =>
      session.agentId === agentId &&
      session.kind === "topic" &&
      !session.archivedAt
  );
  const candidates = await selectCandidates(config, content, topics);

  const result = await generateStructured(
    config,
    {
      schemaName: "ChatRoute",
      echoTag: "chat-route",
      system: buildSystemPrompt(candidates.length > 0),
      user: buildUserPrompt(content, candidates),
      validator: {
        parse: (value: unknown) => coerceDecision(value, candidates, content)
      }
    },
    providerOverrideForRuntime(config)
  );
  void recordUsage(config.instance, { source: "chat-route", agentId }, result.cost).catch(() => {});
  return result.data;
}

// Pick the candidate Topics to show the model. At or below the cap, pass them
// all. Above it, embed the message + each candidate's title/summary and take
// the top-MAX_ROUTE_CANDIDATES by cosine similarity. Any embedding failure
// falls back to the most-recently-updated topics so routing never hard-fails.
async function selectCandidates(
  config: RuntimeConfig,
  content: string,
  topics: ChatSessionRecord[]
): Promise<RouteCandidate[]> {
  const toCandidate = (session: ChatSessionRecord): RouteCandidate => ({
    topicId: session.id,
    title: session.title,
    ...(session.topicSummary ? { topicSummary: session.topicSummary } : {})
  });
  if (topics.length <= MAX_ROUTE_CANDIDATES) {
    return topics.map(toCandidate);
  }
  try {
    const provider = getEmbeddingProvider(config);
    const candidateTexts = topics.map(
      (session) => `${session.title}\n${session.topicSummary ?? ""}`
    );
    const [queryVector, ...candidateVectors] = await provider.embed([content, ...candidateTexts]);
    if (!queryVector) throw new Error("missing query embedding");
    return topics
      .map((session, index) => ({
        session,
        score: cosineSimilarity(queryVector, candidateVectors[index]!)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ROUTE_CANDIDATES)
      .map((entry) => toCandidate(entry.session));
  } catch {
    return [...topics]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, MAX_ROUTE_CANDIDATES)
      .map(toCandidate);
  }
}

function buildSystemPrompt(hasCandidates: boolean): string {
  const routes = [
    "You route a user's chat message to one of these destinations.",
    "Return JSON {decision, topicId?, title?} where decision is one of:",
    '- "chat": a one-liner, greeting, or quick factual ask. Prefer this for anything trivial or conversational.',
    '- "new_topic": a genuinely new piece of work or project worth its own thread. Set title to a short subject name (2 to 7 words).'
  ];
  if (hasCandidates) {
    routes.push(
      '- "existing_topic": the message clearly extends one of the listed topics. Set topicId to that topic\'s id.',
      "Choose existing_topic only when the message plainly continues a listed topic; otherwise prefer chat or new_topic."
    );
  } else {
    routes.push(
      "There are no existing topics, so you may only choose \"chat\" or \"new_topic\"."
    );
  }
  return routes.join(" ");
}

function buildUserPrompt(content: string, candidates: RouteCandidate[]): string {
  const lines = [`Message:\n${content}`];
  if (candidates.length > 0) {
    const list = candidates
      .map((c) => `#${c.title} (id=${c.topicId}): ${c.topicSummary ?? ""}`)
      .join("\n");
    lines.push(`\nExisting topics:\n${list}`);
  }
  return lines.join("\n");
}

// Coerce an arbitrary model result into a safe RouteDecision. Anything
// unparseable or unknown becomes "chat"; an existing_topic whose topicId isn't a
// real candidate downgrades to "chat"; a new_topic with an empty title falls
// back to a content-derived stub.
function coerceDecision(
  value: unknown,
  candidates: RouteCandidate[],
  content: string
): RouteDecision {
  if (!value || typeof value !== "object") return { decision: "chat" };
  const record = value as { decision?: unknown; topicId?: unknown; title?: unknown };
  if (record.decision === "existing_topic") {
    const topicId = typeof record.topicId === "string" ? record.topicId : "";
    if (candidates.some((c) => c.topicId === topicId)) {
      return { decision: "existing_topic", topicId };
    }
    return { decision: "chat" };
  }
  if (record.decision === "new_topic") {
    const title = sanitizeRouteTitle(record.title) ?? contentTitleStub(content);
    return { decision: "new_topic", title };
  }
  return { decision: "chat" };
}

// Trim and bound a model-supplied topic title; returns undefined when empty.
function sanitizeRouteTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^["'`*_#\s.?!:;,-]+|["'`*_#\s.?!:;,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title : undefined;
}

// Fallback title when the model returns new_topic with no usable title: the
// first few words of the message, so a Topic is never minted untitled.
function contentTitleStub(content: string): string {
  const words = content.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.length > 0 ? words.join(" ") : "New topic";
}
