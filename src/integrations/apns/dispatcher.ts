// APNs dispatcher. Subscribes to the chat-blocks instance-wide emitter
// and translates two kinds of blocks into APNs pushes:
//   - `approval_requested` → alert push (always sent; the user needs to
//     decide and may not be in the app).
//   - `phase` with a terminal label (`Completed` or `Failed`) → silent
//     background push (`content-available: 1`). Sent ONLY when the
//     credential isn't actively watching the session over SSE — if the
//     user is on the chat detail, the SSE stream delivers the block
//     directly and the wake-up is redundant.
//
// Privacy: the alert payload carries ids + a generic title only. Never
// the message text, the approval summary, or any user-authored
// content. The notification body always says "Tap to review" — the
// iOS app fetches the full approval detail on tap via the existing
// /api/approvals/:id endpoint. Silent payloads carry no alert at all,
// only routing fields.
//
// Token cleanup: a 410 Unregistered from APNs means the device
// uninstalled the app or revoked notifications. We delete the row so
// subsequent fan-outs don't re-attempt the dead token. Other non-2xx
// statuses (BadCertificate, ExpiredToken, etc.) are logged but the
// token stays — they may recover or require human intervention.

import {
  isCredentialWatching,
  listAllDevices,
  removeDevice,
  subscribeAllChatBlocks
} from "../../state";
import type { ChatBlock, Instance } from "../../types";
import { defaultClient, type APNsClient, type APNsPayload } from "./client";

// Phase labels that fire a silent completion push. Aligned with the
// `TERMINAL_PHASE_LABELS` set on the mobile side
// (mobile/src/queries.ts) but only `Completed` and `Failed` trigger
// pushes — `Cancelled` is a user-initiated terminal state where the
// user is already in the app, so a wake-up is never useful.
const SILENT_PHASE_LABELS = new Set<string>(["Completed", "Failed"]);

export interface DispatcherDeps {
  // Override the APNs client — tests inject a stub here so they don't
  // need a real .p8 + http2 session.
  client?: APNsClient;
  // Override the device listing — tests pre-seed devices without
  // touching the SQLite layer.
  listDevices?: (instance: Instance) => ReturnType<typeof listAllDevices>;
  // Override the cleanup hook — tests assert that 410 triggers a delete
  // without actually mutating the DB.
  onTokenInvalidated?: (instance: Instance, token: string) => void;
  // Override the subscribe seam — tests drive blocks directly via the
  // returned `dispatch` function without registering against the live
  // EventEmitter.
  subscribe?: (instance: Instance, handler: (block: ChatBlock) => void) => () => void;
  // Override the active-watch predicate — tests pin "user is watching"
  // / "user is away" without touching the SSE registry's process state.
  // The dispatcher passes the device's credentialId and the block's
  // sessionId; the implementation should return true when the user
  // is on that chat detail in any open SSE stream.
  isWatching?: (instance: Instance, credentialId: string, sessionId: string) => boolean;
  // One-shot logger for unexpected failures. Defaults to console.warn.
  warn?: (message: string, detail?: unknown) => void;
}

export interface ApnsDispatcher {
  // Tear down the chat-blocks subscription. Called from the SIGTERM
  // handler so the runtime stops emitting pushes during drain.
  stop(): void;
  // Test-only entry — drives the dispatcher synchronously without
  // routing through the EventEmitter. The fire-and-forget shape mirrors
  // the production subscription handler.
  dispatch(block: ChatBlock): Promise<void>;
}

// Builds the silent (background) payload fired for a terminal-phase
// block. Carries routing fields only — no alert envelope, no badge,
// no sound. iOS wakes the app long enough to run the silent handler,
// which refetches /api/badge and updates the icon. Exported so tests
// can pin the wire shape without mocking the dispatcher loop.
//
// `content-available` must be the number 1 (not the boolean true) per
// Apple's APNs spec — JSON `true` serializes to `true`, which iOS
// silently ignores. JSON.stringify writes the literal number through
// untouched, so this works as written.
export function buildPhaseSilentPayload(
  block: ChatBlock & { kind: "phase" }
): APNsPayload {
  return {
    aps: {
      "content-available": 1
    },
    sessionId: block.sessionId,
    blockId: block.id,
    event: block.label === "Failed" ? "phase_failed" : "phase_completed"
  };
}

// Builds the per-call APNs payload + headers for an approval_requested
// block. Exported for tests that want to assert payload shape without
// mocking the entire dispatcher.
export function buildApprovalPayload(block: ChatBlock & { kind: "approval_requested" }): APNsPayload {
  return {
    aps: {
      alert: {
        title: "Gini needs your approval",
        body: "Tap to review"
      },
      sound: "default",
      // `thread-id` groups multiple notifications under a single
      // stack in iOS's notification center. Using sessionId means a
      // chat with several approvals collapses to one stack instead
      // of flooding the lock screen.
      "thread-id": block.sessionId,
      // `mutable-content: 1` lets the Notification Service Extension
      // (Step 4) modify the payload before display — required for
      // the inline Approve/Deny actions to be wired up later.
      "mutable-content": 1,
      // `category` ties the notification to the iOS-side
      // UNNotificationCategory that defines the Approve/Deny
      // actions. The mobile app registers the category on launch.
      category: "APPROVAL_REQUEST"
    },
    sessionId: block.sessionId,
    blockId: block.id,
    approvalId: block.approvalId,
    event: "approval_requested"
  };
}

