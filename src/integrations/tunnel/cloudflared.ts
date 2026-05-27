// Cloudflare Quick Tunnel subprocess manager.
//
// `cloudflared tunnel --url http://127.0.0.1:<port>` opens an anonymous public
// HTTPS tunnel to a localhost origin. The binary writes a banner to stderr
// shortly after start that contains a `https://<words>.trycloudflare.com`
// URL — that URL is the only published handle for the tunnel, and it rotates
// every restart. This module owns spawning, parsing the URL, observing the
// child for exit, and tearing it down cleanly on shutdown.
//
// The tunnel itself is unauthenticated; the gateway gates requests by URL
// prefix (see secret-path.ts) so the URL alone is enough to grant access
// to anyone holding it. Cloudflare's quick tunnels rotate on every restart,
// so leaked URLs do not survive the next gateway boot.

import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export interface SpawnTunnelOptions {
  /** Where cloudflared should send its origin requests. */
  targetUrl: string;
  /** Path to the `cloudflared` binary. Defaults to `cloudflared` on PATH. */
  binary?: string;
  /** Append cloudflared's stderr to this file (created if absent). */
  logPath?: string;
  /** Cap on how long to wait for the first URL to appear. Defaults to 25s. */
  startupTimeoutMs?: number;
  /**
   * Optional abort signal. When triggered, the in-flight spawn rejects
   * promptly, the cloudflared child is SIGTERM'd, and the log handle is
   * closed. Used by the TunnelManager so a SIGTERM in the gateway's
   * shutdown drain can cancel a pending spawn without waiting for the
   * full `startupTimeoutMs`.
   */
  signal?: AbortSignal;
  /**
   * Injectable spawner for tests. Receives the resolved command + args and
   * must return a Bun-compatible Subprocess. The default uses Bun.spawn.
   */
  spawn?: (command: string[], opts: { stderr: "pipe"; stdout: "ignore" | "inherit" }) =>
    {
      readonly stderr: ReadableStream<Uint8Array> | null;
      readonly exited: Promise<number>;
      kill(signal?: string | number): void;
      readonly pid?: number;
    };
  /**
   * Strings to scrub from stderr before persisting to the log file.
   * cloudflared logs per-request error lines that include the full
   * destination URL — when the gateway pairs cloudflared with a
   * secret-path scheme, that URL embeds the secret. Without this
   * redaction the on-disk log carries the live credential, which a
   * helpful "share the log" support-debug message can leak. The
   * TunnelManager passes the active secret here so a leaked log
   * doesn't double as a leaked tunnel URL.
   */
  redactStrings?: readonly string[];
}

const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Stateful redactor that holds back the trailing N-1 bytes of every
 * input chunk (where N is the longest redact string) so a secret
 * straddling a chunk boundary still matches. Each `consume` returns
 * the bytes that are safe to flush now; `flush` returns any held
 * remainder when the stream closes.
 */
class StreamingRedactor {
  private readonly secrets: readonly string[];
  private readonly maxLen: number;
  private buffer = "";

