# Releases

How Gini Agent versions, ships, and documents releases. Read this before bumping a version, opening a release PR, or writing changelog entries.

## Versioning

Gini follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While pre-1.0:

- **`0.x.0`** — anything user-visible: new CLI commands, gateway `/api/*` changes, config or state-file migrations, behavior changes that users would notice.
- **`0.x.y`** — bug fixes and internal-only changes.
- **`1.0.0`** — first release that commits to a stable public contract for the CLI, gateway API, and on-disk state shape.

The package is `"private": true` (no npm publish). Versions exist for human-readable identity and for what `gini status` / the web sidebar surface. The installer-managed runtime updates by `git pull`, so end users pick up new versions when they run `gini update`.

## CHANGELOG conventions

[`CHANGELOG.md`](../CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The format is non-negotiable; tooling and humans both rely on it.

### Categories

Group entries under these headings, in this order, and omit any that are empty:

- **Added** — new features users can use.
- **Changed** — behavior changes to existing features.
- **Deprecated** — features still present but marked for removal.
- **Removed** — features deleted.
- **Fixed** — bug fixes.
- **Security** — vulnerability fixes (cross-reference `SECURITY.md`).

### When to add an entry

Every PR that produces a **user-visible** change adds a line under `## [Unreleased]`. User-visible means: changes a CLI command, the gateway API, the web UI, install/update behavior, config keys, on-disk state shape, or default behavior.

Skip the changelog for: pure refactors, internal renames, test-only changes, doc fixes that don't change product behavior, and dependency bumps that don't change behavior. PR titles already cover those (see [AGENTS.md](../AGENTS.md#commits-and-pr-titles)).

### How to write an entry

One line per change, present tense, user-focused. Lead with the verb and the user-visible thing, not the file you touched.

Good:

```md
- Add `gini snapshots restore` for rolling an instance back to a named snapshot.
- Change `gini provider set` to read API keys from environment variables only (never from config).
- Fix `gini smoke` hanging when the runtime port is already bound.
```

Bad:

```md
- Refactor src/cli/snapshots.ts                        # not user-visible
- Update snapshot restore                              # vague, no subject
- Reviewer feedback round 2                            # process meta, not the change
```

If a change links to an issue, PR, or ADR that adds important context, append it: `(#123)`, `(see ADR provider-extra-body.md)`.

## Release process

A release is a version bump, a tag, a GitHub release, and a CHANGELOG entry — done together, from `main`.

### 1. Decide the version

Look at what's in `## [Unreleased]`:

- Any **Added**, **Changed**, **Removed**, or **Deprecated** entries → minor bump.
- Only **Fixed** or **Security** entries → patch bump.

If you can't decide, default up.

### 2. Open a release PR from `main`

From a clean checkout of `main`:

```bash
git checkout -b release/<version>
```

Edit `CHANGELOG.md`:

- Add a new `## [X.Y.Z] - YYYY-MM-DD` heading directly below `## [Unreleased]`.
- Move every entry under `[Unreleased]` into the new section, preserving subsection order.
- Leave `## [Unreleased]` empty (don't delete the heading).
- Update the link footnotes at the bottom of the file so `[X.Y.Z]` points at the compare URL and `[Unreleased]` points at `vX.Y.Z...HEAD`.

Then bump the package version (this also creates a commit and tag locally):

```bash
bun pm version <patch|minor|major>
```

If you need to amend the CHANGELOG to match (`bun pm version` commits before you can stage it), instead do the bump by hand:

```bash
# edit package.json version, then:
git add package.json CHANGELOG.md
git commit -m "vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
```

Open the PR. Title: `vX.Y.Z`. Body: paste the new CHANGELOG section.

### 3. Merge and push the tag

After the release PR is approved and merged into `main`:

```bash
git checkout main
git pull
git push origin vX.Y.Z
```

(The tag was created locally in step 2. Push it only after the release commit lands on `main`, so the tag points at a commit reachable from `main`.)

### 4. Create the GitHub release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes-file <(awk "/## \\[X\\.Y\\.Z\\]/,/## \\[/{print}" CHANGELOG.md | sed '$d')
```

Or pass `--notes` with the section pasted by hand. Don't use `--generate-notes` for the body — it duplicates work and produces lower-quality notes than the curated CHANGELOG section.

### 5. Verify

```bash
gini update                       # on a test machine, picks up the new tag
gini status                       # confirm the sidebar/CLI report the new version
```

## Release notes vs. CHANGELOG

The CHANGELOG is the source of truth. The GitHub release body for `vX.Y.Z` is the same text as the `[X.Y.Z]` section of the CHANGELOG — copy it verbatim, don't paraphrase.

If a release needs extra context (a migration note, a known issue, a breaking-change call-out), add it inside the CHANGELOG section under a `### Notes` subsection so the CHANGELOG and release page stay identical.

## Hotfixes

For an urgent fix to the latest release:

1. Branch from the tag: `git checkout -b hotfix/X.Y.Z+1 vX.Y.Z`.
2. Apply the minimal fix.
3. Add a `Fixed` entry to `[Unreleased]` and follow the normal release process for `X.Y.Z+1`.
4. Merge `main` into the hotfix branch (or rebase) so `main` includes the fix before the tag.
