import { describe, expect, test } from "bun:test";
import {
  extractTunnelUrl,
  readTunnelUrlFromStream,
  spawnQuickTunnel,
  type SpawnTunnelOptions
} from "./cloudflared";

describe("cloudflared URL parsing", () => {
  test("extracts URL from a single line banner", () => {
    expect(extractTunnelUrl("2026-01-01T00:00:00Z INF |  https://demo-words-123.trycloudflare.com  |"))
      .toBe("https://demo-words-123.trycloudflare.com");
  });

  test("returns null when no URL is present", () => {
    expect(extractTunnelUrl("2026-01-01T00:00:00Z INF Starting tunnel")).toBeNull();
  });

  test("matches the first URL when multiple are emitted on one line", () => {
    const line = "see https://primary-a.trycloudflare.com and https://other-b.trycloudflare.com";
    expect(extractTunnelUrl(line)).toBe("https://primary-a.trycloudflare.com");
  });

  test("readTunnelUrlFromStream pulls bytes until a URL appears", async () => {
    const stream = makeStream([
      "Starting tunnel...\n",
      "Negotiating with edge...\n",
      "+--------------+\n",
      "|  https://demo-fox-quick-12.trycloudflare.com  |\n",
      "+--------------+\n"
    ]);
    const url = await readTunnelUrlFromStream(stream);
    expect(url).toBe("https://demo-fox-quick-12.trycloudflare.com");
  });

  test("throws when the stream ends without producing a URL", async () => {
    const stream = makeStream(["only logs here\n", "no url\n"]);
    await expect(readTunnelUrlFromStream(stream)).rejects.toThrow(/closed before a URL appeared/);
  });

  test("throws when stderr is not piped", async () => {
    await expect(readTunnelUrlFromStream(null)).rejects.toThrow(/not piped/);
  });
});

describe("spawnQuickTunnel", () => {
  test("returns a handle once the URL is observed", async () => {
    const fakeChild = makeFakeChild([
      "INF Starting tunnel\n",
      "INF |  https://stub-tunnel-42.trycloudflare.com  |\n"
    ]);
    const spawnStub: SpawnTunnelOptions["spawn"] = () => fakeChild;
    const handle = await spawnQuickTunnel({
      targetUrl: "http://127.0.0.1:7778",
      spawn: spawnStub,
      startupTimeoutMs: 1000
    });
    expect(handle.url).toBe("https://stub-tunnel-42.trycloudflare.com");
    await handle.stop();
    await handle.exited;
  });

  test("rejects when cloudflared exits before producing a URL", async () => {
    const fakeChild = makeFakeChild(["INF Starting\n"], { exitImmediately: true, exitCode: 1 });
    const spawnStub: SpawnTunnelOptions["spawn"] = () => fakeChild;
    await expect(
      spawnQuickTunnel({
        targetUrl: "http://127.0.0.1:7778",
        spawn: spawnStub,
        startupTimeoutMs: 1000
      })
    ).rejects.toThrow(/exited before advertising a URL|stderr closed before a URL/);
  });

  test("rejects when startup timeout elapses", async () => {
    const fakeChild = makeFakeChild([], { keepOpen: true });
    const spawnStub: SpawnTunnelOptions["spawn"] = () => fakeChild;
    await expect(
      spawnQuickTunnel({
        targetUrl: "http://127.0.0.1:7778",
        spawn: spawnStub,
        startupTimeoutMs: 50
      })
    ).rejects.toThrow(/did not advertise a URL within 50ms/);
    fakeChild.kill("SIGTERM");
    await fakeChild.exited;
  });
});

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    }
  });
}

interface FakeChild {
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: string | number): void;
  readonly pid?: number;
}

function makeFakeChild(
  chunks: string[],
  options: { exitImmediately?: boolean; exitCode?: number; keepOpen?: boolean } = {}
): FakeChild {
  const encoder = new TextEncoder();
  let killed = false;
  const exitResolvers = Promise.withResolvers<number>();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (options.exitImmediately) {
        controller.close();
        return;
      }
      // Emit all chunks immediately, then keep the stream open unless killed.
      (async () => {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        if (!options.keepOpen && !options.exitImmediately) {
          // Keep the controller around so kill() can close it; tests that
          // expect a URL will resolve before the stream closes.
        }
      })();
    },
    cancel() {
      controllerRef = null;
    }
  });
  if (options.exitImmediately) {
    queueMicrotask(() => exitResolvers.resolve(options.exitCode ?? 0));
  }
  return {
    stderr,
    exited: exitResolvers.promise,
    pid: 12345,
    kill() {
      if (killed) return;
      killed = true;
      try { controllerRef?.close(); } catch { /* already closed */ }
      exitResolvers.resolve(0);
    }
  };
}
