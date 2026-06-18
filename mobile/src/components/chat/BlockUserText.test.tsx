import { beforeEach, describe, expect, mock, test } from "bun:test";

// Identity-comparable stand-ins for the native primitives the bubble renders.
// Tests never mount them; they invoke the component as a function and walk the
// returned element tree, asserting on element.type and element.props.
function makeStub(name: string) {
  const C = () => null;
  C.displayName = name;
  return C;
}
const Image = makeStub("Image");
const Pressable = makeStub("Pressable");
const Text = makeStub("Text");
const View = makeStub("View");

mock.module("react-native", () => ({
  Image,
  Pressable,
  Text,
  View,
  StyleSheet: { create: (s: unknown) => s }
}));

// Controllable expo-audio mock. The player records the ORDER of method calls so
// a test can prove a rewind (seekTo) lands before play() on the replay path —
// the exact ordering that, when violated, starts the AVQueuePlayer at the clip
// end and is silently stopped (StopAtEnd). `playerStatus` is mutated per-test
// before invoking the bubble; useAudioPlayerStatus returns it verbatim.
const calls: string[] = [];
let seekResolves: Array<() => void> = [];
const player = {
  play: mock(() => {
    calls.push("play");
  }),
  pause: mock(() => {
    calls.push("pause");
  }),
  // seekTo is async (returns a Promise) exactly like the native module, so the
  // test can assert play() is chained AFTER the seek settles, not fired in the
  // same tick.
  seekTo: mock((_seconds: number) => {
    calls.push("seekTo");
    return new Promise<void>((resolve) => {
      seekResolves.push(() => {
        calls.push("seekResolved");
        resolve();
      });
    });
  })
};

let playerStatus: {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
};

mock.module("expo-audio", () => ({
  useAudioPlayer: () => player,
  useAudioPlayerStatus: () => playerStatus
}));

mock.module("@expo/vector-icons", () => ({ Feather: makeStub("Feather") }));

mock.module("@/src/api", () => ({
  uploadUrl: (id: string) => `http://gw.local/api/uploads/${id}`,
  authHeader: () => ({ Authorization: "Bearer t" })
}));

const openPreview = mock((_: { uri: string; headers: Record<string, string> }) => {});
mock.module("@/src/components/ImagePreview", () => ({
  useImagePreview: () => ({ open: openPreview })
}));

mock.module("@/src/theme", () => ({
  theme: {
    userBubble: "#1A1A1A",
    userBubbleText: "#FFFFFF",
    codeChipBg: "#E8E8ED"
  },
  family: (name: string, weight = 400) => `${name}_${weight}`
}));

mock.module("./SelectableBlockText", () => ({ SelectableBlockText: makeStub("SelectableBlockText") }));

const { VoiceBubble, BlockUserText } = await import("@/src/components/chat/BlockUserText");

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

// Render the bubble and return the play/pause Pressable's onPress (the toggle).
function getToggle() {
  const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
    audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 4000 }
  });
  const pressable = flatten(tree).find(
    (n) => n.type === Pressable && typeof n.props.onPress === "function"
  );
  if (!pressable) throw new Error("play/pause Pressable not found");
  return pressable.props.onPress as () => void;
}

beforeEach(() => {
  calls.length = 0;
  seekResolves = [];
  player.play.mockClear();
  player.pause.mockClear();
  player.seekTo.mockClear();
  playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
});

describe("VoiceBubble playback toggle", () => {
  test("a fresh (unloaded) clip plays without a needless seek", () => {
    // duration still 0 (not decoded yet): a pre-load tap must NOT be treated as
    // 'at the end' — it should just play from the start.
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    getToggle()();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(calls).toEqual(["play"]);
  });

  test("a loaded, mid-clip paused position resumes without seeking", () => {
    playerStatus = { playing: false, currentTime: 2, duration: 9, didJustFinish: false };
    getToggle()();
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["play"]);
  });

  test("tapping while playing pauses (and never starts a second stream)", () => {
    playerStatus = { playing: true, currentTime: 3, duration: 9, didJustFinish: false };
    getToggle()();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  test("replaying a finished clip rewinds to 0 BEFORE playing (seek then play)", async () => {
    // didJustFinish marks the clip as ended. The fix: await the seek, then play
    // — so the AVQueuePlayer restarts at 0 instead of at the end (which the
    // native player silently stops as StopAtEnd).
    playerStatus = { playing: false, currentTime: 9, duration: 9, didJustFinish: true };
    getToggle()();
    // play() must NOT have fired yet — it's chained behind the pending seek.
    expect(calls).toEqual(["seekTo"]);
    expect(player.play).not.toHaveBeenCalled();
    // Settle the seek; play runs only after the rewind resolves.
    seekResolves[0]();
    await Promise.resolve();
    expect(calls).toEqual(["seekTo", "seekResolved", "play"]);
    expect(player.seekTo).toHaveBeenCalledWith(0);
  });

  test("a clip parked at the end (currentTime >= duration) also rewinds before play", async () => {
    playerStatus = { playing: false, currentTime: 9, duration: 9, didJustFinish: false };
    getToggle()();
    expect(calls).toEqual(["seekTo"]);
    seekResolves[0]();
    await Promise.resolve();
    expect(calls).toEqual(["seekTo", "seekResolved", "play"]);
  });
});

describe("VoiceBubble rendering", () => {
  test("shows the decoded duration once known, overriding the client estimate", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 9, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 1000 }
    });
    const texts = flatten(tree).filter((n) => n.type === Text);
    // The duration label renders 0:09 (decoded) rather than 0:01 (the estimate).
    const labels = texts.map((n) => n.props.children);
    expect(labels).toContain("0:09");
  });

  test("falls back to the client duration before the clip decodes", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 4000 }
    });
    const labels = flatten(tree).filter((n) => n.type === Text).map((n) => n.props.children);
    expect(labels).toContain("0:04");
  });
});

