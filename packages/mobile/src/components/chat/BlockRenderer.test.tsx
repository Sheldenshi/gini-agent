import { beforeEach, describe, expect, mock, test } from "bun:test";
// The shared setup installs the (process-global) react / react-native / theme
// mocks before BlockRenderer is imported, so View resolves to the identity stub
// the tree assertions compare against.
import { View } from "./chatMockSetup";

// Stub each per-kind row + the forward chip to identity-comparable markers so
// the dispatcher is exercised on its own. bun's mock.module is process-global,
// but these module ids are unique to this test, so no sibling test collides.
function AuthCard() {
  return null;
}
function SetupCard() {
  return null;
}
function ForwardChip() {
  return null;
}
function Stub() {
  return null;
}
mock.module("@/src/components/chat/BlockAuthorizationRequested", () => ({ BlockAuthorizationRequested: AuthCard }));
mock.module("@/src/components/chat/BlockSetupRequested", () => ({ BlockSetupRequested: SetupCard }));
mock.module("@/src/components/chat/BlockAssistantText", () => ({ BlockAssistantText: Stub }));
mock.module("@/src/components/chat/BlockPhase", () => ({ BlockPhase: Stub }));
mock.module("@/src/components/chat/BlockSystemNote", () => ({ BlockSystemNote: Stub }));
mock.module("@/src/components/chat/BlockToolCall", () => ({ BlockToolCall: Stub }));
mock.module("@/src/components/chat/BlockUserText", () => ({ BlockUserText: Stub }));
mock.module("@/src/components/chat/TopicForwardChip", () => ({ TopicForwardChip: ForwardChip }));

const { BlockRenderer } = await import("@/src/components/chat/BlockRenderer");

type El =
  | { type: unknown; props: { children?: unknown; [k: string]: unknown } }
  | null
  | undefined
  | string
  | number
  | boolean;

function flatten(node: El, out: Array<Exclude<El, null | undefined | string | number | boolean>> = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  const kids = (node as { props?: { children?: unknown } }).props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  for (const k of list) flatten(k as El, out);
  return out;
}

function render(props: Parameters<typeof BlockRenderer>[0]): El {
  return (BlockRenderer as unknown as (p: typeof props) => El)(props);
}

const base = {
  id: "b1",
  sessionId: "s",
  instance: "test" as const,
  ordinal: 0,
  createdAt: "2026-01-01T00:00:00.000Z"
};

const setupBlock = (extra = {}) =>
  ({ ...base, kind: "setup_requested", setupRequestId: "sr1", action: "confirmation.request", summary: "Confirm", ...extra }) as const;
const authBlock = (extra = {}) =>
  ({ ...base, kind: "authorization_requested", authorizationId: "az1", action: "terminal.exec", risk: "high", summary: "Run", ...extra }) as const;

beforeEach(() => {});

describe("BlockRenderer (mobile)", () => {
  test("a forwarded setup_requested gate renders the card and the topic chip below it", () => {
    const tree = render(
      { block: setupBlock({ forwardedFromTopicId: "topic-9", forwardedFromTopicTitle: "Taxes" }) } as Parameters<typeof BlockRenderer>[0]
    );
    const nodes = flatten(tree);
    expect(nodes.some((n) => n.type === SetupCard)).toBe(true);
    const chip = nodes.find((n) => n.type === ForwardChip);
    expect(chip).toBeDefined();
    expect(chip?.props.topicId).toBe("topic-9");
    expect(chip?.props.topicTitle).toBe("Taxes");
  });

  test("a non-forwarded setup_requested gate renders the bare card with no chip", () => {
    const tree = render({ block: setupBlock() } as Parameters<typeof BlockRenderer>[0]);
    const nodes = flatten(tree);
    expect(nodes.some((n) => n.type === SetupCard)).toBe(true);
    expect(nodes.some((n) => n.type === ForwardChip)).toBe(false);
    // Bare card: no wrapping View was introduced.
    expect(tree && (tree as { type: unknown }).type).toBe(SetupCard);
  });

  test("a forwarded authorization_requested gate renders the card and the topic chip below it", () => {
    const tree = render(
      { block: authBlock({ forwardedFromTopicId: "topic-5", forwardedFromTopicTitle: "Trip" }) } as Parameters<typeof BlockRenderer>[0]
    );
    const nodes = flatten(tree);
    expect(nodes.some((n) => n.type === AuthCard)).toBe(true);
    const chip = nodes.find((n) => n.type === ForwardChip);
    expect(chip?.props.topicId).toBe("topic-5");
  });

  test("a non-forwarded authorization_requested gate renders the bare card with no chip", () => {
    const tree = render({ block: authBlock() } as Parameters<typeof BlockRenderer>[0]);
    const nodes = flatten(tree);
    expect(nodes.some((n) => n.type === AuthCard)).toBe(true);
    expect(nodes.some((n) => n.type === ForwardChip)).toBe(false);
    expect(tree && (tree as { type: unknown }).type).toBe(AuthCard);
  });

  test("the forwarded wrapper is a View", () => {
    const tree = render(
      { block: setupBlock({ forwardedFromTopicId: "t" }) } as Parameters<typeof BlockRenderer>[0]
    );
    expect(tree && (tree as { type: unknown }).type).toBe(View);
  });
});
