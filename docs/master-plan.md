# Gini Next-Generation Personal Agent Framework Master Plan

> **For coding agents:** This is the master product and implementation reference. Use it to understand the vision, gaps in existing frameworks, required core functionality, UI/UX direction, architecture, and phased build plan. When implementing, turn each phase into bite-sized TDD tasks and preserve the product principles in this document.

**Goal:** Build a next-generation personal agent framework that combines the working strengths of OpenClaw and Hermes Agent with a first-class mobile/headless UI, reliable automation runtime, auditable memory, structured permissions, and operational observability.

**Architecture:** A local-first headless agent runtime runs on a Mac mini, Mac Studio, workstation, server, or VPS. A phone-first control plane provides voice, rich task cards, permission approvals, auth onboarding, memory/skill inspection, job monitoring, and push notifications. Messaging apps remain optional channels, not the primary UI.

**Core thesis:** Current agent frameworks are powerful but incomplete. They over-index on chat, tools, channels, and model support while under-investing in trust, reliability, observability, permissions, state inspection, and agent-native UX. The next generation should be an agent operating system, not just a chatbot or messaging gateway.

**Implementation flexibility:** This document defines product semantics, user-visible behavior, and non-negotiable product invariants. It does **not** prescribe final database schemas, exact APIs, file layouts, class names, storage engines, service boundaries, UI component structures, or implementation mechanisms unless explicitly marked as mandatory. Coding agents should preserve the outcomes and acceptance criteria, but they may propose better technical designs when those designs improve reliability, security, simplicity, maintainability, performance, or user experience.

**Guiding rule:** Constrain outcomes, not mechanisms. Treat the concepts in this plan as first-class product requirements; treat the example data structures, paths, APIs, and implementation sketches as reference designs.

---

## 0. Executive Summary

Existing frameworks such as OpenClaw and Hermes Agent prove that users want always-on personal agents with tools, memory, scheduling, messaging access, and extensibility.

OpenClaw appears strongest at breadth:
- many messaging channels
- broad platform support
- large ecosystem
- gateway-first always-on assistant model
- many integrations and plugins

Hermes appears strongest at agent depth:
- persistent memory
- skills
- session search
- self-improvement loop
- model/provider flexibility
- delegation/subagents
- cron jobs
- migration path from OpenClaw

But both expose the same deeper gap:

Users do not just need more tools. They need an agent they can trust to run unattended.

The next-generation framework should own this category:

**A reliable personal AI operations layer.**

It should provide:
- local-first runtime
- phone-native control plane
- structured permissions
- auth/connector onboarding
- auditable memory
- governed skills
- reliable jobs/cron
- task state tracking
- full execution traces
- cost/context visibility
- gateway health
- rollback and audit logs
- voice-first interactions
- optional messaging app integrations

The ideal product promise:

**Install an open source agent on your own computer. Control it from an app. Every action has a receipt.**

Release interpretation:
- v0 proves the durable local runtime trunk: CLI, local Next.js control surface, tasks, traces, audit, permissions, tools, jobs, memory/skills basics, instances, connectors, and governed self-improvement primitives.
- v1 completes the end-state system structure and reaches feature parity with the current Hermes Agent runtime feature set: CLI depth, persistent memory, skills, session search, cron/jobs, provider flexibility, toolsets/tool gating, delegation/subagents, MCP, messaging bridges, config/profile equivalents, migration/import basics, and the stable architecture/contracts needed for the future app and end-state product.
- v2 is not a catch-up phase. v2 improves beyond Hermes in reliability, security, governance, mobile UX, connector/auth depth, production/sandbox promotion, rollback, evals, harness optimization, and long-running operational maturity.
- Gini Computer, if pursued, is a separate product and is not part of this open source Gini Agent roadmap.

---

## 0.1 Resolved Architecture Decisions

These decisions resolve the major ambiguities discovered during review. They should guide coding agents unless a later explicit decision supersedes them.

### Product and release track

Gini Agent is the open source software layer: something people can install on their own computer, pair with the app, and use directly.

The first implementation target is an installable local runtime for a user-controlled Mac. It should not assume preinstalled hardware, special packaging, or a dedicated Gini Computer device.

Gini Computer is a separate product idea. This plan should stay focused on Gini Agent and should not include hardware roadmap work.

### First-run and control surface

v0 should use:
- CLI for install, start, stop, status, doctor, reset, and scripted testing
- a local Next.js control plane for task, approval, job, trace, memory, and runtime inspection
- the same local runtime API/contracts that the future mobile app will consume

Expo/mobile should come later and consume the same contracts. The local web control plane is both a useful early product surface and a testable stand-in for future mobile UX.

Next.js + Expo is the preferred control-plane stack. Next.js gives browser-automated testing for agent-visible product flows, while Expo gives a practical mobile path. Xcode/iOS Simulator and Shelden's physical iPhone should supplement testing. Native iOS should be reconsidered only if Expo hits a real capability wall.

### Product wedge

The core product is not a vertical workflow. It is a reliable agent runtime plus an agent-native control plane.

The product promise is:

**An agent you can operate, inspect, approve, debug, and trust.**

The primary surfaces are tasks, approvals, jobs, memory, skills, tools, traces, audit, connectors, notifications, and runtime health. Example workflows may demonstrate these surfaces, but they should not redefine the product into a domain-specific application.

### Development harness vs runtime self-improvement

Use two separate terms:

1. **Closed-loop development harness**
   - used by coding agents and maintainers while building Gini itself
   - covers install, launch, exercise, observe, diagnose, and iterate
   - exists to prevent the user from being the first integration test
   - is development infrastructure, not the primary end-user product feature

2. **Runtime self-improvement**
   - used by the installed Gini after users are using it
   - improves skills, memories, recurring jobs, workflows, prompts, harness configuration, connector patterns, or task strategies
   - should be visible, reviewable, trace-backed, and rollbackable
   - should not casually rewrite Gini’s own framework source code

Hermes-style self-improvement maps mostly to runtime self-improvement. The closed-loop development harness is a separate engineering discipline for building Gini reliably.

### Mac process and startup model

v0 may be manually started and user-level. Long term, Gini should auto-start on its own.

Default direction:
- v0: user-level runtime, LaunchAgent-style direction when persistence is needed
- avoid root LaunchDaemon as the default early design
- later: add a small privileged helper only if install, updates, or OS integration truly require it

### Gini Agent vs Gini Computer

Gini Agent is open source software that users install themselves. It should work without special hardware.

Gini Computer is a separate product concept. It may reuse Gini Agent someday, but hardware packaging and device distribution are out of scope for this plan.

### Local development vs real remote product experience

Local mode is acceptable for development. The real product should work wherever the user is.

Build order:
1. localhost API for CLI and Next.js
2. LAN/mobile connection through paired-device auth
3. remote relay/push path for the serious mobile product

The Mac remains the source of truth. The relay should route encrypted control/event traffic and should not become the authority, the brain, or the place where sensitive runtime state lives.

### Instances

Be instance-aware from the beginning, but do not require full production/sandbox machinery in the first milestone.

Early implementation may run only one dev instance, but config, paths, events, traces, and runtime identity should avoid hardcoding “there is only one Gini forever.”

Later milestones should add dev/sandbox/production instances, separate state paths, separate ports/sockets, separate logs/traces, separate credential namespaces, isolation tests, promotion artifacts, and rollback workflows.

### v0 and v1 milestone ladder

Split v0 into smaller milestones that build the durable runtime trunk:

- v0.1 Runtime skeleton
- v0.2 Local Next.js control plane
- v0.3 Tools with safety
- v0.4 Jobs
- v0.5 Memory, skills, and basic session search
- v0.6 Instances and closed-loop development harness
- v0.7 Connector foundation
- v0.8 Runtime self-improvement primitives

Then use v1 to complete Hermes parity and the end-state control structure:

- v1.0 Architecture skeleton and contract hardening for the end-state product, without building the iOS/Expo app
- v1.1 Hermes-parity runtime completion: provider breadth, toolsets, delegation/subagents, MCP, session search depth, config/profile equivalents, and import/migration basics
- v1.2 Messaging bridge parity for at least the most important Hermes-style channels, without making messaging the source of truth
- v1.3 v1 parity hardening, smoke/eval coverage, and public-release readiness

Jobs should come before full memory/skills because jobs, traces, approvals, and task visibility prove the reliability layer before deeper agent-learning primitives are added. By the end of v1, Gini should not be less capable than Hermes; it should expose Hermes-class capability through Gini's task/permission/trace/control-plane architecture. The iOS/Expo mobile app is explicitly post-v1.

### Phase 0 architecture decisions

Phase 0 should include lightweight ADRs, not long theoretical specs.

Required Phase 0 ADR topics:
- Mac process model
- local API exposure
- tool execution boundaries
- secret handling
- trace privacy
- audit integrity
- permission defaults
- instance identity
- pairing/approval model
- relay threat model

Each ADR should state the decision, context, what is required now, what is deferred, consequences for coding agents, and acceptance checks.

### Trust substrate before dangerous tools

Minimal permission, audit, and trace primitives must exist before file/terminal tools are allowed to perform meaningful side effects.

The first implementation does not need the full polished permission engine or trace viewer, but every risky tool action should pass through a minimal trust substrate from the beginning.

### Naming

Use Gini consistently.

Default names:
- product: Gini
- CLI: `gini`
- runtime: `gini-runtime` or `gini-daemon`
- state root: `~/.gini/instances/<instance>` (overridable via `GINI_STATE_ROOT`)
- logs: `~/.gini/logs/<instance>` (overridable via `GINI_LOG_ROOT`)

Development builds may use simpler local paths, but old placeholder product names should be removed.

### Connectors

Do not let real connectors block the core runtime. Start with demo connectors and add one practical real connector only after tasks, approvals, traces, jobs, memory/skills, and instance-aware development flows are stable enough to observe connector behavior.

Default sequencing:
- v0.7 Connector foundation after v0.6 instances/development harness
- one demo connector with no secrets first
- one real connector later, likely GitHub, before serious mobile polish if useful
- broad connector catalog much later

### Memory

Use a Hermes-like memory system first. Memory should exist early enough to demonstrate runtime self-improvement, but deep memory UX, retrieval optimization, and annoyance tuning can improve later.

Initial memory behavior should be conservative, inspectable, editable, and source-attributable.

### Business and team mode

Default business direction: open source local runtime. Paid relay/mobile/cloud convenience may be added later if the product needs hosted infrastructure for remote access, push, device registry, or support.

Team mode is not part of the early product. Design should avoid making team support impossible, but implementation should optimize for single-user personal agent use first.

---

## 0.2 Reference Implementations and Research Anchors

Coding agents should not build this product in a vacuum. Before implementing a subsystem, inspect existing systems that already solve adjacent problems well. Use them as references for concepts, behavior, edge cases, terminology, and proven workflows. Do not blindly clone their architecture, respect licenses, and do not copy code unless license compatibility is confirmed. Actively learn from what works.

Primary references:

### Hermes Agent

Reference:
- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs

Use Hermes as a reference for:
- skills as reusable procedures
- persistent memory and user profile concepts
- session search and transcript recall
- model/provider abstraction
- toolsets and tool gating
- cron/scheduled jobs
- subagent delegation
- MCP integration
- messaging gateway patterns
- profile/config management
- OpenClaw migration tooling
- CLI ergonomics for power users

Specific Hermes concepts to preserve or improve:
- skills should exist, but be more visible and governed
- memory should exist, but be inspectable, scoped, and attributable
- cron should exist, but be operationally reliable and observable
- tools should exist, but have clearer permission UX
- provider flexibility should exist, but setup/auth should be simpler
- session search should exist, but be tied to task traces and source citations
- self-improvement should exist, but changes should be proposed, reviewed, tested, and rollbackable

When coding agents work on memory, skills, cron, model routing, toolsets, or migration, they should first review how Hermes handles the analogous feature and then decide what to borrow, simplify, or redesign.

### OpenClaw

Reference:
- https://github.com/openclaw/openclaw
- https://openclaw.ai
- https://docs.openclaw.ai

