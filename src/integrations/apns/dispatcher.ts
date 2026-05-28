// APNs dispatcher. Subscribes to the chat-blocks instance-wide emitter
// and translates two kinds of blocks into APNs pushes:
//   - `approval_requested` → alert push (always sent; the user needs to
//     decide and may not be in the app).
//   - `phase` with a terminal label → routed by label and by whether the
//     task produced a user-visible message:
//       * `Completed` AND the task emitted ≥1 non-empty `assistant_text`
//         block → alert push ("Gini has a new message"). The user wants
//         to know when background/scheduled work produces a real
//         message for them.
//       * `Completed` with no assistant_text (only tool calls /
//         system notes) → silent background push (badge tick only).
//       * `Failed` → silent background push regardless. Failure noise
//         shouldn't yell at the user; tapping the chat surfaces the
//         error.
//     The silent and alert phase pushes are BOTH suppressed per-device
//     when that device has an active SSE subscription on the session —
//     the open stream delivers the block directly and the wake-up is
//     redundant.
//
// Privacy: every alert payload carries ids + a generic title only.
// Never the message text, the approval summary, or any user-authored
// content. Approval notifications say "Tap to review"; completion
// notifications say "Tap to read". The iOS app fetches detail on tap
// via the existing /api/* endpoints. Silent payloads carry no alert at
// all, only routing fields.
//
// Token cleanup: a 410 Unregistered from APNs means the device
// uninstalled the app or revoked notifications. We delete the row so
// subsequent fan-outs don't re-attempt the dead token. Other non-2xx
// statuses (BadCertificate, ExpiredToken, etc.) are logged but the
// token stays — they may recover or require human intervention.

import {
  isDeviceWatching,
  listAllDevices,
  removeDevice,
  subscribeAllChatBlocks,
  taskProducedAssistantText
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
  // Override the active-watch predicate — tests pin "device is watching"
  // / "device is away" without touching the SSE registry's process
  // state. The dispatcher passes the device's APNs token and the
  // block's sessionId; the implementation should return true when
  // that specific device has an open SSE stream on the session.
  isWatching?: (instance: Instance, deviceToken: string, sessionId: string) => boolean;
  // Override the "did this task produce an assistant_text block" lookup
  // — tests pin alert-vs-silent routing on Completed phase blocks
  // without seeding chat_blocks rows.
  hasAssistantText?: (instance: Instance, taskId: string) => boolean;
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
    // expo-notifications reads remote-push custom data from
    // userInfo["body"], not top-level userInfo keys — top-level fields
    // are dropped on the client. Wrapping our routing payload in a
    // single "body" object means the mobile side sees these fields
    // exactly as written. The discriminator `silent: true` lets the
    // client classify the payload without keying on aps internals
    // (which expo-notifications strips before exposing data).
    body: {
      sessionId: block.sessionId,
      blockId: block.id,
      event: block.label === "Failed" ? "phase_failed" : "phase_completed",
      silent: true
    }
  };
}

// Builds the alert payload fired for a `phase: Completed` block whose
// task produced at least one non-empty assistant_text. Generic strings
// only — the chat content stays out of the wire payload (same privacy
// posture as the approval push). No category id: these notifications
// only carry a tap action that opens the chat detail.
export function buildMessageCompletedPayload(
  block: ChatBlock & { kind: "phase" }
): APNsPayload {
  return {
    aps: {
      alert: {
        title: "Gini has a new message",
        body: "Tap to read"
      },
      sound: "default",
      // Group multiple message notifications for the same chat under
      // one stack on the lock screen (same convention as approvals).
      "thread-id": block.sessionId,
      // `mutable-content: 1` keeps the door open for a future NSE that
      // wants to enrich the payload (e.g. attach a preview snippet from
      // a privileged on-device fetch). The current NSE is approval-only
      // and treats this as a no-op.
      "mutable-content": 1
    },
    // Routing fields under `body` so expo-notifications surfaces them
    // as `content.data` on the client (see comment in
    // buildApprovalPayload). `silent: false` lets the client classifier
    // branch uniformly on `data.silent`.
    body: {
      sessionId: block.sessionId,
      blockId: block.id,
      event: "message_completed",
      silent: false
    }
  };
}