function renderBlock(block: Record<string, unknown>) {
  return (BlockUserText as unknown as (p: { block: unknown }) => El)({ block });
}

beforeEach(() => {
  openPreview.mockClear();
});

describe("BlockUserText attachments", () => {
  test("renders image attachments as a tappable grid that opens the previewer", () => {
    const tree = renderBlock({
      text: "",
      images: [{ id: "img1", mimeType: "image/png", size: 2048 }]
    });
    const nodes = flatten(tree);
    const img = nodes.find((n) => n.type === Image);
    expect(img).toBeTruthy();
    expect((img!.props.source as { uri: string }).uri).toBe("http://gw.local/api/uploads/img1");
    const opener = nodes.find(
      (n) => n.type === Pressable && (n.props as { accessibilityLabel?: string }).accessibilityLabel === "Open image"
    );
    expect(opener).toBeTruthy();
    (opener!.props.onPress as () => void)();
    expect(openPreview).toHaveBeenCalledWith({
      uri: "http://gw.local/api/uploads/img1",
      headers: { Authorization: "Bearer t" }
    });
  });

  test("renders a non-image attachment as a file chip with type label and size", () => {
    const labels = flatten(
      renderBlock({ text: "", images: [{ id: "f1", mimeType: "application/pdf", size: 2_500_000 }] })
    )
      .filter((n) => n.type === Text)
      .map((n) => n.props.children);
    // fileTypeLabel uppercases the mime subtype; formatBytes renders MB at this size.
    expect(labels).toContain("PDF");
    expect(labels).toContain("2.4 MB");
  });

  test("formats small and mid-size files as B and KB", () => {
    const small = flatten(renderBlock({ text: "", images: [{ id: "s", mimeType: "text/csv", size: 512 }] }))
      .filter((n) => n.type === Text)
      .map((n) => n.props.children);
    expect(small).toContain("512 B");
    expect(small).toContain("CSV");

    const kb = flatten(renderBlock({ text: "", images: [{ id: "k", mimeType: "text/plain", size: 4096 }] }))
      .filter((n) => n.type === Text)
      .map((n) => n.props.children);
    expect(kb).toContain("4 KB");
  });

  test("a mime with no subtype falls back to the whole type for the label", () => {
    const labels = flatten(renderBlock({ text: "", images: [{ id: "x", mimeType: "weirdtype", size: 10 }] }))
      .filter((n) => n.type === Text)
      .map((n) => n.props.children);
    expect(labels).toContain("WEIRDTYPE");
  });

  test("renders the text bubble when the message carries text", () => {
    const tree = renderBlock({ text: "hello there" });
    const sel = flatten(tree).find((n) => (n.type as { displayName?: string })?.displayName === "SelectableBlockText");
    expect(sel).toBeTruthy();
    expect(sel!.props.children).toBe("hello there");
  });

  test("renders a VoiceBubble element when the message carries audio", () => {
    const tree = renderBlock({ text: "", audio: { id: "a1", mimeType: "audio/wav", size: 100, durationMs: 2000 } });
    // BlockUserText embeds <VoiceBubble audio=.../> as a child element; it isn't
    // invoked here, so assert the element node is present with the audio prop
    // forwarded (the toggle/render behavior is covered by the VoiceBubble suite).
    const voice = flatten(tree).find((n) => n.type === VoiceBubble);
    expect(voice).toBeTruthy();
    expect((voice!.props as { audio: { id: string } }).audio.id).toBe("a1");
  });

  test("an image-only message omits the empty text bubble", () => {
    const tree = renderBlock({ text: "", images: [{ id: "img1", mimeType: "image/png", size: 10 }] });
    const sel = flatten(tree).find((n) => (n.type as { displayName?: string })?.displayName === "SelectableBlockText");
    expect(sel).toBeUndefined();
  });
});
