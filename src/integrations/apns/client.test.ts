// Unit tests for the APNs client. Pins:
//   - missing config returns `apns_not_configured` and warns once
//   - 200 OK round-trips as `{ ok: true, status: 200 }`
//   - 410 surfaces Apple's `reason: "Unregistered"` verbatim so the
//     dispatcher can branch on it
//   - JWT is cached across calls within 50 minutes; refreshed after
//
// http2 is mocked end-to-end: the test injects a fake ClientHttp2Session
// whose `request()` returns an EventEmitter that emits `response`
// + `end` synchronously after the caller writes the body. No real
// network or filesystem access.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { constants as http2Constants } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { createApnsClient } from "./client";

// A minimal http2 stream stub. We only need the events the client
// consumes: `response`, `data`, `end`, `error`. The client writes the
// body via `stream.end(json)`; we capture that and then fire `response`
// + `end` to drive the resolution path.
class FakeStream extends EventEmitter {
  written: string | null = null;
  // The client calls setEncoding; we accept and ignore (the events we
  // emit are already strings).
  setEncoding(_encoding: string): void { /* noop */ }
  end(body: string): void {
    this.written = body;
    // Resolution is owned by the test's `respond()` helper — we
    // intentionally don't auto-respond here so the test can choose
    // when (and how) the fake APNs replies.
  }
}

interface FakeRequestRecord {
  headers: Record<string, string | number>;
  stream: FakeStream;
}

interface FakeSessionApi {
  session: ClientHttp2Session;
  // Each call to `session.request()` appends to this list.
  requests: FakeRequestRecord[];
  // Programmatic response — tests call this with the index of the
  // request and the simulated APNs status + body. Emits the events
  // the client awaits.
  respond(index: number, status: number, body: string): void;
}

function buildFakeSession(): FakeSessionApi {
  const requests: FakeRequestRecord[] = [];
  // Cast through `unknown` because we only implement the subset of
  // ClientHttp2Session the client actually uses (request, close,
  // once/closed/destroyed). The structural cast keeps the test free
  // of node:http2 internals.
  const sessionEmitter = new EventEmitter();
  const session = {
    closed: false,
    destroyed: false,
    request(headers: Record<string, string | number>): ClientHttp2Stream {
      const stream = new FakeStream();
      requests.push({ headers, stream });
      return stream as unknown as ClientHttp2Stream;
    },
    close(): void { /* noop */ },
    once: sessionEmitter.once.bind(sessionEmitter),
    on: sessionEmitter.on.bind(sessionEmitter),
    off: sessionEmitter.off.bind(sessionEmitter)
  } as unknown as ClientHttp2Session;
  return {
    session,
    requests,
    respond(index, status, body) {
      const record = requests[index];
      if (!record) throw new Error(`No request at index ${index}`);
      record.stream.emit("response", { [http2Constants.HTTP2_HEADER_STATUS]: String(status) });
      if (body) record.stream.emit("data", body);
      record.stream.emit("end");
    }
  };
}

