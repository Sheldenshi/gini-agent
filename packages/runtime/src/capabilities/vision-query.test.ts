import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { clearEchoVisionResponses, setEchoVisionResponse } from "../provider";
import { storeUpload } from "../state/uploads";
import type { RuntimeConfig } from "../types";
import { invokeVisionQuery } from "./vision-query";

const ROOT = "/tmp/gini-vision-query-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  clearEchoVisionResponses();
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

describe("invokeVisionQuery", () => {
  test("happy path: PNG upload, returns vision model's answer", async () => {
    const instance = "vq-happy";
    const upload = storeUpload(instance, new Uint8Array([1, 2, 3]), "image/png", "shot.png");
    setEchoVisionResponse({ text: "Two horses on a hill." });
    const result = await invokeVisionQuery(
      config(instance),
      { uploadId: upload.id, question: "what is in this picture" }
    );
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("Two horses on a hill.");
  });

  test("rejects unknown upload id", async () => {
    const instance = "vq-missing";
    const result = await invokeVisionQuery(
      config(instance),
      { uploadId: "does-not-exist", question: "anything" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Upload not found/);
  });

  test("rejects non-image upload mime type", async () => {
    const instance = "vq-non-image";
    const upload = storeUpload(instance, new Uint8Array([1, 2]), "application/pdf", "doc.pdf");
    const result = await invokeVisionQuery(
      config(instance),
      { uploadId: upload.id, question: "what does this say" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/png|jpeg/);
  });

  test("rejects empty question", async () => {
    const instance = "vq-no-question";
    const upload = storeUpload(instance, new Uint8Array([1]), "image/png");
    const result = await invokeVisionQuery(
      config(instance),
      { uploadId: upload.id, question: "" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/question/);
  });

  test("rejects uploads above the vision byte cap", async () => {
    const instance = "vq-too-big";
    const big = new Uint8Array(6 * 1024 * 1024);
    big.fill(7);
    const upload = storeUpload(instance, big, "image/png");
    const result = await invokeVisionQuery(
      config(instance),
      { uploadId: upload.id, question: "describe" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cap/);
  });
});
