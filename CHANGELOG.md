# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0.0`. See [docs/releases.md](docs/releases.md) for the release process.

## [Unreleased]

## [0.2.0] - 2026-06-02

### Added

- Add voice messages with on-device speech-to-text: press-and-hold recording, a playable voice bubble, a first-run model setup notice, and `GET /api/stt/status`. (iOS)
- Add Brave and Exa web search as connector-backed providers, with an in-chat connect card and "Learn more" docs links.
- Add agent self-configuration tools so the agent can manage its own setup in chat: set approval mode, edit its toolset, add or remove providers and connectors, install and rotate connectors, run runtime updates, roll back skills, rename or delete agents, and manage the approval allowlist.
- Add `rename_agent` (tool, `PATCH` route, and CLI) and seed each agent's name into its per-agent `SOUL.md`.
- Add `linear_attach_image` to attach a screenshot to a Linear issue.
- Add generated-file support in chat: a `GET /api/files` endpoint with a raw download mode, an in-app file viewer, and a grouped files card with a side preview drawer that renders PDFs, images, and CSV.
- Add full-screen image preview from chat. (mobile)
- Add consent-based crash reporting: a watchdog that revives and reports a dead web or runtime process, GitHub-issue filing, the `gini-bug-report` skill, and a restart-time prompt before any report is filed.
- Add chat-driven credential provisioning so skills prompt for required credentials at install time, including templateless typed credentials via `request_connector`.
- Add a re-auth call-to-action that names the failed provider and routes OAuth and CLI providers to re-authentication on expired-token chat failures.
- Add an approval-needed indicator to the chat list.
- Add streaming (SSE) chat responses on mobile.
- Add a stop control for pausing an in-flight chat turn, and text selection in chat messages. (mobile)
- Persist the tool-calling transcript and replay it across chat turns.

### Changed

- Serve the web app through the gateway via reverse proxy, aligning WebSocket and HTTP routing on a single origin.
- Rename the default agent to "Gini", derive each agent's identity line from its per-agent name, and drop framework branding from the preamble; existing instances migrate on boot.
- Default new installs to `approvalMode: yolo`; existing instances stay on `auto`.
- Default voice transcription to `whisper-small` (q8).
- Auto-apply clean `edit_soul` edits without an approval prompt.
- Launch the detected branded Chrome for the agent browser, clear automation fingerprints, persist browser logins independently of the macOS Keychain, and self-heal when Chrome dies externally.
- Supervise instances as always-up under launchd so a crashed web or runtime process respawns automatically.
- Collapse tool-call details by default and open external links in the system browser. (mobile)
- Bump the memory schema to v8, purging legacy push devices on database open.

### Removed

- Remove the Cloudflare quick-tunnel off-LAN subsystem.

### Fixed

- Skip mobile OTA updates when a build includes native changes, so JS bundles never load against a mismatched native runtime.
- Fix the mobile chat drawer overlapping the Dynamic Island safe area and a blocked burger-menu tap.

## [0.1.0] - 2026-05-22

### Added

- Initial public open-source release. See [README.md](README.md) for what's included and the [Roadmap](ROADMAP.md) for what's planned.

[Unreleased]: https://github.com/Lilac-Labs/gini-agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lilac-Labs/gini-agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lilac-Labs/gini-agent/releases/tag/v0.1.0
