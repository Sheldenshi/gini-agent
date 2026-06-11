# Gini Roadmap

Gini's runtime is the gateway. The roadmap is organized around that fact: shipped surfaces deepen the gateway contract, and planned surfaces are new clients and capabilities built on top of it. The architecture invariant (one stateful local runtime, replaceable clients, no browser tokens, no privileged side channels) does not change.

This is the long-form version of the short list in the [README](README.md#roadmap). Items marked ✅ are shipped today. Items marked ⚪ are planned and may shift order.

## Shipped

- ✅ **Local-first Bun gateway.** One process per instance owns durable state and performs all real work, exposing an authenticated HTTP + SSE `/api/*` contract.
- ✅ **Next.js webapp with BFF.** The browser never receives a gateway bearer token; the Next.js server attaches it on every proxied request.
- ✅ **CLI and parallel instances.** Each worktree can run an isolated instance with its own ports, state, logs, and workspace. Smoke tests run in ephemeral instances.
- ✅ **Persistent conversational surface.** Chat sessions, runs, plan steps, tasks, approvals, audit events, traces, and evidence bundles are all durable.
- ✅ **Approval-gated tools.** File, terminal, and code tools always raise high-risk approvals before side-effecting; trace and audit handoff is preserved.
- ✅ **Four-network memory.** Retain, recall, embeddings, and reranking ship locally by default; Transformers.js model cache is shared across instances.
- ✅ **Trace-backed improvement proposals.** Memory, skill, and job changes are proposed from traces rather than written blindly.
- ✅ **Provider support.** Codex OAuth (existing `codex login`), OpenAI API key, and OpenRouter-compatible records. Provider tokens are never written to Gini config.
- ✅ **Paired-device auth.** Mobile bootstrap contract and device records are in place so a future mobile client can pair once and hold its own token.
- ✅ **Instance-local snapshots.** Snapshots and promotion proposal records preserve the "before trying a candidate" state.
- ✅ **Hermes / OpenClaw parity primitives.** Memory, skills, jobs, search, providers, toolsets, subagents, MCP records, messaging records, and import inspection.
- ✅ **Pre-run job hooks + email watcher + concern fan-out.** A domain-agnostic pre-run hook primitive (`src/hooks/`) runs a trusted, deterministic step before a model turn — short-circuiting it or injecting fenced context — with the scheduler as its first consumer. A routed hook result fans one job tick out into many constrained-subagent workers, one per non-empty bucket, each in its own session (`JobRecord.routes`), with the cursor committed per-bucket. The email watcher is the first feature built on it: one shared recurring job per agent runs one deterministic detection pass that fans out into per-concern channels (a sender/thread concern each, plus a broad triage concern that can escalate), drafting replies for review (never auto-sends). See [Pre-LLM Job Hooks](docs/adr/job-pre-run-hooks.md), [Job Concern Fan-Out](docs/adr/job-concern-fanout.md), and [Email Watch](docs/adr/email-watch.md).

## Planned

Order below matches the README preview. The webapp is the primary interface for the foreseeable future; a Tauri shell around the same UI is the eventual native client, not a near-term rewrite.

### Auto-start after install (always-on runtime)

The current flow makes the user type `gini start` after install. The target experience matches what tools like Paperclip do today: install completes, the runtime is already running, and it stays running across reboots and crashes.

- ✅ **LaunchAgent registration at install time.** The installer writes three per-instance plists under `~/Library/LaunchAgents/` — `ai.lilaclabs.gini.<instance>.gateway` (Bun runtime), `ai.lilaclabs.gini.<instance>.web` (Next.js dev), and `ai.lilaclabs.gini.<instance>.watchdog` (periodic health probe) — and registers them with `launchctl bootstrap gui/$(id -u)`. Uninstall tears them all down and surfaces bootout failures.
- ✅ **Crash recovery.** `KeepAlive` is `true` on the gateway and web plists, so launchd respawns the service on *any* exit (including a clean `exit 0` from an auto-update self-restart), bounded by `ThrottleInterval`. Because a clean exit no longer keeps a service down, `gini stop` unloads via `launchctl bootout`. The web plist's shell shim execs `bun run dev` to keep the launchd-tracked PID accurate. See [Always-Up Supervision](docs/adr/always-up-supervision.md).
- ✅ **Health watchdog.** A third `StartInterval` plist (`gini watchdog`, ~30s) probes the gateway `/api/status` and web `/api/runtime/__healthz`, and `kickstart -k`s whatever is dead or hung — covering wedged-but-alive processes and clean exits that launchd defers respawning.
- ✅ **Crash reporting.** Runtime `uncaughtException`/`unhandledRejection` handlers (and the watchdog for web) capture a redacted crash report into a local queue — nothing is filed automatically. On the next restart of the `default` launchd instance, Gini asks the user (once per fingerprint) whether to file the captured crash(es); on a "yes" the `gini-bug-report` skill files one GitHub issue per fingerprint via the user's own `gh` CLI. See [Crash Reporting And Issue Filing](docs/adr/crash-reporting-and-issue-filing.md).
- ✅ **Opt-out.** `--no-autostart` on the installer for users who want to manage the runtime themselves.
- ⚠ **macOS 26+ caveat.** launchd often defers auto-respawn after SIGKILL indefinitely (`pended nondemand spawn = inefficient`). The watchdog kickstarts a dead/hung service on its next tick; RunAtLoad still fires at login; `gini autostart kick` is the manual workaround.
- ⚪ **Linux equivalent.** `systemd --user` unit shipped alongside the macOS plist for parity.

### Browser-based onboarding at install

The CLI install runs to completion, the runtime + webapp start, and the user's browser is opened to a first-run `/setup` route on the webapp. Provider picker happens in the UI instead of the terminal. The terminal `gini setup` flow remains for headless installs and power users.

- ✅ **`/setup` route in the webapp.** Detects first-run state via `/api/setup/status`, renders a two-tab form (OpenAI API key, Codex `login` instructions + Refresh), redirects to `/` on success.
- ✅ **Auto-open the browser.** The installer waits for the webapp's healthz on the port read from `~/.gini/instances/<inst>/web.port` (hash-derived per instance, written by the autostart web shim at boot), then calls `open` on the resulting `/setup` URL. Works in both interactive and piped-curl runs on macOS.
- ✅ **Proxy guard.** Next.js proxy.ts redirects unconfigured users to `/setup` from any other route. Configured users pass through.
- ⚪ **First-task suggestion.** After provider setup, the onboarding ends with a "try this" example (e.g., "ask Gini to read its own architecture") so the user lands on a useful first interaction, not a blank chat.
- ⚪ **Headless mode.** `--non-interactive` / `--yes` paths produce identical state without launching a browser, for CI and scripted installs.

### iOS mobile app (remote control)

The phone is not a place to run the gateway — the gateway lives on the Mac. The phone is a **remote control** for that running agent: see what's pending, approve from anywhere, trigger tasks, receive notifications. This is what the paired-device auth and mobile bootstrap contracts (shipped) were designed for.

- ⚪ **Native iOS client.** SwiftUI app pairing once with a Mac instance and storing its token in the Secure Enclave.
- ⚪ **Approvals on the phone.** Pending approvals delivered as push notifications, actioned with Face ID confirmation, audit-logged on the gateway like any other approval.
- ⚪ **Run and task visibility.** Live view of in-flight runs, queued tasks, and recent traces — the same SSE stream the Mac client consumes.
- ⚪ **Voice and quick triggers.** Shortcuts.app and Siri integration so a task can be kicked off without unlocking the phone.
- ⚪ **Push notifications.** APNs delivery for pending approvals and run completion, with the user-facing payload generated server-side from existing event surfaces.
- ⚪ **Off-LAN reachability.** Production relay so remote control works outside the home network — a hosted, self-hostable switchboard that forwards end-to-end-encrypted bytes it cannot read, with auth that never trusts the relay operator. Tailscale-style mesh works too. Local-network usage works without it.
- ⚪ **Android later.** Same paired-device contract, lower priority.

### Trust layer

The native clients are *expressions* of the local-first philosophy, not compromises of it. Users should not have to trust Gini-the-distributor any more than they have to trust Gini-the-source-code. The trust posture should be stronger than the commercial alternatives in this space — closer to Signal and Bitwarden than to any commercial AI desktop app.

The structural property the architecture already gives us: **the native clients have no privileged side channels.** Their only inputs come from `/api/*`. Their only outputs go to `/api/*`. Anything they do is auditable in the gateway logs the user already has. The trust layer makes that property visible and verifiable.

- ⚪ **Client source in this repo.** `clients/macos/` and `clients/ios/` live next to the runtime. No closed-source binary anywhere in the install path.
- ⚪ **Reproducible builds.** Pinned toolchain, vendored or hash-locked dependencies, `SOURCE_DATE_EPOCH=0`, stripped timestamps, documented in `BUILDING.md`. Anyone can rebuild the released binary on their own Mac and verify the hash matches the artifact on GitHub Releases.
- ⚪ **`gini verify-app`.** First-class CLI subcommand that rebuilds the installed app from the corresponding tag in a fresh sandbox and diffs hashes. Reports `verified` or `mismatch`. The existence of the command is the trust signal, not the fact that most users will run it.
- ⚪ **SLSA / sigstore build provenance.** CI publishes a signed attestation for every release saying "this binary was built from commit X by this exact workflow run." Verifiable via the public transparency log without the user rebuilding.
- ⚪ **Apple notarization.** For Gatekeeper UX. Treated as a UX signal, not a trust signal — notarization proves Apple's malware scanner cleared the binary, not that the maintainer is honest.
- ⚪ **Zero anonymized telemetry by default.** No analytics, no "anonymized telemetry" sent automatically. If telemetry is ever added, it is opt-in with payload preview before the first send. Discoverable in code, not just policy. The shipped crash reporting holds to the same line: a crash is captured to a local, redacted queue and **offered** for filing — never sent automatically. On the next restart of the `default` launchd instance, Gini asks the user whether to file it; only on an explicit "yes" does it create a GitHub issue, via the user's own `gh` CLI, to the user's own tracker — not phone-home telemetry to the maintainer. See [Crash Reporting And Issue Filing](docs/adr/crash-reporting-and-issue-filing.md).
- ⚪ **Network policy.** Each client talks only to its paired gateway and a fixed GitHub Releases URL for update checks. CI-enforced lint fails any PR that introduces a new outbound endpoint.
- ⚪ **Auto-update is the user's choice.** Sparkle (or Tauri's updater) defaults on, pulling signed updates from GitHub Releases, with a one-click setting to disable the channel entirely.
- ⚪ **Live debug pane.** Real-time view of API calls between the client and the gateway. Nothing the app does is hidden from a user who wants to look.
- ⚪ **`TRUST.md`.** Public document listing every entitlement requested, every network endpoint contacted, and the exact verification commands users can run to confirm each claim.