  constructor(secrets: readonly string[] | undefined) {
    this.secrets = (secrets ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
    this.maxLen = this.secrets.reduce((max, s) => Math.max(max, s.length), 0);
  }

  consume(value: Uint8Array): Uint8Array {
    if (this.secrets.length === 0) return value;
    // Decode as UTF-8. cloudflared stderr is ASCII, so chunk-split
    // multi-byte sequences aren't a concern in practice; on the
    // boundary we hold back maxLen-1 chars regardless of encoding.
    this.buffer += new TextDecoder().decode(value);
    if (this.buffer.length <= this.maxLen - 1) return new Uint8Array(0);
    // Keep the trailing (maxLen - 1) characters as the holdover —
    // the next chunk's prefix combined with this tail still has a
    // chance to form a complete secret occurrence.
    const cutoff = this.buffer.length - (this.maxLen - 1);
    let release = this.buffer.slice(0, cutoff);
    this.buffer = this.buffer.slice(cutoff);
    for (const secret of this.secrets) {
      release = release.replaceAll(secret, REDACTED_PLACEHOLDER);
    }
    return new TextEncoder().encode(release);
  }

  flush(): Uint8Array {
    if (this.secrets.length === 0 || this.buffer.length === 0) return new Uint8Array(0);
    let release = this.buffer;
    this.buffer = "";
    for (const secret of this.secrets) {
      release = release.replaceAll(secret, REDACTED_PLACEHOLDER);
    }
    return new TextEncoder().encode(release);
  }
}

export interface TunnelHandle {
  /** The parsed `https://<...>.trycloudflare.com` URL. */
  url: string;
  /** PID of the cloudflared process, when the spawner exposed one. */
  pid: number | undefined;
  /** Resolves when the child process exits, with its exit code. */
  exited: Promise<number>;
  /** Send SIGTERM; resolves once `exited` settles. */
  stop(): Promise<void>;
}

/**
 * Spawn cloudflared and wait for it to advertise a public URL. The returned
 * handle keeps the subprocess alive; call `stop()` to tear it down.
 *
 * @throws if the subprocess exits before producing a URL, or if the
 * startup timeout elapses.
 */
export async function spawnQuickTunnel(options: SpawnTunnelOptions): Promise<TunnelHandle> {
  // Honour the abort signal BEFORE spawning. A SIGTERM or disable PATCH
  // that landed between options being constructed and this function
  // being entered would otherwise still cause cloudflared to spawn —
  // the abort listener registered later would only fire after the
  // child was already running, leaving a brief window where the
  // public tunnel went live despite the operator's intent.
  if (options.signal?.aborted) {
    throw new Error("cloudflared spawn aborted");
  }
  const binary = options.binary ?? "cloudflared";
  const command = [binary, "tunnel", "--no-autoupdate", "--url", options.targetUrl];
  const spawner = options.spawn ?? defaultSpawner;
  const child = spawner(command, { stderr: "pipe", stdout: "ignore" });

  let logHandle: FileHandle | null = null;
  if (options.logPath) {
    try {
      mkdirSync(dirname(options.logPath), { recursive: true });
      logHandle = await open(options.logPath, "a");
    } catch {
      logHandle = null;
    }
  }
  // Re-check the abort signal after the log-open await: the operator
  // may have flipped disable while we awaited the file handle. The
  // race below catches a CONCURRENT abort, but an abort that already
  // settled by the time the race starts would otherwise be missed.
  if (options.signal?.aborted) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    if (logHandle) {
      try { await logHandle.close(); } catch { /* ignore */ }
    }
    throw new Error("cloudflared spawn aborted");
  }

  // The parser resolves with the URL plus a `drained` promise that
  // settles when the background drainer finishes reading stderr. We
  // need to await that drainer before closing the log handle on exit,
  // otherwise the last few stderr lines (usually the most diagnostic
  // info about why cloudflared crashed) get dropped because the
  // drainer's pending `log.write()` throws "file closed" after we
  // close the handle.
  let drained: Promise<void> = Promise.resolve();
  const urlPromise = parseUrlFromStderr(child.stderr, logHandle, options.redactStrings).then((result) => {
    drained = result.drained;
    return result.url;
  });
  const timeoutMs = options.startupTimeoutMs ?? 25_000;

  // Externally-aborted spawn: the parent runtime can cancel before
  // either the URL arrives or the timeout elapses. Wrap the abort in a
  // promise alongside the rest of the race so cleanup runs through the
  // shared catch path.
  const abortPromise = new Promise<never>((_, reject) => {
    if (!options.signal) return;
    if (options.signal.aborted) {
      reject(new Error("cloudflared spawn aborted"));
      return;
    }
    options.signal.addEventListener(
      "abort",
      () => reject(new Error("cloudflared spawn aborted")),
      { once: true }
    );
  });

  let url: string;
  try {
    url = await Promise.race([
      urlPromise,
      child.exited.then((code) => {
        throw new Error(`cloudflared exited before advertising a URL (code ${code})`);
      }),
      Bun.sleep(timeoutMs).then(() => {
        throw new Error(`cloudflared did not advertise a URL within ${timeoutMs}ms`);
      }),
      abortPromise
    ]);
  } catch (error) {
    // Clean up before the throw escapes: kill the child if it's still
    // running and close the log handle. Without this, a startup-timeout
    // path leaves cloudflared running in the background indefinitely,
    // and the open file descriptor leaks until GC eventually finalises
    // the handle. Both kills are best-effort — a kill against a child
    // that already exited is harmless.
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    try {
      await Promise.race([child.exited, Bun.sleep(2_000)]);
    } catch { /* ignore */ }
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    if (logHandle) {
      try { await logHandle.close(); } catch { /* ignore */ }
      logHandle = null;
    }
    // Swallow the orphaned urlPromise so its eventual rejection (the
    // stream closes after kill) does not surface as an unhandled
    // rejection later in the event loop.
    void urlPromise.catch(() => {});
    throw error;
  }

  const handle: TunnelHandle = {
    url,
    pid: child.pid,
    exited: child.exited.finally(async () => {
      if (logHandle) {
        // Wait for the background drainer to finish before closing the
        // log handle, so the tail of stderr — which often carries the
        // most diagnostic info about why cloudflared crashed — actually
        // lands in the log. Bounded to 1s so a misbehaving cloudflared
        // can't block gateway shutdown indefinitely.
        try {
          await Promise.race([drained, Bun.sleep(1_000)]);
        } catch { /* drainer errors are already swallowed */ }
        // Best-effort close; failure is non-fatal.
        try { await logHandle.close(); } catch { /* ignore */ }
        logHandle = null;
      }
    }),
    async stop() {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      try {
        await Promise.race([
          child.exited,
          Bun.sleep(5_000).then(() => { child.kill("SIGKILL"); return child.exited; })
        ]);
      } catch {
        // child.exited never rejects, but defensive in case the spawner does.
      }
    }
  };
  return handle;
}

