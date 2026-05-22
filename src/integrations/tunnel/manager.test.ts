import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  composeAppleNoteBody,
  renderSnapshotQr,
  resolveTunnelConfig,
  TunnelManager,
  type TunnelManagerOptions
} from "./manager";
import type { RuntimeConfig } from "../../types";

describe("resolveTunnelConfig", () => {
  test("generates a fresh secret when the on-disk value is missing", () => {
    const result = resolveTunnelConfig(baseConfig());
    expect(result.mutated).toBe(true);
    expect(result.config.secret).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  test("preserves an existing valid secret", () => {
    const config = baseConfig();
    config.tunnel = { secret: "preserved-secret-1234567890abc" };
    const result = resolveTunnelConfig(config);
    expect(result.mutated).toBe(false);
    expect(result.config.secret).toBe("preserved-secret-1234567890abc");
  });

  test("env var GINI_TUNNEL=1 flips the default enabled flag on", () => {
    const config = baseConfig();
    const result = resolveTunnelConfig(config, { GINI_TUNNEL: "1" });
    expect(result.config.enabled).toBe(true);
  });

  test("explicit config.tunnel.enabled wins over env", () => {
    const config = baseConfig();
    config.tunnel = { enabled: false, secret: "abcdefghij1234567890" };
    const result = resolveTunnelConfig(config, { GINI_TUNNEL: "1" });
    expect(result.config.enabled).toBe(false);
  });

  test("apple notes enabled defaults to true on darwin and false elsewhere", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const a = resolveTunnelConfig(baseConfig());
      expect(a.config.appleNotes.enabled).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const b = resolveTunnelConfig(baseConfig());
      expect(b.config.appleNotes.enabled).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("TunnelManager", () => {
  test("start populates the snapshot once the URL appears", async () => {
    setupInstanceDir("tunnel-manager-start");
    const manager = makeManager("tunnel-manager-start", {
      streamChunks: ["INF starting...\n", "INF https://test-vibes-77.trycloudflare.com\n"]
    });
    const snapshot = await manager.start();
    expect(snapshot.publicUrl).toBe(`https://test-vibes-77.trycloudflare.com/${snapshot.secret}/`);
    expect(snapshot.cloudflareUrl).toBe("https://test-vibes-77.trycloudflare.com");
    expect(snapshot.observedAt).not.toBeNull();
    await manager.stop();
  });

  test("stop tears down the subprocess and clears the public URL", async () => {
    setupInstanceDir("tunnel-manager-stop");
    const manager = makeManager("tunnel-manager-stop", {
      streamChunks: ["INF https://test-vibes-66.trycloudflare.com\n"]
    });
    await manager.start();
    await manager.stop();
    const snapshot = manager.getSnapshot();
    expect(snapshot.publicUrl).toBeNull();
    expect(snapshot.cloudflareUrl).toBeNull();
  });

  test("Apple Notes push is invoked when iCloud is signed in and disabled flag false", async () => {
    setupInstanceDir("tunnel-manager-notes");
    const calls: string[] = [];
    const manager = makeManager("tunnel-manager-notes", {
      streamChunks: ["INF https://test-vibes-55.trycloudflare.com\n"],
      osascript: async (script) => {
        calls.push(script);
        if (script.includes("name of every account")) {
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    await manager.flushNotes();
    const snapshot = manager.getSnapshot();
    expect(snapshot.appleNotes.available).toBe(true);
    expect(snapshot.appleNotes.lastSyncedAt).not.toBeNull();
    expect(calls.some((script) => script.includes("make new note"))).toBe(true);
    // The runtime log must never contain the secret-bearing public URL.
    // The credential bypasses bearer auth, so persisting it to disk
    // would make stale logs equivalent to a leaked token.
    const logPath = join("/tmp/gini-tunnel-tests-logs/tunnel-manager-notes/runtime.jsonl");
    if (existsSync(logPath)) {
      const contents = readFileSync(logPath, "utf8");
      expect(contents).not.toContain(snapshot.secret);
    }
    await manager.stop();
  });

  test("refreshAppleNote skips osascript entirely when appleNotes.enabled is false", async () => {
    setupInstanceDir("tunnel-manager-notes-disabled");
    let osascriptCalls = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-notes-disabled",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://gated-notes-1.trycloudflare.com\n"]),
      osascript: async () => {
        osascriptCalls += 1;
        return { stdout: "yes\n", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    const snapshot = await manager.refreshAppleNote();
    // No osascript invocation should have happened on either the
    // fire-and-forget refresh (gated at start()) or this explicit call.
    expect(osascriptCalls).toBe(0);
    expect(snapshot.appleNotes.lastSyncedAt).toBeNull();
    await manager.stop();
  });

  test("refreshAppleNote is single-flight under concurrent callers", async () => {
    setupInstanceDir("tunnel-manager-notes-singleflight");
    let inFlight = 0;
    let maxInFlight = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-notes-singleflight",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: true, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://singleflight-1.trycloudflare.com\n"]),
      osascript: async (script) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        if (script.includes("name of every account")) {
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    await Promise.all([manager.refreshAppleNote(), manager.refreshAppleNote(), manager.refreshAppleNote()]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    await manager.stop();
  });

  test("Apple Notes is skipped when iCloud lookup reports no", async () => {
    setupInstanceDir("tunnel-manager-no-icloud");
    const manager = makeManager("tunnel-manager-no-icloud", {
      streamChunks: ["INF https://test-vibes-44.trycloudflare.com\n"],
      osascript: async () => ({ stdout: "no\n", stderr: "", exitCode: 0 })
    });
    await manager.start();
    await manager.flushNotes();
    const snapshot = manager.getSnapshot();
    expect(snapshot.appleNotes.available).toBe(false);
    expect(snapshot.appleNotes.lastSyncedAt).toBeNull();
    await manager.stop();
  });

  test("composeAppleNoteBody renders the public URL prominently", () => {
    const body = composeAppleNoteBody({
      publicUrl: "https://x.trycloudflare.com/sssss/",
      cloudflareUrl: "https://x.trycloudflare.com",
      secret: "sssss",
      targetUrl: "http://127.0.0.1:7778",
      observedAt: "2026-01-01T00:00:00.000Z",
      appleNotes: {
        enabled: true,
        folder: "gini",
        noteName: "n",
        available: true,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    });
    expect(body.split("\n")[0]).toBe("https://x.trycloudflare.com/sssss/");
    expect(body).toContain("Target: http://127.0.0.1:7778");
  });

  test("renderSnapshotQr returns null when there is no public URL", () => {
    const out = renderSnapshotQr({
      publicUrl: null,
      cloudflareUrl: null,
      secret: "x",
      targetUrl: "http://127.0.0.1:1",
      observedAt: null,
      appleNotes: {
        enabled: false,
        folder: "",
        noteName: "",
        available: null,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    });
    expect(out).toBeNull();
  });

  test("concurrent start() calls dedup onto a single spawn", async () => {
    setupInstanceDir("tunnel-manager-dedup");
    let spawnCount = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-dedup",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        spawnCount += 1;
        return scriptedChild(["INF https://dedup-tunnel-1.trycloudflare.com\n"]);
      }
    });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    expect(spawnCount).toBe(1);
    expect(a.cloudflareUrl).toBe("https://dedup-tunnel-1.trycloudflare.com");
    expect(b.cloudflareUrl).toBe("https://dedup-tunnel-1.trycloudflare.com");
    await manager.stop();
  });

  test("start() during in-flight stop waits for teardown before spawning", async () => {
    setupInstanceDir("tunnel-manager-start-during-stop");
    let spawnCount = 0;
    const spawned: Array<{ killed: boolean }> = [];
    const manager = new TunnelManager({
      instance: "tunnel-manager-start-during-stop",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        const state = { killed: false };
        spawned.push(state);
        const url = `INF https://restart-${++spawnCount}.trycloudflare.com\n`;
        return scriptedChild([url], {
          killDelayMs: 30,
          onKill: () => { state.killed = true; }
        });
      }
    });
    await manager.start();
    const stopP = manager.stop();
    const startP = manager.start();
    await Promise.all([stopP, startP]);
    // First child stopped completely before the second spawn began.
    expect(spawned[0]?.killed).toBe(true);
    expect(spawnCount).toBe(2);
    expect(manager.getSnapshot().publicUrl).toContain("restart-2");
    await manager.stop();
  });

  test("stop() during in-flight start tears the child down on its own", async () => {
    setupInstanceDir("tunnel-manager-stop-during-start");
    let killed = false;
    const manager = new TunnelManager({
      instance: "tunnel-manager-stop-during-start",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        const child = scriptedChild(["INF https://laggard-tunnel-9.trycloudflare.com\n"], {
          urlDelayMs: 20,
          onKill: () => { killed = true; }
        });
        return child;
      }
    });
    const startP = manager.start();
    // Don't await start — issue stop while it's still spawning.
    await manager.stop();
    const snapshot = await startP;
    expect(snapshot.publicUrl).toBeNull();
    expect(snapshot.lastError).toContain("cancelled by concurrent stop");
    expect(killed).toBe(true);
  });

  test("renderSnapshotQr returns ANSI + SVG when a URL is set", () => {
    const out = renderSnapshotQr({
      publicUrl: "https://x.trycloudflare.com/abcd1234efgh5678/",
      cloudflareUrl: "https://x.trycloudflare.com",
      secret: "abcd1234efgh5678",
      targetUrl: "http://127.0.0.1:7778",
      observedAt: "2026-01-01",
      appleNotes: {
        enabled: false,
        folder: "",
        noteName: "",
        available: null,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    });
    expect(out?.svg.startsWith("<svg")).toBe(true);
    expect(out?.ansi.length).toBeGreaterThan(50);
    expect(out?.url).toBe("https://x.trycloudflare.com/abcd1234efgh5678/");
  });
});

function baseConfig(): RuntimeConfig {
  return {
    instance: "tunnel-test",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: "/tmp/gini-tunnel-tests/instances/tunnel-test",
    logRoot: "/tmp/gini-tunnel-tests-logs/tunnel-test",
    approvalMode: "auto"
  };
}

function setupInstanceDir(instance: string): void {
  const root = "/tmp/gini-tunnel-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  // Clean the log dir too. Historical runtime.jsonl entries from earlier
  // runs would otherwise be visible to credential-leak regression
  // assertions and confuse "is this a fresh write or stale residue?".
  rmSync(`${root}-logs/${instance}`, { recursive: true, force: true });
}

interface ScriptedSpawnOptions {
  streamChunks: string[];
  osascript?: TunnelManagerOptions["osascript"];
  disableAppleNotes?: boolean;
}

function makeManager(instance: string, options: ScriptedSpawnOptions): TunnelManager {
  return new TunnelManager({
    instance,
    config: {
      enabled: true,
      secret: "abcd1234efgh5678ijkl9012mnop3456",
      appleNotes: {
        enabled: true,
        folder: "gini-test",
        noteName: "tunnel-url",
        account: "iCloud"
      }
    },
    targetUrl: "http://127.0.0.1:7778",
    disableAppleNotes: options.disableAppleNotes ?? !options.osascript,
    spawn: () => scriptedChild(options.streamChunks),
    osascript: options.osascript
  });
}

function scriptedChild(
  chunks: string[],
  options: { urlDelayMs?: number; killDelayMs?: number; onKill?: () => void } = {}
) {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const exitResolvers = Promise.withResolvers<number>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      void (async () => {
        if (options.urlDelayMs) await Bun.sleep(options.urlDelayMs);
        for (const chunk of chunks) {
          if (!controllerRef) return;
          controller.enqueue(encoder.encode(chunk));
        }
      })();
    },
    cancel() {
      controllerRef = null;
    }
  });
  return {
    stderr: stream,
    exited: exitResolvers.promise,
    pid: 99999,
    kill() {
      try { controllerRef?.close(); } catch { /* ignore */ }
      controllerRef = null;
      options.onKill?.();
      if (options.killDelayMs) {
        setTimeout(() => exitResolvers.resolve(0), options.killDelayMs);
      } else {
        exitResolvers.resolve(0);
      }
    }
  };
}