### Gini as MCP server

The gateway already records MCP. The reverse direction — Gini *as* an MCP server consumed by Claude Desktop, Cursor, Zed, Warp, and other AI-native hosts — turns trusted host apps into inherited trust surfaces. Users reuse permissions they already granted to those tools instead of being asked to grant Gini new ones.

- ⚪ **Gini MCP server.** Stable MCP surface exposing chat, runs, memory, skills, approvals, and tools to host AI editors.
- ⚪ **Discovery and wiring.** `gini setup` detects installed MCP hosts (Claude Desktop, Cursor, Zed) and offers to register Gini with them.
- ⚪ **Capability scoping.** Per-host capability tokens so a host editor only sees the surface a user opts into.

### Task self-learning and iteration loop

Trace-backed improvement proposals (shipped) let memory, skills, and jobs evolve from observed runs. The next step is closing the loop at the task level: a task observes its own attempts, refines its plan, and retries — without a human relaying the lesson each time.

- ⚪ **Per-task trace introspection.** A task can read its own prior runs, plan steps, tool calls, and outcomes as structured signal, not just a chat log.
- ⚪ **Plan revision from outcomes.** When a step fails or produces a low-quality result, the next attempt revises the plan rather than retrying verbatim.
- ⚪ **Auto-proposed memory and skill writes.** Lessons from a task's own runs surface as improvement proposals against the relevant memory bank or skill, gated by the existing approval surface.
- ⚪ **Multi-attempt budgets.** Tasks declare a budget (time, tokens, attempts) and the loop terminates cleanly when exhausted, with an explanation rather than a hang.
- ⚪ **Replay determinism.** A failed task can be re-run from any checkpoint with the same provider, tools, and memory state — so the iteration loop is debuggable, not magic.

