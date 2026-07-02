import * as FileSystem from "expo-file-system/legacy";
import { Alert, Platform, Share, type ShareContent } from "react-native";
import { signUploadUrl, uploadRawSource } from "@/src/api";
import { openLink } from "./linkContextMenu";

// Tapping a non-image attachment chip (a `gini-upload://<id>` markdown LINK)
// must open the file as a preview. The system browser can't attach the bearer
// the gateway requires, so opening the upload URL there 401s. Instead we pull
// the bytes down with the bearer (same flow as the file-preview sheet's
// Download/Share toolbar), write them to the app cache, and hand the local
// file to the OS share/preview sheet — on iOS that surfaces Quick Look +
// "Save to Files". Errors surface via Alert rather than failing silently.
//
// Deps are injected so the orchestration is unit-testable without the native
// FileSystem/Share/Alert bridges; production callers use the defaults.
export interface UploadAttachmentDeps {
  source: typeof uploadRawSource;
  cacheDir: string | null;
  download: (uri: string, dest: string, opts: { headers: Record<string, string> }) => Promise<{ uri: string }>;
  share: (content: ShareContent) => Promise<unknown>;
  platformOS: typeof Platform.OS;
  alert: (title: string, message: string) => void;
}

const defaultDeps = (): UploadAttachmentDeps => ({
  source: uploadRawSource,
  cacheDir: FileSystem.cacheDirectory,
  download: (uri, dest, opts) => FileSystem.downloadAsync(uri, dest, opts),
  share: (content) => Share.share(content),
  platformOS: Platform.OS,
  alert: (title, message) => Alert.alert(title, message)
});

// Sanitize a chip label into a filesystem-safe cache filename so the OS preview
// shows a sensible name (and a label with slashes/control chars can't escape
// the cache dir).
export function safeAttachmentName(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
}

export async function openUploadAttachment(
  uploadId: string,
  filename: string,
  deps: UploadAttachmentDeps = defaultDeps()
): Promise<void> {
  try {
    const { uri, headers } = deps.source(uploadId);
    const safeName = safeAttachmentName(filename);
    // Namespace the cache path by upload id, not just the display name: two
    // distinct uploads can share a name ("report.pdf", "screenshot.png"), and a
    // bare-name dest would let a second concurrent open overwrite the first —
    // surfacing the wrong bytes (or a half-written file) in the share sheet. The
    // id is a UUID (filesystem-safe); sanitize it anyway for defense in depth.
    const dest = `${deps.cacheDir ?? ""}${safeAttachmentName(uploadId)}-${safeName}`;
    const result = await deps.download(uri, dest, { headers });
    // RN core Share can't attach a file on Android; there a full save needs
    // expo-sharing (native module → new build). iOS shares the local file via
    // the share sheet, which exposes Quick Look preview + "Save to Files".
    if (deps.platformOS === "ios") {
      await deps.share({ url: result.uri });
    } else {
      await deps.share({ message: result.uri, title: filename });
    }
  } catch (err) {
    deps.alert("Couldn't open attachment", err instanceof Error ? err.message : String(err));
  }
}

// Deps for the in-app-browser open path. Split from UploadAttachmentDeps so the
// browser path can be unit-tested without the download/share bridges.
export interface OpenInBrowserDeps {
  sign: typeof signUploadUrl;
  open: (url: string) => void;
  fallback: (uploadId: string, filename: string) => Promise<void>;
}

const defaultBrowserDeps = (): OpenInBrowserDeps => ({
  sign: signUploadUrl,
  open: (url) => openLink(url),
  fallback: (uploadId, filename) => openUploadAttachment(uploadId, filename)
});

// Preferred tap action for a non-image attachment chip: mint a short-lived
// SIGNED url server-side, then open it in the in-app browser
// (SFSafariViewController / Custom Tabs). The signed url carries its own auth
// in the query string, so the header-less in-app browser can load it. If
// minting fails (offline, gateway error), fall back to the
// download-then-OS-share path so a tap never silently does nothing.
export async function openUploadInBrowser(
  uploadId: string,
  filename: string,
  deps: OpenInBrowserDeps = defaultBrowserDeps()
): Promise<void> {
  try {
    const url = await deps.sign(uploadId);
    deps.open(url);
  } catch {
    await deps.fallback(uploadId, filename);
  }
}
