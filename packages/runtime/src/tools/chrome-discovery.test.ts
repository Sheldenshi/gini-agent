import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_LAUNCH_ARGS,
  cleanChromeUserAgent,
  findChromePath,
  platformCandidates,
  resolveBrowserLaunchTarget
} from "./chrome-discovery";

// Save / restore the env var so tests don't leak state into each other.
const ORIGINAL_ENV = process.env["GINI_CHROME_PATH"];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env["GINI_CHROME_PATH"];
  } else {
    process.env["GINI_CHROME_PATH"] = ORIGINAL_ENV;
  }
  mock.restore();
});

async function withFakeBinary<T>(fn: (path: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gini-chrome-"));
  const binary = join(dir, "fake-chrome");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    return await fn(binary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Like withFakeBinary but the script prints `version` to stdout (so
// cleanChromeUserAgent's `--version` probe can parse a major version).
async function withVersionBinary<T>(
  version: string,
  fn: (path: string) => T | Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gini-chrome-ver-"));
  const binary = join(dir, "fake-chrome");
  writeFileSync(binary, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  try {
    return await fn(binary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("findChromePath", () => {
  test("env override wins when the pointed-at file exists", async () => {
    await withFakeBinary(async (path) => {
      process.env["GINI_CHROME_PATH"] = path;
      expect(await findChromePath()).toBe(path);
    });
  });

  test("env override returns null when the file does not exist", async () => {
    const missing = join(tmpdir(), `gini-missing-${Date.now()}-${Math.random()}`);
    process.env["GINI_CHROME_PATH"] = missing;
    expect(await findChromePath()).toBeNull();
  });

  test("empty env override falls back to candidate scan", async () => {
    process.env["GINI_CHROME_PATH"] = "";
    // We can't assert the absolute return value (depends on the host
    // machine) but we can verify that it didn't blow up and produced
    // either a string or null — never undefined.
    const result = await findChromePath();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("platformCandidates returns macOS paths on darwin", () => {
    const list = platformCandidates("darwin");
    expect(list.some((path) => path.endsWith("Google Chrome"))).toBe(true);
  });

  test("platformCandidates returns Linux paths on linux", () => {
    const list = platformCandidates("linux");
    expect(list.some((path) => path.includes("google-chrome"))).toBe(true);
    expect(list.some((path) => path.includes("chromium"))).toBe(true);
  });

  test("platformCandidates returns Windows .exe paths on win32", () => {
    const list = platformCandidates("win32");
    expect(list.some((path) => path.toLowerCase().endsWith("chrome.exe"))).toBe(true);
  });

  test("returns null when no candidates exist (mocked via empty-dir override)", async () => {
    // The override branch is what's actually directly testable without
    // monkey-patching fs.existsSync. We've already covered the
    // candidate-scan fall-through via the "empty env override" test above.
    // Use a fresh directory with no Chrome binaries inside to point the
    // override at a path that definitely doesn't exist.
    const dir = mkdtempSync(join(tmpdir(), "gini-chrome-empty-"));
    try {
      mkdirSync(join(dir, "subdir"), { recursive: true });
      process.env["GINI_CHROME_PATH"] = join(dir, "subdir", "nope");
      expect(await findChromePath()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Playwright bundled Chromium has higher precedence than the
  // system-paths scan: Playwright was built against an exact Chromium
  // revision, so the CDP protocol version is guaranteed to match. The
  // system Chrome can be arbitrarily ahead and produces silent
  // /devtools/browser/<id> handshake hangs on protocol drift. Mock the
  // playwright-core module so we don't depend on a real install on disk.
  test("Playwright bundled Chromium is preferred over system paths", async () => {
    // Ensure no env override masks the bundled-vs-system precedence.
    delete process.env["GINI_CHROME_PATH"];
    await withFakeBinary(async (bundled) => {
      mock.module("playwright-core", () => ({
        chromium: { executablePath: () => bundled }
      }));
      expect(await findChromePath()).toBe(bundled);
    });
  });

  test("GINI_CHROME_PATH still wins over Playwright bundled", async () => {
    await withFakeBinary(async (override) => {
      await withFakeBinary(async (bundled) => {
        process.env["GINI_CHROME_PATH"] = override;
        mock.module("playwright-core", () => ({
          chromium: { executablePath: () => bundled }
        }));
        expect(await findChromePath()).toBe(override);
      });
    });
  });

  test("falls back to system scan when Playwright bundled path does not exist", async () => {
    delete process.env["GINI_CHROME_PATH"];
    const missing = join(tmpdir(), `gini-bundled-missing-${Date.now()}-${Math.random()}`);
    mock.module("playwright-core", () => ({
      chromium: { executablePath: () => missing }
    }));
    // We can't assert the exact return value (depends on the host) but
    // we can verify the bundled-missing path didn't blow up and the
    // function returned either null or a string from the system scan.
    const result = await findChromePath();
    expect(result === null || typeof result === "string").toBe(true);
    if (typeof result === "string") {
      expect(result).not.toBe(missing);
    }
  });
});

describe("CHROME_LAUNCH_ARGS", () => {
  test("includes the AutomationControlled toggle that clears navigator.webdriver", () => {
    expect(CHROME_LAUNCH_ARGS).toContain("--disable-blink-features=AutomationControlled");
  });

  test("uses the basic password store so logins persist independent of the Keychain", () => {
    expect(CHROME_LAUNCH_ARGS).toContain("--password-store=basic");
  });
});

describe("resolveBrowserLaunchTarget", () => {
  test("GINI_CHROME_PATH override yields the explicit binary, not branded", async () => {
    await withFakeBinary(async (path) => {
      process.env["GINI_CHROME_PATH"] = path;
      const target = await resolveBrowserLaunchTarget();
      expect(target.executablePath).toBe(path);
      expect(target.branded).toBe(false);
    });
  });

  test("invariant: a branded target always carries a non-null executablePath", async () => {
    delete process.env["GINI_CHROME_PATH"];
    const target = await resolveBrowserLaunchTarget();
    if (target.branded) {
      expect(target.executablePath).not.toBeNull();
    }
  });
});

describe("cleanChromeUserAgent", () => {
  test("returns undefined for a null path", async () => {
    expect(await cleanChromeUserAgent(null)).toBeUndefined();
  });

  test("derives a reduced Chrome UA (major only) with no Headless token", async () => {
    await withVersionBinary("Google Chrome 142.0.7000.1", async (path) => {
      const ua = await cleanChromeUserAgent(path, "darwin");
      expect(ua).toBeDefined();
      expect(ua!).toContain("Chrome/142.0.0.0");
      expect(ua!).toContain("Macintosh; Intel Mac OS X 10_15_7");
      expect(ua!).not.toContain("Headless");
    });
  });

  // Separate binaries per platform: the UA is cached per execPath, so reusing
  // one path would return the first platform's cached result for the second.
  test("uses the platform token for the passed platform", async () => {
    await withVersionBinary("Google Chrome 142.0.7000.1", async (linuxPath) => {
      expect((await cleanChromeUserAgent(linuxPath, "linux"))!).toContain("X11; Linux x86_64");
    });
    await withVersionBinary("Google Chrome 142.0.7000.1", async (winPath) => {
      expect((await cleanChromeUserAgent(winPath, "win32"))!).toContain(
        "Windows NT 10.0; Win64; x64"
      );
    });
  });
});
