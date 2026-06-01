// Unit coverage for the cloudflared binary resolver. Every effectful seam is
// injected so these tests never scan the real PATH, touch the network, or shell
// out — the resolution order, the isolated-temp-dir + atomic-publish staging
// (which is what makes concurrent installs safe without a lock), the SHA-256
// integrity gate, the failure-to-typed-error mapping, and the platform/arch
// asset matrix are all exercised deterministically.

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCloudflaredBin,
  manualInstallHint,
  cloudflaredAssetFor,
  findCloudflaredOnPath,
  CloudflaredUnavailableError,
  CLOUDFLARED_RELEASES_URL,
  type EnsureCloudflaredDeps
} from "./cloudflared-install";

const tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// Build a fully-injected deps object whose effectful seams are inert by
// default. Tests override only the seams they exercise; everything else is a
// safe no-op so a stray real fs/network call can't leak in.
function stubDeps(over: Partial<EnsureCloudflaredDeps> = {}): Partial<EnsureCloudflaredDeps> {
  return {
    envOverride: undefined,
    envPath: "",
    platform: "linux",
    arch: "x64",
    binPath: "/managed/cloudflared",
    cacheDir: "/managed",
    findOnPath: () => null,
    fileExists: () => false,
    isExecutable: () => false,
    ensureDir: () => {},
    install: async () => {
      throw new Error("install should not run in this test");
    },
    mkTempDir: (cacheDir: string, rand: string) => join(cacheDir, `.tmp-${rand}`),
    rename: () => {},
    removeDir: () => {},
    rand: () => "rand",
    fetchDigest: async () => null,
    hashFile: async () => "sha256:deadbeef",
    log: () => {},
    ...over
  };
}