Use OpenClaw as a reference for:
- always-on personal assistant positioning
- broad messaging gateway design
- channel/plugin ecosystem
- onboarding and daemon/service setup
- mobile/messaging access patterns
- user expectations for an agent reachable from anywhere
- integration breadth and plugin surfaces

Specific OpenClaw concepts to preserve or improve:
- always-on gateway should exist, but failures must be visible
- messaging channels should exist, but not be the primary source of truth
- plugin/connectors should exist, but permissions and auth must be clearer
- setup should be simple, but not hide broken state
- broad integrations are valuable, but reliability beats breadth in the MVP

When coding agents work on gateway, channel integrations, daemon setup, plugins/connectors, or migration/coexistence, they should review OpenClaw’s implementation and user-facing behavior for lessons and edge cases.

### Meta-Harness

Reference:
- https://yoonholee.com/meta-harness/
- https://arxiv.org/abs/2603.28052

Use Meta-Harness as a research anchor for:
- treating prompts, tool definitions, memory policies, context management, completion checks, and runtime glue as an optimizable harness
- storing full execution traces rather than only summaries
- letting improvement agents inspect source code, scores, logs, tool outputs, and prior candidates through a filesystem
- improving reliability from real failures, not intuition alone
- versioning harness changes and evaluating them before rollout

Specific Meta-Harness ideas to incorporate:
- every agent run should leave enough trace data for diagnosis
- harness changes should be proposed from evidence in traces
- failure analysis should inspect raw logs, not only scalar scores or summaries
- prompts/tool schemas/context policies should be versioned and testable
- optimization should be governed; do not auto-ship self-modifications without review

When coding agents work on traces, audit logs, evals, self-improvement, skills, context compression, tool schemas, or harness configuration, they should reference Meta-Harness and preserve the idea that richer access to prior execution evidence enables better agent reliability.

### Reference usage rule

Before implementing a major subsystem, coding agents should answer:
1. How does Hermes solve the closest version of this?
2. How does OpenClaw solve the closest version of this?
3. Does Meta-Harness suggest how this subsystem should produce traces, evals, or improvement proposals?
4. What should we borrow, avoid, simplify, or make more reliable?
5. What user-visible invariant from this master plan must remain true?

The goal is not to copy any existing framework. The goal is to incorporate the concepts that already work, avoid known failure modes, and build the reliability/UX layer that existing frameworks do not fully provide.

---

## 0.3 Closed-Loop Development Harness and Runtime Self-Improvement

This section covers two different ideas that must not be confused.

1. **Closed-loop development harness:** the engineering workflow used by coding agents to build Gini itself. Coding agents should install the product, launch it, exercise user-facing flows, inspect logs/traces, diagnose failures, and iterate until the framework works. The user should not be the first integration test.

2. **Runtime self-improvement:** the installed Gini improving its own skills, memories, jobs, prompts, workflow templates, or task strategies after installation. This is the Hermes-like product capability. It must be visible, reviewable, trace-backed, and rollbackable. It should not silently rewrite Gini’s own source code.

The target operating principle:

**Every implementation task ends with an exercised product loop, not just passing unit tests.**

A coding agent should not stop at "the code compiles." It should prove that the product can be installed, started, controlled, observed, and recovered in the same way a user would experience it.

### Why this matters

Agent frameworks often fail at the seams:
- setup works only on the maintainer's machine
- launch agents or daemons do not start after reboot
- OAuth flows fail halfway through
- gateway connections silently disconnect
- cron jobs do not fire or have no visible history
- permissions are requested in chat instead of structured UI
- memory/skill edits appear to work but are not persisted
- background jobs fail without notifications
- logs exist but are not connected to user-visible traces
- a feature passes unit tests but fails when installed end-to-end

The framework should assume these failures will happen and make them observable, testable, and fixable by agents.

### Required closed-loop development harness

For each meaningful framework feature or phase, the orchestration agent should run a development loop like this:

1. Plan
   - identify the user-facing outcome
   - identify acceptance criteria
   - identify reference systems to inspect: Hermes, OpenClaw, Meta-Harness, or existing internal code
   - define what must be proven end-to-end

2. Implement
   - build the smallest coherent slice
   - add unit tests for pure logic
   - add integration tests for boundaries
   - add trace/audit events while implementing, not after

3. Package/install
   - produce the same install path a user would use
   - install into a clean or semi-clean Mac test environment when possible
   - verify config files, launch services, permissions, auth storage, logs, and data directories
   - support uninstall/reset so agents can rerun tests from a clean state

4. Launch
   - start the runtime through the real entry point, not an internal dev shortcut
   - verify process health
   - verify local API/IPC availability
   - verify phone/control-plane pairing or simulated pairing
   - verify background job scheduler status

5. Exercise
   - drive the feature through the public UX/API/CLI/control-plane surface
   - simulate the user action, approval, rejection, retry, and cancellation paths
   - verify resulting state in the app, runtime, logs, traces, and audit history

6. Observe
   - collect structured logs
   - collect execution traces
   - collect screenshots or UI snapshots where applicable
   - collect install/startup diagnostics
   - collect job histories and connector health states

7. Diagnose
   - if anything fails, perform root-cause analysis before patching
   - trace the failure through UI, API, runtime, tool execution, storage, and scheduler layers
   - avoid random fixes
   - create a regression test or smoke test for the discovered failure

8. Iterate
   - apply the minimal fix
   - rerun the failed test
   - rerun the full smoke path
   - repeat until the acceptance criteria are met

9. Record
   - save what was tested
   - save what failed
   - save what changed
   - save what remains risky
   - attach traces/log references to the task

10. Review
   - run spec compliance review
   - run code quality review
   - run install/operations review
   - run product UX review for the affected flow

### Product requirement: agent-testable runtime

The product architecture should expose enough control surfaces for agents to test it without special hidden privileges.

Useful control surfaces:
- deterministic local CLI for install, start, stop, reset, status, doctor, and uninstall
- machine-readable health endpoint or status command
- structured logs with stable event names
- trace export command
- audit export command
- job list/run/history commands
- connector list/health/revoke commands
- memory list/read/edit/delete commands
- skill list/read/validate commands
- permission request/approve/deny simulation commands
- phone-control-plane simulator for CI and local agent testing
- sample/demo connector that does not require real credentials
- seeded test data and resettable local state

These surfaces are not just developer conveniences. They are the foundation for autonomous iteration. If an agent cannot observe or drive a subsystem, it cannot reliably improve it.

### Mac installation test expectations

Because the intended runtime is a headless Mac or always-on local machine, installation must be a first-class test target.

The project should eventually support automated checks for:
- fresh install
- upgrade from previous version
- uninstall
- reset local state
- launch at login or daemon startup
- restart after crash
- restart after reboot where feasible
- missing dependency diagnostics
- broken config diagnostics
- permission-denied diagnostics
- keychain/credential access diagnostics without exposing secrets
- local network/API availability
- log and trace file creation
- scheduler startup and missed-run detection
- control-plane pairing or simulated pairing

The install path should be boring, scriptable, and repeatable. If a user would have to perform manual cleanup or guess what failed, the loop is not good enough.

### Smoke tests before declaring work done

Every meaningful implementation should define a smoke test that represents the user-facing promise.

Examples:
- install runtime, run doctor, start daemon, verify healthy status
- create a scheduled job, force-run it, inspect history, verify trace exists
- create a memory item, search it, edit it, delete it, verify audit events
- add a skill, validate it, run it in a toy task, inspect trace
- connect a demo integration, inspect scopes, revoke it, verify disabled state
- request a risky action, approve it through simulated phone UX, verify audit record
- reject a risky action, verify no side effect occurred
- crash/restart runtime, verify incomplete task is visible and recoverable

These smoke tests should run locally and be runnable by coding agents. Some can run in CI; others may require a Mac host or a local simulator.

Smoke tests must also be safe for concurrent coding-agent work. The default smoke path should allocate an isolated non-production instance, state root, log root, and localhost port when no instance is explicitly supplied. Named instances are allowed for persistent harness work, but concurrent agents must not install, reset, or smoke-test against the same instance unless the test is intentionally exercising shared-instance contention.

### Orchestration model for coding agents

Use a staged agent workflow:

1. Builder agent
   - implements the feature
   - writes tests
   - adds traces/logs
   - produces install/run instructions

2. Spec reviewer agent
   - checks implementation against the planned acceptance criteria
   - verifies no requirement was skipped or over-scoped

3. Operations reviewer agent
   - performs install/start/stop/reset/doctor checks
   - verifies logs, traces, launch behavior, and failure visibility

4. UX reviewer agent
   - exercises the user-facing flow through CLI, UI, API, or simulator
   - checks that failure states are understandable and recoverable

5. Reliability reviewer agent
   - inspects traces and test evidence
   - looks for silent failure modes
   - recommends regression tests

The orchestrator should not accept the builder's self-report. It should verify artifacts, run commands, inspect outputs, and require evidence.

### Gates

A feature is not complete until it passes these gates:

- Build gate: code compiles and tests run
- Spec gate: planned acceptance criteria are satisfied
- Install gate: product can be installed or upgraded through the intended path
- Launch gate: runtime starts through the real entry point and reports health
- Exercise gate: user-facing flow works end-to-end
- Observability gate: logs/traces/audit events exist and are usable
- Recovery gate: common failure or cancellation path is visible and recoverable
- Review gate: independent review agents approve spec, quality, operations, and UX

If a gate fails, the orchestrator should preserve evidence, perform root-cause analysis, fix the cause, and rerun the failed gate plus any downstream gates.

### Harness improvement loop

This project should use a meta-Harness-style improvement loop for its own development process:

- capture full traces from coding-agent implementation runs
- score runs against acceptance criteria and gates
- identify repeated failure patterns
- propose changes to prompts, task templates, test harnesses, tool descriptions, smoke tests, and documentation
- review proposed harness changes before applying them
- version harness changes
- rollback harness changes that reduce reliability

The development process itself should become a product testbed. If agents repeatedly fail to install, test, or observe the product, the harness should improve until they can.

### Production vs sandbox isolation

These sections describe the v0.6+ and later target. v0.1 may run a single dev instance. The early requirement is to avoid hardcoding assumptions that would prevent future instance separation, not to implement full production/sandbox promotion machinery immediately.

Gini should assume the user may eventually run a stable production installation while coding agents are simultaneously building the next version. The self-iteration loop must not corrupt, replace, or destabilize the user's main agent.

Core rule:

**Production Gini is sacred. Experimental Gini runs in a sandbox until promoted.**

The product should support at least two installation instances:

1. Production instance
   - the user's trusted daily-driver Gini
   - stable config, memory, skills, jobs, connectors, credentials, and audit history
   - conservative auto-updates
   - explicit user approval for upgrades
   - easy rollback to the prior known-good version

2. Sandbox instance
   - isolated development/test Gini instance
   - separate binary/build output
   - separate config directory
   - separate database/state directory
   - separate logs/traces/audit directory
   - separate launch service name
   - separate local ports or IPC sockets
   - separate test credentials and demo connectors
   - no access to production secrets unless explicitly granted through a scoped test permission

A coding agent should iterate against the sandbox instance by default. It can install, uninstall, reset, crash, migrate, and mutate the sandbox without touching production.

### Promotion model

New versions should move through a promotion path:

1. Build artifact
   - compile/package the candidate version
   - attach build metadata, commit SHA, task ID, and harness version

2. Sandbox install
   - install into isolated sandbox paths
   - run doctor/start/stop/reset checks

3. Sandbox smoke tests
   - run required product flows
   - use a unique instance/state root/port per concurrent coding agent
   - collect logs, traces, audit events, screenshots/snapshots where relevant

4. Staged migration test
   - copy or synthesize representative production-like data without exposing secrets
   - run migrations against the copy
   - verify rollback

5. Review gates
   - spec review
   - code quality review
   - operations review
   - UX review
   - reliability review

6. Promotion proposal
   - summarize what changed
   - summarize tests passed/failed
   - summarize migration risk
   - summarize rollback plan
   - request explicit user approval before production upgrade

