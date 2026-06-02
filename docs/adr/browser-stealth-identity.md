# ADR: Browser Stealth Identity

## Decision

The agent's managed/persistent browser launches as a normal branded Google Chrome rather than Playwright's bundled Chromium. Three coordinated choices, all centralized in `src/tools/chrome-discovery.ts` and shared by both launch sites (`src/tools/browser.ts` `ensureShared` and `src/capabilities/browser-connect.ts` `launchManaged`) via the `launchPersistentChrome` helper:

1. **Branded identity.** `resolveBrowserLaunchTarget` prefers `channel: "chrome"` (the real Google Chrome stable build) over the bundled Chromium. The bundled Chromium remains the automatic fallback — used when no branded Chrome is installed, or when a branded launch fails to start/drive. `GINI_CHROME_PATH` still wins unconditionally (explicit binary, no channel).
2. **Cleared `navigator.webdriver`.** Every managed/persistent launch carries `--disable-blink-features=AutomationControlled` (in the shared `CHROME_LAUNCH_ARGS`), which makes `navigator.webdriver` read `false`.
3. **Normalized headless UA.** For headless launches, `cleanChromeUserAgent` derives a reduced Chrome UA (major version only, no "Headless" token) from the resolved binary's `--version` and passes it as the `userAgent` context option. When the version can't be determined, the override is skipped.

## Context

Issue #218: sites such as Yelp detected the agent browser as an automation/test browser and refused to behave normally. Three tells, all stemming from how the browser was launched:

- `findChromePath` preferred Playwright's bundled Chromium, which on disk is literally `Google Chrome for Testing.app`. That build advertises a "Chrome for Testing" identity that automation-integrity checks flag.
- Under CDP, `navigator.webdriver` is `true` by default — spoofing the UA alone does not clear it (noted in the issue thread).
- Headless Chrome leaks `HeadlessChrome` into both `navigator.userAgent` and the wire `User-Agent` header. Worse, that string mismatches the (already branded) `Sec-CH-UA` client hints the same headless build sends — the inconsistency is itself a detection signal.

Spikes against playwright-core 1.60 + the installed Chrome confirmed each fix in isolation: the AutomationControlled flag clears `navigator.webdriver` in all modes; `channel: "chrome"` launches the real branded Chrome with a clean UA and brands; and setting the `userAgent` option to a reduced, "Headless"-stripped UA makes both the navigator UA and the wire header consistent with the existing branded `Sec-CH-UA`.

## Tradeoff

This deliberately reverses the prior "prefer bundled Chromium" default. That earlier stance existed for CDP-protocol stability: the bundled Chromium is built against playwright-core's pinned protocol revision, while a system Chrome can be arbitrarily ahead and produce silent `/devtools/browser/<id>` handshake hangs on protocol drift. The fallback preserves that safety net: when a branded launch can't start or drive (the protocol-drift failure mode), `launchPersistentChrome` falls back to the bundled Chromium so the agent browser stays available. The branded-first default trades a slightly larger surface for protocol drift (mitigated by the fallback) against no longer presenting as "Chrome for Testing".

The CDP-attach mode (a user's own Chrome, reached via `connectOverCDP`) is unchanged — it is already a real branded Chrome, and remains the documented workaround for users who want full control over the browser identity.

## Consequences For Coding Agents

- Launch identity and args are chosen in one place: `src/tools/chrome-discovery.ts`. New launch sites should call `launchPersistentChrome` rather than invoking `chromium.launchPersistentContext` with their own args, so the stealth args, the channel→bundled fallback, and the headless UA normalization stay consistent.
- `CHROME_LAUNCH_ARGS` is the single source of shared launch args. Adding or changing a flag there propagates to both launch sites.
- `record.chromePath` stores the binary that actually backed the context (`usedPath` from `launchPersistentChrome`). A branded channel launch records the branded path, not the bundled one — don't reintroduce a `chromium.executablePath()` fallback that would mislabel a channel launch.
- The headless UA override is best-effort. On platforms where `--version` doesn't print to stdout (Windows `chrome.exe`), `cleanChromeUserAgent` returns `undefined` and the launch proceeds with no override — same behavior as before, no regression.

## Acceptance Checks

- `CHROME_LAUNCH_ARGS` contains `--disable-blink-features=AutomationControlled`, and both launch sites pass it through.
- With branded Chrome installed, `resolveBrowserLaunchTarget` returns `{ channel: "chrome", executablePath: <branded path> }`; a `chrome`-channel target always carries a non-null `executablePath`.
- `GINI_CHROME_PATH` pointing at an existing binary yields `{ executablePath: <path> }` with no `channel`.
- `cleanChromeUserAgent(null)` returns `undefined`; for a binary whose `--version` prints `Google Chrome 142.0.7000.1`, it returns a UA containing `Chrome/142.0.0.0` and the platform token, with no "Headless".
- In a real headed managed connect, the Dock shows "Google Chrome" and `navigator.webdriver` is `false`.
- In a real headless launch, the wire `User-Agent` has no "Headless" and is consistent with `Sec-CH-UA`.
