# ADR: Browser Stealth Identity

## Decision

The agent's DEFAULT browser launches as a normal branded Google Chrome rather than Playwright's bundled Chromium. This stealth identity applies to the spawned per-instance Chrome (the default transport); the optional `cdp` attach drives the user's OWN already-running Chrome, whose identity the user owns and which this ADR does not govern.

- **The default browser is a spawned per-instance Chrome.** `packages/runtime/src/tools/chrome-launch.ts` (`launchSpawnedChrome`) drives a real branded Chrome via `chromium.launchPersistentContext` over Playwright's PIPE transport with `--headless=new`, the shared `CHROME_LAUNCH_ARGS`, the clean UA, the per-instance `--user-data-dir`, and a free-picked `--remote-debugging-port` in the launch args (the TCP debug port is an extra local-only endpoint used by the sign-in screencast bridge, not how the automation is driven — `launchPersistentContext` drives the spawned page over the pipe inherently). Teardown closes the persistent context; if that wedges, it reaps the Chrome bound to the instance's profile dir by scanning for the matching `--user-data-dir` (never `killall`, never the user's `:9222`). There is no runtime-spawned visible managed window; the only non-spawned option is the explicit user-supplied `cdp` attach (see [Browser Automation Engine](browser-automation-engine.md)).

The identity choices are centralized in `packages/runtime/src/tools/chrome-discovery.ts` and used by `launchSpawnedChrome`:

1. **Branded identity.** `resolveBrowserLaunchTarget` prefers the detected branded Google Chrome stable binary (launched via `executablePath`) over the bundled Chromium. The bundled Chromium remains the automatic fallback — used when no branded Chrome is installed, or when a branded launch fails to start/drive. `GINI_CHROME_PATH` still wins unconditionally (explicit binary). We launch by `executablePath` rather than Playwright's `channel: "chrome"` so the launch drives exactly the binary we already probe for the UA (`cleanChromeUserAgent`) — a channel launch leans on Playwright's own separate channel detection, which can resolve a different binary than the one we discovered and divergence there would mislabel the UA. (This identity logic governs the spawned transport; the cdp attach drives the user's own Chrome, whose binary we never resolve.)
2. **Cleared `navigator.webdriver`.** The spawned launch carries `--disable-blink-features=AutomationControlled` (in the shared `CHROME_LAUNCH_ARGS`), which makes `navigator.webdriver` read `false`.
3. **Normalized headless UA.** For headless launches, `cleanChromeUserAgent` derives a reduced Chrome UA (major version only, no "Headless" token) from the resolved binary's `--version` and passes it as the `userAgent` context option. When the version can't be determined, the override is skipped.
4. **Keychain-independent persistent login.** Every launch carries `--password-store=basic` (in `CHROME_LAUNCH_ARGS`). Chrome otherwise encrypts its cookie/credential store with a key from the macOS Keychain ("Chrome Safe Storage"); on a headless Mac (Gini's structural deployment model — see [Connector Secret Storage](connector-secret-storage.md)) the Keychain is frequently locked, so cookies written under one launch can't be decrypted on the next and the agent appears logged out. The basic store uses a stable file-based key, so a login set once stays consistent across relaunches and crashes.

## Profile Persistence And Login Consistency

The profile is per instance. `chromeProfileDirFor(instance)` resolves to `~/.gini/instances/<instance>/chrome-profile`, and every spawned launch and relaunch shares that one dir — so a sign-in done through the in-chat screencast modal is visible to every subsequent browser tool call in the instance. There is one shared browser per instance; cookies bleed across tasks within an instance, per the explicit product decision. Two failure modes broke "login set once stays logged in" and are addressed here:

- **Keychain-encrypted cookies** couldn't be decrypted across launches on a locked-Keychain Mac → `--password-store=basic` (above).
- **An externally-killed Chrome** (crash, or the user quitting the branded Chrome the agent now shares) used to wedge the runtime on a stale, dead handle so every later tool call failed until a gateway restart. `isContextConnected` (in `packages/runtime/src/tools/browser.ts`) now probes `Browser.isConnected()` instead of `context.pages()` — which returns `[]` without throwing after an external kill — so `ensureShared` relaunches and `getOrCreate` drops a session whose Chrome died mid-task. The browser self-heals; cookies already flushed to the persistent profile survive the relaunch.
- **A wedged Chrome that won't close** — a page stuck on a heavy/bot-protected navigation can leave `context.close()` unresolved forever, which used to hang the whole teardown and strand any task waiting on a relaunch against the same profile dir. Teardown now bounds every `close()`/`disconnect()` (`settledWithin`, `teardownCloseTimeoutMs`); on timeout it reaps the spawned Chromium by OS pid — playwright-core's `Browser` exposes no `process()`, so the child is found by scanning for the process whose `--user-data-dir` is the instance profile dir and `SIGKILL`ed — which frees the profile-dir lock so the relaunch (and the resumed task) proceed.

## Context

Issue #218: sites such as Yelp detected the agent browser as an automation/test browser and refused to behave normally. Three tells, all stemming from how the browser was launched:

- `findChromePath` preferred Playwright's bundled Chromium, which on disk is literally `Google Chrome for Testing.app`. That build advertises a "Chrome for Testing" identity that automation-integrity checks flag.
- Under CDP, `navigator.webdriver` is `true` by default — spoofing the UA alone does not clear it (noted in the issue thread).
- Headless Chrome leaks `HeadlessChrome` into both `navigator.userAgent` and the wire `User-Agent` header. Worse, that string mismatches the (already branded) `Sec-CH-UA` client hints the same headless build sends — the inconsistency is itself a detection signal.

Spikes against playwright-core 1.60 + the installed Chrome confirmed each fix in isolation: the AutomationControlled flag clears `navigator.webdriver` in all modes; launching the detected branded Chrome binary via `executablePath` produces the real branded Chrome with a clean UA and brands (identical clean signals to `channel: "chrome"`, while letting us drive the exact binary we probe); and setting the `userAgent` option to a reduced, "Headless"-stripped UA makes both the navigator UA and the wire header consistent with the existing branded `Sec-CH-UA`.

## Tradeoff

This deliberately reverses the prior "prefer bundled Chromium" default. That earlier stance existed for CDP-protocol stability: the bundled Chromium is built against playwright-core's pinned protocol revision, while a system Chrome can be arbitrarily ahead and produce silent `/devtools/browser/<id>` handshake hangs on protocol drift. The fallback preserves that safety net: when a branded launch can't start or drive (the protocol-drift failure mode), `launchSpawnedChrome` falls back to the bundled Chromium so the agent browser stays available. Only a branded target retries on the bundled binary — an override or already-bundled target has no better fallback and rethrows. The branded-first default trades a slightly larger surface for protocol drift (mitigated by the fallback) against no longer presenting as "Chrome for Testing".

## Consequences For Coding Agents

- Launch identity and args are chosen in one place: `packages/runtime/src/tools/chrome-discovery.ts`. New launch sites should call `launchSpawnedChrome` rather than invoking `chromium.launchPersistentContext` with their own args, so the stealth args, the branded→bundled fallback, and the headless UA normalization stay consistent.
- `CHROME_LAUNCH_ARGS` is the single source of shared launch args. Adding or changing a flag there propagates to the spawned launch.
- The launch records the binary that actually backed the context (the resolved `executablePath`). A branded launch records the branded path, and a fallback launch records the bundled one — don't reintroduce a `chromium.executablePath()` fallback that would mislabel the launched binary.
- The headless UA override is best-effort. On platforms where `--version` doesn't print to stdout (Windows `chrome.exe`), `cleanChromeUserAgent` returns `undefined` and the launch proceeds with no override — same behavior as before, no regression.

## Acceptance Checks

- `CHROME_LAUNCH_ARGS` contains `--disable-blink-features=AutomationControlled` and `--password-store=basic`, and the spawn launcher (`launchSpawnedChrome`) passes them through.
- The spawned launch picks a free debug port at or above `DEFAULT_CDP_PORT_BASE` (well above the conventional `9222`), so it never collides with — or attaches to — a user's personal debugging Chrome on `9222`; on teardown it closes the persistent context and, only if that wedges, reaps the Chrome bound to the instance's profile dir (never `killall`).
- The spawned launch and every relaunch target the per-instance `chrome-profile` dir (`chromeProfileDirFor(instance)`), so they share one signed-in profile.
- A login (persistent cookie + localStorage) set in the instance's browser is still present after a gateway restart, and after the spawned Chrome is killed and relaunched.
- With branded Chrome installed, `resolveBrowserLaunchTarget` returns `{ executablePath: <branded path>, branded: true }`; a branded target always carries a non-null `executablePath`.
- `GINI_CHROME_PATH` pointing at an existing binary yields `{ executablePath: <path>, branded: false }`.
- `cleanChromeUserAgent(null)` returns `undefined`; for a binary whose `--version` prints `Google Chrome 142.0.7000.1`, it returns a UA containing `Chrome/142.0.0.0` and the platform token, with no "Headless".
- In a real headless launch, the wire `User-Agent` has no "Headless" and is consistent with `Sec-CH-UA`, and `navigator.webdriver` is `false`.