7. Production upgrade
   - snapshot production state first
   - stop production runtime cleanly
   - apply upgrade
   - run production doctor
   - start production runtime
   - verify health
   - keep rollback artifact available

8. Post-promotion monitoring
   - watch early production traces/logs
   - surface regressions quickly
   - rollback automatically only for pre-approved safe conditions, otherwise ask the user

### State isolation requirements

Sandbox and production must never accidentally share mutable state.

Isolate:
- databases
- memory stores
- skill directories
- job schedules
- connector tokens
- OAuth callback routes where possible
- local ports and IPC sockets
- logs and traces
- cache directories
- config files
- launch services
- model/provider credentials
- file-write workspaces

If sandbox needs realistic data, prefer generated fixtures, demo connectors, redacted exports, or read-only snapshots. The default sandbox should not have production credential access.

### Safe access to production context

Sometimes the development agent will need to understand production behavior. It should use safe observation channels first:

- read-only production health summary
- redacted logs
- redacted traces
- schema/version metadata
- anonymized task/job history
- synthetic reproductions of production failures
- explicit user-approved temporary access grants

Access to production memory, credentials, connectors, or filesystem write permissions should be treated as privileged and time-limited.

### Rollback and recovery

Every promoted version should have a rollback plan before it touches production.

Required rollback capabilities:
- restore prior binary/app bundle
- restore prior config if changed
- restore prior database snapshot or run down-migration where safe
- disable newly introduced jobs/connectors
- preserve failed-upgrade logs and traces
- explain to the user what was rolled back and why

A failed sandbox run is normal. A failed production upgrade without rollback is unacceptable.

### Dogfooding model

Once Gini has v0.6 instance isolation and later promotion/rollback support, the ideal workflow is:

1. User runs stable Gini as daily driver.
2. User asks production Gini to improve itself or build a feature.
3. Production Gini delegates implementation to a sandbox builder environment.
4. Sandbox Gini installs and tests the candidate version in isolation.
5. Reviewer agents inspect evidence from the sandbox run.
6. Production Gini presents a promotion card on the phone:
   - what changed
   - what was tested
   - what failed and was fixed
   - what risks remain
   - rollback plan
7. User approves or rejects promotion.
8. Production Gini upgrades only after approval.

This creates a loop where Gini can improve Gini without making the user's trusted installation the experiment.

### Non-goals and guardrails

Do not rely on:
- "works on my machine" manual validation
- screenshots without machine-readable state checks
- passing unit tests as proof of product readiness
- hidden setup steps known only to the human
- autonomous self-modification without review
- brittle scripts that only work in one local directory
- fake tests that bypass the real launch/install/control surfaces

The right outcome is a system where coding agents can repeatedly make a change, install it, exercise it, inspect what happened, and improve it without requiring the user to discover obvious breakage manually.

---

## 1. Context: What Existing Agent Frameworks Already Prove

### 1.1 What OpenClaw proves works

OpenClaw proves there is demand for:
- an always-on personal AI assistant
- multi-channel messaging access
- self-hosted/local-ish control
- personal automation from chat
- plugins and app integrations
- platform breadth
- chat-based command/control
- gateway daemon running in the background
- single-user personal assistant workflows

OpenClaw strengths to preserve:
- broad channel support
- easy access from common messaging apps
- always-on gateway model
- strong community/ecosystem energy
- plugin mindset
- service/daemon install path
- local device ownership
- approachable assistant framing

OpenClaw lessons:
- breadth creates adoption
- users want the assistant wherever they already are
- messaging apps are a useful wedge
- but broad channel support increases fragility
- debugging channel failures is painful
- cron/gateway regressions destroy trust
- big integration surfaces create attack-surface concerns

### 1.2 What Hermes Agent proves works

Hermes proves there is demand for:
- a self-improving agent
- persistent memory
- skill accumulation
- session search
- model/provider flexibility
- cron jobs
- delegation/subagents
- MCP integrations
- CLI + messaging gateway
- migration from other agent frameworks
- local and remote execution

Hermes strengths to preserve:
- skills as reusable procedures
- persistent memory as first-class state
- session search / prior transcript recall
- provider-agnostic model routing
- toolsets
- cron/scheduled jobs
- subagent delegation
- messaging gateway
- profiles
- migration tooling
- CLI power-user workflow
- active docs and explicit commands

Hermes lessons:
- users love the idea of an agent that grows with them
- memory and skills are powerful product primitives
- migration tooling can be a growth strategy
- model flexibility matters to power users
- but memory must be inspectable and reliable
- self-improvement needs governance
- config complexity causes churn
- token usage must be visible

### 1.3 What both frameworks prove

Both OpenClaw and Hermes prove that users want:
- a persistent agent, not a one-off chatbot
- local execution with real tools
- access from phone and desktop
- memory across sessions
- scheduled/background work
- app integrations
- file and terminal access
- approvals for risky actions
- voice and mobile convenience
- extensibility

But they also prove that the next frontier is not merely more integrations.

The next frontier is:
- reliability
- observability
- permissions
- memory governance
- task tracking
- UI/UX designed for agents
- long-running operational trust

---

## 2. Core Gaps in Existing Agent Frameworks

### 2.1 Chat is overloaded

Current frameworks use chat for everything:
- conversation
- task control
- approvals
- logs
- errors
- settings
- memory inspection
- auth instructions
- cron updates
- artifacts
- debugging

This does not scale.

Chat is good for natural-language interaction.
Chat is bad for structured agent operations.

Needed primitives:
- task objects
- approval cards
- connector cards
- memory records
- skill records
- job records
- audit logs
- trace viewers
- permission scopes
- notification types

### 2.2 Messaging apps are convenience hacks

Messaging apps are useful because they provide:
- push notifications
- identity
- voice messages
- mobile access
- media sharing
- familiar UI

But they are not agent-native.

Shortcomings:
- iMessage has poor rendering and weak topic tracking
- Telegram has better markdown and bot UX, but cannot expose memory/skills/tasks well
- Discord has threads but is noisy and community-shaped
- Slack is workplace-shaped and permission-heavy
- WhatsApp/Signal have weak structured bot affordances
- all flatten agent state into chat messages

Conclusion:
Messaging apps should become optional notification/input channels, not the primary interface.

### 2.3 Memory is not trustworthy enough

Problems:
- agents claim to remember but later forget
- users cannot see why a memory was used
- users cannot easily edit/delete/scope memories
- stale memory persists
- context compression can hide important facts
- memory retrieval is opaque
- memory conflicts are not surfaced

Needed:
- memory browser
- memory provenance
- memory scopes
- memory confidence
- memory expiry
- memory tests
- memory conflict resolution
- explicit save/reject flow for important facts

### 2.4 Skills are not governed enough

Problems:
- auto-generated skills can drift
- agent may self-evaluate incorrectly
- manual skill edits can be overwritten
- users cannot easily understand when a skill triggers
- skills lack tests and versioning

Needed:
- skill proposals
- diff review
- skill tests
- skill provenance
- version history
- rollback
- trusted/draft distinction
- human-authored vs agent-authored separation

### 2.5 Cron and automation are not operationally reliable enough

Problems:
- scheduled jobs fail silently
- missed jobs are not obvious
- logs are hard to inspect
- retries are inconsistent
- LLM jobs and deterministic jobs are mixed together
- users cannot tell what happened while they were away

Needed:
- job dashboard
- last/next run
- retries
- missed-run alerts
- replay
- artifacts
- logs
- deterministic preflight checks
- job health status
- cost per run
- explicit failure reasons

### 2.6 Permissions are too crude

Current systems often rely on:
- shell approval prompts
- yolo mode
- static config
- API keys in env files
- all-or-nothing tool access

Needed:
- structured permissions graph
- per-app scopes
- per-folder filesystem permissions
- per-tool risk levels
- duration controls
- project/session/workflow scoping
- biometric approvals on phone
- audit logs
- one-tap revocation

### 2.7 Auth onboarding is too technical

Problems:
- users copy API keys into env files
- OAuth setup is unclear
- connector status is hidden
- expired credentials cause confusing failures
- secrets are not tied to clear scopes and use history

Needed:
- phone-native OAuth flows
- connector setup cards
- scope explanations
- credential test button
- keychain-backed storage
- expiration alerts
- connector usage audit

### 2.8 Agent state is invisible

Users cannot easily answer:
- what is the agent doing now?
- what does it know?
- what tools can it use?
- what credentials does it have?
- what jobs are running?
- what did it change?
- what did it cost?
- why is it waiting?
- what failed?

Needed:
- agent state inspector
- task timeline
- active assumptions
- loaded memories
- loaded skills
- tool status
- provider status
- current cost
- pending approvals
- recent failures

### 2.9 Cost/context usage is opaque

Problems:
- users do not know why something was expensive
- some agents appear smarter by stuffing more context
- recurring jobs can become costly
- memory retrieval can bloat prompts

Needed:
- cost estimates
- per-run cost breakdown
- per-tool token attribution
- context composition viewer
- cheap/balanced/deep modes
- recurring job cost budgets
- cost spike alerts

### 2.10 Failure traces are not first-class

Meta-Harness points at the right abstraction: agent harnesses improve when optimizers can inspect full execution traces, not summaries.

Existing systems often lack:
- structured trace stores
- reproducible runs
- full tool logs
- prompt versions
- harness versions
- eval results
- failure classification

Needed:
- flight recorder for every run
- filesystem trace store
- replay
- eval harness
- harness versioning
- automatic improvement proposals

---

## 3. Product Vision

### 3.1 One-sentence vision

A local-first personal agent runtime that runs headlessly on your Mac or server and is controlled from a phone-native interface for voice, tasks, memory, skills, permissions, auth, jobs, and approvals.

### 3.2 Positioning

Do not position as:
- another chatbot
- another Telegram bot
- another coding agent
- another OpenClaw/Hermes clone
- another model wrapper

Position as:

**The reliable personal AI operations layer.**

Alternative phrasing:
- The agent you can trust to run for a month.
- An open source agent you can install, operate, and trust.
- Local-first agent OS with memory, permissions, and receipts.
- An agent runtime where every action has a receipt.

### 3.3 Core product principles

1. Local-first, phone-controlled
   - The runtime lives on the user’s machine.
   - The phone is the control plane.

2. Chat is one view, not the whole product
   - Tasks, permissions, memory, skills, jobs, and connectors need native UI.

3. Every action has a receipt
   - Tool calls, auth use, memory writes, job runs, file edits, and messages are logged.

4. No silent failures
   - Failed jobs, expired auth, gateway issues, and memory conflicts are surfaced.

5. Permissions are structured and revocable
   - Access is scoped by app, action, project, duration, and risk.

6. Memory is inspectable
   - Users can see, edit, delete, scope, and test memory.

7. Skills are governed
   - Agent-authored skills are proposed, reviewed, tested, versioned, and rollbackable.

8. Automation is operational infrastructure
   - Jobs need logs, retries, health, alerts, and replay.

9. Harness changes are code changes
   - Prompts, tool schemas, memory policies, and completion checks are versioned and tested.

10. Messaging apps are optional channels
   - Useful for convenience, but not the source of truth.

---

## 4. Target User and Deployment Model

### 4.1 Initial target users

Prioritize:
- AI power users
- developers
- founders
- security/admin operators
- people with Mac minis or Mac Studios
- people running local agents today
- users frustrated by OpenClaw/Hermes reliability and UX
- local-first/privacy-sensitive users

Secondary:
- small teams
- researchers
- home automation users
- platform engineers
- executive assistants / operators

### 4.2 Deployment targets by release track

v0 primary:
- BYO macOS runtime on Mac mini, Mac Studio, laptop, or workstation
- CLI for install/start/status/doctor/reset/testing
- local Next.js control plane for task, approval, job, trace, memory, and runtime inspection

v1 primary:
- Hermes runtime feature parity
- stable local runtime API/contracts and event stream
- local Next.js control plane as the primary v1 human/control surface
- architecture skeleton for future app, pairing, relay, push, mobile cards, and richer remote control
- no iOS/Expo mobile app implementation in v1

