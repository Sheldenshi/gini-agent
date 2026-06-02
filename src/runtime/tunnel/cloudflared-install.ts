import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { delimiter, join } from "node:path";
import { install as installCloudflaredBinary } from "cloudflared";
import { cloudflaredBinPath, cloudflaredCacheDir } from "../../paths";
import type { CloudflaredInstallHint } from "./types";

// Re-exported so callers can pull the hint type from the install module they
// already import for `manualInstallHint` / `ensureCloudflaredBin`.
export type { CloudflaredInstallHint } from "./types";

// Resolve (and, if necessary, download) a usable `cloudflared` binary so the
// tunnel can be enabled on a machine that has never installed it — no
// Homebrew / apt / scoop required. The actual download + platform/arch
// selection + extraction is delegated to the `cloudflared` npm package
// (MIT, github.com/JacobLinCool/node-cloudflared); this module owns the
// resolution order, the managed cache location, the concurrent-install
// safety, the post-download integrity check, and the operator-facing failure
// guidance. See docs/adr/tunnel-and-mobile-access.md.
//
// Concurrent-install correctness comes from staging, not a lock: each install
// downloads into a process-unique temp dir under the cache dir, verifies the
// raw binary against Cloudflare's published SHA-256, then publishes with a
// single same-filesystem atomic `rename(2)` onto `binPath`. Two installers
// racing the shared `~/.gini/bin` (a second gateway, `gini tunnel
// install-cloudflared`, scripts/install.sh) can at worst each redundantly
// download — the last atomic rename wins and a spawner never observes a
// half-written or tampered binary. No cross-process lock is needed.

export const CLOUDFLARED_RELEASES_URL = "https://github.com/cloudflare/cloudflared/releases";
const DOWNLOAD_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
// GitHub REST endpoint for the same "latest" release the package downloads
// from. Each asset object carries a `digest` ("sha256:<hex>") field we verify
// the downloaded binary against. Documented at
// https://docs.github.com/en/rest/releases/assets — the field is stable.
const RELEASE_API_LATEST = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

/** Thrown when no usable cloudflared could be resolved or installed. Carries
 *  the platform-appropriate manual-install hint so the caller can stamp it
 *  onto the tunnel snapshot for the UI without re-deriving it. */
export class CloudflaredUnavailableError extends Error {
  readonly hint: CloudflaredInstallHint;
  constructor(message: string, hint: CloudflaredInstallHint) {
    super(message);
    this.name = "CloudflaredUnavailableError";
    this.hint = hint;
  }
}

interface AssetSpec {
  /** Release asset filename for this platform + arch. */
  asset: string;
  /** macOS ships a `.tgz` that must be untarred to yield the bare binary;
   *  Linux and Windows ship the executable directly. Drives the shape of the
   *  manual-install one-liner. */
  archived: boolean;
}

/** Map a Node `process.platform` / `process.arch` pair to the matching
 *  cloudflared release asset. Returns null for combinations Cloudflare does
 *  not publish a build for. Asset names verified against the live GitHub
 *  releases (tag 2026.5.2). */
export function cloudflaredAssetFor(platform: NodeJS.Platform, arch: string): AssetSpec | null {
  if (platform === "darwin") {
    if (arch === "arm64") return { asset: "cloudflared-darwin-arm64.tgz", archived: true };
    if (arch === "x64") return { asset: "cloudflared-darwin-amd64.tgz", archived: true };
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return { asset: "cloudflared-linux-amd64", archived: false };
    if (arch === "arm64") return { asset: "cloudflared-linux-arm64", archived: false };
    if (arch === "arm") return { asset: "cloudflared-linux-arm", archived: false };
    if (arch === "ia32") return { asset: "cloudflared-linux-386", archived: false };
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return { asset: "cloudflared-windows-amd64.exe", archived: false };
    if (arch === "ia32") return { asset: "cloudflared-windows-386.exe", archived: false };
    return null;
  }
  return null;
}

function platformLabel(platform: NodeJS.Platform): CloudflaredInstallHint["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "other";
}

/** Platform + arch-appropriate manual-install guidance. Always returns a hint;
 *  unsupported combinations point at the releases page instead of a command. */
