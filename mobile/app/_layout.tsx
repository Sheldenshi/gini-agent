import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold
} from "@expo-google-fonts/hanken-grotesk";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_700Bold
} from "@expo-google-fonts/inter";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient
} from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { primeCredentials, useAuth } from "@/src/auth";
import { refreshBadge, registerApprovalCategoryAsync } from "@/src/push";
import { family, theme } from "@/src/theme";

// Single shared client across the tree so navigating between screens
// keeps caches warm. Built once per app lifetime — Expo Router never
// remounts _layout outside of a full reload.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling on every screen is the primary freshness signal; aggressive
      // refetch-on-mount just doubles the request rate when the user taps
      // back from chat detail to the list.
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

export default function RootLayout() {
  // Prime the AsyncStorage credentials cache once before the first child
  // render. Without this, the auth gate in `app/index.tsx` would briefly
  // see `credentials: null` and bounce the user to /setup even if they
  // were already authed — bad UX on every cold start.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    let active = true;
    primeCredentials().then(() => {
      if (active) setPrimed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Register the APPROVAL_REQUEST notification category as early as
  // possible — before any push (foreground or wake-up) can arrive — so
  // the inline Approve / Deny buttons are wired regardless of whether
  // the user has visited a chat detail yet. The category survives
  // process restarts in iOS's local cache, but a fresh install or a
  // cleared simulator has nothing until we register, and the chat
  // detail screen is no longer the load-bearing site for this.
  // registerApprovalCategoryAsync is iOS-gated and idempotent.
  useEffect(() => {
    void registerApprovalCategoryAsync();
  }, []);

  // Load all custom font faces up front. `useFonts` from `expo-font` keys
  // each TTF by the face name we want to reference in `fontFamily` styles;
  // the `family()` helper in theme.ts is the single source of truth for
  // those names. The promise resolves on first run after Expo downloads
  // and caches the files locally — subsequent launches are instant.
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_700Bold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    JetBrainsMono_400Regular
  });

  // Light palette is the only theme — pin the header chrome to white +
  // dark text and use Hanken Grotesk for the screen title font so the
  // native stack header matches the rest of the chat surfaces.
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: theme.bg } as const,
      headerTitleStyle: {
        color: theme.text,
        fontFamily: family("HankenGrotesk", 700)
      } as const,
      headerTintColor: theme.text,
      contentStyle: { backgroundColor: theme.bg } as const
    }),
    []
  );

  // Hold the first render until both AsyncStorage and the font files are
  // ready. Blank white surface (no spinner) keeps the cold-start visual
  // quiet — the wait should be ≤500ms once the TTFs are cached on disk.
  if (!primed || !fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthCacheGuard />
          {/* Light theme — status bar text needs to be dark so it reads
              against the white header chrome. */}
          <StatusBar style="dark" />
          <Stack screenOptions={screenOptions}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="setup" options={{ title: "Connect to Gini" }} />
            {/* agents.tsx owns its own header via a <Stack.Screen> inside
                the component (custom left/right buttons), so we set
                headerShown: false here and let the screen draw its own
                hamburger + title + plus row. */}
            <Stack.Screen name="agents" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
            {/* Chat detail draws its own header (back arrow + centered
                title). */}
            <Stack.Screen
              name="chat/[sessionId]"
              options={{ headerShown: false }}
            />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Drop every cached query when the gateway identity changes. Sign-out
// and switching to a different gateway both broadcast through useAuth,
// so this single effect keeps stale data from leaking across
// credential boundaries without baking baseUrl/token into every query
// key.
function AuthCacheGuard() {
  const { credentials } = useAuth();
  const qc = useQueryClient();
  const prevKeyRef = useRef<string | null | undefined>(undefined);
  // Compose a stable identity from baseUrl + token so a token rotation
  // against the same gateway also evicts stale auth-tied data.
  const identity = credentials
    ? `${credentials.baseUrl}|${credentials.token}`
    : null;

  useEffect(() => {
    const prev = prevKeyRef.current;
    if (prev !== undefined && prev !== identity) {
      qc.clear();
    }
    prevKeyRef.current = identity;
    // Sync the app icon badge once per (newly-authed) identity. The
    // gateway computes the unread total from chat_read_state across
    // every session for the credential, so a cold launch that opened
    // straight to setup picks up everything that arrived while the
    // app was killed. Subsequent badge updates ride on silent pushes
    // (push.ts:refreshBadge in the receive handler) and on chat-detail
    // mount.
    if (identity) {
      void refreshBadge();
    }
  }, [identity, qc]);

  return null;
}
