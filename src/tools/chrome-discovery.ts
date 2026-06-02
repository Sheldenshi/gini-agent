// Cross-platform Chrome discovery and launch-identity selection. Two jobs:
// (1) findChromePath probes the canonical install locations for Chrome /
// Chromium / Edge on macOS, Linux, and Windows (plus an explicit override env
// var) and returns an absolute path or null; (2) resolveBrowserLaunchTarget /
// launchPersistentChrome choose the identity and args the managed/persistent
// launches use so the agent browser presents as a normal branded Chrome rather
// than "Google Chrome for Testing". See ADR browser-stealth-identity.md
// (issue #218).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const ENV_OVERRIDE = "GINI_CHROME_PATH";

// Shared Chromium launch args for every managed/persistent launch. The
// AutomationControlled toggle clears navigator.webdriver so sites with
// automation-integrity checks treat the browser like a normal Chrome.
// See ADR browser-stealth-identity.md (issue #218).
export const CHROME_LAUNCH_ARGS: readonly string[] = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=ChromeWhatsNewUI,Translate",
  "--disable-blink-features=AutomationControlled"
];

// macOS canonical paths in priority order: Chrome stable → Chromium →
// Microsoft Edge. We prefer Chrome because it's the most common headed
// browser on developer Macs.
const MACOS_CANDIDATES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];

// Linux: the same binaries live under /usr/bin/ or /usr/local/bin/ depending
// on distro. We hard-code both prefixes instead of shelling out to `which`
// so the discovery stays synchronous and dependency-free.
const LINUX_CANDIDATES: readonly string[] = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/usr/local/bin/google-chrome",
  "/usr/local/bin/chromium",
  "/snap/bin/chromium"
];

// Windows: %ProgramFiles%, %ProgramFiles(x86)%, and %LocalAppData% are the
// three install roots Chrome / Edge use. Resolve env vars manually instead
// of relying on shell expansion since Node's existsSync sees the literal
// string.
function windowsCandidates(): string[] {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LocalAppData"] ?? join(homedir(), "AppData", "Local");
  return [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Chromium", "Application", "chrome.exe")
  ];
}

export function platformCandidates(plat: NodeJS.Platform = platform()): readonly string[] {
  if (plat === "darwin") return MACOS_CANDIDATES;
  if (plat === "win32") return windowsCandidates();
  // Default to the Linux list for any other Unix-like platform.
  return LINUX_CANDIDATES;
}

// Returns the path to the Chromium binary playwright-core ships with, or
// null if it isn't on disk (e.g. `bunx playwright install chromium` was
// never run, or playwright-core isn't installed). This bundled Chromium is
// the automatic FALLBACK for findChromePath: it's guaranteed to match
// playwright-core's pinned CDP protocol revision (system Chrome can be
// arbitrarily ahead and produces silent /devtools/browser/<id> handshake
// hangs on protocol drift), but on disk it's literally "Google Chrome for
// Testing.app", which trips automation-integrity checks — so the launch
// path prefers branded Chrome and only lands here when branded Chrome is
// absent or fails to launch (see resolveBrowserLaunchTarget and ADR
// browser-stealth-identity.md). The import is dynamic so callers (and tests
// that mock playwright-core) aren't forced to eagerly resolve the module.
async function playwrightChromiumPath(): Promise<string | null> {
  try {
    const mod = (await import("playwright-core")) as {
      chromium?: { executablePath?: () => string };
    };
    const exec = mod.chromium?.executablePath?.();
    if (typeof exec !== "string" || exec.length === 0) return null;
    return existsSync(exec) ? exec : null;
  } catch {
    // playwright-core not installed, executablePath threw because the
    // browser wasn't installed, or any other resolution failure.
    return null;
  }
}

