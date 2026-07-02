import { beforeEach, describe, expect, test } from "bun:test";
// Importing the shared setup installs the (process-global) module mocks before
// the component under test is imported.
import {
  effectCleanups,
  hostStateRef,
  linkingOpenURL,
  openBrowserAsync,
  Platform,
  setRequest,
  setStringAsync,
  share
} from "./chatMockSetup";

const {
  isWebUrl,
  linkHostname,
  openLink,
  openLinkExternally,
  copyLink,
  shareLink,
  handleMarkdownLinkPress,
  clampMenuPosition,
  presentLinkMenu,
  subscribeLinkMenu,
  LinkContextMenuHost,
  MENU_WIDTH,
  MENU_HEIGHT
} = await import("@/src/components/chat/linkContextMenu");

beforeEach(() => {
  openBrowserAsync.mockClear();
  linkingOpenURL.mockClear();
  setStringAsync.mockClear();
  share.mockClear();
  setRequest.mockClear();
  hostStateRef.current = null;
  Platform.OS = "ios";
  effectCleanups.splice(0);
});

describe("url helpers", () => {
  test("isWebUrl allows http(s) only", () => {
    expect(isWebUrl("http://a.com")).toBe(true);
    expect(isWebUrl("https://a.com")).toBe(true);
    expect(isWebUrl("HTTPS://A.com")).toBe(true);
    for (const bad of ["tel:1", "mailto:a@b", "file:///x", "gini://y", "/rel", " https://x"]) {
      expect(isWebUrl(bad)).toBe(false);
    }
  });

  test("linkHostname shows the real host and strips userinfo + port", () => {
    expect(linkHostname("https://docs.anthropic.com/path?q=1")).toBe("docs.anthropic.com");
    expect(linkHostname("http://lego.com")).toBe("lego.com");
    expect(linkHostname("notaurl")).toBe("notaurl");
    // Userinfo must not disguise the destination in the preview header.
    expect(linkHostname("https://apple.com@evil.example/x")).toBe("evil.example");
    expect(linkHostname("https://user:pass@evil.example:8443/x")).toBe("evil.example");
    expect(linkHostname("https://a.com@b.com@evil.example/x")).toBe("evil.example");
    expect(linkHostname("https://host:9999/x")).toBe("host");
    // Backslash is normalized to "/" by browsers, so the authority ends there.
    expect(linkHostname("https://evil.example\\@trusted.example/x")).toBe("evil.example");
  });
});

