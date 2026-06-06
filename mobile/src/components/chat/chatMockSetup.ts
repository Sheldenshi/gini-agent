// Shared bun-test mock setup for the chat markdown components. Both
// BlockAssistantText.test and linkContextMenu.test import this so they install
// ONE identical, superset set of module mocks. bun's mock.module is
// process-global, so divergent per-file mocks would clobber each other when the
// files run in the same process (e.g. `bun test --changed`); a single shared
// shape keeps them compatible. This file is not a test (no `.test`/`.spec` in
// its name) so the runner won't collect it.
import { mock } from "bun:test";
import * as ReactActual from "react";

// Identity-comparable stand-ins for native primitives. We never mount them;
// tests assert on element.type === Text etc. and read element.props.
export function Text() {
  return null;
}
export function TextInput() {
  return null;
}
export function View() {
  return null;
}
export function Pressable() {
  return null;
}
export function AnimatedView() {
  return null;
}
export function Stub() {
  return null;
}

// Mutable so a test can pick the iOS vs. non-iOS branch.
export const Platform = { OS: "ios" as "ios" | "android" | "web" };
export const dims = { width: 400, height: 800 };

export const openBrowserAsync = mock((_url: string) => Promise.resolve());
export const linkingOpenURL = mock((_url: string) => Promise.resolve());
export const setStringAsync = mock((_s: string) => Promise.resolve(true));
export const share = mock((_opts: unknown) => Promise.resolve({} as never));
export const loopStart = mock(() => {});
export const loopStop = mock(() => {});

// Controllable useState backing for invoking hook components as plain
// functions; a test sets hostStateRef.current before invoking the host.
export const hostStateRef: { current: unknown } = { current: null };
export const setRequest = mock((v: unknown) => {
  hostStateRef.current = v;
});
export const effectCleanups: Array<() => void> = [];

mock.module("react-native", () => ({
  Platform,
  Text,
  TextInput,
  View,
  Pressable,
  Share: { share },
  Linking: { openURL: linkingOpenURL },
  StyleSheet: {
    create: (s: unknown) => s,
    hairlineWidth: 1,
    absoluteFillObject: {}
  },
  useWindowDimensions: () => dims,
  Animated: {
    View: AnimatedView,
    Value: function Value(this: { v: number }, v: number) {
      this.v = v;
    },
    loop: () => ({ start: loopStart, stop: loopStop }),
    sequence: () => ({}),
    timing: () => ({})
  },
  Easing: { inOut: (e: unknown) => e, ease: () => ({}) }
}));

mock.module("react", () => ({
  __esModule: true,
  ...ReactActual,
  default: (ReactActual as { default?: unknown }).default ?? ReactActual,
  useRef: <T,>(v: T) => ({ current: v }),
  useState: (_init: unknown) => [hostStateRef.current, setRequest],
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (typeof cleanup === "function") effectCleanups.push(cleanup);
  }
}));

mock.module("react-native-markdown-display", () => ({
  __esModule: true,
  default: function Markdown() {
    return null;
  },
  MarkdownIt: (cfg: unknown) => cfg
}));

mock.module("expo-web-browser", () => ({ openBrowserAsync }));
mock.module("expo-clipboard", () => ({ setStringAsync }));
mock.module("@expo/vector-icons", () => ({ Feather: Stub }));

mock.module("@/src/theme", () => ({
  theme: {
    bg: "#FFFFFF",
    bgDrawer: "#F2F2F7",
    surface: "#FFFFFF",
    searchBg: "#F0F0F0",
    codeChipBg: "#E8E8ED",
    text: "#1A1A1A",
    subtle: "#5A5A5A",
    muted: "#8A8A8A",
    codeChipText: "#3A3A3C",
    border: "#ECECEC",
    borderStrong: "#D1D1D6",
    accent: "#007AFF",
    assistantBubble: "#E9E9EB",
    assistantBubbleText: "#1A1A1A"
  },
  family: (name: string, weight = 400) => `${name}_${weight}`
}));