// Returns the first existing Chrome-compatible binary path, or null if none
// of the candidates are present on disk. This is the bundled-first FALLBACK
// chain (used by resolveBrowserLaunchTarget when no branded Chrome is
// installed, and as launchPersistentChrome's recovery when a branded launch
// fails). Precedence:
//   1. GINI_CHROME_PATH env var (user override, wins unconditionally so an
//      override pointing at a missing path returns null rather than
//      silently falling back).
//   2. Playwright's bundled Chromium (CDP protocol guaranteed compatible
//      with the playwright-core version we depend on).
//   3. System Chrome / Chromium / Edge candidates by platform.
export async function findChromePath(): Promise<string | null> {
  const override = process.env[ENV_OVERRIDE];
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? override : null;
  }
  const bundled = await playwrightChromiumPath();
  if (bundled) return bundled;
  for (const candidate of platformCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Path to a STABLE branded Google Chrome (not Canary / Chromium / Edge) if
// one is installed, else null. The branded build is what makes the agent
// browser present as a normal Chrome — see resolveBrowserLaunchTarget.
function brandedChromePath(plat: NodeJS.Platform = platform()): string | null {
  let candidates: readonly string[];
  if (plat === "darwin") {
    candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  } else if (plat === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LocalAppData"] ?? join(homedir(), "AppData", "Local");
    candidates = [
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
    ];
  } else {
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/local/bin/google-chrome"
    ];
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// The identity a managed/persistent launch should use. `channel: "chrome"`
// tells Playwright to drive the real branded Google Chrome stable build;
// when set, executablePath carries the resolved path for display only.
export interface ChromeLaunchTarget {
  channel?: "chrome";
  executablePath: string | null;
}

// Choose the launch identity. GINI_CHROME_PATH override wins (explicit
// binary, no channel). Otherwise prefer branded Chrome via the "chrome"
// channel; fall back to the bundled-first findChromePath chain (no channel)
// when no branded Chrome is installed. See ADR browser-stealth-identity.md.
export async function resolveBrowserLaunchTarget(
  plat: NodeJS.Platform = platform()
): Promise<ChromeLaunchTarget> {
  const override = process.env[ENV_OVERRIDE];
  if (override !== undefined && override.length > 0) {
    return { executablePath: existsSync(override) ? override : null };
  }
  const branded = brandedChromePath(plat);
  if (branded) return { channel: "chrome", executablePath: branded };
  return { executablePath: await findChromePath() };
}

// Maps a resolved Chrome binary to the reduced Chrome UA derived from its
// major version. Computed once per binary so the --version subprocess runs
// at most once.
const userAgentCache = new Map<string, string | undefined>();

// A clean reduced Chrome UA for the given binary, or undefined when the
// version can't be determined (e.g. Windows chrome.exe doesn't print
// --version to stdout). Used only for HEADLESS launches: headless Chrome
// otherwise leaks "HeadlessChrome" into both navigator.userAgent and the
// wire User-Agent header, which mismatches the (already branded) Sec-CH-UA
// client hints and is itself a detection signal. Returning undefined skips
// the override so there's no regression where the version is unknown.
export function cleanChromeUserAgent(
  execPath: string | null,
  plat: NodeJS.Platform = platform()
): string | undefined {
  if (execPath === null) return undefined;
  if (userAgentCache.has(execPath)) return userAgentCache.get(execPath);
  let ua: string | undefined;
  try {
    const out = execFileSync(execPath, ["--version"], { encoding: "utf8", timeout: 4000 });
    const major = (/(\d+)\.\d+\.\d+\.\d+/.exec(out) ?? /(\d+)\./.exec(out))?.[1];
    if (major) {
      const token =
        plat === "darwin"
          ? "Macintosh; Intel Mac OS X 10_15_7"
          : plat === "win32"
            ? "Windows NT 10.0; Win64; x64"
            : "X11; Linux x86_64";
      ua = `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    }
  } catch {
    // --version failed (missing binary, no stdout, timeout) — leave ua
    // undefined so the caller skips the override.
  }
  userAgentCache.set(execPath, ua);
  return ua;
}

// Launch a persistent context as a normal branded Chrome. Resolves the
// identity (branded channel, override binary, or bundled fallback), applies
// the shared stealth args, normalizes the headless UA, and — when driving
// the branded channel — falls back to the bundled Chromium if the branded
// launch can't start or drive (e.g. CDP protocol drift) so the agent
// browser stays available. Returns the live context plus the binary path
// that actually backed it (for UI display). See ADR browser-stealth-identity.md.
export async function launchPersistentChrome(
  chromium: {
    launchPersistentContext: (dir: string, options: Record<string, unknown>) => Promise<unknown>;
  },
  dataDir: string,
  opts: { headless: boolean; extraOptions?: Record<string, unknown> }
): Promise<{ context: unknown; chromePath: string | null }> {
  const target = await resolveBrowserLaunchTarget();
  const userAgent = opts.headless ? cleanChromeUserAgent(target.executablePath) : undefined;
  const base: Record<string, unknown> = {
    headless: opts.headless,
    args: [...CHROME_LAUNCH_ARGS],
    ...(userAgent ? { userAgent } : {}),
    ...(opts.extraOptions ?? {})
  };
  if (target.channel) {
    try {
      const context = await chromium.launchPersistentContext(dataDir, {
        ...base,
        channel: target.channel
      });
      return { context, chromePath: target.executablePath };
    } catch {
      // Branded Chrome couldn't launch/drive (e.g. protocol drift). Fall
      // back to the bundled Chromium so the agent browser stays available.
      const fallback = await findChromePath();
      const context = await chromium.launchPersistentContext(dataDir, {
        ...base,
        executablePath: fallback ?? undefined
      });
      return { context, chromePath: fallback };
    }
  }
  const context = await chromium.launchPersistentContext(dataDir, {
    ...base,
    executablePath: target.executablePath ?? undefined
  });
  return { context, chromePath: target.executablePath };
}
