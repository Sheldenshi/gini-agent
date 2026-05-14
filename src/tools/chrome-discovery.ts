// Cross-platform Chrome binary discovery. Used by the browser-connect
// capability when the runtime needs to spawn a headed Chrome on the user's
// behalf. The lookup is intentionally narrow — we probe the canonical install
// locations for Chrome / Chromium / Edge on macOS, Linux, and Windows, plus an
// explicit override env var. Callers receive an absolute path or null; they're
// responsible for surfacing a user-facing "install Chrome" message.
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const ENV_OVERRIDE = "GINI_CHROME_PATH";

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
// never run, or playwright-core isn't installed). We prefer this over the
// system Chrome because the bundled Chromium is guaranteed to match
// playwright-core's pinned CDP protocol revision; system Chrome can be
// arbitrarily ahead and produces silent /devtools/browser/<id> handshake
// hangs on protocol drift. The import is dynamic so callers (and tests
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
// of the candidates are present on disk. Precedence:
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
