// Integration test for the SIGTERM-drain ordering in src/server.ts.
//
// What we're proving: the gateway's SIGTERM handler awaits
// `server.stop(false)` (the polite "wait for in-flight requests" variant)
// BEFORE the process exits, so a response that's mid-stream when SIGTERM
// arrives still reaches the client in full.
//
// This is the round-4 HIGH-1 fix. The pre-fix code called
// `server.stop(true)` synchronously — force-close — which could drop the
// last bytes of a slow setup POST when /api/setup/provider triggered the
// shutdown-self pattern.
//
// We can't easily stand up the real `src/server.ts` in a unit test (it
// runs migrations, loads the scheduler, etc.). Instead we write a tiny
// throwaway server that mirrors ONLY the SIGTERM handler's structure
// (await server.stop(false) with a 5s failsafe, then process.exit(0))
// and exercise that on a real port with a real fetch over the wire.
//
// Gated by `GINI_AUTOSTART_E2E=1` because it binds a real ephemeral port
// and spawns a real Bun subprocess. ~1-2 seconds when it runs.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E = process.env.GINI_AUTOSTART_E2E === "1";

// The throwaway server inlined here mirrors src/server.ts's SIGTERM
// drain pattern. The handler returns a Response built from a
// ReadableStream whose body is streamed in chunks with sleeps between
// — that lets us reliably catch the stream "mid-flight" by sending
// SIGTERM after the test has read the first chunk.
//
// Keep this in sync with src/server.ts's SIGTERM handler. The key
// behaviors under test:
//   1. await server.stop(false)  ← drains in-flight responses
//   2. 5s failsafe so a hung connection can't block shutdown
//   3. process.exit(0) only after the drain races to completion
const SERVER_SOURCE = `
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch() {
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode("CHUNK-1;"));
        // Hold the response open long enough for the test to send
        // SIGTERM after reading the first chunk. 400ms is comfortable.
        await Bun.sleep(400);
        controller.enqueue(enc.encode("CHUNK-2;"));
        await Bun.sleep(50);
        controller.enqueue(enc.encode("CHUNK-3-END"));
        controller.close();
      }
    });
    return new Response(body, {
      headers: { "content-type": "text/plain" }
    });
  }
});

// Tell the parent test which port we bound on.
console.log("PORT=" + server.port);

process.on("SIGTERM", async () => {
  try {
    await Promise.race([
      server.stop(false),
      Bun.sleep(5000)
    ]);
  } catch {
    /* swallow */
  }
  process.exit(0);
});
`;

describe("server SIGTERM drain", () => {
  test.skipIf(!E2E)(
    "in-flight response body is fully readable before process exits",
    async () => {
      // Stage the throwaway server in a temp dir so we don't pollute the
      // repo. We use `bun run <abs-path>` to execute it.
      const dir = mkdtempSync(join(tmpdir(), "gini-shutdown-drain-"));
      const scriptPath = join(dir, "drain-server.ts");
      writeFileSync(scriptPath, SERVER_SOURCE);

      let child: ReturnType<typeof spawn> | null = null;
      // Container so TS doesn't narrow the field after the `=== null`
      // guard in the finally block. Mutated by the `exit` listener.
      const exitState: { code: number | null; signal: NodeJS.Signals | null; exited: boolean } = {
        code: null,
        signal: null,
        exited: false
      };
      try {
        child = spawn("bun", ["run", scriptPath], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"]
        });
        const proc = child;
        const exited = new Promise<void>((resolve) => {
          proc.on("exit", (code, signal) => {
            exitState.code = code;
            exitState.signal = signal;
            exitState.exited = true;
            resolve();
          });
        });

        // Wait for the server to print "PORT=<n>" so we know it's
        // listening. 5s budget is generous on a healthy machine.
        const port: number = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("server did not print PORT= within 5s")), 5000);
          let buf = "";
          proc.stdout!.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const match = buf.match(/PORT=(\d+)/);
            if (match) {
              clearTimeout(timer);
              resolve(Number(match[1]));
            }
          });
        });

        // Issue a real HTTP request. Read the body as a stream so we
        // can send SIGTERM AFTER the first chunk arrives but BEFORE the
        // server finishes streaming. That's the exact window the
        // pre-fix `server.stop(true)` would drop bytes in.
        const response = await fetch(`http://127.0.0.1:${port}/`);
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();

        // Read first chunk, send SIGTERM, then drain the rest.
        const dec = new TextDecoder();
        let accumulated = "";
        let signaledAfterFirstChunk = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          accumulated += dec.decode(value, { stream: true });
          if (!signaledAfterFirstChunk && accumulated.includes("CHUNK-1")) {
            signaledAfterFirstChunk = true;
            // The headline assertion: SIGTERM lands AFTER first chunk
            // is on the wire but BEFORE the second + third chunks have
            // been enqueued (the controller sleeps for 400ms between
            // chunks). With server.stop(false), the drain MUST wait
            // for all chunks to be written before letting process.exit
            // run.
            proc.kill("SIGTERM");
          }
        }
        accumulated += dec.decode();

        // Wait for the child to exit so we can also assert exit code.
        await exited;

        // The full body must be present — including chunks emitted
        // AFTER SIGTERM landed mid-stream. This is the regression we're
        // guarding against.
        expect(accumulated).toContain("CHUNK-1");
        expect(accumulated).toContain("CHUNK-2");
        expect(accumulated).toContain("CHUNK-3-END");
        expect(accumulated).toBe("CHUNK-1;CHUNK-2;CHUNK-3-END");

        // Clean exit (0), not killed by an external signal.
        expect(exitState.code).toBe(0);
        expect(exitState.signal).toBeNull();
      } finally {
        if (child && !exitState.exited) {
          try { child.kill("SIGKILL"); } catch { /* best-effort */ }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15000
  );
});