export function manualInstallHint(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CloudflaredInstallHint {
  const label = platformLabel(platform);
  const spec = cloudflaredAssetFor(platform, arch);
  if (!spec) {
    return {
      platform: label,
      command: `Download cloudflared for your system from ${CLOUDFLARED_RELEASES_URL}`,
      url: CLOUDFLARED_RELEASES_URL
    };
  }
  const dl = `${DOWNLOAD_BASE}/${spec.asset}`;
  if (spec.archived) {
    return {
      platform: label,
      command: `curl -L ${dl} | tar -xz && sudo mv cloudflared /usr/local/bin/`,
      url: CLOUDFLARED_RELEASES_URL
    };
  }
  if (platform === "win32") {
    return {
      platform: label,
      command: `Invoke-WebRequest ${dl} -OutFile cloudflared.exe`,
      url: CLOUDFLARED_RELEASES_URL
    };
  }
  return {
    platform: label,
    command: `curl -L ${dl} -o cloudflared && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/`,
    url: CLOUDFLARED_RELEASES_URL
  };
}

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Scan PATH for an executable `cloudflared` (or `cloudflared.exe` on
 *  Windows). Returns the absolute path of the first hit, or null. Lets a
 *  system install (Homebrew, apt, a hand-placed binary) win over a managed
 *  download so we don't re-fetch a binary the user already has. */
export function findCloudflaredOnPath(
  envPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (p: string) => boolean = isExecutableFile
): string | null {
  if (!envPath) return null;
  const names = platform === "win32" ? ["cloudflared.exe", "cloudflared.cmd"] : ["cloudflared"];
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    // Skip node_modules/.bin: the `cloudflared` npm package installs a JS
    // launcher shim there with a `#!/usr/bin/env node` shebang. The gateway
    // runs on Bun and a machine installed via scripts/install.sh may have no
    // Node on PATH, so spawning that shim would fail with ENOENT. The native
    // binary is provisioned separately (managed cache / download step below);
    // from PATH we only want a real system install (Homebrew, apt, …).
    if (dir.split(/[\\/]/).includes("node_modules")) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function ensureCacheDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function noop(): void {
  /* default no-op logger */
}

/** Default: create a process-unique temp dir inside the cache dir. The
 *  `cloudflared` package writes (and, on macOS, untars + renames) straight
 *  into `dirname(to)`; pointing `to` at an isolated dir keeps two concurrent
 *  installs from clobbering each other's extraction/rename. Lives under the
 *  cache dir so the final atomic `rename(2)` stays on one filesystem. */
function defaultMkTempDir(cacheDir: string, rand: string): string {
  const dir = join(cacheDir, `.tmp-${process.pid}-${rand}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Default: best-effort recursive remove; never throws (cleanup path). */
function defaultRemoveDir(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** Default: stream the file through SHA-256 and return a `sha256:<hex>`
 *  string matching GitHub's asset `digest` format. */
async function defaultHashFile(p: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(p);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  return promise;
}

/** Default: fetch the published `sha256:<hex>` digest for a release asset from
 *  the GitHub REST API. Returns null (fail-open) on any network/parse error so
 *  an offline or rate-limited host can still install — verification is a
 *  tamper check when the official digest is reachable, not a hard dependency. */
async function defaultFetchDigest(assetName: string): Promise<string | null> {
  try {
    const res = await fetch(RELEASE_API_LATEST, {
      headers: { accept: "application/vnd.github+json", "user-agent": "gini-cloudflared-verify" }
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { assets?: Array<{ name?: string; digest?: string | null }> };
    const asset = body.assets?.find((a) => a.name === assetName);
    const digest = asset?.digest;
    return typeof digest === "string" && digest.startsWith("sha256:") ? digest : null;
  } catch {
    return null;
  }
}

/** Seams the orchestrator depends on, defaulted to real implementations.
 *  Every effectful operation is injectable so the resolution branches can be
 *  unit-tested without touching PATH, the filesystem, the source of
 *  randomness, or the network. */
export interface EnsureCloudflaredDeps {
  envOverride: string | undefined;
  envPath: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
  binPath: string;
  cacheDir: string;
  fileExists: (p: string) => boolean;
  isExecutable: (p: string) => boolean;
  findOnPath: (envPath: string | undefined, platform: NodeJS.Platform) => string | null;
  ensureDir: (p: string) => void;
  install: (to: string) => Promise<unknown>;
  /** Make a process-unique temp dir under `cacheDir`; receives a random token
   *  so the directory name is unique per call even within one process. */
  mkTempDir: (cacheDir: string, rand: string) => string;
  /** Atomic publish of the finished binary onto its final path. */
  rename: (from: string, to: string) => void;
  /** Best-effort recursive directory removal (temp dirs). */
  removeDir: (p: string) => void;
  /** Random token feeding temp-dir uniqueness. */
  rand: () => string;
  /** Published digest for an asset, or null when it can't be fetched. */
  fetchDigest: (assetName: string) => Promise<string | null>;
  /** SHA-256 of a local file as `sha256:<hex>`. */
  hashFile: (p: string) => Promise<string>;
  log: (event: string, data?: Record<string, unknown>) => void;
}

function defaultEnsureDeps(): EnsureCloudflaredDeps {
  return {
    envOverride: process.env.GINI_CLOUDFLARED_BIN,
    envPath: process.env.PATH,
    platform: process.platform,
    arch: process.arch,
    binPath: cloudflaredBinPath(),
    cacheDir: cloudflaredCacheDir(),
    fileExists: existsSync,
    isExecutable: isExecutableFile,
    findOnPath: findCloudflaredOnPath,
    ensureDir: ensureCacheDir,
    install: installCloudflaredBinary,
    mkTempDir: defaultMkTempDir,
    rename: renameSync,
    removeDir: defaultRemoveDir,
    rand: () => randomBytes(6).toString("hex"),
    fetchDigest: defaultFetchDigest,
    hashFile: defaultHashFile,
    log: noop
  };
}

/** Bare binary name the managed install publishes. The macOS tarball always
 *  extracts a file literally named `cloudflared`, so the package's internal
 *  rename target must keep that name on darwin too. */
function managedBinName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

/** True once a usable managed binary exists at `binPath`. */
function managedBinReady(deps: EnsureCloudflaredDeps): boolean {
  return deps.fileExists(deps.binPath) && deps.isExecutable(deps.binPath);
}

/**
 * Download + verify + atomically publish the managed binary. Installs into a
 * process-unique temp dir so the package's extraction/rename can't collide
 * with a concurrent install, verifies the download against Cloudflare's
 * published SHA-256 where the asset maps directly to the produced file, then
 * atomically renames it onto `binPath`. The isolated temp dir + single
 * same-filesystem atomic `rename(2)` are what make concurrent installs safe:
 * racers each stage privately and the last rename wins, so a spawner never
 * sees a half-written or tampered binary. Throws
 * {@link CloudflaredUnavailableError} on any failure.
 */
async function downloadVerifyPublish(
  deps: EnsureCloudflaredDeps,
  hint: CloudflaredInstallHint
): Promise<void> {
  deps.ensureDir(deps.cacheDir);
  const tempDir = deps.mkTempDir(deps.cacheDir, deps.rand());
  const tempBin = join(tempDir, managedBinName(deps.platform));
  try {
    try {
      await deps.install(tempBin);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      deps.log("tunnel.cloudflared.install-failed", { error: cause });
      throw new CloudflaredUnavailableError(
        `cloudflared could not be installed automatically (${cause}). Check your internet connection and try again, or install it manually.`,
        hint
      );
    }
    if (!deps.fileExists(tempBin)) {
      throw new CloudflaredUnavailableError(
        "cloudflared install reported success but the binary is missing. Check your internet connection and try again, or install it manually.",
        hint
      );
    }

    await verifyDownloadedBinary(deps, tempBin, hint);

    // Atomic publish: rename(2) within the same filesystem (temp dir lives
    // under the cache dir) so spawners only ever see a complete binary.
    deps.rename(tempBin, deps.binPath);
  } finally {
    deps.removeDir(tempDir);
  }
}

/**
 * Integrity gate before a downloaded binary is published.
 *
 * Linux/Windows assets ARE the raw executable, so the published `digest`
 * matches the file we just wrote — we hash it and fail closed on a mismatch
 * (a tampered/corrupted binary never reaches `binPath` or gets spawned).
 *
 * macOS assets are `.tgz` archives that the `cloudflared` package extracts and
 * then deletes; the produced binary is NOT the tarball, so the published
 * digest (which is over the tarball) can't validate it. The package discards
 * the archive before returning, so we have nothing left to hash — we log a
 * skip and fall through honestly rather than compare against a digest that
 * could never match. Unsupported platforms (no asset spec) skip likewise.
 *
 * Fail-open when the digest can't be fetched (offline / API error): the goal
 * is catching tampering when the official digest is reachable, not turning the
 * GitHub API into a hard install dependency. On mismatch we delete nothing
 * here — the caller's `finally` removes the whole temp dir.
 */
async function verifyDownloadedBinary(
  deps: EnsureCloudflaredDeps,
  tempBin: string,
  hint: CloudflaredInstallHint
): Promise<void> {
  const spec = cloudflaredAssetFor(deps.platform, deps.arch);
  if (!spec || spec.archived) {
    deps.log("tunnel.cloudflared.verify-skipped", {
      reason: spec ? "archived-asset" : "no-published-asset",
      asset: spec?.asset ?? null
    });
    return;
  }
  const expected = await deps.fetchDigest(spec.asset);
  if (!expected) {
    deps.log("tunnel.cloudflared.verify-skipped", { reason: "digest-unavailable", asset: spec.asset });
    return;
  }
  const actual = await deps.hashFile(tempBin);
  if (actual !== expected) {
    deps.log("tunnel.cloudflared.verify-mismatch", { asset: spec.asset, expected, actual });
    throw new CloudflaredUnavailableError(
      `cloudflared download failed integrity verification (expected ${expected}, got ${actual}). The binary was discarded. Try again, or install it manually.`,
      hint
    );
  }
  deps.log("tunnel.cloudflared.verify-ok", { asset: spec.asset, digest: expected });
}

/**
 * Resolve a usable cloudflared binary path, installing one if needed. Order:
 *   1. `GINI_CLOUDFLARED_BIN` override (operator pinned an exact binary).
 *   2. A system cloudflared on PATH (Homebrew / apt / hand-placed).
 *   3. The managed binary previously installed under `~/.gini/bin/`.
 *   4. Download the official latest build via the `cloudflared` package into
 *      `~/.gini/bin/` — no package manager required.
 *
 * The install step (4) stages the download in a process-unique temp dir,
 * verifies it against Cloudflare's published SHA-256, then atomically
 * publishes it with a single same-filesystem `rename(2)`. That staging is the
 * concurrency guarantee on its own: two gateways, or a concurrent `gini tunnel
 * install-cloudflared` / scripts/install.sh, racing the shared `~/.gini/bin`
 * can at worst each redundantly download — the last atomic rename wins and a
 * spawner never observes a half-written or tampered binary. No lock required.
 *
 * Throws {@link CloudflaredUnavailableError} (carrying manual-install
 * guidance) when every path fails, which in practice means the host is
 * offline on a first enable.
 */
export async function ensureCloudflaredBin(
  overrides: Partial<EnsureCloudflaredDeps> = {}
): Promise<string> {
  const deps = { ...defaultEnsureDeps(), ...overrides };
  const hint = manualInstallHint(deps.platform, deps.arch);

  if (deps.envOverride) {
    if (deps.fileExists(deps.envOverride) && deps.isExecutable(deps.envOverride)) {
      return deps.envOverride;
    }
    deps.log("tunnel.cloudflared.override-invalid", { path: deps.envOverride });
  }

  const onPath = deps.findOnPath(deps.envPath, deps.platform);
  if (onPath) return onPath;

  if (managedBinReady(deps)) {
    return deps.binPath;
  }

  deps.log("tunnel.cloudflared.install-start", { target: deps.binPath });

  await downloadVerifyPublish(deps, hint);

  if (!deps.fileExists(deps.binPath)) {
    throw new CloudflaredUnavailableError(
      "cloudflared install reported success but the binary is missing. Check your internet connection and try again, or install it manually.",
      hint
    );
  }
  deps.log("tunnel.cloudflared.install-ok", { target: deps.binPath });
  return deps.binPath;
}
