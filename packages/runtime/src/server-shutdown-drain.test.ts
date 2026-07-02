// Integration test for the SIGTERM-drain ordering in src/server.ts.
//
// What we're proving: the gateway's SIGTERM handler gives in-flight
// responses a short grace (`SERVER_DRAIN_GRACE_MS`) to finish writing,
// then force-closes (`server.stop(true)`) so idle keep-alive connections
// don't stall shutdown. A response that completes within the grace is
// delivered in full before the force-close.
//
// The graceful `server.stop(false)` alone never resolves while idle
// keep-alive connections linger (up to idleTimeout), so racing it against
// a short grace and then force-closing is what keeps shutdown prompt
// without truncating an in-flight response that finishes in time.
//
// We can't easily stand up the real `src/server.ts` in a unit test (it
// runs migrations, loads the scheduler, etc.). Instead we write a tiny
// throwaway server that mirrors ONLY the SIGTERM handler's structure
// (race server.stop(false) against the grace, force-close, then
// process.exit(0)) and exercise that on a real port with a real fetch
// over the wire.
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
//   1. race server.stop(false) against a short grace  ← lets an
//      in-flight response finish writing
//   2. server.stop(true)  ← force-close so idle keep-alive connections
//      can't stall shutdown
//   3. process.exit(0) only after the drain
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
        // SIGTERM after reading the first chunk, but finish the whole
        // body comfortably within the 500ms grace (~150ms total) so the
        // grace-then-force-close path delivers it in full without racing
        // the deadline.
        await Bun.sleep(120);
        controller.enqueue(enc.encode("CHUNK-2;"));
        await Bun.sleep(30);
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

// Mirror src/server.ts's SIGTERM idempotency guard. Two concurrent
// SIGTERMs must not run the handler body twice. To make the second SIGTERM
// reliably observable (POSIX may coalesce signals delivered back-to-back
// at the same moment), the handler does an artificial Bun.sleep(150ms)
// AFTER setting shutdownStarted but BEFORE running server.stop. That
// window is long enough for a "second SIGTERM" sent ~80ms later to
// land in a distinct signal event — proving the idempotency guard is
// what suppresses the duplicate, not the OS coalescer.
let shutdownStarted = false;
let handlerInvocations = 0;
let stopCalls = 0;
process.on("SIGTERM", async () => {
  handlerInvocations += 1;
  if (shutdownStarted) {
    // Surface a count of suppressed invocations on stdout so the test
    // can confirm the guard fired.
    process.stdout.write("SUPPRESSED=" + (handlerInvocations - 1) + "\\n");
    return;
  }
  shutdownStarted = true;
  // Give the test time to issue a second SIGTERM that lands while
  // we're holding the flag but haven't yet exited.
  await Bun.sleep(150);
  try {
    stopCalls += 1;
    // Give an in-flight response a short grace to finish writing, then
    // force-close so idle keep-alive connections can't stall shutdown.
    await Promise.race([
      server.stop(false),
      Bun.sleep(500)
    ]);
    server.stop(true);
  } catch {
    /* swallow */
  }
  process.stdout.write("STOP_CALLS=" + stopCalls + "\\n");
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
        // server finishes streaming — the window in which a response is
        // genuinely in-flight when shutdown begins.
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
            // The headline assertion: SIGTERM lands AFTER the first
            // chunk is on the wire but BEFORE the second + third chunks
            // have been enqueued (the controller sleeps between chunks).
            // The whole body still finishes within SERVER_DRAIN_GRACE_MS,
            // so the grace lets every chunk be written before the
            // force-close and process.exit run.
            proc.kill("SIGTERM");
          }
        }
        accumulated += dec.decode();

        // Wait for the child to exit so we can also assert exit code.
        await exited;

        // The full body must be present — including chunks emitted
        // AFTER SIGTERM landed mid-stream. The grace must deliver an
        // in-flight response that completes in time, in full.
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

  // SIGTERM idempotency. Two concurrent SIGTERMs to the same gateway
  // must not run the shutdown handler body twice. With the
  // shutdownStarted flag, the second invocation returns early. We
  // assert via stdout that STOP_CALLS=1 (server.stop called once) and
  // that at least one SUPPRESSED= line appeared.
  test.skipIf(!E2E)(
    "shutdownStarted flag prevents double-execution under concurrent SIGTERM",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gini-shutdown-idemp-"));
      const scriptPath = join(dir, "drain-server.ts");
      writeFileSync(scriptPath, SERVER_SOURCE);

      let child: ReturnType<typeof spawn> | null = null;
      const exitState: { code: number | null; exited: boolean } = { code: null, exited: false };
      try {
        child = spawn("bun", ["run", scriptPath], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        const proc = child;
        let stdoutBuf = "";
        proc.stdout!.on("data", (chunk: Buffer) => { stdoutBuf += chunk.toString("utf8"); });
        const exited = new Promise<void>((resolve) => {
          proc.on("exit", (code) => {
            exitState.code = code;
            exitState.exited = true;
            resolve();
          });
        });

        // Wait for PORT= so we know SIGTERM handler is wired.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("server did not start within 5s")), 5000);
          const check = () => {
            if (stdoutBuf.includes("PORT=")) {
              clearTimeout(timer);
              resolve();
            } else {
              setTimeout(check, 20);
            }
          };
          check();
        });

        // Fire one SIGTERM, wait ~80ms for the handler to flip the
        // shutdownStarted flag and enter its artificial 150ms sleep,
        // then fire a second SIGTERM. The second signal lands as a
        // distinct event (the OS doesn't coalesce when there's a clear
        // dispatch boundary between deliveries) and the handler's
        // re-entry must hit the guard.
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 80));
        proc.kill("SIGTERM");

        await exited;
        expect(exitState.code).toBe(0);

        // Side-effect assertions: stop was called once, the second
        // invocation was suppressed.
        expect(stdoutBuf).toContain("STOP_CALLS=1");
        expect(stdoutBuf).toMatch(/SUPPRESSED=\d+/);
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
