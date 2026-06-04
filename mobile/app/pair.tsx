import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { normalizeBaseUrl, readCachedCredentials, saveCredentials } from "@/src/auth";
import { createPairingClient, PairingError, type PairingClient } from "@/src/pairing";
import { isGatewaySwitch, isPairableHost } from "@/src/relay-link";
import { family, theme } from "@/src/theme";

// The device-side pairing screen — the mirror of web/src/app/pair/page.tsx for
// the native app. Entered either by a universal link to a relay subdomain
// (app/+native-intent.tsx rewrites it to /pair?relay=<origin>) or by pasting a
// link here. We create a pairing request, show its code as the hero, poll until
// the operator approves it on the web app, then claim — storing the returned
// device token so every later call authenticates as `Authorization: Bearer`.

type Phase =
  | "input" // no relay yet — ask for a link
  | "confirm" // a deep link would switch an already-paired gateway — confirm first
  | "creating"
  | "create-error"
  | "pending"
  | "claiming"
  | "paired"
  | "rejected"
  | "expired"
  | "claim-error"
  | "cancelled";

// Match the web /pair cadence so the operator sees an approval reflected on the
// device within a couple of seconds.
const POLL_INTERVAL_MS = 2000;

// Display host for a stored/incoming URL (the parsed host is un-spoofable, unlike
// raw link text). Empty string when absent/unparseable.
function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function PairScreen() {
  const params = useLocalSearchParams<{ relay?: string | string[] }>();
  const relayParam = Array.isArray(params.relay) ? params.relay[0] : params.relay;

  // A deep link to a relay host that differs from an already-stored gateway must
  // be confirmed (a silent switch could repoint the app to an attacker's relay);
  // a first-time pair or a same-host re-pair starts straight away.
  const [phase, setPhase] = useState<Phase>(() => {
    if (!relayParam) return "input";
    return isGatewaySwitch(readCachedCredentials()?.baseUrl, relayParam) ? "confirm" : "creating";
  });
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(() =>
    relayParam && isGatewaySwitch(readCachedCredentials()?.baseUrl, relayParam) ? relayParam : null
  );
  const [linkInput, setLinkInput] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The handshake client + the live request id/secret for this attempt.
  const clientRef = useRef<PairingClient | null>(null);
  const requestRef = useRef<{ id: string; secret: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Per-attempt generation. Bumped on every start(), on cancel(), and on unmount.
  // Every async closure captures the gen it was dispatched under and bails if the
  // current gen has moved on — so a stale create()/poll()/claim() from a
  // superseded attempt (e.g. cancel → retry while a poll is mid-flight) can never
  // clobber the current attempt's state or pair with mismatched refs.
  const genRef = useRef(0);
  // The relay origin auto-start has already fired for. Tracking the value (not a
  // boolean) means a second deep link to a DIFFERENT relay while mounted restarts
  // the handshake against it, while a re-fire for the same relay stays once-only.
  const startedRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Best-effort cancel the CURRENT attempt's server request. Used wherever an
  // attempt is superseded or torn down (start of a new attempt, cancel, the
  // gateway-switch confirm, unmount) so a pending request doesn't linger
  // server-side — the pending cap is instance-global, so orphans from rapid
  // retries could otherwise 429 a later legitimate create. Reads the live refs,
  // so call it BEFORE clearing them.
  const cancelActiveRequest = useCallback(() => {
    const client = clientRef.current;
    const request = requestRef.current;
    if (client && request) {
      void client.cancel(request.id, request.secret).catch(() => {});
    }
  }, []);

  // Begin (or restart) a handshake against `origin`. Resolving the client throws
  // for a malformed/public-http origin, surfaced as a create error.
  const start = useCallback(
    async (origin: string) => {
      stopPolling();
      const myGen = ++genRef.current;
      // Tear down a superseded prior attempt (best-effort) before dropping refs.
      cancelActiveRequest();
      requestRef.current = null;
      clientRef.current = null;
      setError(null);
      setCode(null);
      setPhase("creating");
      // Validate the host before any network call. This is the single choke point
      // for BOTH manual paste and deep-link auto-start, so a crafted
      // `gini://pair?relay=https://evil` (the custom scheme bypasses the relay-only
      // link rewriter) can't drive pairing against — and persist credentials for —
      // an arbitrary host.
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        host = "";
      }
      if (!isPairableHost(host)) {
        if (genRef.current !== myGen) return;
        setError(
          "Pairing needs a Gini relay link (…gini-relay.lilaclabs.ai). For a gateway on your own network, use its bearer token on the previous screen."
        );
        setPhase("create-error");
        return;
      }
      let client: PairingClient;
      try {
        client = createPairingClient(origin);
      } catch (e) {
        if (genRef.current !== myGen) return;
        setError(e instanceof Error ? e.message : "That doesn't look like a Gini link.");
        setPhase("create-error");
        return;
      }
      if (genRef.current !== myGen) return;
      clientRef.current = client;
      try {
        const handshake = await client.create();
        if (genRef.current !== myGen) {
          // Superseded WHILE create() was in flight: the request was never stored
          // in requestRef, so cancelActiveRequest can't reach it — best-effort
          // cancel it directly so it doesn't linger pending server-side.
          void client.cancel(handshake.id, handshake.bindSecret).catch(() => {});
          return;
        }
        requestRef.current = { id: handshake.id, secret: handshake.bindSecret };
        setCode(handshake.code);
        setPhase("pending");
      } catch (e) {
        if (genRef.current !== myGen) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("create-error");
      }
    },
    [stopPolling, cancelActiveRequest]
  );

  // Auto-start when a relay origin arrived via the deep link. Guarded so it runs
  // once even if the effect re-fires.
  useEffect(() => {
    if (!relayParam || startedRef.current === relayParam) return;
    startedRef.current = relayParam;
    // Switching an already-paired app to a different relay host needs explicit
    // confirmation; a first-time or same-host pair auto-starts.
    if (isGatewaySwitch(readCachedCredentials()?.baseUrl, relayParam)) {
      // Invalidate any in-flight prior attempt so it can't complete and save
      // credentials behind the confirm screen: bump the generation (its
      // poll/claim closures bail), stop polling, best-effort cancel its server
      // request, and drop its refs.
      genRef.current += 1;
      stopPolling();
      cancelActiveRequest();
      clientRef.current = null;
      requestRef.current = null;
      setPendingOrigin(relayParam);
      setPhase("confirm");
      return;
    }
    void start(relayParam);
  }, [relayParam, start, stopPolling, cancelActiveRequest]);

  // Component-wide unmount cleanup, installed regardless of entry path (manual
  // paste OR deep link). Bumps the generation so any in-flight create/poll/claim
  // bails instead of calling setState after unmount, and tears down the poller.
  useEffect(() => {
    return () => {
      genRef.current += 1;
      stopPolling();
      // Best-effort cancel an in-flight request so it doesn't linger pending
      // server-side after the screen is gone.
      cancelActiveRequest();
    };
  }, [stopPolling, cancelActiveRequest]);

  // Poll while pending. On approval we hand off to the claim effect rather than
  // claiming inline, so flipping to "claiming" can't self-cancel this tick.
  useEffect(() => {
    if (phase !== "pending") return;
    const myGen = genRef.current;
    const tick = async () => {
      const client = clientRef.current;
      const request = requestRef.current;
      if (!client || !request) return;
      try {
        const status = await client.poll(request.id, request.secret);
        if (genRef.current !== myGen) return;
        if (status === "approved") {
          stopPolling();
          setPhase("claiming");
        } else if (status === "rejected") {
          stopPolling();
          setPhase("rejected");
        } else if (status === "expired") {
          stopPolling();
          setPhase("expired");
        } else if (status === "cancelled") {
          stopPolling();
          setPhase("cancelled");
        }
        // "pending" / "claimed" → keep waiting.
      } catch (e) {
        if (genRef.current !== myGen) return;
        // 401/403/404 are terminal for this request (gone/expired/binding lost);
        // anything else is a transient relay blip — let the next tick retry.
        const status = e instanceof PairingError ? e.status : 0;
        if (status === 401 || status === 403 || status === 404) {
          stopPolling();
          setError("This pairing request is no longer valid. Start over.");
          setPhase("claim-error");
        }
      }
    };
    pollRef.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => stopPolling();
  }, [phase, stopPolling]);

  // Claim once approved: mint + store the device token, then drop into the app.
  useEffect(() => {
    if (phase !== "claiming") return;
    const myGen = genRef.current;
    void (async () => {
      const client = clientRef.current;
      const request = requestRef.current;
      if (!client || !request) return;
      try {
        const token = await client.claim(request.id, request.secret);
        // Do NOT persist a superseded attempt's token. If the generation moved on
        // (a new attempt started, the confirm phase took over, or the screen
        // unmounted), bail BEFORE saving so a stale/late claim can't silently
        // repoint the app to that attempt's gateway. The cost is a rare orphaned
        // active device row when an unmount races a successful claim — bounded and
        // self-healing (the row carries a TTL and its one-time token was discarded,
        // so it's an unused session the server expires).
        if (genRef.current !== myGen) return;
        await saveCredentials({ baseUrl: client.origin, token });
        if (genRef.current !== myGen) return;
        setPhase("paired");
        router.replace("/agents");
      } catch (e) {
        if (genRef.current !== myGen) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("claim-error");
      }
    })();
  }, [phase]);

  const submitLink = useCallback(() => {
    let origin: string;
    try {
      origin = normalizeBaseUrl(linkInput);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enter a valid Gini link.");
      return;
    }
    // start() applies the relay/loopback host check (the single choke point), so a
    // non-pairable link surfaces the same guidance there.
    void start(origin);
  }, [linkInput, start]);

  const cancel = useCallback(() => {
    // Move to the terminal state and drop the refs SYNCHRONOUSLY, before the
    // network round-trip: instant cancelled feedback, and no queued transition can
    // claim once the generation is bumped and the refs are gone. The server cancel
    // is best-effort (the request may already be terminal).
    genRef.current += 1;
    stopPolling();
    cancelActiveRequest();
    clientRef.current = null;
    requestRef.current = null;
    setPhase("cancelled");
  }, [stopPolling, cancelActiveRequest]);

  const retry = useCallback(() => {
    // A manual entry returns to the editable input (the typed link is preserved)
    // so a well-formed-but-wrong link can be corrected instead of retried forever.
    if (!relayParam) {
      setPhase("input");
      return;
    }
    // Re-apply the gateway-switch gate so "Not now" → "Try again" can't bypass the
    // confirmation when the link's host differs from the stored gateway.
    if (isGatewaySwitch(readCachedCredentials()?.baseUrl, relayParam)) {
      setPendingOrigin(relayParam);
      setPhase("confirm");
      return;
    }
    void start(relayParam);
  }, [relayParam, start]);

  const confirmHost = hostOf(pendingOrigin);
  const currentHost = hostOf(readCachedCredentials()?.baseUrl);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen options={{ title: "Connect to Gini" }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.heading}>
            {phase === "confirm" ? "Switch gateway?" : "Pair this device"}
          </Text>
          {phase === "confirm" ? null : (
            <Text style={styles.subhead}>
              A code appears below. Approve it on the computer where Gini is signed
              in, and this device connects.
            </Text>
          )}

          {phase === "confirm" ? (
            <>
              <Text style={styles.subhead}>
                This connects this device to{" "}
                <Text style={styles.confirmHost}>{confirmHost}</Text>
                {currentHost
                  ? `, replacing your current connection to ${currentHost}`
                  : ""}
                . Continue only if you opened this link yourself.
              </Text>
              <TouchableOpacity
                onPress={() => {
                  const origin = pendingOrigin;
                  if (origin) void start(origin);
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Connect to {confirmHost}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setPhase("cancelled")} style={styles.ghostButton}>
                <Text style={styles.ghostButtonText}>Not now</Text>
              </TouchableOpacity>
            </>
          ) : phase === "input" ? (
            <>
              <Text style={styles.label}>Gini link</Text>
              <TextInput
                value={linkInput}
                onChangeText={setLinkInput}
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="url"
                keyboardType="url"
                placeholder="https://….gini-relay.lilaclabs.ai"
                placeholderTextColor={theme.placeholder}
                style={styles.input}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <TouchableOpacity onPress={submitLink} style={styles.button}>
                <Text style={styles.buttonText}>Connect</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {code ? (
                <Text style={[styles.code, (phase === "expired" || phase === "cancelled") && styles.codeDimmed]}>
                  {code}
                </Text>
              ) : (
                <ActivityIndicator color={theme.accent} style={styles.codeSpinner} />
              )}

              <StatusRow phase={phase} error={error} />

              <Controls phase={phase} onRetry={retry} onCancel={cancel} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function StatusRow({ phase, error }: { phase: Phase; error: string | null }) {
  const map: Partial<Record<Phase, { text: string; tone?: "error" | "muted" | "success" }>> = {
    creating: { text: "Generating your code…" },
    pending: { text: "Waiting for approval on your computer…" },
    claiming: { text: "Approved — finishing up…" },
    paired: { text: "Paired — taking you in…", tone: "success" },
    rejected: { text: "Request denied.", tone: "error" },
    expired: { text: "This code expired.", tone: "muted" },
    cancelled: { text: "Pairing cancelled.", tone: "muted" },
    "create-error": { text: error ?? "Couldn't start pairing.", tone: "error" },
    "claim-error": { text: error ?? "Pairing couldn't be completed.", tone: "error" }
  };
  const entry = map[phase];
  if (!entry) return null;
  const color =
    entry.tone === "error"
      ? theme.danger
      : entry.tone === "success"
        ? theme.accent
        : entry.tone === "muted"
          ? theme.muted
          : theme.subtle;
  return <Text style={[styles.status, { color }]}>{entry.text}</Text>;
}

function Controls({
  phase,
  onRetry,
  onCancel
}: {
  phase: Phase;
  onRetry: () => void;
  onCancel: () => void;
}) {
  if (phase === "pending" || phase === "claiming") {
    return (
      <TouchableOpacity onPress={onCancel} disabled={phase === "claiming"} style={styles.ghostButton}>
        <Text style={styles.ghostButtonText}>Cancel</Text>
      </TouchableOpacity>
    );
  }
  if (phase === "rejected" || phase === "expired" || phase === "cancelled" || phase === "create-error" || phase === "claim-error") {
    return (
      <TouchableOpacity onPress={onRetry} style={styles.button}>
        <Text style={styles.buttonText}>Try again</Text>
      </TouchableOpacity>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  scroll: { padding: 20, paddingTop: 24, gap: 12 },
  heading: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 24
  },
  subhead: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8
  },
  confirmHost: {
    fontFamily: family("JetBrainsMono"),
    fontSize: 14,
    color: theme.text
  },
  label: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13,
    marginTop: 12
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    color: theme.text,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg
  },
  code: {
    alignSelf: "center",
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    fontFamily: family("JetBrainsMono"),
    fontSize: 40,
    letterSpacing: 6
  },
  codeDimmed: { opacity: 0.4 },
  codeSpinner: { marginTop: 28, marginBottom: 8 },
  status: {
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    textAlign: "center",
    marginTop: 4
  },
  error: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    marginTop: 4
  },
  button: {
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.button
  },
  buttonText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  },
  ghostButton: {
    marginTop: 16,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center"
  },
  ghostButtonText: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  }
});
