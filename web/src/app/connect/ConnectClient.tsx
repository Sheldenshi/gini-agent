"use client";

import { useEffect } from "react";

// Client-side companion to the /connect server page. Receives the validated
// scheme URL + fallback web URL + timeout from the server component and
// performs the iOS deep-link handoff on mount.
//
// Why a Client Component instead of the inline `<script>` the page used to
// render: in Next.js 16 / React 19, `<script>` tags rendered through React
// (whether via dangerouslySetInnerHTML or otherwise) trigger a console
// error — "Scripts inside React components are never executed when
// rendering on the client" — every time the component reconciles. The
// script DID execute on the first SSR paint, but React's warning is
// noise that scrolls real errors off the page. useEffect runs once on
// mount with the same semantics: attempt the scheme handoff, listen for
// the page to background (which iOS does when the app actually opens),
// fall back to the web URL after the timeout if nothing happened.

interface ConnectClientProps {
  schemeUrl: string;
  webUrl: string;
  fallbackMs: number;
}

export function ConnectClient({ schemeUrl, webUrl, fallbackMs }: ConnectClientProps) {
  useEffect(() => {
    let appOpened = false;
    const onVisibilityChange = () => {
      if (document.hidden) appOpened = true;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Trigger the scheme handoff. iOS routes registered URL schemes to the
    // installed app; if no app is registered, the navigation is a no-op
    // (no error, no page change) and the fallback timer fires.
    window.location.href = schemeUrl;
    const timer = window.setTimeout(() => {
      if (!appOpened) window.location.replace(webUrl);
    }, fallbackMs);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearTimeout(timer);
    };
  }, [schemeUrl, webUrl, fallbackMs]);
  return null;
}
