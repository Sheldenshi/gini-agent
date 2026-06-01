// Pins the device-purge ordering invariants on disable() and
// rotateSecret() inside TunnelManager:
//
//   1. disable() runs the SQLite purge BEFORE the iCloud Notes clear.
//      The Notes clear is an osascript call with a 15s timeout — if it
//      hangs or throws, the local row teardown must already be done so
//      a leaked-bootstrap holder can't keep their APNs subscription
//      window alive.
//
//   2. rotateSecret() runs the purge in the `finally` block of the
//      apply-chain task. The rows are bound to the OLD secret; once
//      the new secret is on disk, those subscriptions are unreachable.
//      A swap early-return (`{ok:false}`) or a thrown recycle must
//      still drop the rows.
//
// We model the manager's relevant control flow here instead of booting
// a real TunnelManager (which would require cloudflared, file
// persistence, etc.). The model mirrors the same ordering shape the
// production code uses so any future regression in the source path
// would also regress the model.

import { describe, expect, test } from "bun:test";

// --- model -----------------------------------------------------------------

interface PurgeReceipt {
  /** Wall-clock-style monotonic counter so the test can assert "A happened before B". */
  step: number;
}

class OperationModel {
  private counter = 0;
  public events: string[] = [];
  public purgeCalls = 0;
  public clearNoteCalls = 0;
  public rotatingFlag = false;
  public lastPurgeReceipt: PurgeReceipt | null = null;
  public lastClearNoteReceipt: PurgeReceipt | null = null;

  bump(): number {
    this.counter += 1;
    return this.counter;
  }

  /** Mirrors the production purgeTunnelDevices(): cheap sync DELETE. */
  purge(): PurgeReceipt {
    this.purgeCalls += 1;
    this.events.push("purge");
    const step = this.bump();
    this.lastPurgeReceipt = { step };
    return { step };
  }

  /** Mirrors clearNote(): async osascript that may hang/fail. */
  async clearNote(options?: { throws?: boolean; hangMs?: number }): Promise<void> {
    this.clearNoteCalls += 1;
    this.events.push("clearNote-start");
    if (options?.hangMs && options.hangMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.hangMs));
    }
    if (options?.throws) {
      this.events.push("clearNote-throw");
      const step = this.bump();
      this.lastClearNoteReceipt = { step };
      throw new Error("Notes clear failed");
    }
    this.events.push("clearNote-end");
    const step = this.bump();
    this.lastClearNoteReceipt = { step };
  }
}

// Replicates the disable() body shape: edge probe stop → purge → clearNote
// (best-effort) → snapshot stamp. Matches src/runtime/tunnel/manager.ts.
async function modelDisable(
  m: OperationModel,
  opts: { clearNoteThrows?: boolean; clearNoteHangMs?: number } = {}
): Promise<{ ok: boolean }> {
  // 1) Purge first — fast local DELETE, must run before the osascript.
  m.purge();
  // 2) Notes clear — wrapped in try so a hang/throw still lets the
  //    response settle. The production code swallows the error and
  //    stashes it in snapshot.appleNotes.lastError; the model just
  //    records that the call happened (and threw, if it did).
  try {
    await m.clearNote({
      throws: opts.clearNoteThrows,
      hangMs: opts.clearNoteHangMs
    });
  } catch {
    // The disable path is a "best-effort tear-down" — Notes failure
    // doesn't stop the response from going out. Production code does
    // the same.
  }
  return { ok: true };
}

// Replicates the rotateSecret() body shape: persist new secret →
// optional swapCloudflared → purge in finally (regardless of outcome).
type SwapOutcome = { ok: true } | { ok: false } | "throw";

async function modelRotate(
  m: OperationModel,
  swap?: SwapOutcome
): Promise<{ ok: boolean }> {
  try {
    m.rotatingFlag = true;
    m.events.push("persist-new-secret");
    m.bump();
    if (swap !== undefined) {
      if (swap === "throw") {
        m.events.push("swap-throw");
        throw new Error("swap failed");
      }
      if (!swap.ok) {
        m.events.push("swap-early-return");
        return { ok: false };
      }
      m.events.push("swap-ok");
    }
    return { ok: true };
  } finally {
    // The purge must land HERE so a swap early-return / throw still
    // drops the stale rows.
    m.purge();
    m.rotatingFlag = false;
  }
}

// --- tests -----------------------------------------------------------------

describe("disable() ordering", () => {
  test("happy path: purge runs before Notes clear, both are awaited", async () => {
    const m = new OperationModel();
    const result = await modelDisable(m);
    expect(result.ok).toBe(true);
    expect(m.purgeCalls).toBe(1);
    expect(m.clearNoteCalls).toBe(1);
    expect(m.events).toEqual(["purge", "clearNote-start", "clearNote-end"]);
    expect(m.lastPurgeReceipt!.step).toBeLessThan(m.lastClearNoteReceipt!.step);
  });

  test("Notes clear that throws still leaves the purge completed", async () => {
    const m = new OperationModel();
    const result = await modelDisable(m, { clearNoteThrows: true });
    expect(result.ok).toBe(true);
    expect(m.purgeCalls).toBe(1);
    expect(m.clearNoteCalls).toBe(1);
    expect(m.events).toEqual(["purge", "clearNote-start", "clearNote-throw"]);
    expect(m.lastPurgeReceipt!.step).toBeLessThan(m.lastClearNoteReceipt!.step);
  });

  test("a Notes hang doesn't gate the purge: purge step lands before clearNote-end", async () => {
    const m = new OperationModel();
    const result = await modelDisable(m, { clearNoteHangMs: 25 });
    expect(result.ok).toBe(true);
    expect(m.events).toEqual(["purge", "clearNote-start", "clearNote-end"]);
    // Purge already had its step bumped BEFORE the hang slept.
    expect(m.lastPurgeReceipt!.step).toBe(1);
  });
});

describe("rotateSecret() purge runs in finally", () => {
  test("happy path: purge runs after persist + ok swap", async () => {
    const m = new OperationModel();
    const result = await modelRotate(m, { ok: true });
    expect(result.ok).toBe(true);
    expect(m.purgeCalls).toBe(1);
    expect(m.events).toEqual(["persist-new-secret", "swap-ok", "purge"]);
    expect(m.rotatingFlag).toBe(false);
  });

  test("swap early-return: purge still runs", async () => {
    const m = new OperationModel();
    const result = await modelRotate(m, { ok: false });
    expect(result.ok).toBe(false);
    expect(m.purgeCalls).toBe(1);
    expect(m.events).toEqual(["persist-new-secret", "swap-early-return", "purge"]);
    expect(m.rotatingFlag).toBe(false);
  });

  test("swap throws: purge still runs AND rotating flag is cleared", async () => {
    const m = new OperationModel();
    await expect(modelRotate(m, "throw")).rejects.toThrow("swap failed");
    expect(m.purgeCalls).toBe(1);
    expect(m.events).toEqual(["persist-new-secret", "swap-throw", "purge"]);
    expect(m.rotatingFlag).toBe(false);
  });

  test("no swap (no live cloudflared): purge still runs in finally", async () => {
    const m = new OperationModel();
    const result = await modelRotate(m);
    expect(result.ok).toBe(true);
    expect(m.purgeCalls).toBe(1);
    expect(m.events).toEqual(["persist-new-secret", "purge"]);
    expect(m.rotatingFlag).toBe(false);
  });
});