describe("link actions", () => {
  test("openLink opens the in-app browser for web urls only", () => {
    openLink("https://x.com");
    expect(openBrowserAsync).toHaveBeenCalledWith("https://x.com");
    openBrowserAsync.mockClear();
    openLink("tel:123");
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });

  test("openLink uses Linking.openURL on web (noopener) instead of the in-app browser", () => {
    Platform.OS = "web";
    openLink("https://x.com");
    expect(linkingOpenURL).toHaveBeenCalledWith("https://x.com");
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });

  test("openLinkExternally opens the system default browser for web urls only", () => {
    openLinkExternally("https://x.com");
    expect(linkingOpenURL).toHaveBeenCalledWith("https://x.com");
    expect(openBrowserAsync).not.toHaveBeenCalled();
    linkingOpenURL.mockClear();
    openLinkExternally("tel:123");
    expect(linkingOpenURL).not.toHaveBeenCalled();
  });

  test("copyLink writes to the clipboard", () => {
    copyLink("https://x.com");
    expect(setStringAsync).toHaveBeenCalledWith("https://x.com");
  });

  test("shareLink opens the share sheet with url + message", () => {
    shareLink("https://x.com");
    expect(share).toHaveBeenCalledWith({ url: "https://x.com", message: "https://x.com" });
  });

  test("handleMarkdownLinkPress opens web urls in-app and always returns false", () => {
    expect(handleMarkdownLinkPress("https://x.com")).toBe(false);
    expect(openBrowserAsync).toHaveBeenCalledWith("https://x.com");
    openBrowserAsync.mockClear();
    expect(handleMarkdownLinkPress("tel:1")).toBe(false);
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });

  test("native bridge rejections are swallowed (no unhandled rejection)", async () => {
    openBrowserAsync.mockImplementationOnce(() => Promise.reject(new Error("nope")));
    setStringAsync.mockImplementationOnce(() => Promise.reject(new Error("nope")));
    share.mockImplementationOnce(() => Promise.reject(new Error("nope")));
    openLink("https://x.com");
    copyLink("https://x.com");
    shareLink("https://x.com");
    // Flush microtasks so the .catch handlers run.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("clampMenuPosition", () => {
  test("keeps the card on screen, anchored below the touch", () => {
    expect(clampMenuPosition(10, 20, 400, 800)).toEqual({ left: 10, top: 28 });
    // Past the right edge -> clamped to screenW - MENU_WIDTH - margin.
    expect(clampMenuPosition(390, 20, 400, 800).left).toBe(400 - MENU_WIDTH - 8);
    // Negative x -> clamped to the left margin.
    expect(clampMenuPosition(-5, 20, 400, 800).left).toBe(8);
    // Near the bottom -> clamped up so the card fits.
    expect(clampMenuPosition(10, 790, 400, 800).top).toBe(800 - MENU_HEIGHT - 8);
    // Screen narrower than the menu -> origin pinned to the margin.
    expect(clampMenuPosition(10, 20, 100, 800).left).toBe(8);
  });
});

describe("menu emitter", () => {
  test("presentLinkMenu notifies subscribers for web urls and skips others", () => {
    const calls: Array<{ href: string; x: number; y: number }> = [];
    const unsub = subscribeLinkMenu((r) => calls.push(r));

    presentLinkMenu("https://x.com", 5, 6);
    expect(calls).toEqual([{ href: "https://x.com", x: 5, y: 6 }]);

    presentLinkMenu("tel:123", 1, 2);
    expect(calls).toHaveLength(1);

    unsub();
    presentLinkMenu("https://y.com", 7, 8);
    expect(calls).toHaveLength(1);
  });
});

describe("LinkContextMenuHost", () => {
  test("renders nothing while idle and subscribes for requests", () => {
    hostStateRef.current = null;
    expect(LinkContextMenuHost()).toBeNull();
    // The effect subscribed the state setter; a request should reach it.
    presentLinkMenu("https://x.com", 3, 4);
    expect(setRequest).toHaveBeenCalledWith({ href: "https://x.com", x: 3, y: 4 });
    for (const c of effectCleanups.splice(0)) c();
  });

  test("renders the card and wires open / copy / share / dismiss", () => {
    hostStateRef.current = { href: "https://lego.com/x", x: 10, y: 20 };
    // The host renders an absolute-fill Pressable backdrop directly (no Modal).
    const backdrop = LinkContextMenuHost() as any;

    // Backdrop press dismisses.
    backdrop.props.onPress();
    expect(setRequest).toHaveBeenCalledWith(null);

    // backdrop -> shadow wrapper -> clipped card -> rows.
    const cardShadow = backdrop.props.children;
    const card = cardShadow.props.children;
    const rows = (card.props.children as any[]).filter(
      (c) => c && typeof c === "object" && typeof c.type === "function" && c.props?.label
    );
    expect(rows.map((r) => r.props.label)).toEqual(["Open Link", "Copy Link", "Share…"]);

    // Menu "Open Link" hands off to the system default browser, not in-app.
    rows[0].props.onPress();
    expect(linkingOpenURL).toHaveBeenCalledWith("https://lego.com/x");
    rows[1].props.onPress();
    expect(setStringAsync).toHaveBeenCalledWith("https://lego.com/x");
    rows[2].props.onPress();
    expect(share).toHaveBeenCalled();

    // Cover the MenuRow body + its pressed/unpressed style function.
    const MenuRow = rows[0].type as (p: unknown) => any;
    const rowEl = MenuRow(rows[0].props);
    expect(typeof rowEl.props.style).toBe("function");
    rowEl.props.style({ pressed: true });
    rowEl.props.style({ pressed: false });

    for (const c of effectCleanups.splice(0)) c();
  });
});