Post-v1 / v2 primary:
- Expo/mobile companion app
- paired-device auth
- remote relay/push path so the phone works wherever the user is
- mobile cards for tasks, approvals, jobs, memory, traces, and runtime health

Out of scope for this open source roadmap:
- Gini Computer / preinstalled hardware product work

Deferred/non-goals for early product:
- Linux server/VPS runtime
- Android app
- Docker/server packaging
- team/enterprise mode
- broad connector catalog

### 4.3 installable agent first-run flow

Initial setup:
1. User installs Gini Agent on an existing Mac.
2. User starts the runtime manually or with user-level LaunchAgent-style persistence when needed.
3. User runs `gini doctor`.
4. User opens the local control plane.
5. User configures a model provider key.
6. User runs a first task.
7. Gini shows task status, trace/log evidence, and any approval requests.

The v1 target experience is that people can install Gini Agent on their own Mac and operate it through CLI and the local Next.js control plane. The future app should connect to the same runtime contracts after v1; it should not be required for v1.

---

## 5. Core Product Surfaces

### 5.1 Control Pinstance Surfaces

In v0 and v1, these product surfaces should be exposed through the local Next.js control plane so coding agents can test them with browser automation and users can operate Gini without a mobile app. The Expo/mobile app is post-v1 and should consume the same runtime contracts once the v1 architecture is stable.

Tabs:
1. Home
2. Chat / Voice
3. Tasks
4. Memory
5. Skills / Workflows
6. Jobs
7. Connections
8. Permissions
9. Activity / Audit
10. Settings

The UI should feel closer to Linear + Shortcuts + Home app + TestFlight than to a generic chat app.

### 5.2 Home

Purpose:
Give immediate operational status.

Show:
- agent online/offline
- active tasks
- pending approvals
- failed jobs
- connector issues
- recent findings
- cost today/week/month
- memory changes needing review
- runtime health

Cards:
- Approval needed
- Task completed
- Job failed
- Credential expired
- New memory proposed
- New skill proposed
- Cost spike
- Agent update available

### 5.3 Chat / Voice

Purpose:
Natural-language interaction.

Requirements:
- text chat
- voice input
- voice output optional
- rich markdown
- file/image sharing
- task references
- structured cards inline
- topic/task threading
- “turn this into a task” action
- “show state” action

Important:
Chat must render structured objects, not just text.

Supported cards:
- task card
- permission card
- connector card
- memory card
- skill card
- job card
- file card
- error card
- cost card
- diff card

### 5.4 Tasks

Purpose:
Track long-running work as structured objects.

Task fields:
- id
- title
- goal
- status: queued / running / waiting / blocked / failed / complete / cancelled
- owner
- created_at
- updated_at
- current_step
- progress summary
- linked conversation
- linked memories
- linked skills
- tools used
- files changed
- approvals requested
- artifacts produced
- cost
- logs
- trace path
- final summary

Task views:
- active
- waiting on me
- scheduled
- completed
- failed
- archived

Task timeline events:
- user request
- plan created
- tool called
- file changed
- approval requested
- approval granted/denied
- job spawned
- error encountered
- memory read/write
- skill used
- artifact produced
- task completed

### 5.5 Memory

Purpose:
Make memory visible, editable, and trustworthy.

Memory categories:
- User profile
- Organization
- Project
- Device/environment
- Preferences
- Temporary assumptions
- Learned facts
- Sensitive/secrets references
- Rejected memories
- Conflicts

Memory record fields:
- id
- content
- scope
- source session/task
- created_at
- updated_at
- last_used_at
- confidence
- status: proposed / active / archived / rejected / conflicted
- sensitivity
- provenance
- related memories

Actions:
- approve
- edit
- delete
- archive
- change scope
- pin
- mark stale
- never remember this
- test recall
- show usages

Key UX:
- “Agent learned 3 new facts. Review?”
- “This conflicts with an older memory. Which is correct?”
- “This memory was used in the last answer.”

### 5.6 Skills / Workflows

Purpose:
Expose reusable procedures and agent self-improvement.

Skill fields:
- name
- description
- trigger conditions
- required tools/connectors
- required permissions
- steps
- tests
- author: user / agent / imported / marketplace
- status: draft / trusted / disabled / archived
- version
- last_used_at
- success rate
- source sessions

Actions:
- inspect
- edit
- test
- approve proposed change
- rollback
- disable
- duplicate
- export
- import

Governance:
- agent-created skills start as draft
- skill updates show diffs
- trusted skills require tests
- manual edits are protected from overwrite

### 5.7 Jobs / Automation

Purpose:
Make scheduled/background work reliable.

Job fields:
- id
- name
- schedule
- prompt or script
- status
- last_run
- next_run
- last_success
- last_failure
- retry policy
- timeout
- cost budget
- required permissions
- delivery targets
- logs
- artifacts

Actions:
- run now
- pause/resume
- edit schedule
- view logs
- replay failed run
- change retry policy
- set alert rules
- disable

Must-have alerts:
- job missed
- job failed
- job cost spike
- job needs auth
- job needs approval
- job produced high-risk finding

Design principle:
Cron should feel like GitHub Actions/Airflow for personal agents.

### 5.8 Connections

Purpose:
Manage app auth and integrations.

Connector examples:
- Google Workspace
- Gmail
- Google Calendar
- Google Drive
- GitHub
- Linear
- Slack
- Notion
- Apple Calendar
- Apple Notes
- Filesystem
- Terminal
- Browser
- Home Assistant
- Brex
- AWS
- Stripe

Connector fields:
- status
- account
- scopes
- token expiry
- last used
- used by which tasks/jobs/skills
- health check result
- audit log

Actions:
- connect
- reconnect
- revoke
- test
- view scopes
- view usage
- rotate credential

Auth UX:
- OAuth on phone where possible
- secrets stored on runtime machine keychain
- scopes explained in plain language
- no copy-pasting API keys unless unavoidable

### 5.9 Permissions

Purpose:
Make agent capability explicit and controllable.

Permission dimensions:
- app/account
- action type: read / write / delete / admin / execute
- scope: folder/project/workspace/account
- duration: once / session / task / project / permanent
- approval requirement
- risk level
- audit policy

Examples:
- GitHub: read repos always, create PR ask each time, delete branch never
- Filesystem: read ~/Dev always, write ~/Dev/project ask once per task, no Downloads access
- Terminal: safe commands allowed, destructive commands require approval
- Linear: read always, create issues ask once per project, delete never
- Gmail: search/read ask per project, send email always ask

Permission card fields:
- requested action
- reason
- app/tool
- exact scope
- risk
- duration options
- raw details
- approve/deny/edit
- require Face ID for high-risk actions

### 5.10 Activity / Audit

Purpose:
Provide trust and forensic traceability.

Log everything important:
- tool calls
- file writes
- shell commands
- auth use
- messages sent
- memories read/written
- skills used/changed
- job runs
- approvals
- denials
- model calls/cost
- errors

User questions the audit log must answer:
- What did the agent do today?
- What credentials did it use?
- What files did it change?
- Why did it send that message?
- What memory did it use?
- What did this job cost?
- What failed and why?

---

## 6. Core Runtime Functionalities

These are table-stakes features that must work well because OpenClaw/Hermes already train users to expect them.

### 6.1 Agent conversation loop

Requirements:
- interactive chat
- single-shot query mode
- tool calling
- multi-turn context
- streaming output
- stop/retry/undo
- session history
- context compression
- task creation from chat

Quality bar:
- no assistant/user role corruption
- no duplicate responses
- graceful context overflow handling
- clear errors when model/provider fails

### 6.2 Tool execution

Required tool categories:
- terminal
- file read/write/search/patch
- web search/extraction
- browser automation later
- vision later
- code execution/sandboxed Python
- image generation optional
- text-to-speech/speech-to-text

Quality bar:
- tool schemas clear and tested
- errors returned structured
- dangerous commands gated
- outputs truncated intelligently with full logs stored
- tool availability visible in UI

### 6.3 File operations

Requirements:
- read file
- write file
- patch file
- search files
- list files
- detect binary/image files
- track file diffs
- rollback changed files where possible

Quality bar:
- every write has audit log
- every patch shows diff
- protected paths require approval
- user can inspect changed files from phone

### 6.4 Terminal execution

Requirements:
- foreground commands
- background processes
- process logs
- kill/stop
- stdin for interactive processes
- timeout handling
- dangerous command detection

Quality bar:
- no silent hangs
- long-running commands visible as tasks
- destructive commands require approval
- full stdout/stderr stored in trace
- summarized output shown in chat/task UI

### 6.5 Memory

Requirements:
- save durable facts
- retrieve relevant facts
- scope by user/project/org/device
- inspect/edit/delete memories
- provenance and last-used tracking
- conflict detection

Quality bar:
- no hidden memory writes for important facts
- memory record visible in UI
- memory retrieval logged
- user can test recall

### 6.6 Skills / procedures

Requirements:
- skill documents
- skill search/load
- skill creation proposals
- skill update proposals
- skill tests
- skill provenance

Quality bar:
- no silent overwrite of user-authored skills
- agent-authored skills are drafts
- diffs shown before promotion
- failed skills can be disabled quickly

### 6.7 Session search

Requirements:
- searchable prior sessions
- summaries
- source links
- task/session provenance

Quality bar:
- results are cited to sessions
- user can open source transcript/trace
- privacy scopes respected

### 6.8 Cron / scheduled jobs

Requirements:
- create/list/update/pause/resume/remove/run
- prompt-based jobs
- script-only jobs
- context injection
- delivery targets
- logs
- retries

Quality bar:
- missed jobs alert
- failed jobs explain why
- job history visible
- job replay supported
- cost shown

### 6.9 Control surfaces and messaging channels

Initial control-surface priority:
- CLI for v0 install/runtime/testing
- local Next.js control plane for v0 browser-automated product testing
- Expo/mobile app after runtime contracts stabilize
- push notifications with the mobile/relay phase

Optional messaging-channel priority:
- Telegram optional later
- iMessage later only if high demand

Messaging features:
- receive message
- send message
- voice message support
- rich markdown where supported
- task links
- fallback notifications

Quality bar:
- channel health visible
- failed sends retried/logged
- topic tracking not dependent on messaging app alone

### 6.10 Model/provider support

Initial providers:
- Codex OAuth using existing Codex CLI credentials, preferred for local user installs when available
- OpenRouter or OpenAI-compatible endpoint
- Anthropic/OpenAI direct optional
- local Ollama/vLLM later

Requirements:
- model switching
- provider health
- credential discovery/storage that does not copy secrets into Gini config
- cost tracking
- model capability metadata

Quality bar:
- provider errors clear
- cost estimates available
- fallback/backup provider optional
- no mystery config failures

### 6.11 Delegation/subagents

Requirements:
- spawn subagents for isolated tasks
- collect summaries
- attach traces
- enforce tool scopes
- limit depth/concurrency

Quality bar:
- subagent output verified before user-facing claims
- side effects tracked
- costs attributed
- subagent failures visible

### 6.12 MCP/plugin integrations

Requirements:
- add/list/remove/test MCP servers
- select exposed tools
- credential filtering
- plugin health

Quality bar:
- broken MCP does not crash runtime
- tool names/descriptions visible
- per-plugin permissions
- clear setup instructions

---

## 7. UI/UX Flows

### 7.1 First-run flows by release track

The first-run experience has two separate tracks.

### 7.1.0 v0 BYO Mac first run

Goal:
A developer or power user can install and operate Gini on an already configured Mac without needing the future mobile app.

Flow:
1. User installs or runs Gini on a Mac they already control.
2. User runs `gini doctor` to verify prerequisites, config paths, model provider configuration, local API health, logs, and state directory.
3. User starts the runtime through the real entry point.
4. User opens the local Next.js control plane or uses the CLI.
5. User submits a first task.
6. User sees task status, trace/log output, audit events, and any approval requests.
7. User can stop/reset/uninstall through documented commands.