describe("cloudflaredAssetFor", () => {
  test("maps macOS arm64/x64 to the extractable tarballs", () => {
    expect(cloudflaredAssetFor("darwin", "arm64")).toEqual({ asset: "cloudflared-darwin-arm64.tgz", archived: true });
    expect(cloudflaredAssetFor("darwin", "x64")).toEqual({ asset: "cloudflared-darwin-amd64.tgz", archived: true });
  });

  test("maps Linux arches to the bare binaries", () => {
    expect(cloudflaredAssetFor("linux", "x64")).toEqual({ asset: "cloudflared-linux-amd64", archived: false });
    expect(cloudflaredAssetFor("linux", "arm64")).toEqual({ asset: "cloudflared-linux-arm64", archived: false });
    expect(cloudflaredAssetFor("linux", "arm")).toEqual({ asset: "cloudflared-linux-arm", archived: false });
    expect(cloudflaredAssetFor("linux", "ia32")).toEqual({ asset: "cloudflared-linux-386", archived: false });
  });

  test("maps Windows arches to the .exe assets", () => {
    expect(cloudflaredAssetFor("win32", "x64")).toEqual({ asset: "cloudflared-windows-amd64.exe", archived: false });
    expect(cloudflaredAssetFor("win32", "ia32")).toEqual({ asset: "cloudflared-windows-386.exe", archived: false });
  });

  test("returns null for unsupported arch and platform combinations", () => {
    expect(cloudflaredAssetFor("darwin", "ppc")).toBeNull();
    expect(cloudflaredAssetFor("linux", "ppc64")).toBeNull();
    expect(cloudflaredAssetFor("win32", "arm64")).toBeNull();
    expect(cloudflaredAssetFor("freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });
});

describe("manualInstallHint", () => {
  test("macOS hint extracts the tarball, no package manager assumed", () => {
    const hint = manualInstallHint("darwin", "arm64");
    expect(hint.platform).toBe("macos");
    expect(hint.command).toContain("cloudflared-darwin-arm64.tgz");
    expect(hint.command).toContain("tar -xz");
    expect(hint.command).not.toContain("brew");
    expect(hint.url).toBe(CLOUDFLARED_RELEASES_URL);
  });

  test("Linux hint downloads the bare binary and chmods it", () => {
    const hint = manualInstallHint("linux", "x64");
    expect(hint.platform).toBe("linux");
    expect(hint.command).toContain("cloudflared-linux-amd64");
    expect(hint.command).toContain("chmod +x");
  });

  test("Windows hint uses Invoke-WebRequest", () => {
    const hint = manualInstallHint("win32", "x64");
    expect(hint.platform).toBe("windows");
    expect(hint.command).toContain("Invoke-WebRequest");
    expect(hint.command).toContain("cloudflared-windows-amd64.exe");
  });

  test("unsupported platform points at the releases page", () => {
    const hint = manualInstallHint("freebsd" as NodeJS.Platform, "x64");
    expect(hint.platform).toBe("other");
    expect(hint.command).toContain(CLOUDFLARED_RELEASES_URL);
  });
});

describe("findCloudflaredOnPath", () => {
  test("returns null when PATH is undefined", () => {
    expect(findCloudflaredOnPath(undefined, "linux")).toBeNull();
  });

  test("finds an executable cloudflared in a PATH dir (real fs)", () => {
    const dir = freshDir("cf-path-hit-");
    const exe = join(dir, "cloudflared");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    expect(findCloudflaredOnPath(dir, "linux")).toBe(exe);
  });

  test("returns null when no executable is present (real fs, covers access throw)", () => {
    const dir = freshDir("cf-path-miss-");
    expect(findCloudflaredOnPath(dir, "linux")).toBeNull();
  });

  test("skips empty PATH segments", () => {
    // Leading empty segment exercises the `if (!dir) continue` guard.
    expect(findCloudflaredOnPath(":/definitely/not/here", "linux", () => false)).toBeNull();
  });

  test("looks for cloudflared.exe on Windows", () => {
    expect(
      findCloudflaredOnPath("/winbin", "win32", (p) => p.endsWith("cloudflared.exe"))
    ).toBe(join("/winbin", "cloudflared.exe"));
  });

  test("skips node_modules/.bin shims and honors a real system dir", () => {
    // The npm package's JS launcher shim under node_modules/.bin must be
    // ignored even when present + executable (it needs Node to run).
    expect(findCloudflaredOnPath("/proj/node_modules/.bin", "linux", () => true)).toBeNull();
    // A genuine system dir later in the same PATH is still used.
    expect(
      findCloudflaredOnPath("/proj/node_modules/.bin:/usr/local/bin", "linux", () => true)
    ).toBe(join("/usr/local/bin", "cloudflared"));
  });
});

describe("ensureCloudflaredBin — resolution order", () => {
  test("returns a valid GINI_CLOUDFLARED_BIN override (real fs checks)", async () => {
    const dir = freshDir("cf-override-");
    const exe = join(dir, "cloudflared");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    // No fileExists/isExecutable overrides: exercises the real default checks.
    const resolved = await ensureCloudflaredBin({ envOverride: exe, findOnPath: () => null });
    expect(resolved).toBe(exe);
  });

  test("ignores an invalid override and falls through to PATH (covers default logger)", async () => {
    const resolved = await ensureCloudflaredBin({
      envOverride: "/nonexistent/cloudflared",
      fileExists: () => false,
      findOnPath: () => "/usr/local/bin/cloudflared"
      // `log` left as the default no-op, which the override-invalid branch hits.
    });
    expect(resolved).toBe("/usr/local/bin/cloudflared");
  });

  test("returns the managed cache binary when present, without installing", async () => {
    const resolved = await ensureCloudflaredBin(
      stubDeps({
        fileExists: (p) => p === "/managed/cloudflared",
        isExecutable: () => true,
        install: async () => {
          throw new Error("install must not run when the cache is warm");
        }
      })
    );
    expect(resolved).toBe("/managed/cloudflared");
  });
});

describe("ensureCloudflaredBin — staged install (temp dir + atomic publish)", () => {
  test("installs into an isolated temp dir then atomically renames onto binPath", async () => {
    let installedTo = "";
    let renamedFrom = "";
    let renamedTo = "";
    let removed = "";
    let published = false;
    const resolved = await ensureCloudflaredBin(
      stubDeps({
        platform: "linux",
        arch: "x64",
        binPath: "/managed/cloudflared",
        cacheDir: "/managed",
        // binary is "missing" until the rename publishes it
        fileExists: (p) => (p === "/managed/cloudflared" ? published : p === installedTo),
        isExecutable: () => true,
        mkTempDir: (cacheDir, rand) => join(cacheDir, `.tmp-99-${rand}`),
        install: async (to) => {
          installedTo = to;
        },
        rename: (from, to) => {
          renamedFrom = from;
          renamedTo = to;
          published = true;
        },
        removeDir: (p) => {
          removed = p;
        },
        // verification: a real digest is published and the hash matches it.
        fetchDigest: async () => "sha256:match",
        hashFile: async () => "sha256:match"
      })
    );
    expect(resolved).toBe("/managed/cloudflared");
    // Installed into the isolated temp dir, not straight onto binPath.
    expect(installedTo).toBe(join("/managed", ".tmp-99-rand", "cloudflared"));
    expect(renamedFrom).toBe(installedTo);
    expect(renamedTo).toBe("/managed/cloudflared");
    // Temp dir cleaned up afterwards.
    expect(removed).toBe(join("/managed", ".tmp-99-rand"));
  });

  test("names the staged binary cloudflared.exe on Windows", async () => {
    let installedTo = "";
    let published = false;
    await ensureCloudflaredBin(
      stubDeps({
        platform: "win32",
        arch: "x64",
        binPath: "/managed/cloudflared.exe",
        cacheDir: "/managed",
        fileExists: (p) => (p === "/managed/cloudflared.exe" ? published : p === installedTo),
        isExecutable: () => true,
        mkTempDir: (cacheDir, rand) => join(cacheDir, `.tmp-${rand}`),
        install: async (to) => {
          installedTo = to;
        },
        rename: () => {
          published = true;
        }
      })
    );
    expect(installedTo).toBe(join("/managed", ".tmp-rand", "cloudflared.exe"));
  });

  test("real defaults: cold install stages under the cache dir and publishes the binary", async () => {
    // Exercises defaultMkTempDir, defaultRemoveDir, real renameSync, the real
    // ensureCacheDir mkdir, the default no-op logger, and managedBinName — only
    // the network install + digest fetch are stubbed.
    const root = freshDir("cf-real-stage-");
    const cacheDir = join(root, "bin");
    const binPath = join(cacheDir, "cloudflared");
    let stagedDir = "";
    const resolved = await ensureCloudflaredBin({
      envOverride: undefined,
      envPath: "",
      platform: "linux",
      arch: "x64",
      binPath,
      cacheDir,
      findOnPath: () => null,
      // Real existsSync/isExecutableFile defaults: binary truly absent until publish.
      install: async (to) => {
        // Mimic the cloudflared package writing the raw binary at `to`.
        stagedDir = join(to, "..");
        writeFileSync(to, "#!/bin/sh\nexit 0\n");
        chmodSync(to, 0o755);
      },
      // No digest available -> fail-open, real hashing skipped on this path.
      fetchDigest: async () => null
    });
    expect(resolved).toBe(binPath);
    expect(existsSync(binPath)).toBe(true);
    // The staged temp dir was created under the cache dir and then removed.
    expect(stagedDir.startsWith(cacheDir)).toBe(true);
    const leftover = readdirSync(cacheDir).filter((n) => n.startsWith(".tmp-"));
    expect(leftover).toEqual([]);
  });

  test("throws CloudflaredUnavailableError with a hint when the install fails", async () => {
    let removed = "";
    let caught: unknown;
    try {
      await ensureCloudflaredBin(
        stubDeps({
          platform: "linux",
          arch: "arm64",
          binPath: "/m/cloudflared",
          cacheDir: "/m",
          removeDir: (p) => {
            removed = p;
          },
          install: async () => {
            throw new Error("getaddrinfo ENOTFOUND github.com");
          }
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudflaredUnavailableError);
    const e = caught as CloudflaredUnavailableError;
    expect(e.hint.platform).toBe("linux");
    expect(e.message).toContain("ENOTFOUND");
    expect(e.message).toContain("install it manually");
    // Temp dir is cleaned up even on failure (finally).
    expect(removed).toBe(join("/m", ".tmp-rand"));
  });

  test("throws when install resolves but the staged binary is missing", async () => {
    let caught: unknown;
    try {
      await ensureCloudflaredBin(
        stubDeps({
          platform: "win32",
          arch: "x64",
          binPath: "/m/cloudflared.exe",
          cacheDir: "/m",
          fileExists: () => false, // staged temp bin never appears
          install: async () => {
            /* resolves but writes nothing */
          }
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudflaredUnavailableError);
    expect((caught as CloudflaredUnavailableError).hint.platform).toBe("windows");
    expect((caught as Error).message).toContain("missing");
  });

  test("throws the post-publish missing-binary error when the rename leaves nothing", async () => {
    // install + verify succeed and rename is a no-op, so the final
    // fileExists(binPath) guard after downloadVerifyPublish fires.
    let caught: unknown;
    const seen = { tempBin: false };
    try {
      await ensureCloudflaredBin(
        stubDeps({
          platform: "linux",
          arch: "x64",
          binPath: "/m/cloudflared",
          cacheDir: "/m",
          // Staged temp bin exists (so verify/rename run) but binPath never does.
          fileExists: (p) => {
            if (p === "/m/cloudflared") return false;
            seen.tempBin = true;
            return true;
          },
          install: async () => {},
          rename: () => {}, // publish is a no-op -> binPath still missing
          fetchDigest: async () => null
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(seen.tempBin).toBe(true);
    expect(caught).toBeInstanceOf(CloudflaredUnavailableError);
    expect((caught as Error).message).toContain("missing");
  });
});

describe("ensureCloudflaredBin — integrity verification", () => {
  test("fails closed when the downloaded binary's digest does not match (raw asset)", async () => {
    let removed = "";
    let renamed = false;
    const events: string[] = [];
    let caught: unknown;
    try {
      await ensureCloudflaredBin(
        stubDeps({
          platform: "linux",
          arch: "x64",
          binPath: "/m/cloudflared",
          cacheDir: "/m",
          fileExists: (p) => p !== "/m/cloudflared", // temp bin present, binPath absent
          install: async () => {},
          rename: () => {
            renamed = true;
          },
          removeDir: (p) => {
            removed = p;
          },
          fetchDigest: async () => "sha256:expected",
          hashFile: async () => "sha256:tampered",
          log: (e) => events.push(e)
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudflaredUnavailableError);
    expect((caught as Error).message).toContain("integrity verification");
    expect((caught as Error).message).toContain("sha256:expected");
    // Never published; temp dir removed.
    expect(renamed).toBe(false);
    expect(removed).toBe(join("/m", ".tmp-rand"));
    expect(events).toContain("tunnel.cloudflared.verify-mismatch");
  });

  test("passes and publishes when the digest matches (raw asset, logs verify-ok)", async () => {
    const events: string[] = [];
    let published = false;
    const resolved = await ensureCloudflaredBin(
      stubDeps({
        platform: "linux",
        arch: "x64",
        binPath: "/m/cloudflared",
        cacheDir: "/m",
        fileExists: (p) => (p === "/m/cloudflared" ? published : true),
        isExecutable: () => true,
        install: async () => {},
        rename: () => {
          published = true;
        },
        fetchDigest: async () => "sha256:abc",
        hashFile: async () => "sha256:abc",
        log: (e) => events.push(e)
      })
    );
    expect(resolved).toBe("/m/cloudflared");
    expect(events).toContain("tunnel.cloudflared.verify-ok");
  });

  test("fails open (logs skip, still publishes) when the digest cannot be fetched", async () => {
    const events: Array<{ e: string; d?: Record<string, unknown> }> = [];
    let published = false;
    const resolved = await ensureCloudflaredBin(
      stubDeps({
        platform: "linux",
        arch: "x64",
        binPath: "/m/cloudflared",
        cacheDir: "/m",
        fileExists: (p) => (p === "/m/cloudflared" ? published : true),
        isExecutable: () => true,
        install: async () => {},
        rename: () => {
          published = true;
        },
        fetchDigest: async () => null, // offline / API error
        hashFile: async () => {
          throw new Error("hashFile must not run when no digest is available");
        },
        log: (e, d) => events.push({ e, d })
      })
    );
    expect(resolved).toBe("/m/cloudflared");
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("digest-unavailable");
  });

  test("skips verification for the macOS .tgz asset (digest is over the archive, not the binary)", async () => {
    const events: Array<{ e: string; d?: Record<string, unknown> }> = [];
    let published = false;
    let fetched = false;
    const resolved = await ensureCloudflaredBin(
      stubDeps({
        platform: "darwin",
        arch: "arm64",
        binPath: "/m/cloudflared",
        cacheDir: "/m",
        fileExists: (p) => (p === "/m/cloudflared" ? published : true),
        isExecutable: () => true,
        install: async () => {},
        rename: () => {
          published = true;
        },
        fetchDigest: async () => {
          fetched = true;
          return "sha256:tgzdigest";
        },
        hashFile: async () => {
          throw new Error("hashFile must not run for an archived asset");
        },
        log: (e, d) => events.push({ e, d })
      })
    );
    expect(resolved).toBe("/m/cloudflared");
    // The tgz digest is never even fetched — the produced binary can't match it.
    expect(fetched).toBe(false);
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("archived-asset");
  });

  test("skips verification for a platform with no published asset", async () => {
    const events: Array<{ e: string; d?: Record<string, unknown> }> = [];
    let published = false;
    const resolved = await ensureCloudflaredBin(
      stubDeps({
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
        binPath: "/m/cloudflared",
        cacheDir: "/m",
        fileExists: (p) => (p === "/m/cloudflared" ? published : true),
        isExecutable: () => true,
        install: async () => {},
        rename: () => {
          published = true;
        },
        log: (e, d) => events.push({ e, d })
      })
    );
    expect(resolved).toBe("/m/cloudflared");
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("no-published-asset");
  });
});

describe("ensureCloudflaredBin — real default seams (temp, hashing)", () => {
  test("real defaultFetchDigest + defaultHashFile verify a real staged binary (stubbed fetch)", async () => {
    const root = freshDir("cf-real-verify-");
    const cacheDir = join(root, "bin");
    const binPath = join(cacheDir, "cloudflared");
    // Stub global fetch so defaultFetchDigest runs for real against a fake
    // GitHub response; compute the matching sha256 with Bun's hasher so the
    // real defaultHashFile produces an equal digest.
    const realFetch = globalThis.fetch;
    const payload = "fake-cloudflared-binary-bytes";
    const expectedHex = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ assets: [{ name: "cloudflared-linux-amd64", digest: `sha256:${expectedHex}` }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
    try {
      const events: string[] = [];
      const resolved = await ensureCloudflaredBin({
        envOverride: undefined,
        envPath: "",
        platform: "linux",
        arch: "x64",
        binPath,
        cacheDir,
        findOnPath: () => null,
        // Real defaultMkTempDir/rename/removeDir/hashFile/fetchDigest.
        install: async (to) => {
          writeFileSync(to, payload);
          chmodSync(to, 0o755);
        },
        log: (e) => events.push(e)
      });
      expect(resolved).toBe(binPath);
      expect(existsSync(binPath)).toBe(true);
      expect(events).toContain("tunnel.cloudflared.verify-ok");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("defaultFetchDigest behavior (via the real seam)", () => {
  // Drive ensureCloudflaredBin with the real fetchDigest while stubbing global
  // fetch, to cover every branch of defaultFetchDigest: !ok, no-match,
  // bad-digest-shape, and a thrown fetch — all must fail OPEN (install still
  // succeeds) since none yields a usable digest.
  async function runWithFetch(fakeFetch: typeof fetch): Promise<{ resolved: string; events: Array<{ e: string; d?: Record<string, unknown> }> }> {
    const root = freshDir("cf-fetch-branch-");
    const cacheDir = join(root, "bin");
    const binPath = join(cacheDir, "cloudflared");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    const events: Array<{ e: string; d?: Record<string, unknown> }> = [];
    try {
      const resolved = await ensureCloudflaredBin({
        envOverride: undefined,
        envPath: "",
        platform: "linux",
        arch: "x64",
        binPath,
        cacheDir,
        findOnPath: () => null,
        install: async (to) => {
          writeFileSync(to, "x");
          chmodSync(to, 0o755);
        },
        log: (e, d) => events.push({ e, d })
      });
      return { resolved, events };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("non-OK response -> fail open (verify-skipped: digest-unavailable)", async () => {
    const { events } = await runWithFetch((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("digest-unavailable");
  });

  test("asset not present in the release -> fail open", async () => {
    const { events } = await runWithFetch((async () =>
      new Response(JSON.stringify({ assets: [{ name: "something-else", digest: "sha256:x" }] }), {
        status: 200
      })) as unknown as typeof fetch);
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("digest-unavailable");
  });

  test("asset present but digest not sha256-prefixed -> fail open", async () => {
    const { events } = await runWithFetch((async () =>
      new Response(JSON.stringify({ assets: [{ name: "cloudflared-linux-amd64", digest: "md5:abc" }] }), {
        status: 200
      })) as unknown as typeof fetch);
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("digest-unavailable");
  });

  test("fetch throws (offline) -> fail open", async () => {
    const { events } = await runWithFetch((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    const skip = events.find((x) => x.e === "tunnel.cloudflared.verify-skipped");
    expect(skip?.d?.reason).toBe("digest-unavailable");
  });
});

describe("defaultHashFile error path", () => {
  test("rejects when the file cannot be read (covers stream error branch)", async () => {
    // A digest mismatch is irrelevant here; we need defaultHashFile to be
    // invoked against a path that errors mid-stream. Point install at a temp
    // bin that we delete before hashing by making fileExists lie: simplest is
    // to drive the real hashFile against a missing file through a stubbed fetch
    // that returns a real digest so hashing runs.
    const root = freshDir("cf-hash-err-");
    const cacheDir = join(root, "bin");
    const binPath = join(cacheDir, "cloudflared");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ assets: [{ name: "cloudflared-linux-amd64", digest: "sha256:abc" }] }), {
        status: 200
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await ensureCloudflaredBin({
        envOverride: undefined,
        envPath: "",
        platform: "linux",
        arch: "x64",
        binPath,
        cacheDir,
        findOnPath: () => null,
        // Claim the staged bin exists so verification proceeds, but never
        // actually create it -> real defaultHashFile's createReadStream errors.
        fileExists: (p) => p !== binPath,
        install: async () => {
          /* writes nothing; temp bin is absent on disk */
        },
        rename: () => {}
      });
    } catch (err) {
      caught = err;
    }
    globalThis.fetch = realFetch;
    // The hash stream error surfaces as a rejection out of ensureCloudflaredBin.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/ENOENT|no such file/i);
  });
});

describe("CloudflaredUnavailableError", () => {
  test("carries the hint and a stable name", () => {
    const err = new CloudflaredUnavailableError("nope", { platform: "other", command: "c", url: "u" });
    expect(err.name).toBe("CloudflaredUnavailableError");
    expect(err.hint).toEqual({ platform: "other", command: "c", url: "u" });
    expect(err).toBeInstanceOf(Error);
  });
});
