// Delta-engine regime coverage through the gmail-delta hook entrypoint
// (ADR job-pre-run-hooks.md, ADR email-watch.md).
//
// Ports the watcher-state regimes (seeding, dedup, truncation, backlog drain,
// same-second siblings, signed-out, gws error, config-broken) onto the hook,
// keeping the injectable gws boundary, ephemeral instance + memory.db, and the
// disk-readback durability check. The hook returns a typed result; we assert
// both the result (shortCircuit / context / error) and the persisted watcher
// state. No child process or model turn runs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailWatcherRecord, JobRecord, JobRunRecord, RuntimeConfig } from "../../types";
import { addEmailWatcher, closeAllMemoryDbs, closeMemoryDb, isEmailSeen, readState } from "../../state";
import { WINDOW_PAGE_LIMIT, type EmailMetadata } from "../../integrations/gmail-poll-worker";
import { gmailDeltaHandler, type GmailDeltaDeps } from "./gmail-delta";
import type { JobPreRunHookResult, PreRunHookContext } from "./types";

const ROOT = mkdtempSync(join(tmpdir(), "gini-gmail-delta-test-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

const PREAMBLE = "Using keyring backend: keyring\n";

function listResponse(ids: string[]): string {
  return PREAMBLE + JSON.stringify({ messages: ids.map((id) => ({ id, threadId: id })) });
}

function pagedListResponse(pages: string[][], truncated = false): string {
  const lines = pages.map((ids, i) => {
    const isLast = i === pages.length - 1;
    const doc: Record<string, unknown> = { messages: ids.map((id) => ({ id, threadId: id })) };
    if (!isLast || truncated) doc.nextPageToken = `tok-${i}`;
    return JSON.stringify(doc);
  });
  return PREAMBLE + lines.join("\n");
}

function metadataResponse(meta: EmailMetadata): string {
  return (
    PREAMBLE +
    JSON.stringify({
      id: meta.id,
      internalDate: meta.internalDate,
      snippet: meta.snippet ?? "",
      payload: {
        headers: [
          { name: "From", value: meta.from ?? "" },
          { name: "Subject", value: meta.subject ?? "" },
          { name: "Date", value: meta.date ?? "" }
        ]
      }
    })
  );
}

function getArgId(joined: string): string | undefined {
  return joined.match(/"id":"([^"]+)"/)?.[1];
}

// gwsSpawn stub from a flat list response + a metadata map.
function stubSpawn(ids: string[], metaById: Record<string, EmailMetadata>): GmailDeltaDeps {
  return {
    sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
    resolveSelfEmail: async () => "me@example.com",
    gwsSpawn: async (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(ids);
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && metaById[hit] ? metadataResponse(metaById[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    }
  };
}

function capturingStub(
  ids: string[],
  metaById: Record<string, EmailMetadata>
): { deps: GmailDeltaDeps; listCalls: string[] } {
  const listCalls: string[] = [];
  const base = stubSpawn(ids, metaById);
  return {
    listCalls,
    deps: {
      ...base,
      gwsSpawn: async (args: string[]) => {
        const joined = args.join(" ");
        if (joined.includes("messages list")) listCalls.push(joined);
        return base.gwsSpawn!(args);
      }
    }
  };
}

// A gwsSpawn stub that HONORS the `after:<epochSec>` bound the engine builds from
// the watermark (the real Gmail contract). When `truncated` is set the last page
// carries a nextPageToken (page-cap-hit) and only the newest `pageCap` messages
// are listed.
function afterHonoringStub(
  corpus: EmailMetadata[],
  opts: { truncated?: boolean; pageCap?: number } = {}
): GmailDeltaDeps {
  const pageCap = opts.pageCap ?? 1000;
  const byId: Record<string, EmailMetadata> = {};
  for (const m of corpus) byId[m.id] = m;
  return {
    sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
    resolveSelfEmail: async () => "me@example.com",
    gwsSpawn: async (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
        const matched = corpus
          .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        const listed = opts.truncated ? matched.slice(0, pageCap) : matched;
        const pages: string[][] = [];
        if (opts.truncated && listed.length > 0) {
          const per = Math.ceil(listed.length / WINDOW_PAGE_LIMIT);
          for (let i = 0; i < WINDOW_PAGE_LIMIT; i++) {
            pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
          }
        } else {
          for (let i = 0; i < listed.length; i += 100) pages.push(listed.slice(i, i + 100).map((m) => m.id));
        }
        if (pages.length === 0) pages.push([]);
        return pagedListResponse(pages, opts.truncated);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    }
  };
}

// Invoke the hook for a watcher. Returns the typed result. Builds the minimal
// PreRunHookContext the handler reads (config + hookConfig); job/run are inert.
async function fire(
  config: RuntimeConfig,
  watcherId: string,
  deps: GmailDeltaDeps
): Promise<JobPreRunHookResult> {
  const ctx: PreRunHookContext = {
    config,
    job: { id: "job-stub" } as JobRecord,
    run: { id: "run-stub" } as JobRunRecord,
    hookConfig: { watcherId }
  };
  return gmailDeltaHandler(ctx, deps);
}

// Count the per-email draft items in a result (each is a JSON+nonce fence).
function draftCount(result: JobPreRunHookResult): number {
  if (result.kind !== "context") return 0;
  return result.items.filter((i) => i.text.includes("UNTRUSTED_EMAIL_METADATA")).length;
}

async function seedWatcher(config: RuntimeConfig, sender: string): Promise<EmailWatcherRecord> {
  return addEmailWatcher(config, { sender });
}

describe("gmail-delta hook — config validation", () => {
  test("missing watcherId => error", async () => {
    const config = buildConfig("delta-no-watcher");
    const ctx: PreRunHookContext = {
      config,
      job: { id: "j" } as JobRecord,
      run: { id: "r" } as JobRunRecord,
      hookConfig: {}
    };
    const result = await gmailDeltaHandler(ctx, {});
    expect(result.kind).toBe("error");
  });

  test("unknown watcher => error", async () => {
    const config = buildConfig("delta-unknown-watcher");
    const result = await fire(config, "nope", {});
    expect(result.kind).toBe("error");
  });
});

describe("gmail-delta hook — regimes", () => {
  test("first run baselines from the newest match without producing context", async () => {
    const config = buildConfig("delta-seed");
    const watcher = await seedWatcher(config, "alice@x.com");
    const deps = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "a" },
      m2: { id: "m2", internalDate: "2000", from: "alice@x.com", subject: "b" }
    });
    const result = await fire(config, watcher.id, deps);
    // Seeding => no model turn.
    expect(result.kind).toBe("shortCircuit");
    // Seeding BASELINES — it marks only the newest boundary id, not the backlog.
    expect(isEmailSeen(config.instance, watcher.id, "m2")).toBe(true);
    expect(isEmailSeen(config.instance, watcher.id, "m1")).toBe(false);
    const live = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(live?.lastSeenInternalDate).toBe("2000");
  });

  test("seeding on a truncated window produces no context and baselines at the newest", async () => {
    const config = buildConfig("delta-seed-huge");
    const watcher = await seedWatcher(config, "alice@x.com");
    let getCount = 0;
    const newest = "huge-newest";
    const deps: GmailDeltaDeps = {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
      resolveSelfEmail: async () => "me@example.com",
      gwsSpawn: async (args: string[]) => {
        const joined = args.join(" ");
        if (joined.includes("messages list")) {
          const tail = Array.from({ length: 40 }, (_, i) => [`old-${i}`]);
          return pagedListResponse([[newest], ...tail], true);
        }
        if (joined.includes("messages get")) {
          getCount += 1;
          const id = getArgId(joined)!;
          const internalDate = id === newest ? "8000" : "7000";
          return metadataResponse({ id, internalDate, from: "alice@x.com", subject: "s" });
        }
        return PREAMBLE + "{}";
      }
    };
    const result = await fire(config, watcher.id, deps);
    expect(result.kind).toBe("shortCircuit");
    // Newest + one older-tail probe (different second) — bounded, not a full
    // backlog enumeration.
    expect(getCount).toBe(2);
    const live = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(live?.lastSeenInternalDate).toBe("8000");
    expect(isEmailSeen(config.instance, watcher.id, newest)).toBe(true);
    expect(isEmailSeen(config.instance, watcher.id, "old-0")).toBe(false);
  });

  test("a new human match yields exactly one fenced draft; self/automated dropped", async () => {
    const config = buildConfig("delta-trigger");
    const watcher = await seedWatcher(config, "alice@x.com");
    // Seed: pretend the inbox already had m1; it must NOT draft.
    const seedRes = await fire(config, watcher.id, stubSpawn(["m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "old" }
    }));
    expect(seedRes.kind).toBe("shortCircuit");

    const result = await fire(config, watcher.id, stubSpawn(["m2", "m3", "m4"], {
      m2: { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "new" },
      m3: { id: "m3", internalDate: "3100", from: "no-reply@alice.com", subject: "auto" },
      m4: { id: "m4", internalDate: "3200", from: "me@example.com", subject: "self" }
    }));
    expect(result.kind).toBe("context");
    expect(draftCount(result)).toBe(1);
    expect(isEmailSeen(config.instance, watcher.id, "m2")).toBe(true);
    expect(isEmailSeen(config.instance, watcher.id, "m3")).toBe(true);
    expect(isEmailSeen(config.instance, watcher.id, "m4")).toBe(true);
    const live = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(live?.status).toBe("ok");
  });

  test("the context item carries an already-fenced prompt with untrusted:false", async () => {
    const config = buildConfig("delta-fenced-item");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, stubSpawn([], {}));
    const result = await fire(config, watcher.id, stubSpawn(["mm"], {
      mm: { id: "mm", internalDate: "9000", from: "Alice <alice@x.com>", subject: "hi" }
    }));
    expect(result.kind).toBe("context");
    if (result.kind === "context") {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.untrusted).toBe(false);
      expect(result.items[0]!.text).toContain("UNTRUSTED_EMAIL_METADATA");
    }
  });

  test("already-seen mail does not re-trigger, even after a restart", async () => {
    const config = buildConfig("delta-dedup");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, stubSpawn([], {})); // seed empty -> cursor

    const deps = stubSpawn(["m9"], {
      m9: { id: "m9", internalDate: "5000", from: "alice@x.com", subject: "new" }
    });
    const r1 = await fire(config, watcher.id, deps);
    expect(draftCount(r1)).toBe(1);
    // Simulate a process restart: drop the cached memory.db handle so the next
    // fire reads email_seen back from disk.
    closeMemoryDb(config.instance);
    const r2 = await fire(config, watcher.id, deps);
    expect(r2.kind).toBe("shortCircuit");
  });

  test("bounds the query with after:<epochSec> once a watermark exists, but not on seeding", async () => {
    const config = buildConfig("delta-after");
    const watcher = await seedWatcher(config, "alice@x.com");
    const seed = capturingStub([], {});
    await fire(config, watcher.id, seed.deps);
    expect(seed.listCalls).toHaveLength(1);
    expect(seed.listCalls[0]).not.toContain("after:");

    const { updateEmailWatcher } = await import("../../state");
    await updateEmailWatcher(config, watcher.id, { lastSeenInternalDate: "3000" });
    const tick = capturingStub([], {});
    await fire(config, watcher.id, tick.deps);
    expect(tick.listCalls).toHaveLength(1);
    expect(tick.listCalls[0]).toContain("after:3");
  });

  test("steady non-truncated window of 30 drafts all 30 exactly once across fires, honoring after:", async () => {
    const config = buildConfig("delta-backlog");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, stubSpawn([], {})); // seed -> cursor

    const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
    const corpus: EmailMetadata[] = ids.map((id, i) => ({
      id,
      internalDate: String(11_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `m${i}`
    }));
    const { updateEmailWatcher } = await import("../../state");
    await updateEmailWatcher(config, watcher.id, { lastSeenInternalDate: "1000" });
    const deps = afterHonoringStub(corpus);

    // Fire 1: caps at MAX_MESSAGES_PER_TICK (25) items, oldest-first (b0..b24).
    const r1 = await fire(config, watcher.id, deps);
    expect(draftCount(r1)).toBe(25);
    const drafted1 = r1.kind === "context" ? r1.items.map((i) => i.text.match(/"id":"(b\d+)"/)![1]) : [];
    expect(drafted1).toEqual(ids.slice(0, 25));
    const afterT1 = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(afterT1?.lastSeenInternalDate).toBe(String(11_000_000 + 24 * 1000));

    // Fire 2: `after:` excludes b0..b24; the remaining 5 drain.
    const r2 = await fire(config, watcher.id, deps);
    expect(draftCount(r2)).toBe(5);
    const drafted2 = r2.kind === "context" ? r2.items.map((i) => i.text.match(/"id":"(b\d+)"/)![1]) : [];
    expect(drafted2).toEqual(ids.slice(25));
    for (const id of ids) expect(isEmailSeen(config.instance, watcher.id, id)).toBe(true);

    // Fire 3: nothing new => shortCircuit.
    const r3 = await fire(config, watcher.id, deps);
    expect(r3.kind).toBe("shortCircuit");
  });

  test("steady truncated window jumps cursor to newest, yields one notice, no re-loop", async () => {
    const config = buildConfig("delta-truncated");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, stubSpawn([], {}));
    const { updateEmailWatcher } = await import("../../state");
    await updateEmailWatcher(config, watcher.id, { lastSeenInternalDate: "1000" });

    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const corpus: EmailMetadata[] = ids.map((id, i) => ({
      id,
      internalDate: String(12_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `t${i}`
    }));
    const deps = afterHonoringStub(corpus, { truncated: true, pageCap: 10 });

    const r1 = await fire(config, watcher.id, deps);
    // Exactly ONE notice item, ZERO per-message drafts.
    expect(r1.kind).toBe("context");
    if (r1.kind === "context") {
      expect(r1.items).toHaveLength(1);
      expect(r1.items[0]!.text).toContain("[automated email-watch notice]");
      expect(r1.items[0]!.text).not.toContain("UNTRUSTED_EMAIL_METADATA");
    }
    const afterT1 = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(afterT1?.lastSeenInternalDate).toBe(String(12_000_000 + 59 * 1000));
    expect(isEmailSeen(config.instance, watcher.id, "c59")).toBe(true);

    const r2 = await fire(config, watcher.id, deps);
    expect(r2.kind).toBe("shortCircuit");
  });

  test("truncated window with a bad newest metadata-get still advances cursor and notices at most once", async () => {
    const config = buildConfig("delta-truncated-badget");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, stubSpawn([], {}));
    const { updateEmailWatcher } = await import("../../state");
    await updateEmailWatcher(config, watcher.id, { lastSeenInternalDate: "1000" });

    const newestId = "stuck-newest";
    const deps: GmailDeltaDeps = {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
      resolveSelfEmail: async () => "me@example.com",
      gwsSpawn: async (args: string[]) => {
        const joined = args.join(" ");
        if (joined.includes("messages list")) {
          const tail = Array.from({ length: 20 }, (_, i) => [`s${i}`]);
          return pagedListResponse([[newestId], ...tail], true);
        }
        if (joined.includes("messages get")) return PREAMBLE + "{}"; // no internalDate
        return PREAMBLE + "{}";
      }
    };

    const r1 = await fire(config, watcher.id, deps);
    expect(r1.kind).toBe("context");
    if (r1.kind === "context") {
      expect(r1.items).toHaveLength(1);
      expect(r1.items[0]!.text).toContain("[automated email-watch notice]");
    }
    const afterT1 = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(Number(afterT1?.lastSeenInternalDate)).toBeGreaterThan(1000);

    // Fire 2: same truncated window, same newest id => gate suppresses a second
    // notice.
    const r2 = await fire(config, watcher.id, deps);
    expect(r2.kind).toBe("shortCircuit");
  });

  test("seeding marks same-second siblings so the inclusive after: boundary does not re-draft them", async () => {
    const config = buildConfig("delta-seed-samesecond");
    const watcher = await seedWatcher(config, "alice@x.com");

    const corpus: EmailMetadata[] = [
      { id: "s-new", internalDate: "1780000000900", from: "Alice <alice@x.com>", subject: "newest" },
      { id: "s-sib", internalDate: "1780000000100", from: "Alice <alice@x.com>", subject: "sibling" },
      { id: "s-old", internalDate: "1779999000000", from: "Alice <alice@x.com>", subject: "old" }
    ];
    const byId: Record<string, EmailMetadata> = {};
    for (const m of corpus) byId[m.id] = m;
    // Inclusive-after stub: `after:N` lists messages whose floored second is >= N.
    const inclusiveAfterStub: GmailDeltaDeps = {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
      resolveSelfEmail: async () => "me@example.com",
      gwsSpawn: async (args: string[]) => {
        const joined = args.join(" ");
        if (joined.includes("messages list")) {
          const afterMatch = joined.match(/after:(\d+)/);
          const afterSec = afterMatch ? Number(afterMatch[1]) : 0;
          const matched = corpus
            .filter((m) => !afterMatch || Math.floor(Number(m.internalDate) / 1000) >= afterSec)
            .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
          return listResponse(matched.map((m) => m.id));
        }
        if (joined.includes("messages get")) {
          const hit = getArgId(joined);
          return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
        }
        return PREAMBLE + "{}";
      }
    };

    const seed = await fire(config, watcher.id, inclusiveAfterStub);
    expect(seed.kind).toBe("shortCircuit");
    expect(isEmailSeen(config.instance, watcher.id, "s-new")).toBe(true);
    expect(isEmailSeen(config.instance, watcher.id, "s-sib")).toBe(true);
    expect(isEmailSeen(config.instance, watcher.id, "s-old")).toBe(false);
    const live = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(live?.lastSeenInternalDate).toBe("1780000000900");

    // Steady fire: the same-second sibling is re-listed but already seen => no draft.
    const r = await fire(config, watcher.id, inclusiveAfterStub);
    expect(r.kind).toBe("shortCircuit");
  });
});

