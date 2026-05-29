import { spawn, type ChildProcess } from "node:child_process";

// Spawn cloudflared as a quick tunnel forwarding to 127.0.0.1:<port>, parse
// the public URL out of stderr's banner, and provide a SIGTERM-with-SIGKILL
// fallback for teardown. See docs/adr/tunnel-and-mobile-access.md
// "Architecture (summary)".

export interface CloudflaredLaunch {
  process: ChildProcess;
  /** Resolves with the public URL once cloudflared prints its banner. */
  publicUrl: Promise<string>;
  /** Stop the process. Sends SIGTERM, then SIGKILL after the cap. */
  stop(): Promise<void>;
}

const URL_REGEX = /https?:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/;
export const TERMINATE_CAP_MS = 5_000;

export interface LaunchOptions {
  /** Override the binary path. Defaults to `cloudflared` from PATH. */
  bin?: string;
  /** Web port cloudflared forwards to. */
  port: number;
  /** Bound on banner-parse time. */
  bannerTimeoutMs?: number;
}

export function launchCloudflared(opts: LaunchOptions): CloudflaredLaunch {
  const bin = opts.bin ?? "cloudflared";
  const args = [
    "tunnel",
    "--no-autoupdate",
    "--protocol", "http2",
    "--url", `http://127.0.0.1:${opts.port}`
  ];
  // Whitelist the env the subprocess actually needs. The gateway's parent
  // env carries provider API keys (OPENAI_API_KEY, GINI_* tokens) that
  // cloudflared has no business reading; passing `env: {...}` overrides
  // Node's default-inherited env so a compromise of the cloudflared
  // binary can't exfiltrate them via process.env.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8"
  };
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const publicUrl = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });

  const timeoutMs = opts.bannerTimeoutMs ?? 30_000;
  const bannerTimer = setTimeout(() => rejectUrl(new Error("cloudflared banner timeout")), timeoutMs);

  // Accumulate stdout + stderr into rolling buffers so the URL is still
  // matched when cloudflared's banner is split across two `'data'` events
  // (Node streams deliver arbitrary byte boundaries). Each buffer is capped
  // at 64 KiB and trimmed from the front so the most-recent tail — where
  // the URL line lives — always survives.
  const MAX_BUFFER = 65_536;
  let stdoutBuf = "";
  let stderrBuf = "";
  const onChunk = (which: "stdout" | "stderr") => (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (which === "stdout") {
      stdoutBuf = (stdoutBuf + text).slice(-MAX_BUFFER);
    } else {
      stderrBuf = (stderrBuf + text).slice(-MAX_BUFFER);
    }
    const m = stdoutBuf.match(URL_REGEX) ?? stderrBuf.match(URL_REGEX);
    if (m) {
      clearTimeout(bannerTimer);
      resolveUrl(m[0]);
    }
  };
  proc.stdout?.on("data", onChunk("stdout"));
  proc.stderr?.on("data", onChunk("stderr"));
  proc.on("error", (err) => {
    clearTimeout(bannerTimer);
    rejectUrl(translateSpawnError(err));
  });
  proc.on("exit", (code) => {
    clearTimeout(bannerTimer);
    // If we never observed a banner before exit, fail the promise so the
    // caller's apply path surfaces the error rather than hanging.
    rejectUrl(new Error(`cloudflared exited with code ${code ?? "?"} before banner`));
  });

  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, TERMINATE_CAP_MS);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  return { process: proc, publicUrl, stop };
}

/** Replace a raw ENOENT from `child_process.spawn` with an operator-readable
 *  error that names the missing dependency and points at the one-liner
 *  install per platform. Other spawn errors (EACCES, ECHILD, signal-driven
 *  exits) propagate unchanged — the ENOENT shape is the only one that
 *  reliably maps to "cloudflared isn't on PATH", and we don't want to
 *  mistranslate a real runtime fault. The wrapped error still propagates up
 *  through `publicUrl`'s reject path so TunnelManager surfaces it as
 *  `lastError` exactly the same way it did before. */
function translateSpawnError(err: Error): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") return err;
  return new Error(
    "cloudflared not installed or not on PATH — install via 'brew install cloudflared' (macOS), " +
      "'sudo apt install cloudflared' (Linux), or 'scoop install cloudflared' (Windows)"
  );
}