// Synthetic ES256 PEM. crypto.createSign won't actually fire in tests
// that exercise the not-configured path; for tests that exercise the
// signing path we generate a real keypair on the fly so the JWT cache
// hit assertion can compare actual signed tokens.
async function makeP8Key(): Promise<string> {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

describe("apns client", () => {
  test("returns apns_not_configured when env vars are missing and warns once", async () => {
    const warnings: string[] = [];
    const client = createApnsClient({
      readConfig: () => ({ keyId: undefined, teamId: undefined, keyP8Path: undefined, bundleId: undefined }),
      warn: (msg) => warnings.push(msg)
    });
    const first = await client.sendPush("tok", { aps: {} }, {
      pushType: "alert",
      priority: 10,
      topic: "ai.lilaclabs.gini.mobile"
    });
    const second = await client.sendPush("tok", { aps: {} }, {
      pushType: "alert",
      priority: 10,
      topic: "ai.lilaclabs.gini.mobile"
    });

    expect(first).toEqual({ ok: false, status: 0, reason: "apns_not_configured" });
    expect(second).toEqual({ ok: false, status: 0, reason: "apns_not_configured" });
    // Warning fires exactly once across multiple calls.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("APNS_KEY_ID");
  });

  test("posts an alert and resolves ok on 200", async () => {
    const pem = await makeP8Key();
    const fake = buildFakeSession();
    const client = createApnsClient({
      readConfig: () => ({
        keyId: "KEY12345AB",
        teamId: "TEAM98765C",
        keyP8Path: "/synthetic.p8",
        bundleId: "ai.lilaclabs.gini.mobile",
        host: "https://fake.apns.example"
      }),
      readKey: () => pem,
      connect: () => fake.session
    });

    const promise = client.sendPush(
      "device-token-abc",
      { aps: { alert: { title: "Hi", body: "There" } }, sessionId: "chat_x" },
      { pushType: "alert", priority: 10, topic: "ai.lilaclabs.gini.mobile" }
    );

    // The client's `request()` is synchronous; the stream has been
    // captured. Drive the response on the next microtask so we don't
    // race the .end() write.
    await Bun.sleep(1);
    fake.respond(0, 200, "");
    const result = await promise;

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fake.requests.length).toBe(1);
    const sent = fake.requests[0];
    expect(sent.headers[http2Constants.HTTP2_HEADER_PATH]).toBe("/3/device/device-token-abc");
    expect(sent.headers["apns-topic"]).toBe("ai.lilaclabs.gini.mobile");
    expect(sent.headers["apns-push-type"]).toBe("alert");
    expect(sent.headers["apns-priority"]).toBe("10");
    // JWT shape check — header.payload.signature, all base64url.
    expect(String(sent.headers.authorization)).toMatch(/^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    const body = JSON.parse(sent.stream.written ?? "null") as { aps: Record<string, unknown>; sessionId: string };
    expect(body.sessionId).toBe("chat_x");
    expect(body.aps).toEqual({ alert: { title: "Hi", body: "There" } });
  });

  test("surfaces 410 Unregistered reason so caller can prune the token", async () => {
    const pem = await makeP8Key();
    const fake = buildFakeSession();
    const client = createApnsClient({
      readConfig: () => ({
        keyId: "KEY12345AB",
        teamId: "TEAM98765C",
        keyP8Path: "/synthetic.p8",
        bundleId: "ai.lilaclabs.gini.mobile",
        host: "https://fake.apns.example"
      }),
      readKey: () => pem,
      connect: () => fake.session
    });

    const promise = client.sendPush(
      "dead-token",
      { aps: { alert: { title: "Hi", body: "There" } } },
      { pushType: "alert", priority: 10, topic: "ai.lilaclabs.gini.mobile" }
    );
    await Bun.sleep(1);
    fake.respond(0, 410, JSON.stringify({ reason: "Unregistered", timestamp: 1700000000000 }));
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(410);
      expect(result.reason).toBe("Unregistered");
    }
  });

  test("caches the JWT across calls within 50 minutes and refreshes after", async () => {
    const pem = await makeP8Key();
    const fake = buildFakeSession();
    let clock = 1700000000000;
    const client = createApnsClient({
      readConfig: () => ({
        keyId: "KEY12345AB",
        teamId: "TEAM98765C",
        keyP8Path: "/synthetic.p8",
        bundleId: "ai.lilaclabs.gini.mobile",
        host: "https://fake.apns.example"
      }),
      readKey: () => pem,
      connect: () => fake.session,
      now: () => clock
    });

    const p1 = client.sendPush("t", { aps: {} }, { pushType: "alert", priority: 10, topic: "ai.lilaclabs.gini.mobile" });
    await Bun.sleep(1);
    fake.respond(0, 200, "");
    await p1;

    // Advance clock by 40 minutes — still inside the 50-min TTL.
    clock += 40 * 60 * 1000;
    const p2 = client.sendPush("t", { aps: {} }, { pushType: "alert", priority: 10, topic: "ai.lilaclabs.gini.mobile" });
    await Bun.sleep(1);
    fake.respond(1, 200, "");
    await p2;

    expect(fake.requests[0].headers.authorization).toBe(fake.requests[1].headers.authorization);

    // Now jump past the 50-min TTL — the next call must mint a new
    // JWT. The signed payload includes `iat` which advances with the
    // clock, so the third token differs from the first two even
    // though the cache key is unchanged.
    clock += 20 * 60 * 1000;
    const p3 = client.sendPush("t", { aps: {} }, { pushType: "alert", priority: 10, topic: "ai.lilaclabs.gini.mobile" });
    await Bun.sleep(1);
    fake.respond(2, 200, "");
    await p3;

    expect(fake.requests[2].headers.authorization).not.toBe(fake.requests[0].headers.authorization);
  });
});