The v0 first-run path may be technical. It is meant to prove the runtime and control contracts before consumer onboarding is built.

### 7.1.1 Post-v1 mobile pairing for BYO Mac

Goal:
After v1 has stabilized the runtime contracts, a later iOS/Expo app can pair with an already running Mac runtime without changing the core runtime architecture. This flow is not required for v1.

Flow:
1. User starts Gini on their Mac.
2. Gini exposes a local pairing screen or command through CLI/Next.js.
3. User opens the Expo/mobile app.
4. App discovers Gini on LAN where possible or accepts a pairing code/QR from the local control plane.
5. Pairing establishes a revocable paired-device identity.
6. App can view tasks, submit tasks, approve/deny actions, inspect jobs, and view summaries/traces.
7. Remote relay/push support can later carry the same control protocol when the user is away from home.

### 7.1.2 Ready-to-use setup checklist


After pairing, the app should guide the user through the minimum setup required to get value:
- confirm Gini device/name
- configure model provider or activate bundled provider plan when available
- enable notifications
- connect first app/account if needed
- choose safe permission profile
- run first test task

The first diagnostic task should verify:
- runtime healthy
- network reachable
- model provider reachable
- notifications configured where available
- scheduler running
- trace/audit logging working
- instance identity clear

### 7.1.3 Recovery and re-pairing

A headless product needs obvious recovery paths:
- re-pair phone
- revoke old phone
- reset app pairing only
- reset sandbox instance only
- preserve production data unless user explicitly chooses destructive reset

Recovery must be understandable to non-technical users and safe for technical users running production workloads.

### 7.2 App connector flow

Example: Connect Google Workspace.

Flow:
1. User taps Connections → Google Workspace.
2. App explains what it can do.
3. App shows requested scopes.
4. User taps Continue.
5. OAuth opens on phone.
6. Runtime receives token securely.
7. Token saved to macOS Keychain.
8. Runtime tests connection.
9. App shows connected status and audit settings.

Must include:
- plain-language scope explanation
- least-privilege default
- read-only preferred
- revoke button
- test connection button

### 7.3 Permission approval flow

Trigger:
Agent wants to perform sensitive action.

Card fields:
- title
- requested action
- tool/app
- exact target
- risk level
- why needed
- raw command/API details
- duration options
- approve/deny/edit buttons

Actions:
- approve once
- approve for this task
- approve for this project
- always allow similar
- deny
- ask follow-up
- edit command/scope

High-risk approvals require Face ID.

### 7.4 Memory review flow

Trigger:
Agent identifies durable facts.

Flow:
1. App shows “Agent learned 3 things.”
2. Each proposed memory has source quote/session.
3. User approves/edits/rejects.
4. User picks scope.
5. Memory becomes active and searchable.

Memory scope options:
- personal
- organization
- project
- temporary
- do not save

### 7.5 Skill proposal flow

Trigger:
Agent completes a complex task and proposes reusable skill.

Flow:
1. App shows proposed skill summary.
2. User opens diff/procedure.
3. App shows required tools/permissions.
4. Tests can be run.
5. User approves as trusted, saves as draft, edits, or rejects.

### 7.6 Scheduled job failure flow

Trigger:
Cron job fails or is missed.

Push card:
- job name
- failure reason
- last successful run
- next scheduled run
- logs summary
- suggested fix

Actions:
- retry
- view logs
- reconnect auth
- edit job
- pause job

### 7.7 Task completion flow

Trigger:
Task finishes.

Card shows:
- summary
- artifacts
- files changed
- cost
- duration
- memories proposed
- skills proposed
- follow-up suggestions

Actions:
- open artifact
- approve memory changes
- approve skill proposal
- run follow-up
- archive task

### 7.8 Voice-first flow

Example:
User: “Summarize what Gini did overnight and show anything that failed or needs my approval.”

Agent:
- creates task
- checks Google Workspace connector
- requests permission if needed
- runs inventory
- sends structured summary
- creates finding cards

Voice output should be concise.
Visual UI should carry detail.

---

## 8. Architecture

### 8.1 High-level components

Runtime daemon:
- conversation loop
- tool execution
- job scheduler
- memory engine
- skill engine
- connector manager
- permission engine
- audit logger
- trace recorder
- model router
- local API server

Phone app:
- chat/voice UI
- task dashboard
- approvals
- memory browser
- skill manager
- job dashboard
- connections
- push notification handling

Optional cloud relay:
- push notifications
- remote pairing
- encrypted relay
- no plaintext secrets
- no required dependency for local network usage

Optional web UI:
- advanced trace viewer
- artifact viewing
- developer/debugging dashboard

### 8.2 Local runtime process model

Recommended processes:
- agent-daemon: main runtime
- scheduler: cron/job runner or thread
- connector workers: optional isolated workers
- local-api: HTTP/WebSocket API
- update manager: optional

macOS integration:
- v0 user-level runtime; LaunchAgent-style persistence when needed
- avoid root LaunchDaemon by default; add helper/daemon later only with ADR
- macOS Keychain
- local notifications optional
- Bonjour discovery
- Secure Enclave/Touch ID support where possible

### 8.3 Storage

Use local database plus filesystem traces.

Database stores:
- users/devices
- sessions
- tasks
- messages
- memories
- skills metadata
- jobs
- connectors
- permissions
- audit events
- cost records

Filesystem trace store stores full artifacts:

```
~/.gini/instances/<instance>/
  config.yaml
  auth/                 # references only; secrets in Keychain
  db.sqlite
  skills/
  traces/
    2026-05-05_task_x/
      manifest.json
      prompt.md
      system.md
      messages.jsonl
      tool_calls.jsonl
      terminal.log
      browser.log
      memory_reads.jsonl
      memory_writes.jsonl
      files_changed.patch
      approvals.jsonl
      cost.json
      result.md
      eval.json
  jobs/
  logs/
  backups/
```

### 8.4 Mac-to-mobile communication architecture

The architecture must be designed from the beginning around one fact: Gini lives on the Mac, but the phone is the primary human control plane. The runtime should not treat the mobile app as an afterthought or as a thin chat client. The mobile app needs structured, real-time access to tasks, approvals, memory, jobs, connectors, traces, health, and promotion proposals.

Core principle:

**The Mac runtime is the source of truth. The phone is an authenticated control plane.**

The Mac owns:
- agent execution
- tools and filesystem access
- terminal/repo jobs
- scheduler
- memory and skills
- connector credentials
- audit history
- traces
- production/sandbox state
- promotion and rollback artifacts

The phone owns:
- user input
- voice/chat interface
- approval and denial decisions
- task/job/memory/connector browsing
- notification interaction
- promotion review
- human-readable summaries of traces and audits

The phone should not be required for the Mac runtime to keep running jobs, but it should be the preferred place for high-trust human decisions.

### 8.5 Communication modes

Support multiple communication modes without making any single mode the whole architecture.

1. Local network direct mode
   - phone and Mac communicate over the same LAN
   - useful for home/office/headless Mac mini use
   - should support service discovery where possible
   - should also support manual pairing by code/address for reliability
   - should be the normal steady-state path once Gini is on Wi-Fi or Ethernet

2. Localhost/dev mode
   - CLI, test harness, and phone simulator communicate locally
   - used by coding agents and CI/local smoke tests
   - must exercise the same contracts the phone app will use

3. Optional encrypted relay mode
   - used when the phone is outside the local network
   - relay should carry encrypted messages or route sessions
   - relay should not be able to decrypt secrets or inspect sensitive payloads if avoidable
   - local-only operation should still work without the relay

4. Push notification mode
   - used for wakeups and alerts
   - notification should point back to authoritative runtime state
   - push payloads should avoid secrets and sensitive full content

The architecture should allow starting with localhost/CLI and a phone simulator in v0, then adding real LAN pairing and remote relay later without changing the core task/approval/job/trace model.

### 8.6 Pairing and trust model

Pairing should be a first-class protocol, not an ad hoc shared token.

Pairing goals:
- prove the phone is authorized to control this Mac runtime
- prove the Mac runtime is the intended Gini instance
- establish device identity
- establish long-lived but revocable credentials
- support multiple trusted devices later
- support device revocation
- support production and sandbox instances without confusing them

Possible pairing surfaces:
- QR code shown by Mac CLI/local web page
- pairing code printed by CLI
- Bonjour/local network discovery
- manual IP/hostname entry
- future remote relay pairing

A paired device record should represent:
- device identity
- device name
- public key or credential reference
- role/capabilities
- paired timestamp
- last seen timestamp
- revocation status
- production vs sandbox target

The exact cryptographic implementation is an implementation choice, but the product semantics are not: paired devices must be authenticated, revocable, auditable, and clearly associated with the correct runtime instance.

### 8.7 Real-time event model

The phone should not have to poll blindly to understand what Gini is doing. The runtime should expose an event stream or equivalent mechanism for real-time updates.

Events should cover:
- task created/started/updated/completed/failed
- model response streaming or incremental output
- tool call requested/started/completed/failed
- permission requested/approved/denied/expired
- job scheduled/started/completed/failed/missed
- memory proposed/approved/edited/deleted/used
- connector connected/failed/revoked/needs-auth
- trace available/updated
- audit event written
- runtime health changed
- sandbox promotion proposed/approved/rejected/rolled back

The same event model should power:
- CLI watch commands
- phone UI updates
- phone simulator
- smoke tests
- optional web UI
- optional messaging bridge summaries

This prevents every surface from inventing its own state model.

### 8.8 API boundaries and contracts

Runtime local API or IPC should expose contracts for:
- create message/task
- stream response or subscribe to task events
- list tasks
- get task
- cancel/retry task
- approve/deny permission
- list pending approvals
- list memories
- create/update/delete memory
- list skills
- validate/update skill
- list jobs
- create/run/pause/resume job
- list connectors
- connect/revoke connector
- get connector health
- list audit events
- get trace summary
- export trace evidence
- get runtime health
- pair/revoke device
- get sandbox/promotion status

All control APIs require authenticated local client or paired-device auth. Dangerous state-changing APIs require permission checks and audit events.

Important design rule:

**Design contracts around product state, not screens.**

The same contracts should support CLI, simulator, Expo/mobile app, local web UI, and future messaging bridges. The mobile app should be a client of stable runtime semantics, not the place where core task/permission/job logic lives.

### 8.9 Offline and degraded behavior

The Mac runtime must continue operating when the phone is offline.

Expected behavior:
- scheduled jobs keep running if they do not require approval
- jobs requiring approval pause and wait
- expired approvals are marked clearly
- notifications are queued or retried where possible
- phone reconnects and catches up from authoritative runtime state
- missed or failed jobs are visible after reconnect
- task/event history is not lost because the phone was offline

The phone should be allowed to cache read-only summaries, but the runtime remains authoritative.

### 8.10 Security model

Principles:
- local secrets stay local
- secrets stored in OS keychain
- phone approvals are signed/authenticated
- high-risk actions require biometric confirmation
- all credential use is audited
- least privilege by default
- app scopes visible and revocable
- destructive actions gated
- remote relay cannot decrypt secrets

---

## 9. Conceptual Domain Models

The following models are conceptual domain models, not mandatory database schemas. They describe information the product must be able to represent, display, audit, derive, or reason over. Implementers may change storage design, field names, normalization, APIs, indexes, event models, sync strategy, and internal boundaries as long as the product semantics remain intact.

Use these models as a checklist of first-class concepts and user-visible state, not as rigid SQL table definitions.

### 9.1 Task

Fields:
- id
- title
- goal
- status
- priority
- created_by
- created_at
- updated_at
- started_at
- completed_at
- current_step
- summary
- trace_id
- parent_task_id
- cost_total
- token_total
- approval_state
- artifact_refs

### 9.2 Memory

Fields:
- id
- content
- scope_type
- scope_id
- status
- confidence
- sensitivity
- source_task_id
- source_session_id
- source_message_id
- created_at
- updated_at
- last_used_at
- usage_count
- conflict_group_id

### 9.3 Skill