/**
 * Pull bytes off `stream` until a `https://*.trycloudflare.com` URL appears.
 * Exposed for unit tests so the parser can be exercised without spawning a
 * subprocess.
 */
export async function readTunnelUrlFromStream(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) throw new Error("cloudflared stderr is not piped");
  const result = await parseUrlFromStderr(stream, null, undefined);
  return result.url;
}

/**
 * Extract the public URL from one or more lines of cloudflared output. The
 * banner wraps the URL inside box-drawing characters, so we strip leading
 * decoration before matching.
 */
export function extractTunnelUrl(line: string): string | null {
  // Two known shapes:
  //  - 2024-01-01T00:00:00Z INF |  https://words-here.trycloudflare.com  |
  //  - https://words-here.trycloudflare.com (some structured-log paths)
  const match = line.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

async function parseUrlFromStderr(
  stream: ReadableStream<Uint8Array> | null,
  log: FileHandle | null,
  redactStrings: readonly string[] | undefined
): Promise<{ url: string; drained: Promise<void> }> {
  if (!stream) throw new Error("cloudflared stderr is not piped");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const redactor = new StreamingRedactor(redactStrings);
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (log) {
      const safe = redactor.consume(value);
      if (safe.length > 0) await log.write(Buffer.from(safe));
    }
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const url = extractTunnelUrl(line);
      if (url) {
        // Release the reader and immediately re-acquire a drainer so
        // stderr keeps flowing — either into the log file when one is
        // configured, or just to /dev/null when not. Without draining,
        // the OS pipe buffer (64 KiB on macOS and Linux) saturates and
        // cloudflared's writer blocks, eventually deadlocking the
        // subprocess.
        try { reader.releaseLock(); } catch { /* ignore */ }
        const drained = keepDraining(stream, log, redactor);
        return { url, drained };
      }
      nl = buffer.indexOf("\n");
    }
  }
  // Stream closed before URL: flush held-back bytes (if redacting) so
  // we don't lose any tail material the log was supposed to carry.
  if (log) {
    const tail = redactor.flush();
    if (tail.length > 0) await log.write(Buffer.from(tail));
  }
  throw new Error("cloudflared stderr closed before a URL appeared");
}

function keepDraining(stream: ReadableStream<Uint8Array>, log: FileHandle | null, redactor: StreamingRedactor): Promise<void> {
  // Continue reading stderr without blocking startup. When a log handle
  // is provided we copy bytes into it; without one we discard. Errors
  // are swallowed so a closed log or stream can't keep the process
  // alive after exit. The returned promise settles when the stream
  // closes (or errors), so callers can await it before closing the log
  // handle to avoid losing the tail of stderr.
  return (async () => {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (log) {
          const safe = redactor.consume(value);
          if (safe.length > 0) await log.write(Buffer.from(safe));
        }
      }
      // Stream closed: flush held-back bytes so the log doesn't lose
      // the final fragment of stderr.
      if (log) {
        const tail = redactor.flush();
        if (tail.length > 0) await log.write(Buffer.from(tail));
      }
    } catch {
      /* ignore */
    }
  })();
}

function defaultSpawner(
  command: string[],
  opts: { stderr: "pipe"; stdout: "ignore" | "inherit" }
): ReturnType<NonNullable<SpawnTunnelOptions["spawn"]>> {
  // Bun's Subprocess shape is broader than the minimal interface we expose
  // to consumers; the cast narrows the return type without leaking
  // Bun-specific shape into callers.
  //
  // Spawn cloudflared with a SANITIZED environment, not the gateway's
  // ambient one. cloudflared honours `TUNNEL_HTTP_HOST_HEADER` (per
  // its origin-parameters docs) — when set, every request forwarded
  // from cloudflared to the local origin carries the configured
  // value as `Host:`. If that env var leaked in from the operator's
  // shell or a co-tenant launcher to say `localhost`, every tunneled
  // request would arrive at proxy.ts with a loopback Host, the
  // isLocalHostName check would pass, and the secret-path gate would
  // be bypassed entirely. Whitelist only PATH, HOME, USER, LANG, TZ
  // — enough for cloudflared to find its binary, locate its own
  // cache dir, and produce timestamps in the operator's locale.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ"]) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  const child = Bun.spawn(command, { ...opts, stdin: "ignore", env });
  return child as unknown as ReturnType<NonNullable<SpawnTunnelOptions["spawn"]>>;
}
