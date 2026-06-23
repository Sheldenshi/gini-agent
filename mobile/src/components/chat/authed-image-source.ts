// Pure source-resolution for AuthedImage, split out from the .tsx so it carries
// no react-native import and can be unit-tested without a render harness.
//
// Native passes the bearer via the <Image> source `headers`; web waits for the
// fetched blob URL and renders it header-free (undefined while the blob is
// still loading, so the frame stays blank rather than firing a doomed
// header-less request that RN Web's <img> can't authenticate). See ADR
// outbound-chat-attachments.md.
export function resolveImageSource(
  platform: string,
  directUri: string,
  headers: Record<string, string>,
  blobUri: string | null
): { uri: string; headers?: Record<string, string> } | undefined {
  if (platform === "web") return blobUri ? { uri: blobUri } : undefined;
  return { uri: directUri, headers };
}
