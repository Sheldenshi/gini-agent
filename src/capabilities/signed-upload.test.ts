import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { storeUpload } from "../state/uploads";
import type { RuntimeConfig } from "../types";
import { invokeSignedUpload } from "./signed-upload";

const ROOT = "/tmp/gini-signed-upload-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function config(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

describe("invokeSignedUpload", () => {
  test("happy path: reads upload, PUTs bytes, returns ok with bytesSent", async () => {
    const instance = "signed-upload-happy";
    const upload = storeUpload(instance, new Uint8Array([1, 2, 3, 4, 5]), "image/png", "shot.png");

    const seen: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
    const result = await invokeSignedUpload(
      config(instance),
      {
        uploadId: upload.id,
        url: "https://storage.googleapis.com/uploads.linear.app/signed",
        headers: { "content-type": "image/png", "x-goog-content-length-range": "5,5" }
      },
      {
        taskId: "task_t1",
        putBytes: async (url, headers, bytes) => {
          seen.push({ url, headers, bytes: bytes.length });
          return { ok: true, status: 200 };
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.bytesSent).toBe(5);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://storage.googleapis.com/uploads.linear.app/signed");
    expect(seen[0]!.headers["content-type"]).toBe("image/png");
    expect(seen[0]!.bytes).toBe(5);
  });

  test("rejects http:// — only https is allowed", async () => {
    const instance = "signed-upload-http";
    const upload = storeUpload(instance, new Uint8Array([1]), "image/png");
    const result = await invokeSignedUpload(
      config(instance),
      { uploadId: upload.id, url: "http://example.com/insecure" },
      { putBytes: async () => ({ ok: true, status: 200 }) }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/https/);
  });

  test("returns clear error when uploadId is unknown", async () => {
    const instance = "signed-upload-missing";
    const result = await invokeSignedUpload(
      config(instance),
      { uploadId: "does-not-exist", url: "https://example.com/x" },
      { putBytes: async () => ({ ok: true, status: 200 }) }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Upload not found/);
  });

  test("surfaces non-2xx PUT failures with status + truncated body", async () => {
    const instance = "signed-upload-403";
    const upload = storeUpload(instance, new Uint8Array([7, 7, 7]), "image/png");
    const result = await invokeSignedUpload(
      config(instance),
      { uploadId: upload.id, url: "https://storage.googleapis.com/x" },
      {
        putBytes: async () => ({ ok: false, status: 403, body: "MalformedSecurityHeader: content-type missing" })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("403");
    expect(result.error).toContain("MalformedSecurityHeader");
  });

  test("surfaces fetch exceptions (timeouts, DNS) as ok=false error", async () => {
    const instance = "signed-upload-throw";
    const upload = storeUpload(instance, new Uint8Array([1, 2]), "image/png");
    const result = await invokeSignedUpload(
      config(instance),
      { uploadId: upload.id, url: "https://example.com/timeout" },
      {
        putBytes: async () => { throw new Error("aborted: timeout"); }
      }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PUT failed/);
    expect(result.error).toMatch(/timeout/);
  });

  test("requires uploadId and url", async () => {
    const instance = "signed-upload-required";
    const r1 = await invokeSignedUpload(config(instance), { uploadId: "", url: "https://example.com" });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/uploadId/);
    const r2 = await invokeSignedUpload(config(instance), { uploadId: "x", url: "" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/url/);
  });
});