Fields:
- id
- name
- description
- status
- author_type
- version
- file_path
- required_tools
- required_connectors
- required_permissions
- tests_path
- source_task_id
- created_at
- updated_at
- last_used_at
- success_count
- failure_count

### 9.4 Job

Fields:
- id
- name
- schedule
- enabled
- prompt
- script_path
- delivery_targets
- retry_policy
- timeout_seconds
- cost_budget
- last_run_at
- next_run_at
- last_success_at
- last_failure_at
- status

### 9.5 Connector

Fields:
- id
- type
- display_name
- account_identifier
- status
- scopes
- token_ref
- expires_at
- last_used_at
- health_status
- created_at
- updated_at

### 9.6 Permission

Fields:
- id
- subject_type: agent / skill / job / task
- subject_id
- resource_type: app / filesystem / terminal / connector / messaging
- resource_id
- actions
- scope
- duration
- expires_at
- approval_required
- risk_level
- status

### 9.7 AuditEvent

Fields:
- id
- event_type
- actor
- task_id
- session_id
- tool_name
- connector_id
- permission_id
- timestamp
- summary
- details_ref
- risk_level
- cost

---

## 10. Harness Optimization and Self-Improvement

This section covers runtime self-improvement: improving skills, memory behavior, jobs, prompts, workflow templates, and harness configuration after Gini is installed. The closed-loop development harness for building Gini itself is covered separately in Section 0.3.

### 10.1 Why Meta-Harness matters

Meta-Harness shows that LLM systems improve when the optimizer can inspect full source code, scores, and execution traces rather than compressed summaries.

Apply this to agent frameworks:
- prompts
- tool schemas
- memory retrieval
- context compression
- completion checks
- truncation policies
- permission prompts
- cron prompts
- task state machines

### 10.2 Required trace infrastructure

Every run should save:
- system prompt
- active skills
- active memories
- user messages
- model messages
- tool calls
- tool results
- terminal logs
- file diffs
- connector calls
- approvals
- costs
- errors
- final result
- user feedback
- eval result if available

### 10.3 Harness versioning

Version these as code:
- system prompt templates
- tool descriptions
- memory retrieval policy
- context compression policy
- approval templates
- completion checker
- job execution policy
- cost policy

### 10.4 Improvement proposal flow

1. Collect traces.
2. Run evals or use user feedback.
3. Optimization agent inspects full traces.
4. It proposes harness changes.
5. Changes are shown as diffs.
6. Regression tests run.
7. Human approves rollout.
8. Rollout is staged.
9. Metrics are monitored.
10. Rollback is available.

### 10.5 Do not auto-ship self-modifications by default

Risks:
- benchmark overfitting
- weaker safety prompts
- hidden cost increase
- prompt bloat
- reward hacking
- bad learned behavior

Default:
- propose changes
- test changes
- require approval for trusted harness updates

---

## 11. Reliability Requirements

### 11.1 No silent failure policy

Any of these must produce visible status:
- model call failed
- connector auth expired
- job missed
- tool crashed
- gateway disconnected
- memory write failed
- skill load failed
- MCP server unavailable
- push notification failed
- file write failed

### 11.2 Health checks

Runtime health:
- daemon running
- scheduler running
- database OK
- keychain OK
- model provider OK
- push channel OK
- local API OK

Connector health:
- token valid
- scopes valid
- API reachable
- last test status

Job health:
- last run
- next run
- last success
- last failure
- retries

### 11.3 Recovery

Support:
- restart daemon
- retry task
- replay job
- reconnect connector
- rollback file changes where possible
- restore config backup
- disable broken skill/plugin
- safe mode

---

## 12. MVP Definition and Release Ladder

### 12.1 Product track

Build Gini in layers.

The first implementation target is an installable Mac runtime with CLI and a local Next.js control plane. The future app should consume the same runtime/control contracts, but it should not block the first runtime milestones.

**v0 target:** A local macOS agent runtime that can be installed/run on a user-controlled Mac, inspected through CLI and local Next.js, execute tasks safely, show traces/audit, run jobs, expose memory/skills/session-search basics, support instance-aware development, and expose contracts that future mobile can consume.

**v1 target:** Finish the full v1 plan as a complete product foundation, not a partial preview. By the end of v1, Gini should have everything Hermes Agent currently has at the runtime-capability level, plus Gini's end-state architecture skeleton: local runtime, CLI, stable API/contracts, local web control plane, future app/control-plane contracts, task/event model, tasks, approvals, jobs, memory, skills, session search, traces, audit, permissions, connectors, toolsets, provider abstraction, delegation, MCP, messaging bridge, instances, import/migration basics, and parity smoke/eval coverage. Gini may present these capabilities through different UX primitives than Hermes, but a Hermes user should not lose a major runtime capability by switching to Gini v1. The iOS/Expo app is not part of v1.

**v2 target:** Start from completed v1 parity and improve beyond Hermes rather than catching up: iOS/Expo app, paired-device auth, remote/push path, hardened production/sandbox promotion, rollback, stronger adversarial security, richer connector/auth UX, mature runtime self-improvement, eval/harness optimization, long-running reliability, and operational polish.

### 12.1.1 v1 Hermes-parity requirement

By the end of v1, Gini should have feature parity with the current Hermes Agent runtime feature set and the architecture skeleton needed for the larger Gini vision. v1 is not a teaser, prototype, or "mobile shell only" release. It is the point where the full v1 plan is complete: Hermes-equivalent runtime capabilities are present, Gini's task/permission/trace/control-plane architecture is in place, and future v2 work can improve beyond Hermes instead of finishing parity. The iOS/Expo app is post-v1; v1 should define the contracts that app will later consume, not build the app itself.

This does not mean copying Hermes' interface shape. It means matching Hermes-class capabilities while expressing them through Gini's more inspectable, permissioned, task-centric, control-plane architecture.

Minimum v1 Hermes-parity capabilities:
- CLI power-user workflow: chat, single-shot task mode, status/doctor/config commands, and scriptable local control.
- Persistent memory: user, project, organization, device/environment, preference, and temporary memory scopes with retrieval across sessions.
- Skills/procedures: load, search, inspect, validate, create proposal, update proposal, test, disable, and rollback/governance where feasible.
- Session search: searchable prior conversations, task traces, summaries, source links, and transcript/trace citations.
- Cron/jobs: prompt-based jobs, script-only jobs, create/list/update/pause/resume/remove/run, context injection, delivery targets, logs, missed-run detection, replay, and cost history.
- Tools: file read/write/search/patch/list, terminal/process management, web search/extraction, code execution/sandboxed Python, browser automation where required for parity, and structured error handling.
- Toolsets/tool gating: named tool groups, per-task/job/skill availability, visible tool state, and permission mediation.
- Model/provider abstraction: OpenRouter/OpenAI-compatible provider support, direct providers where practical, local-provider path where practical, provider health, model switching, model capability metadata, and cost tracking.
- Delegation/subagents: isolated subagent tasks, concurrency/depth limits, tool-scope restrictions, trace linkage, cost attribution, cancellation, and parent verification of side-effect claims.
- MCP/plugin integration: add/list/remove/test MCP servers, selected exposed tools, plugin health, permission mediation, and failure isolation.
- Messaging gateway/bridge: at least the most important Hermes-style messaging paths for remote input/notifications, with channel health and links back to Gini's source-of-truth task/control plane.
- Config/profile equivalent: instance-aware config/profile management that covers the same practical use cases as Hermes profiles while preserving Gini's production/sandbox/dev isolation model.
- Migration/import basics: at minimum, read-only inspection or guided import for useful Hermes/OpenClaw state such as memories, skills, jobs, profiles, and connector references, without mutating existing installs by default.
- Runtime self-improvement: memory, skill, job, prompt, or workflow improvement proposals sourced from traces and user feedback, reviewable before application.

v1 release is not complete if a Hermes user loses a major runtime capability by switching to Gini. The acceptable tradeoff is that some capabilities may be narrower in integration breadth, but they must be present in the Gini architecture with clear paths to expand. v2 should begin from parity and move beyond Hermes in reliability, governance, security, UX, and operational maturity.

### 12.2 v0 milestone ladder

#### v0.1 Runtime skeleton

Goal:
Gini can run locally and accept simple tasks.

Includes:
- BYO Mac install/dev start
- CLI
- config loading
- local state
- basic runtime process
- health/status/doctor
- one model provider
- Codex OAuth credential discovery or another real provider path
- simple task execution
- minimal structured logs
- minimal trace per task

Success criteria:
- runtime starts on macOS
- CLI can start/stop/status/doctor
- one provider can be configured
- Codex OAuth provider can reuse an existing local Codex login without manual API key copy/paste
- user can submit a simple task
- task status and trace are persisted

#### v0.2 Local Next.js control plane

Goal:
The agent becomes inspectable through a local web control plane that exercises the same contracts future mobile will use.

Includes:
- localhost authenticated API
- event stream or equivalent update mechanism
- Next.js task list/detail
- chat/task input
- trace viewer skeleton
- audit/event viewer skeleton
- approval UI skeleton

Success criteria:
- user can operate basic task flow from local web
- CLI and web observe the same runtime state
- web UI is not a separate brain or mock product
- API contracts are testable by coding agents

#### v0.3 Tools with safety

Goal:
Gini can do useful local work with guardrails.

Includes:
- file read/write/search/patch tools
- terminal command execution
- workspace boundaries
- minimal permission gate
- audit events for side effects
- trace records for tool calls
- approval before risky actions
- timeout/cancel/process cleanup for commands where feasible

Success criteria:
- agent can operate in a test workspace
- file writes produce diffs/evidence
- terminal commands are logged and bounded
- risky actions pause for approval
- every tool side effect produces audit and trace evidence

#### v0.4 Jobs

Goal:
Unattended work becomes visible and reliable.

Includes:
- scheduled jobs
- run history
- pause/resume/run-now
- failure visibility
- missed-run detection
- job traces/logs

Success criteria:
- recurring job runs locally
- failed job records visible error/log/trace
- missed-run condition is inspectable
- user can pause/resume/force-run a job

#### v0.5 Memory, skills, and basic session search

Goal:
Hermes-like agent improvement and recall primitives become visible and governed.

Includes:
- memory store
- memory proposals
- memory review/edit/delete
- basic session transcript/task trace indexing
- session search with source task/session links
- basic skill/procedure format
- skill list/read/validate
- governed skill updates
- audit events for memory/skill mutation

Success criteria:
- agent can propose a memory from a task
- user can approve/edit/reject it
- approved memory can be retrieved later
- user can search prior sessions/tasks and open the cited source trace or transcript
- skill can be loaded for a toy task
- skill/memory changes are inspectable and reversible where possible

#### v0.6 Instances and closed-loop development harness

Goal:
Coding agents can safely iterate on Gini without destabilizing a real daily-driver install.

Includes:
- instance-aware config/state
- dev/sandbox instance support
- reset/uninstall paths
- smoke test runner
- evidence bundle
- basic isolation checks

Success criteria:
- coding agent can run smoke tests against a non-production instance
- instance identity appears in traces/audit/config
- reset affects only the selected instance
- evidence bundle includes task, logs, trace, audit, and test results

#### v0.7 Connector foundation

Goal:
Gini can demonstrate connector lifecycle behavior without turning v0 into a broad integration platform.

Includes:
- demo connector with no secrets
- connector abstraction
- one practical real connector later, likely GitHub
- Keychain storage where needed
- connector health checks
- revoke/disable flow
- scoped permissions

Success criteria:
- connector can be configured through CLI/API/web
- connector health is visible
- connector use emits audit and trace evidence
- real connector tokens, when present, are stored securely
- broken connector state is inspectable and recoverable

#### v0.8 Runtime self-improvement primitives

Goal:
Gini can propose improvements to its own operating material without silently changing behavior.

Includes:
- memory/skill/job improvement proposal records
- source trace references
- approve/reject review flow
- apply only after approval
- audit events for proposal, rejection, and application
- evidence bundle for reviewer agents