// Builds the per-call APNs payload + headers for an approval_requested
// block. Exported for tests that want to assert payload shape without
// mocking the entire dispatcher.
type PendingPromptBlock =
  | (ChatBlock & { kind: "authorization_requested" })
  | (ChatBlock & { kind: "setup_requested" });

function promptIdOf(block: PendingPromptBlock): string {
  return block.kind === "authorization_requested" ? block.authorizationId : block.setupRequestId;
}

export function buildApprovalPayload(block: PendingPromptBlock): APNsPayload {
  const isSetup = block.kind === "setup_requested";
  return {
    aps: {
      alert: {
        title: isSetup ? "Gini needs you to finish a step" : "Gini needs your approval",
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
    // expo-notifications reads remote-push custom data from
    // userInfo["body"], not top-level userInfo keys — top-level fields
    // are dropped on the client. Wrapping our routing payload in a
    // single "body" object means the mobile side (and the iOS NSE,
    // which forwards userInfo intact) sees these fields exactly as
    // written. `silent: false` mirrors the discriminator on silent
    // payloads so the client can branch uniformly on `data.silent`.
    body: {
      sessionId: block.sessionId,
      blockId: block.id,
      approvalId: promptIdOf(block),
      event: block.kind,
      silent: false
    }
  };
}

export function createApnsDispatcher(instance: Instance, deps?: DispatcherDeps): ApnsDispatcher {
  const client = deps?.client ?? defaultClient();
  const listDevices = deps?.listDevices ?? listAllDevices;
  const onTokenInvalidated = deps?.onTokenInvalidated ?? ((inst, token) => { removeDevice(inst, token); });
  const subscribe = deps?.subscribe ?? subscribeAllChatBlocks;
  const isWatching = deps?.isWatching ?? isDeviceWatching;
  const hasAssistantText = deps?.hasAssistantText ?? taskProducedAssistantText;
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
    if (block.kind === "authorization_requested" || block.kind === "setup_requested") {
      await dispatchApproval(block);
      return;
    }
    if (block.kind === "phase" && SILENT_PHASE_LABELS.has(block.label)) {
      await dispatchPhaseCompletion(block);
      return;
    }
  }

  async function dispatchApproval(block: PendingPromptBlock): Promise<void> {
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
        collapseId: promptIdOf(block).slice(0, 64)
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

    // Decide alert vs silent. `Completed` with a real assistant message
    // earns the alert; everything else (Failed, or Completed with only
    // tool calls / system notes) stays silent. The lookup is skipped
    // when the block has no taskId — without a task to query, we can't
    // know whether a user-visible message was emitted, so we fall back
    // to the conservative silent path.
    const sendAlert =
      block.label === "Completed" &&
      typeof block.taskId === "string" &&
      block.taskId.length > 0 &&
      (() => {
        try {
          return hasAssistantText(instance, block.taskId!);
        } catch (error) {
          warn("hasAssistantText failed", error instanceof Error ? error.message : String(error));
          return false;
        }
      })();

    const payload = sendAlert
      ? buildMessageCompletedPayload(block)
      : buildPhaseSilentPayload(block);
    const sendOpts = sendAlert
      ? { pushType: "alert" as const, priority: 10 as const }
      : { pushType: "background" as const, priority: 5 as const };

    // For each device, skip the push when THIS device is already
    // watching this session over SSE — the open stream will deliver
    // the block directly and the wake-up is redundant. Suppression
    // is per-device (keyed by APNs token) because two iOS installs
    // of the same human can be in different app states; the
    // backgrounded install still needs the silent wake (or alert)
    // even when the foregrounded one is already watching.
    await Promise.all(devices.map((device) => {
      if (isWatching(instance, device.token, block.sessionId)) {
        return Promise.resolve();
      }
      return sendToDevice(device.token, device.bundleId, payload, {
        ...sendOpts,
        // Collapse by sessionId so a flurry of phase events on the
        // same chat doesn't stack — the silent handler always refetches
        // the badge total, and the alert handler opens a single chat,
        // so coalescing to one notification per session is sufficient.
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
