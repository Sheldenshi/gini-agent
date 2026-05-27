// iOS deep-link interstitial. The page is reached at
//   https://<web-host>/connect?api=<runtime-url>&web=<web-url>
// and tries to hand off to a custom URL scheme (default `gini://connect`).
// If iOS doesn't route the scheme to an installed app within `fallbackMs`,
// the script navigates to the supplied `web` URL.
//
// The redirect-or-fallback signal uses `document.visibilitychange`: when iOS
// switches to the app, the Safari tab is backgrounded and `document.hidden`
// flips to true. That is the only reliable cross-version way to detect a
// successful scheme handoff from a web page.

import { ConnectClient } from "./ConnectClient";

type SearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_SCHEME = "gini://connect";
const DEFAULT_FALLBACK_MS = 1500;

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

// The scheme value lands inside JSON that gets spliced into an inline
// <script>. JSON.stringify handles quote escaping, but we restrict the
// allowed character set so a crafted scheme can't carry HTML or whitespace
// that might break out of the inline block or confuse a downstream parser.
function validateScheme(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value.length > 256) return fallback;
  if (!/^[A-Za-z0-9\-+.:/?=&%_~]+$/.test(value)) return fallback;
  return value;
}

// The bearer token rides through to the app as a query param on the deep
// link. We don't want to embed arbitrary attacker-controlled characters
// into the URL we set on `window.location.href`, so restrict to the
// printable character set that legitimate tokens use. Empty / invalid
// inputs simply drop the param — the app will route the user to /setup
// to paste the token by hand instead of silently saving garbage.
function validateToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > 512) return undefined;
  if (!/^[A-Za-z0-9._~+/=:-]+$/.test(value)) return undefined;
  return value;
}

function clampMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(250, Math.min(10_000, Math.floor(n)));
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const apiUrl = validateHttpUrl(singleParam(params.api));
  const webUrl = validateHttpUrl(singleParam(params.web));
  const token = validateToken(singleParam(params.token));
  const scheme = validateScheme(singleParam(params.scheme), DEFAULT_SCHEME);
  const fallbackMs = clampMs(singleParam(params.ms), DEFAULT_FALLBACK_MS);

  if (!apiUrl || !webUrl) {
    return (
      <div className="mx-auto max-w-md p-6 text-sm">
        <h1 className="mb-3 text-base font-semibold">Gini connect</h1>
        <p className="text-muted-foreground">Missing required params.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <code className="font-mono text-xs">?api=&lt;runtime URL&gt;</code> — the runtime gateway (e.g. the 7778 ngrok)
          </li>
          <li>
            <code className="font-mono text-xs">&amp;web=&lt;web URL&gt;</code> — the browser fallback (e.g. the 7777 ngrok)
          </li>
        </ul>
        <p className="mt-3 text-muted-foreground">
          Optional:{" "}
          <code className="font-mono text-xs">scheme=gini://connect</code>,{" "}
          <code className="font-mono text-xs">ms=1500</code>.
        </p>
      </div>
    );
  }

  const sep = scheme.includes("?") ? "&" : "?";
  const tokenSuffix = token ? `&token=${encodeURIComponent(token)}` : "";
  const schemeUrl = `${scheme}${sep}api=${encodeURIComponent(apiUrl)}${tokenSuffix}`;

  return (
    <div className="mx-auto max-w-md p-6 text-sm">
      <p>Opening Gini…</p>
      <noscript>
        <p className="mt-3">
          JavaScript is required to deep-link into the app.{" "}
          <a className="underline" href={webUrl}>
            Continue to the web app
          </a>
          .
        </p>
      </noscript>
      <ConnectClient schemeUrl={schemeUrl} webUrl={webUrl} fallbackMs={fallbackMs} />
    </div>
  );
}