Success criteria:
- agent or user can create an improvement proposal from evidence
- proposal is inspectable through CLI/API/web
- approval applies the target memory, skill, or job
- rejection creates no side effect
- smoke emits an evidence bundle with tasks, traces, audit, state, and runtime status

### 12.3 v0 should not include

Avoid initially:
- production mobile app as a blocking dependency
- Gini Computer / preinstalled hardware as part of this roadmap
- Android
- broad messaging platform support
- large plugin marketplace
- enterprise SSO
- complex team permissions
- visual workflow builder
- full MCP marketplace
- autonomous source-code self-modification
- too many model providers
- broad connector catalog
- full browser automation for arbitrary external websites unless needed
- bundled provider billing

### 12.4 v1 success criteria

By the end of v1, a user can:
1. Install and run Gini on a user-controlled Mac.
2. Operate Gini through the CLI and local Next.js control plane.
3. Submit tasks and see task progress through local control surfaces.
4. Approve or deny risky actions through structured local web/CLI approval flows.
5. Browse and edit memory.
6. Browse, inspect, validate, and approve/reject skill changes.
7. Browse jobs and receive visible failure status through local control surfaces and configured messaging channels where available.
8. Review trace/audit summaries in a readable form.
9. Use Hermes-equivalent runtime capabilities inside Gini: CLI workflow, memory, skills, session search, jobs, file/terminal/web/code tools, toolsets/tool gating, provider abstraction, delegation/subagents, MCP, messaging bridge, config/profile equivalent, and import/migration basics.
10. Confirm through a Hermes-parity smoke/eval suite that switching from Hermes to Gini does not remove a major runtime capability, even if Gini's UX and integration breadth differ.
11. Confirm that the v1 architecture skeleton is in place for future v2 expansion: stable runtime contracts, future app/control-plane contracts, event stream, trace/audit substrate, permission enforcement boundary, instance-aware state, connector/plugin abstraction, provider abstraction, job scheduler, memory/skill governance, support/evidence bundles, and documented extension points.
12. Treat any missing Hermes runtime capability as a v1 blocker unless explicitly documented as an intentional non-goal with an approved expansion path.

Explicit v1 non-goal:
- Do not build the iOS/Expo mobile app in v1. v1 should make the app possible by stabilizing the runtime contracts, event model, local control plane, permission model, and trace/audit substrate.

### 12.5 v2 production success criteria

v2 starts from v1 Hermes parity. It is not a catch-up milestone. A user can:
1. Pair an iOS/Expo app with the Mac runtime.
2. Chat or speak to Gini from the phone.
3. See task progress and approve/deny risky actions from structured mobile cards.
4. Use Gini remotely through paired-device auth, relay/push, and clear degraded/offline behavior.
5. Run production Gini as a daily-driver instance while coding agents test sandbox instances.
6. Promote a tested candidate with an evidence-backed proposal and rollback plan.
7. Recover from a failed upgrade without losing state, traces, or audit history.
8. Use multiple real connectors with scoped credential storage, visible health, revocation, and operational recovery.
9. Use optional messaging bridges without making them the source of truth.
10. Inspect, approve, reject, and roll back runtime self-improvement changes across memories, skills, jobs, prompts, workflow templates, and harness material.
11. Benefit from beyond-Hermes reliability, governance, security, mobile UX, eval/harness optimization, data-egress controls, and long-running operational maturity.

---

## 13. Implementation Plan by Phase

The build order should minimize coupling and let separate agents work concurrently without blocking the critical path. The runtime is the trunk. CLI, local API contracts, Next.js control plane, and smoke harness come before production mobile polish.

### Phase 0: Lightweight architecture foundation

Deliverables:
- repo structure
- lightweight ADRs for required architecture decisions
- conceptual domain model decisions
- CLI command map
- local API/IPC direction
- event vocabulary
- minimal permission/audit/trace substrate design
- instance identity design
- Next.js control-plane direction
- future app/control-plane contract direction

Required ADRs:
- Mac process model
- local API exposure
- tool execution boundaries
- secret handling
- trace privacy
- audit integrity
- permission defaults
- instance identity
- pairing/approval model
- relay threat model

Verification:
- coding agents know what is mandatory vs deferred
- v0/v1 split is explicit
- local dev vs real remote product assumptions are explicit
- dangerous tool work cannot proceed without trust substrate boundaries

### Phase 1: v0.1 runtime skeleton

Deliverables:
- user-level Mac runtime process
- config loading
- local state store
- CLI entry point
- health/status/doctor
- basic session/task model
- one model provider
- simple task execution
- minimal structured logs
- minimal trace record

Verification:
- runtime starts on macOS
- CLI can start/stop/status/doctor
- a simple task can run through the real runtime
- trace/log output exists at predictable paths

### Phase 2: v0.2 local Next.js control plane

Deliverables:
- localhost authenticated API or IPC bridge
- event stream or update mechanism
- Next.js local control plane
- task list/detail
- task input/chat shell
- trace/audit skeleton viewer
- approval skeleton UI

Verification:
- local web and CLI observe the same task state
- task can be submitted through local web
- status updates appear without manual log reading
- API is testable by coding agents

### Phase 3: v0.3 trust substrate and tools with safety

Deliverables:
- minimal PermissionRequest object
- minimal AuditEvent object
- minimal TraceRecord/tool-call linkage
- risk classification defaults
- workspace boundary model
- file read/write/search/patch tools
- terminal execution with timeout/cancel where feasible
- approval pause for risky actions

Verification:
- every tool call records trace evidence
- every meaningful side effect records audit event
- risky file/terminal action pauses for approval
- denial prevents side effect
- tool execution is bounded to approved workspace or explicitly approved target

### Phase 4: v0.4 scheduler and recurring jobs

Deliverables:
- create/list/update/pause/resume/run jobs
- recurring schedule support
- job logs
- retries
- missed-run detection
- failure status
- job trace linkage

Verification:
- recurring job runs locally
- force-run works
- failed job records logs and trace
- missed-run condition is visible through CLI/API/web

### Phase 5: v0.5 memory, skills, and basic session search

Deliverables:
- memory store
- memory retrieval
- memory proposal flow
- memory list/read/edit/delete CLI/API/web
- basic session transcript/task trace indexing
- session search with source task/session links
- basic skill/procedure file format
- skill list/load/validate CLI/API/web
- trusted/draft status

Verification:
- agent proposes memory after a task
- user can approve/edit/reject through CLI or web
- approved memory is later retrieved
- user can search prior sessions/tasks and open cited source trace or transcript
- skill can be loaded and used in a toy task
- memory/skill mutations are audited

### Phase 6: v0.6 instances and closed-loop development harness

Deliverables:
- instance-aware config/state paths
- dev/sandbox instance support
- reset/uninstall for selected instance
- smoke test runner
- ephemeral smoke instances for concurrent coding agents
- support/evidence bundle
- isolation checks
- harness run records

Verification:
- coding agent can run smoke tests against non-production instance
- multiple coding agents can run smoke tests at the same time without sharing state, logs, or ports by default
- reset affects only selected instance
- evidence bundle links tests, logs, traces, audit, and runtime health
- instance confusion is visible in doctor/status

### Phase 7: v0.7 connector foundation

Deliverables:
- demo connector with no secrets
- connector abstraction
- one practical real connector later, likely GitHub
- Keychain storage where needed
- connector health checks
- revoke/disable flow
- scoped permissions

Verification:
- connector can be configured through CLI/API/web
- token is stored securely when real connector exists
- connector use emits audit and trace evidence
- broken connector health is visible

### Phase 8: runtime self-improvement primitives

Deliverables:
- memory/skill/job improvement proposal format
- trace-backed improvement proposals
- review/approve/reject flow
- rollback/revert where feasible
- harness/prompt/workflow versioning direction
- evidence bundle generated by smoke/reviewer flows

Verification:
- Gini can propose a skill/memory/job improvement from evidence
- proposal is not applied silently
- user can inspect source trace/reason
- rejected proposal has no side effect
- approved proposal applies the target change and records audit evidence

### Phase 9: v1.0 architecture skeleton and contract hardening

Deliverables:
- stable runtime API/contracts for CLI, local Next.js, future mobile clients, messaging bridges, and test harnesses
- event stream contract for tasks, approvals, jobs, memory, skills, connectors, traces, audit, runtime health, and future mobile updates
- local Next.js control plane completeness for v1 user-facing flows
- future app contract direction without implementing the iOS/Expo app
- future pairing/remote/relay contract direction without implementing the production mobile path
- architecture-readiness checklist for the end-state product

Verification:
- CLI and local web operate through the same runtime source-of-truth contracts
- event stream can drive local web and automated smoke tests
- future mobile/app requirements are represented in contracts, not hardcoded into a mobile-only implementation
- no iOS/Expo app shell is required or built for v1
- architecture-readiness checklist has explicit pass/fail evidence

### Phase 10: v1.1 Hermes-parity runtime completion

Deliverables:
- provider breadth: OpenRouter/OpenAI-compatible, direct providers where practical, and local-provider path where practical
- toolset/tool-gating model for tasks, jobs, skills, subagents, and MCP tools
- delegation/subagent runtime with isolated contexts, trace linkage, cost attribution, limits, cancellation, and parent verification rules
- MCP server add/list/remove/test and selected tool exposure
- session search depth: prior sessions, task traces, summaries, source links, and transcript/trace citations
- config/profile equivalent through instance-aware profiles and importable/exportable config
- Hermes/OpenClaw import basics for memories, skills, jobs, profiles, and connector references, read-only or guided by default
- parity smoke/eval suite that maps Hermes capabilities to Gini workflows

Verification:
- a Hermes user can perform equivalent runtime tasks in Gini for memory, skills, session search, jobs, providers, tools, toolsets, delegation, MCP, and config/profile workflows
- subagent claims about external side effects are trace-backed or verified before surfacing as success
- MCP/plugin failures are isolated and visible
- migration/import never mutates existing Hermes/OpenClaw installs by default
- parity smoke/eval suite passes before v1 release

### Phase 11: v1.2 messaging bridge parity

Deliverables:
- at least one high-priority Hermes-style messaging bridge, such as Telegram or iMessage
- notification forwarding through the messaging bridge where practical
- inbound message/task creation
- voice message support where the chosen channel makes it practical
- task links back to local web control plane
- channel health and failed-send retry/logging

Verification:
- messaging channel can send/receive simple messages
- messaging channel can create or update a task without becoming the source of truth
- rich tasks still open in the local web control plane
- channel failure is visible
- messaging is not the source of truth

### Phase 12: v1.3 parity hardening and public-release readiness

Deliverables:
- full v1 Hermes-parity smoke/eval coverage
- install/upgrade/reset/uninstall tests for v1 surfaces
- provider, MCP, delegation, messaging, job, memory, skill, session-search, local web, API, event-stream, trace, audit, and permission regression tests
- architecture-readiness review for v2 expansion points: runtime API/contracts, future app/control-plane contracts, event stream, trace/audit substrate, permission enforcement boundary, instance-aware state, connector/plugin abstraction, provider abstraction, job scheduler, memory/skill governance, support/evidence bundles, and extension documentation
- support/evidence bundle for v1 failures
- documentation for Hermes-equivalent workflows, v1 local control surfaces, future app contracts, and where Gini intentionally differs

Verification:
- v1 release candidate passes the Hermes-parity suite
- v1 release candidate passes install, launch, exercise, observability, recovery, and review gates
- v1 release candidate passes architecture-readiness review for v2 expansion
- no major Hermes runtime capability is missing without an explicit documented exception and expansion path
- no iOS/Expo app is required for v1 release readiness
- support/evidence bundle can diagnose failures across runtime, local web, messaging, MCP, provider, job, memory, skill, trace, audit, and permission boundaries

### Phase 13: v2 iOS/Expo app, pairing, relay, and mobile UX

Deliverables:
- Expo app shell backed by v1 runtime contracts
- paired-device auth implementation
- paired-device token issuance and revocation
- mobile bootstrap endpoint backed by runtime state
- task list/detail
- chat/voice UI
- approval cards
- job/memory/skill/trace summary views
- remote relay/push implementation
- notification deep links
- relay outage/degraded behavior