describe("gmail-delta hook — auth + error isolation", () => {
  test("signed-out flips the watcher to needs_auth and short-circuits (job stays active)", async () => {
    const config = buildConfig("delta-needsauth");
    const watcher = await seedWatcher(config, "alice@x.com");
    let spawned = false;
    const result = await fire(config, watcher.id, {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: false, message: "out" }),
      gwsSpawn: async () => { spawned = true; return ""; }
    });
    // The hook short-circuits — it never returns the error kind that would fail
    // the backing job.
    expect(result.kind).toBe("shortCircuit");
    expect(spawned).toBe(false);
    const live = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(live?.status).toBe("needs_auth");
  });

  test("needs_auth recovers to ok on the next signed-in fire", async () => {
    const config = buildConfig("delta-recover");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: false, message: "out" })
    });
    expect(readState(config.instance).emailWatchers.find((w) => w.id === watcher.id)?.status).toBe("needs_auth");
    await fire(config, watcher.id, stubSpawn([], {}));
    expect(readState(config.instance).emailWatchers.find((w) => w.id === watcher.id)?.status).toBe("ok");
  });

  test("a gws failure marks the watcher error + scrubbed lastError and short-circuits (job NOT failed)", async () => {
    const config = buildConfig("delta-error");
    const watcher = await seedWatcher(config, "alice@x.com");
    const result = await fire(config, watcher.id, {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
      resolveSelfEmail: async () => undefined,
      gwsSpawn: async () => { throw new Error("gws blew up reading /Users/x/.config/gws/credentials.enc"); }
    });
    // shortCircuit, NOT error — the backing job must keep scheduling.
    expect(result.kind).toBe("shortCircuit");
    const live = readState(config.instance).emailWatchers.find((w) => w.id === watcher.id);
    expect(live?.status).toBe("error");
    expect(live?.lastError).toContain("<path>");
    expect(live?.lastError).not.toContain("credentials.enc");
  });

  test("a gws failure re-triggers the un-cursored id on a later healthy fire (at-least-once)", async () => {
    const config = buildConfig("delta-error-retrigger");
    const watcher = await seedWatcher(config, "alice@x.com");
    await fire(config, watcher.id, stubSpawn([], {})); // seed -> cursor

    // Fire 1: the list call throws BEFORE markSeen, so m5 stays un-seen.
    const r1 = await fire(config, watcher.id, {
      sessionStatus: async () => ({ installed: true, clientConfigured: true, signedIn: true, message: "ok" }),
      resolveSelfEmail: async () => "me@example.com",
      gwsSpawn: async (args: string[]) => {
        if (args.join(" ").includes("messages list")) throw new Error("transient gws list failure");
        return PREAMBLE + "{}";
      }
    });
    expect(r1.kind).toBe("shortCircuit");
    expect(readState(config.instance).emailWatchers.find((w) => w.id === watcher.id)?.status).toBe("error");
    expect(isEmailSeen(config.instance, watcher.id, "m5")).toBe(false);

    // Fire 2: healthy => m5 drafts (at-least-once) and the watcher clears to ok.
    const r2 = await fire(config, watcher.id, stubSpawn(["m5"], {
      m5: { id: "m5", internalDate: "7000", from: "Alice <alice@x.com>", subject: "hi" }
    }));
    expect(draftCount(r2)).toBe(1);
    expect(isEmailSeen(config.instance, watcher.id, "m5")).toBe(true);
    expect(readState(config.instance).emailWatchers.find((w) => w.id === watcher.id)?.status).toBe("ok");
  });

  test("a disabled watcher short-circuits without polling", async () => {
    const config = buildConfig("delta-disabled");
    const watcher = await seedWatcher(config, "alice@x.com");
    const { updateEmailWatcher } = await import("../../state");
    await updateEmailWatcher(config, watcher.id, { enabled: false });
    let spawned = false;
    const result = await fire(config, watcher.id, {
      sessionStatus: async () => { spawned = true; return { installed: true, clientConfigured: true, signedIn: true, message: "ok" }; },
      gwsSpawn: async () => { spawned = true; return ""; }
    });
    expect(result.kind).toBe("shortCircuit");
    expect(spawned).toBe(false);
  });
});
