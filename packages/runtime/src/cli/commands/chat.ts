import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api, auth, url } from "../api";
import { print, renderOutboundAttachments } from "../output";

// Map a mime to a file extension for the saved-to-disk CLI render. Falls back
// to `bin` for an unknown/missing type so the saved file always has an
// extension the OS can dispatch on.
function extForMime(mimeType: string): string {
  const sub = mimeType.split("/")[1] ?? "bin";
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return sub.split(";")[0]!.replace(/[^a-z0-9]/gi, "") || "bin";
}

export async function chat(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "new") {
    const title = restAfter(cliArgs, sub).join(" ").trim() || "New chat";
    print(await api(config, "/api/chat", { method: "POST", body: JSON.stringify({ title }) }));
    return;
  }
  if (sub === "send") {
    const [sessionId, ...contentParts] = restAfter(cliArgs, sub);
    if (!sessionId || contentParts.length === 0) throw new Error("Usage: gini chat send <session-id> <message>");
    print(await api(config, `/api/chat/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: contentParts.join(" "), client: "cli" })
    }));
    return;
  }
  if (sub === "sync") {
    const [sessionId, taskId] = restAfter(cliArgs, sub);
    if (!sessionId || !taskId) throw new Error("Usage: gini chat sync <session-id> <task-id>");
    print(await api(config, `/api/chat/${sessionId}/tasks/${taskId}/sync`, { method: "POST" }));
    return;
  }
  if (sub === "show") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini chat show <session-id>");
    print(await api(config, `/api/chat/${id}`));
    return;
  }
  if (sub === "blocks") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini chat blocks <session-id>");
    const blocks = await api(config, `/api/chat/${id}/blocks`);
    print(blocks);
    // A TTY can't show a picture (or a PDF), so any outbound attachment the
    // agent referenced inline (`gini-upload://<id>`) in its reply is fetched
    // and written to a temp file; the saved path is printed so the user can
    // open it. The mime comes from the response Content-Type (the markdown ref
    // carries none) so the saved file gets a sensible extension.
    await renderOutboundAttachments(blocks, {
      fetchUpload: async (uploadId) => {
        const response = await fetch(`${url(config)}/api/uploads/${uploadId}`, { headers: auth(config) });
        if (!response.ok) throw new Error(`Failed to fetch upload ${uploadId}: HTTP ${response.status}`);
        const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
        return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType };
      },
      savePath: (uploadId, mimeType) => join(tmpdir(), `gini-${uploadId}.${extForMime(mimeType)}`),
      // Owner-only (0600): a saved screenshot/file can be sensitive, and on a
      // shared Linux host the OS temp dir is world-readable by default umask.
      writeFile: (path, bytes) => writeFileSync(path, bytes, { mode: 0o600 })
    });
    return;
  }
  print(await api(config, "/api/chat"));
}