Verification:
- app or simulator pairs with runtime
- app can list tasks and task detail
- app can send basic task request
- app can approve/deny permission requests
- app can browse job, memory, skill, and trace summaries from runtime state
- mobile uses runtime contracts rather than separate state
- revoked device tokens cannot access the mobile contract
- local mode still works if relay is down

### Phase 14: v2 beyond-Hermes hardening and operations

Deliverables:
- production/sandbox promotion workflow implemented end-to-end
- rollback artifacts and restore commands
- migration tests against redacted or synthetic production-like state
- real connector credential storage and revocation hardening
- remote relay degradation tests
- self-improvement rollback for applied memories, skills, jobs, prompts, workflows, and harness material
- adversarial security and model-egress controls
- richer eval/harness optimization loops
- long-running reliability tests for jobs, connectors, approvals, messaging, subagents, MCP, and mobile/relay operation

Verification:
- production instance is not mutated without explicit approval
- failed promotion can be rolled back with preserved evidence
- connector failures are visible and recoverable
- remote outage does not break local control
- applied self-improvement changes can be traced back to evidence and reversed where feasible
- v2 demonstrably improves beyond Hermes in reliability, governance, security, UX, and operational maturity

---

## 14. Engineering Standards

### 14.1 Testing

Required tests:
- unit tests for data models
- API tests
- permission engine tests
- memory retrieval tests
- job scheduler tests
- connector mock tests
- tool execution tests
- trace logging tests
- mobile API contract tests

Critical regression tests:
- memory survives restart
- job missed alert fires
- denied permission stops action
- expired connector surfaces clear error
- destructive command requires approval
- file write is audited
- trace is complete

### 14.2 TDD expectation

For each feature:
1. Write failing test.
2. Run and verify failure.
3. Implement minimal code.
4. Verify pass.
5. Add edge-case tests.
6. Commit.

### 14.3 Observability as a requirement

No feature is complete unless it logs:
- what happened
- why it happened
- who/what initiated it
- what permissions were used
- whether it succeeded
- where details are stored

### 14.4 Safe defaults

Defaults:
- no destructive actions without approval
- no broad filesystem write access
- no silent memory saves for sensitive info
- no auto-shipping skill/harness changes
- read-only connector scopes where possible
- local secrets only

---

## 15. Product Differentiation

### 15.1 Against OpenClaw

OpenClaw advantage:
- channel breadth
- ecosystem size
- broad integrations

Our advantage:
- agent-native phone UI
- structured permissions
- memory/skill/job visibility
- reliability and auditability
- installable open source agent experience
- fewer but deeper integrations

Message:
OpenClaw connects your agent everywhere. We make your agent operable and trustworthy.

### 15.2 Against Hermes Agent

Hermes advantage:
- skills/memory story
- provider flexibility
- CLI depth
- self-improvement loop

Our advantage:
- v1 Hermes feature parity inside a more operable system structure
- local Next.js control plane first, with future mobile control plane enabled by stable contracts
- structured auth/permission UX
- governed memory and skills
- task/job observability
- trace/audit/cost receipts for every important action
- harness trace/optimization infrastructure
- app/runtime pairing architecture after v1

Message:
Hermes proves the runtime primitives people want. Gini should match those primitives by v1, then make them visible, governable, easier to operate, and reliable enough to trust for long-running work. The iOS/Expo app comes after the v1 parity and architecture foundation are complete.

### 15.3 Against generic chatbots

Generic chatbot advantage:
- simple chat UX
- low setup

Our advantage:
- real tools
- local execution
- persistent tasks
- app auth
- scheduled jobs
- memory/skills
- audit logs

Message:
Chatbots answer. This agent operates.

---

## 16. Non-Negotiable Quality Bars

Before public release, these must be true:

1. Pairing is reliable.
2. The daemon restarts cleanly.
3. Users can see whether the agent is online.
4. Every task has a status.
5. Every risky action asks for approval.
6. Every file write is diffed and logged.
7. Every connector shows scopes and last used.
8. Memory can be inspected and edited.
9. Jobs show last/next run and failure reason.
10. Failed jobs notify the user.
11. Costs are visible per task.
12. Users can revoke access.
13. Users can disable a broken skill/job/connector.
14. The product works without Telegram/iMessage.
15. Messaging integrations are optional, not required.

---

## 17. Open Decisions and Deferred ADRs

This section intentionally excludes questions already resolved in Section 0.1.

### Product and release

Resolved defaults:
- v0 is a BYO Mac developer/power-user runtime.
- v1 is Hermes runtime feature parity plus the end-state architecture skeleton, operated through CLI and local Next.js. The iOS/Expo app, paired-device mobile control, and production remote/push path are post-v1.
- Gini Computer / appliance packaging is a separate product concept, not part of this roadmap.

Open later:
- What exact milestone counts as first public release should be decided once the product is working enough to judge readiness.

### Control-plane stack

Resolved default:
- Next.js + Expo is the preferred control-plane stack.
- Browser automation against Next.js is a core testability advantage.
- Xcode/iOS Simulator and Shelden's physical iPhone should supplement mobile testing.
- Native iOS should be reconsidered only if Expo hits a real capability wall.

Deferred technical questions:
- Which mobile capabilities require Expo dev builds, native modules, physical-device tests, or simulator-only coverage?

### Connectors

Resolved default:
- Do not let real connectors block the core runtime.
- Add connector foundation around v0.7, after the runtime, control plane, tools, jobs, memory/skills, and instance-aware harness are stable.
- Start with a demo connector and at most one practical real connector, likely GitHub.
- Broad connector catalog is later.

### Migration/import from Hermes/OpenClaw

Deferred:
- Think about migration/import later.
- It should not block v0.
- If added, first version should likely be read-only inspection/import rather than mutating existing Hermes/OpenClaw installs.

### Business model

Resolved default:
- Local runtime should be open source.
- Paid relay/mobile/cloud convenience may be added later if hosted infrastructure is needed for remote access, push, device registry, or support.

### Remote access and relay

Resolved product requirement:
- Local mode is acceptable for development.
- Real product should work wherever the user is.

Deferred implementation question:
- Decide later whether the production remote path uses a custom relay, Cloudflare-style tunnel/relay, peer-to-peer/WebRTC-like transport, or another hosted mechanism.
- Tailscale/manual networking may be a dev or power-user escape hatch, but should not be required for normal users.

### Memory

Resolved default:
- Start with a Hermes-like memory system.
- Improve memory UX, retrieval quality, source attribution, and proposal tuning later.
- Early memory behavior should be conservative, inspectable, editable, and source-attributable.

### Team mode

Resolved default:
- No team mode in early product.
- Optimize for single-user personal agent use first.
- Avoid choices that make team support impossible later, but do not implement team permissions, enterprise SSO, org admin, or multi-user collaboration early.

### Required lightweight ADRs

Still required before implementation of affected subsystems:
- database/storage choice
- local API protocol
- Mac process model
- local API exposure
- tool execution boundaries
- model provider abstraction
- secret handling
- trace privacy and large trace storage
- audit integrity
- permission defaults
- instance identity
- pairing/approval cryptography
- relay threat model

### UX details to refine during prototyping

Defaults:
- tasks are the source of truth; chat and cards are views over task state.
- voice is an input/navigation/summarization layer, not the only approval mechanism.
- approval cards use progressive disclosure.
- memory proposals should be conservative and batched when possible.

Open through prototype testing:
- exact voice/card interaction model
- default approval-card detail level
- task threading presentation
- memory-review frequency and annoyance threshold

---

## 18. Recommended Demonstration Workflows

These workflows should demonstrate the generic agent runtime and control plane. They are not separate product verticals and should not distort the core architecture.

### Workflow 1: Reliable agent task with approvals and receipts

Capabilities:
- user asks Gini to perform a bounded task
- Gini plans visible steps
- risky actions produce structured approval requests
- progress appears in task timeline
- completion includes trace/audit receipt

Why it shows value:
- demonstrates agent-native UI rather than plain chat
- demonstrates trust, visibility, and control
- works across CLI, local web, and future mobile

### Workflow 2: Local coding/repo task as stress test

Capabilities:
- user asks Gini to inspect or modify a small test repo
- agent reads files and proposes changes
- terminal commands are risk-classified
- file diffs are shown before/after writes
- final output links to trace, audit, and changed files

Why it shows value:
- stresses file/terminal safety
- demonstrates approvals
- demonstrates traces and diffs
- useful for the closed-loop development harness

This is a stress test and demo workflow, not the entire product category.

### Workflow 3: Recurring job with failure visibility

Capabilities:
- user creates a recurring job
- job runs on schedule
- job history is visible
- failures produce trace/log evidence
- user can pause/resume/force-run

Why it shows value:
- demonstrates reliable unattended work
- demonstrates no silent failures
- demonstrates job cards and notifications

### Workflow 4: Runtime self-improvement proposal

Capabilities:
- Gini identifies a repeated task pattern or failure
- Gini proposes a memory, skill, job, or workflow improvement
- proposal cites the trace/evidence that motivated it
- user approves, edits, or rejects
- accepted change is versioned/audited

Why it shows value:
- demonstrates the Hermes-like improvement promise
- keeps self-improvement visible and governed
- avoids silent mutation

---

## 19. Coding Agent Instructions

When coding agents use this plan:

1. Preserve the product principles.
2. Do not reduce the system to a chat app.
3. Treat permissions, memory, jobs, and traces as first-class objects.
4. Build narrow but reliable MVPs.
5. Add audit events for every meaningful side effect.
6. Add tests before implementation.
7. Keep UI structured around cards and objects.
8. Use safe defaults.
9. Make every failure visible.
10. Prefer fewer integrations that work well over many integrations that fail silently.
11. Preserve the v1 Hermes-parity requirement: v1 should have the end-state system structure and should not leave major Hermes runtime capabilities missing.
12. Treat v2 as beyond-Hermes improvement work, not deferred parity catch-up.

### 19.1 Product invariants vs implementation choices

Coding agents should treat this plan as product law, not schema law.

Strict product invariants:
- Tasks must be first-class, persistent, inspectable objects.
- Permissions must be structured, scoped, reviewable, and revocable.
- Memory must be visible, editable, scoped, and attributable to sources.
- Jobs must have status, history, logs, retry/failure visibility, and missed-run alerts.
- Connectors must expose account, scopes, health, last-used state, and revocation.
- Skills must be inspectable, versioned or otherwise governable, and protected from silent destructive edits.
- Meaningful side effects must produce audit events.
- Runs must produce enough trace data to debug what happened.
- Messaging apps must remain optional channels, not the only source of truth.
- Risky actions must use structured approval UX, not plain chat-only prompts.

Flexible implementation choices:
- database/storage engine
- exact database schema and field names
- REST vs GraphQL vs gRPC vs WebSocket API shape
- service/process boundaries
- local filesystem layout
- event-sourcing vs normalized tables vs document models
- mobile/web component structure
- model/provider abstraction internals
- scheduler implementation
- connector SDK choices
- trace storage format, as long as traces are complete and inspectable

Coding agents may propose alternatives when they can explain why the alternative better preserves the invariants. They may not remove or weaken the invariants without explicit approval.

For implementation:
- Break each phase into bite-sized tasks.
- Use exact file paths.
- Write failing tests first.
- Verify after every task.
- Commit after every task.
- Do not auto-apply self-improvement changes without governance.

---

## 20. Final Product Shape

The final product is not:
- a Telegram bot
- an iMessage bot
- a CLI wrapper
- a generic web chat
- a model provider frontend

The final product is:

A local-first agent runtime with a mobile-first control plane.

It lets users:
- talk to their agent by voice
- approve actions from their phone
- connect apps without config files
- see what the agent knows
- see what the agent can do
- see what the agent is doing
- inspect what the agent did
- schedule work reliably
- debug failures
- govern memory and skills
- run headlessly on a Mac mini or Mac Studio

The strategic wedge:

**The first agent you can operate, audit, and trust.**
