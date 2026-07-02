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
export function Image() {
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
export const alert = mock((_title: string, _message?: string) => {});
export const downloadAsync = mock((_uri: string, dest: string) => Promise.resolve({ uri: dest }));
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
  Image,
  Share: { share },
  Alert: { alert },
  Linking: { openURL: linkingOpenURL },
  StyleSheet: {
    create: (s: unknown) => s,
    flatten: (s: unknown) =>
      Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s ?? {},
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
// uploadAttachment.ts (imported transitively via BlockAssistantText's link
// rule) pulls expo-file-system/legacy at import; stub the one fn it uses so
// the native graph isn't dragged in.
mock.module("expo-file-system/legacy", () => ({ cacheDirectory: "/cache/", downloadAsync }));

// AuthedImage and ImagePreview pull in native modules (reanimated / gesture-
// handler) at import time; BlockAssistantText/BlockUserText now import them for
// inline upload images. Stub both so the component tests don't drag the native
// graph in. (The markdown lib is mocked to render null above, so the image
// rule that uses these never actually executes here.)
mock.module("@/src/components/chat/AuthedImage", () => ({ AuthedImage: Stub }));
mock.module("@/src/components/ImagePreview", () => ({
  useImagePreview: () => ({ open: () => {} })
}));
mock.module("@/src/upload-ref", () => ({
  UPLOAD_REF_SCHEME: "gini-upload://",
  uploadIdFromRef: (ref?: string | null) =>
    ref && ref.startsWith("gini-upload://") ? ref.slice("gini-upload://".length) : null
}));
// @/src/api pulls in expo-file-system at import; the chat components only need
// uploadUrl/authHeader for inline upload images and uploadRawSource for the
// non-image attachment download.
mock.module("@/src/api", () => ({
  uploadUrl: (id: string) => `http://gw.local/api/uploads/${id}`,
  authHeader: () => ({ Authorization: "Bearer t" }),
  uploadRawSource: (id: string) => ({
    uri: `http://gw.local/api/uploads/${id}`,
    headers: { authorization: "Bearer t" }
  }),
  signUploadUrl: (id: string) =>
    Promise.resolve(`http://gw.local/api/uploads/${id}?inline=1&exp=9999999999&sig=deadbeef`)
}));

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
    assistantBubbleText: "#1A1A1A",
    userBubble: "#1A1A1A",
    userBubbleText: "#FFFFFF",
    danger: "#FF3B30"
  },
  family: (name: string, weight = 400) => `${name}_${weight}`
}));
