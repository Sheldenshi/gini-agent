import { useEffect, useState } from "react";
import { Image, Platform, type ImageStyle, type StyleProp } from "react-native";
import { authHeader, uploadUrl } from "@/src/api";
import { resolveImageSource } from "@/src/components/chat/authed-image-source";

// Render a gateway upload as an image with bearer auth on BOTH targets.
//
// On native, RN's <Image> honors a `headers` source prop, so we pass the
// bearer through directly. On web, RN Web renders <Image> as an <img> tag,
// which CANNOT send an Authorization header — the request 401s and the frame
// stays blank. So on web we fetch the bytes with the bearer header ourselves
// and hand <Image> a blob: object URL (no header needed, and — unlike a
// ?token= query string — no secret in any URL). The object URL is revoked on
// unmount. See ADR outbound-chat-attachments.md.
export function AuthedImage({
  uploadId,
  style,
  resizeMode = "cover"
}: {
  uploadId: string;
  style?: StyleProp<ImageStyle>;
  resizeMode?: "cover" | "contain";
}) {
  const directUri = uploadUrl(uploadId);
  const [blobUri, setBlobUri] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let revoked = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(directUri, { headers: authHeader() });
        if (!res.ok) return;
        const blob = await res.blob();
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUri(objectUrl);
      } catch {
        // Leave the frame blank on a fetch failure — best-effort render.
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [directUri]);

  const source = resolveImageSource(Platform.OS, directUri, authHeader(), blobUri);

  return <Image source={source} style={style} resizeMode={resizeMode} />;
}
