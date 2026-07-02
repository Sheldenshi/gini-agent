import { beforeEach, describe, expect, mock, test } from "bun:test";
// Importing the shared setup installs the (process-global) module mocks before
// the component is imported — react-native, react, theme, and the @expo/vector-
// icons Feather stub all come from here so this file stays compatible with the
// sibling chat component tests when the suite runs in one process.
import { Pressable, Text } from "./chatMockSetup";

// expo-router isn't covered by the shared setup; capture router.push so a test
// can assert the chip deep-links into the topic's chat detail. No sibling chat
// test mocks expo-router, so this process-global mock can't collide.
const pushed: string[] = [];
mock.module("expo-router", () => ({
  router: { push: (route: string) => pushed.push(route) }
}));

const { TopicForwardChip } = await import("@/src/components/chat/TopicForwardChip");

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

function render(props: { topicId: string; topicTitle?: string }): El {
  return (TopicForwardChip as unknown as (p: typeof props) => El)(props);
}

beforeEach(() => {
  pushed.length = 0;
});

describe("TopicForwardChip", () => {
  test("renders the topic title as a #-prefixed label", () => {
    const tree = render({ topicId: "topic_1", topicTitle: "World Cup trip" });
    const labels = flatten(tree)
      .filter((n) => n.type === Text)
      .map((n) => JSON.stringify(n.props.children));
    // The hashed title renders somewhere in the chip's text subtree.
    expect(labels.some((l) => l.includes("World Cup trip"))).toBe(true);
    expect(labels.some((l) => l.includes("#"))).toBe(true);
  });

  test("falls back to 'topic' when the title is blank", () => {
    const tree = render({ topicId: "topic_2", topicTitle: "   " });
    const labels = flatten(tree)
      .filter((n) => n.type === Text)
      .map((n) => JSON.stringify(n.props.children));
    expect(labels.some((l) => l.includes("topic"))).toBe(true);
  });

  test("tapping deep-links to the topic's chat detail", () => {
    const tree = render({ topicId: "topic_3", topicTitle: "Taxes" });
    const pressable = flatten(tree).find(
      (n) => n.type === Pressable && typeof n.props.onPress === "function"
    );
    if (!pressable) throw new Error("chip Pressable not found");
    (pressable.props.onPress as () => void)();
    expect(pushed).toEqual(["/chat/topic_3"]);
  });
});