### Native macOS app (Tauri shell, later)

The webapp is the primary interface today; this item is deliberately later. When it ships, the form is a Tauri shell around the existing Next.js UI — not a from-scratch native rewrite. Once auto-start and browser onboarding are in place, the webapp covers the "always available, opens on its own" UX, and the native shell becomes a pure UX-polish layer: menubar presence, hotkey, OS notifications, and lifecycle ownership.

- ⚪ **Tauri shell hosting the existing Next.js UI.** Reuse the frontend verbatim; add the OS-integration layer the browser can't reach.
- ⚪ **Runtime lifecycle ownership.** The app spawns and supervises the Bun gateway as a managed child process. Subsumes the LaunchAgent path once it ships.
- ⚪ **Menubar presence.** Status dot, pending-approval badge, run-activity indicator, click-to-summon. Survives sleep, network changes, and instance restarts.
- ⚪ **Global hotkey.** Summon a Gini chat from anywhere without switching apps. Quick-action surface for the current cursor selection.
- ⚪ **Native notifications.** macOS notifications for pending approvals, run completion, job results, and watchdog events — fire whether the app is foregrounded or not.
- ⚪ **Persistent SSE stream.** No "tab unloaded, missed the run completion." The native window keeps the event stream alive across screensaver, sleep/wake, and reconnects automatically.
- ⚪ **Keychain-backed approval gating.** Touch ID confirmation for high-risk approvals where applicable.
- ⚪ **Universal binary.** Apple Silicon + Intel in one artifact, distributed via GitHub Releases (not the Mac App Store — sandbox constraints conflict with spawning the Bun runtime).

## What's deliberately not on the roadmap

- **A SaaS-hosted Gini.** The runtime is local-first by design. A managed version is a different product, not a stage of this one.
- **A drag-and-drop workflow builder.** Skills, jobs, and runs are the unit of composition. Gini is not a low-code platform.
- **Mac App Store distribution.** Sandbox entitlements conflict with the Mac app spawning and supervising the Bun runtime.
- **Bundled providers.** Gini does not ship an in-house model. Users bring their Codex or OpenAI credentials (or any future provider). Provider tokens never enter Gini config.

## How items move from ⚪ to ✅

A planned item moves to shipped when:

1. The capability is reachable through the current `/api/*` contract (no breaking client changes after the fact).
2. ADRs that govern the relevant boundary are updated or added (see [docs/adr/](docs/adr/)).
3. The change has a verification path documented in [docs/runtime-capabilities.md](docs/runtime-capabilities.md).
4. Trust-layer items additionally require updates to `TRUST.md` and any CI guardrails (network-policy lint, build reproducibility checks) before they are considered shipped.

If a planned item turns out to be wrong-shape or superseded, the corresponding entry here is removed and an ADR records why.