export function createApnsDispatcher(instance: Instance, deps?: DispatcherDeps): ApnsDispatcher {
  const client = deps?.client ?? defaultClient();
  const listDevices = deps?.listDevices ?? listAllDevices;
  const onTokenInvalidated = deps?.onTokenInvalidated ?? ((inst, token) => { removeDevice(inst, token); });
  const subscribe = deps?.subscribe ?? subscribeAllChatBlocks;
  const isWatching = deps?.isWatching ?? isCredentialWatching;
  const warn = deps?.warn ?? ((message: string, detail?: unknown) => {
    if (detail !== undefined) console.warn(`[apns-dispatcher] ${message}`, detail);
    else console.warn(`[apns-dispatcher] ${message}`);
  });

  // Per-device push send with the shared cleanup-on-410 path. Both
  // approval (alert) and completion (silent) flows route through here
  // so the token-cleanup semantics stay consistent.
  async function sendToDevice(
    token: string,
    bundleId: string,
    payload: APNsPayload,
    opts: { pushType: "alert" | "background"; priority: 5 | 10; collapseId?: string }
  ): Promise<void> {
    try {
      const result = await client.sendPush(token, payload, {
        pushType: opts.pushType,
        priority: opts.priority,
        topic: bundleId,
        collapseId: opts.collapseId
      });
      if (!result.ok) {
        if (result.status === 410 && result.reason === "Unregistered") {
          try {
            onTokenInvalidated(instance, token);
          } catch (error) {
            warn("token cleanup failed", error instanceof Error ? error.message : String(error));
          }
          return;
        }
        warn(`sendPush failed status=${result.status} reason=${result.reason} token=${token.slice(0, 8)}…`);
      }
    } catch (error) {
      warn("sendPush threw", error instanceof Error ? error.message : String(error));
    }
  }

  async function dispatch(block: ChatBlock): Promise<void> {
    if (block.kind === "approval_requested") {
      await dispatchApproval(block);
      return;
    }
    if (block.kind === "phase" && SILENT_PHASE_LABELS.has(block.label)) {
      await dispatchPhaseCompletion(block);
      return;
    }
  }

  async function dispatchApproval(block: ChatBlock & { kind: "approval_requested" }): Promise<void> {
    let devices;
    try {
      devices = listDevices(instance);
    } catch (error) {
      warn("listDevices failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (devices.length === 0) return;

    const payload = buildApprovalPayload(block);
    // Fan out in parallel — APNs HTTP/2 supports many concurrent
    // streams over one session, and the client itself reuses the
    // session, so this is effectively just a Promise.all over a few
    // HTTP/2 streams.
    await Promise.all(devices.map((device) =>
      sendToDevice(device.token, device.bundleId, payload, {
        pushType: "alert",
        priority: 10,
        // Per-device bundleId — TestFlight (.dev) and prod (.mobile)
        // installs can coexist behind the same APNs creds, but each
        // device's stored bundle id is the authoritative topic.
        // Coalesce duplicate approval pushes for the same approval id.
        collapseId: block.approvalId.slice(0, 64)
      })
    ));
  }

  async function dispatchPhaseCompletion(block: ChatBlock & { kind: "phase" }): Promise<void> {
    let devices;
    try {
      devices = listDevices(instance);
    } catch (error) {
      warn("listDevices failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (devices.length === 0) return;

    const payload = buildPhaseSilentPayload(block);
    // For each device, skip the push when its owning credential is
    // already watching this session over SSE — the open stream will
    // deliver the block directly and the wake-up is redundant.
    // Active-watch is per-device because two iOS installs of the
    // same human can be in different app states.
    await Promise.all(devices.map((device) => {
      if (isWatching(instance, device.credentialId, block.sessionId)) {
        return Promise.resolve();
      }
      return sendToDevice(device.token, device.bundleId, payload, {
        pushType: "background",
        priority: 5,
        // Collapse by sessionId so a flurry of phase events on the
        // same chat doesn't stack — the silent handler always refetches
        // the badge total, so coalescing to one wake-up is sufficient.
        collapseId: block.sessionId.slice(0, 64)
      });
    }));
  }

  const unsubscribe = subscribe(instance, (block) => {
    // The subscribe path is a fire-and-forget event handler — we
    // can't await dispatch here, but we want to surface unhandled
    // rejections rather than swallow them silently.
    dispatch(block).catch((error) => {
      warn("dispatch rejected", error instanceof Error ? error.message : String(error));
    });
  });

  return {
    stop(): void {
      unsubscribe();
    },
    dispatch
  };
}
