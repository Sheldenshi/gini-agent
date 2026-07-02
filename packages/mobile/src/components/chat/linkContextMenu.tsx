import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import { family, theme } from "@/src/theme";

// Swallow rejections from the native bridges — e.g. Share.share rejects on
// web browsers without the Web Share API — so they don't surface as unhandled
// promise rejections.
const ignore = () => {};

// Open http(s) links only — hrefs come from assistant/file markdown, so an
// unguarded opener would also fire tel:/sms:/mailto:/file:/app-deep-link
// schemes.
export function isWebUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

// Host shown in the menu's preview header, e.g. "docs.anthropic.com".
export function linkHostname(href: string): string {
  // The authority ends at the first / ? # OR backslash — browsers normalize
  // "\" to "/", so "https://evil.example\@trusted.example" navigates to
  // evil.example, not trusted.example.
  const match = /^https?:\/\/([^/?#\\]+)/i.exec(href);
  if (!match) return href;
  // Drop any userinfo (up to and including the last "@") and the trailing
  // port, so a "trusted.com@evil.example" authority can't disguise the real
  // destination in the preview header.
  const authority = match[1]!;
  return authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
}

// Open a link INSIDE the app (SFSafariViewController on iOS, Custom Tab on
// Android) instead of bouncing out to the system default browser. On the web
// target there is no in-app browser, so use Linking.openURL — RN Web opens it
// with `noopener`, which expo-web-browser's window.open path does not set.
export function openLink(href: string): void {
  if (!isWebUrl(href)) return;
  if (Platform.OS === "web") {
    Linking.openURL(href).catch(ignore);
    return;
  }
  WebBrowser.openBrowserAsync(href).catch(ignore);
}

// Open a link in the system DEFAULT browser (external Safari/Chrome), leaving
// the app. Used by the long-press menu's "Open Link" action to match the native
// iOS link menu, whose "Open Link" hands off to the default browser — distinct
// from a plain tap, which stays in the in-app browser via openLink.
export function openLinkExternally(href: string): void {
  if (!isWebUrl(href)) return;
  Linking.openURL(href).catch(ignore);
}

export function copyLink(href: string): void {
  Clipboard.setStringAsync(href).catch(ignore);
}

export function shareLink(href: string): void {
  Share.share({ url: href, message: href }).catch(ignore);
}

// `onLinkPress` handler for <Markdown>. The library's default link/blocklink
// openers (e.g. a linked image) call this; route them through the in-app
// browser and return false so the library does not also hand the URL to the
// system browser. Shared by the chat bubble and the file preview so both
// surfaces open links the same way.
export function handleMarkdownLinkPress(url: string): boolean {
  openLink(url);
  return false;
}

export const MENU_WIDTH = 250;
const MENU_MARGIN = 8;
// Approximate menu height (preview header + three rows) used only to keep the
// card on-screen when the long-press lands near the bottom edge.
export const MENU_HEIGHT = 196;

// Clamp the long-press point to a top-left origin that keeps the whole card
// within the screen, anchored just below the touch like the iOS link menu.
export function clampMenuPosition(
  x: number,
  y: number,
  screenW: number,
  screenH: number
): { left: number; top: number } {
  const left = Math.min(
    Math.max(MENU_MARGIN, x),
    Math.max(MENU_MARGIN, screenW - MENU_WIDTH - MENU_MARGIN)
  );
  const top = Math.min(
    Math.max(MENU_MARGIN, y + MENU_MARGIN),
    Math.max(MENU_MARGIN, screenH - MENU_HEIGHT - MENU_MARGIN)
  );
  return { left, top };
}

type MenuRequest = { href: string; x: number; y: number };
type Listener = (req: MenuRequest) => void;
const listeners = new Set<Listener>();

export function subscribeLinkMenu(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Module-level bridge: the markdown render rules are a module constant with no
// component scope, so they summon the menu host (mounted once at the app root)
// through this emitter rather than via props/context.
export function presentLinkMenu(href: string, x: number, y: number): void {
  if (!isWebUrl(href)) return;
  for (const listener of listeners) listener({ href, x, y });
}

type RowIcon = "compass" | "link" | "share";

function MenuRow({
  icon,
  label,
  onPress
}: {
  icon: RowIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Feather name={icon} size={18} color={theme.text} />
    </Pressable>
  );
}

// Single overlay host, mounted at the app root. Subscribes to menu requests
// and renders the floating link card at the long-press point.
export function LinkContextMenuHost() {
  const [request, setRequest] = useState<MenuRequest | null>(null);
  const { width, height } = useWindowDimensions();

  useEffect(() => subscribeLinkMenu(setRequest), []);

  if (!request) return null;

  const close = () => setRequest(null);
  const run = (action: (href: string) => void) => () => {
    close();
    action(request.href);
  };
  const { left, top } = clampMenuPosition(request.x, request.y, width, height);

  // A plain absolute-fill overlay rather than a <Modal>: a Modal is a native
  // view controller, and dismissing it while immediately presenting the
  // in-app browser / share sheet races on iOS ("present while dismissing").
  // An overlay has no view controller to dismiss, so the open is clean.
  return (
    <Pressable style={styles.backdrop} onPress={close}>
      {/* Outer wrapper carries the shadow; the inner card clips its rows to
          the rounded corners. They're split because `overflow: hidden`
          (needed to clip the rows) also clips the shadow on iOS. */}
      <View style={[styles.cardShadow, { left, top }]}>
        <View style={styles.card}>
          <View style={styles.preview}>
            <Feather name="globe" size={16} color={theme.subtle} />
            <View style={styles.previewText}>
              <Text numberOfLines={1} style={styles.previewHost}>
                {linkHostname(request.href)}
              </Text>
              <Text numberOfLines={1} style={styles.previewUrl}>
                {request.href}
              </Text>
            </View>
          </View>
          <View style={styles.sep} />
          <MenuRow icon="compass" label="Open Link" onPress={run(openLinkExternally)} />
          <View style={styles.sep} />
          <MenuRow icon="link" label="Copy Link" onPress={run(copyLink)} />
          <View style={styles.sep} />
          <MenuRow icon="share" label="Share…" onPress={run(shareLink)} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The host is mounted last in the root tree so it already paints above the
  // navigator; the explicit zIndex/elevation (above the file preview overlay's
  // 1000) makes "topmost" robust on Android and independent of mount order.
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Dim the screen behind the menu so a white card reads against white chat.
    backgroundColor: "rgba(0, 0, 0, 0.25)",
    zIndex: 1001,
    elevation: 1001
  },
  cardShadow: {
    position: "absolute",
    width: MENU_WIDTH,
    borderRadius: 14,
    backgroundColor: theme.surface,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 16
  },
  card: {
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.borderStrong,
    backgroundColor: theme.surface
  },
  preview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: theme.bgDrawer
  },
  previewText: { flex: 1 },
  previewHost: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  previewUrl: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: theme.surface
  },
  rowPressed: { backgroundColor: theme.searchBg },
  rowLabel: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16
  },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border }
});
