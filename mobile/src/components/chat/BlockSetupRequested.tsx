import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/src/api";
import { useSetupRequests } from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { SetupRequestedBlock } from "@/src/types";

// Query keys invalidated after a Confirm/Cancel — the web set
// (["setup-requests","approvals","tasks","task","chat","threads",
// "threads-inbox","events","audit"]) intersected with the keys the mobile
// app actually registers, plus "chats" (the per-agent list) so the chat row
// preview refreshes once the turn resumes.
const CONFIRMATION_INVALIDATE_KEYS = [
  "setup-requests",
  "chat",
  "chats",
  "threads",
  "threads-inbox",
  "unread"
] as const;

// SetupRequest bubble: user-actor gate. No risk pill — the rule is
// structural per docs/adr/authorization-vs-setup-request.md.
//
// confirmation.request is interactive on mobile (Confirm/Cancel mirroring
// the web card, see docs/adr/user-confirmation-primitive.md): the agent
// pauses before an irreversible action toward another person and the user
// decides here. Every OTHER action (connector.request, browser.connect,
// browser.fill_secret, chat.choice, messaging.*) stays read-only — those
// flows are driven from the web client / Gini on the Mac.
export function BlockSetupRequested({
  block
}: {
  block: SetupRequestedBlock;
}) {
  if (block.action === "confirmation.request") {
    return <ConfirmationCard block={block} />;
  }
  return <ReadOnlyCard block={block} />;
}

function ReadOnlyCard({ block }: { block: SetupRequestedBlock }) {
  const isConnectorRequest = block.action === "connector.request";
  // browser.connect covers both sign-in and handoff (payment entry, final
  // confirmation) uses, and the block carries no payload to tell them
  // apart — so the copy stays mode-neutral.
  const title =
    block.action === "browser.connect"
      ? "Browser action needed"
      : isConnectorRequest
        ? "Connection setup needed"
        : block.action === "browser.fill_secret"
          ? "Credentials needed"
          : block.action;
  const hint =
    isConnectorRequest
      ? "Finish this setup in Gini on your Mac. This chat is paused until the connection is completed or the turn is stopped."
      : block.action === "browser.connect"
        ? "Finish this step from Gini on your Mac. This chat is paused until setup is completed or the turn is stopped."
        : block.action === "browser.fill_secret"
          ? "Enter the requested value from Gini on your Mac. This chat is paused until the value is submitted or the turn is stopped."
          : "Open Gini on your Mac to continue, or stop this turn from the composer.";
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.action}>{title}</Text>
      </View>
      {/* connector.request repeats the model's reason as a separate
          assistant bubble, so skip the duplicate here. */}
      {!isConnectorRequest ? <Text style={styles.summary}>{block.summary}</Text> : null}
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

// Interactive Confirm/Cancel card. Confirm POSTs an empty body to
// /complete (resumes the loop with {confirmed:true}); Cancel POSTs to
// /cancel ({confirmed:false}). The trusted details + confirm label come
// from the setup payload the dispatcher minted (the block carries only the
// summary). When the request resolves (status !== "pending") the buttons
// give way to a past-tense outcome line.
function ConfirmationCard({ block }: { block: SetupRequestedBlock }) {
  const qc = useQueryClient();
  const setupRequests = useSetupRequests();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inFlight, setInFlight] = useState(false);

  const setup = (setupRequests.data ?? []).find((s) => s.id === block.setupRequestId) ?? null;
  const isPending = setup ? setup.status === "pending" : true;
  const details =
    setup && typeof setup.payload?.details === "string" ? (setup.payload.details as string) : "";
  const confirmLabel =
    setup
    && typeof setup.payload?.confirmLabel === "string"
    && (setup.payload.confirmLabel as string).trim().length > 0
      ? (setup.payload.confirmLabel as string)
      : "Confirm";

  // POST to /complete (confirm) or /cancel (decline); both resume the
  // paused chat task. invalidate refreshes the card out of pending state
  // and bumps the chat surface so the resumed turn renders promptly. The
  // in-flight flag disables both buttons until the request settles.
  const resolve = async (kind: "complete" | "cancel") => {
    if (inFlight || !isPending) return;
    setInFlight(true);
    try {
      await api(`/setup-requests/${block.setupRequestId}/${kind}`, { method: "POST" });
      for (const key of CONFIRMATION_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      Alert.alert(
        kind === "complete" ? "Confirm failed" : "Cancel failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setInFlight(false);
    }
  };

  const cardStyle = isPending ? [styles.row, styles.pendingCard] : styles.row;

  return (
    <View style={cardStyle}>
      <View style={styles.header}>
        <Text style={styles.action}>Confirmation needed</Text>
      </View>
      <Text style={styles.summary}>{block.summary}</Text>
      {isPending && details ? (
        <View>
          <Pressable onPress={() => setDetailsOpen((v) => !v)} hitSlop={6}>
            <Text style={styles.detailsToggle}>
              {detailsOpen ? "Hide details" : "Review details"}
            </Text>
          </Pressable>
          {detailsOpen ? (
            <View style={styles.detailsBox}>
              <Text style={styles.detailsText}>{details}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {isPending ? (
        <View style={styles.actions}>
          <Pressable
            onPress={() => resolve("complete")}
            disabled={inFlight}
            style={({ pressed }) => [
              styles.confirmButton,
              (pressed || inFlight) && styles.buttonDimmed
            ]}
          >
            <Text style={styles.confirmText}>{confirmLabel}</Text>
          </Pressable>
          <Pressable
            onPress={() => resolve("cancel")}
            disabled={inFlight}
            style={({ pressed }) => [
              styles.cancelButton,
              (pressed || inFlight) && styles.buttonDimmed
            ]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        // Confirm is a /complete, Cancel a /cancel — so completed = confirmed
        // and cancelled = declined.
        <Text style={styles.outcome}>
          {setup?.status === "completed" ? "Confirmed." : "Cancelled."}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    backgroundColor: theme.bg,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    gap: 6
  },
  // Amber accent while the confirmation is awaiting the user, matching the
  // pending convention used by the tool-call waiting card and the web setup
  // card.
  pendingCard: {
    borderColor: "rgba(251, 191, 36, 0.4)",
    backgroundColor: "rgba(251, 191, 36, 0.05)"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  action: {
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 12,
    flexShrink: 1
  },
  summary: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 19
  },
  hint: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 12,
    fontStyle: "italic"
  },
  detailsToggle: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    textDecorationLine: "underline"
  },
  detailsBox: {
    marginTop: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg
  },
  detailsText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13,
    lineHeight: 18
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 2
  },
  confirmButton: {
    borderRadius: 8,
    backgroundColor: theme.button,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  confirmText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  cancelButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  cancelText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13
  },
  buttonDimmed: {
    opacity: 0.6
  },
  outcome: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13
  }
});
