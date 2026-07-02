# Bun Workspaces Monorepo

## Status

Accepted.

## Context

The repository grew three runnable surfaces with independent dependency
trees — the Bun gateway/CLI at the root (`src/`), the Next.js control plane
(`web/`), and the Expo app (`mobile/`) — each with its own `bun.lock` and its
own `bun install`. That shape predated Bun's first-class workspace support and
carried real costs:

- Three lockfiles drifted independently; nothing guaranteed the versions CI
  tested were the versions a fresh checkout installed.
- Root scripts chained `cd web && …`/`cd ../mobile && …` hops, and CI ran
  three separate install steps.
- The root `package.json` was simultaneously the runtime package (deps, `bin`)
  and the de-facto repo root, so runtime concerns and repo concerns were
  entangled.

Bun's current workspace model (workspaces in the root `package.json`, a single
root lockfile, the `catalog:` protocol for shared versions, `bun run --filter`
for cross-package scripts) is the documented way to hold several packages in
one repository, and Expo SDK 52+ auto-configures Metro for monorepos with Bun
workspaces.

## Decision

The repository is a Bun workspaces monorepo:

- The root `package.json` is a **private workspace root**: name `gini-agent`
  (the installer greps for it), the release-tagged `version`, `workspaces`
  with `packages: ["packages/*"]` and a default `catalog` for versions shared
  across packages (`typescript`, `@types/bun`, `@tanstack/react-query`).
- `packages/runtime` (`@gini/runtime`) is the gateway + CLI (the old root
  `src/`), and owns the runtime dependencies, including the `file:` vendor
  tarball (`file:../../vendor/xlsx-0.20.3.tgz`) and the `gini` bin.
- `packages/web` (`@gini/web`) is the Next.js control plane; `packages/mobile`
  (`@gini/mobile`) is the Expo app. Both are full workspace members — their
  standalone lockfiles are gone; the root `bun.lock` is the only lockfile.
- `patchedDependencies` (with `patches/` at the root) and the union of every
  package's `trustedDependencies` live in the root `package.json`, where Bun
  applies them install-wide.
- `skills/`, `docs/`, `scripts/`, `vendor/`, and `patches/` stay at the
  repository root. They are assets and infrastructure — not packages — that
  the runtime locates from the workspace root.
- Bun's isolated linker (the workspace default) is kept: per-package
  `node_modules` with a central store, so undeclared dependencies fail loudly
  instead of resolving through hoisting. Dependencies that code imports must
  be declared by the package that imports them (this surfaced and fixed
  `expo-file-system` in mobile), and Expo config plugins resolve
  `expo/config-plugins` through the declared `expo` package.

`projectRoot()` in `packages/runtime/src/paths.ts` no longer hops a fixed
number of directories: it walks up from the module to the nearest
`package.json` that declares `workspaces` and returns that directory. The
instance-name derivation (worktree basename), the web app spawn
(`packages/web`), bundled `skills/`, and `docs/` all hang off that value, so
the walk is what keeps per-worktree instance isolation working with the
runtime package nested two levels deeper.

Cross-package orchestration stays at the root: `bun run gini|server|smoke`
point into `packages/runtime`, `bun run test` runs the runtime/skills/mobile
suites from the root (root `bunfig.toml` preload) with the web suite as
`posttest` under its own `bunfig.toml`, and `typecheck` combines the root
tsconfig (skills) with `bun run --filter './packages/*' typecheck`.

## Consequences

- One `bun install` at the root installs every package against one lockfile;
  CI's three install steps collapsed into one `--frozen-lockfile` install.
- Version drift during the lockfile consolidation is a real hazard: the web
  app's exact pins (`next`, `react`) carried over, but caret ranges
  re-resolve. `radix-ui` is pinned exactly (`1.6.0`, the version the old
  committed lockfile resolved) because `1.6.1` changes popover keyboard
  behavior that `ModelPicker` tests pin.
- Update-path compatibility: an installed runtime (`~/.gini/runtime`) running
  pre-monorepo code that pulls this layout finds no `web/package.json`, so the
  old updater skips the web build; the root workspace install still installs
  web's deps, the runtime serves the web app in dev mode after restart, and
  the next `gini update` (new code) rebuilds the production bundle at
  `packages/web`. A one-time dev-mode window, not an outage.
- The launchd gateway plist now execs
  `bun run packages/runtime/src/server.ts`, and the web shim `cd`s to
  `packages/web`; `gini autostart enable` regenerates plists on update, so
  installs converge on the new paths.
- Skill scripts must stay self-contained. The `materialize` script's runtime
  import was replaced with a deliberate in-skill copy of `workspace-write`
  (both copies carry a sync pointer and their own test suite).

## Acceptance checks

- `bun install` from a fresh checkout installs every package; `bun.lock` is
  the only lockfile in the tree.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` pass from the
  root.
- `bun pm ls playwright-core` resolves 1.61.1 with the patch applied
  (`'Bun' in globalThis` marker present in
  `packages/runtime/node_modules/playwright-core/lib/utilsBundle.js`).
- `bun run gini run --instance <worktree-basename>` from a worktree boots the
  gateway and spawns the web app from `packages/web`, and the instance name
  still equals the worktree basename.
