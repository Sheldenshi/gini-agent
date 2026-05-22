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

**The CHANGELOG is curated at release time, not per PR.** PRs land with clear titles (per [AGENTS.md](../AGENTS.md#commits-and-pr-titles)) and the release author distills those titles into CHANGELOG entries when cutting the release. The `[Unreleased]` heading stays empty between releases; it exists as a placeholder for the next versioned section to anchor below.

### Categories

When writing the section for a new release, group entries under these headings, in this order, and omit any that are empty:

- **Added** — new features users can use.
- **Changed** — behavior changes to existing features.
- **Deprecated** — features still present but marked for removal.
- **Removed** — features deleted.
- **Fixed** — bug fixes.
- **Security** — vulnerability fixes (cross-reference `SECURITY.md`).

### What to include

One line per user-visible change. User-visible means: changes a CLI command, the gateway API, the web UI, install/update behavior, config keys, on-disk state shape, or default behavior.

Omit: pure refactors, internal renames, test-only changes, doc fixes that don't change product behavior, dependency bumps that don't change behavior.

### How to write an entry

Present tense, user-focused. Lead with the verb and the user-visible thing, not the file that was touched.

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

A release is a version bump, a tag, a GitHub release, and a CHANGELOG section — done together, from `main`.

### 1. Survey what changed

From a clean checkout of `main`:

```bash
PREV=$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null)
if [ -n "$PREV" ]; then
  git log "$PREV"..main --oneline
else
  git log main --oneline    # first release; show the full history
fi
```

Read the PR titles. Decide:

- Any new features, behavior changes, removals, or deprecations → minor bump.
- Only fixes (including security) → patch bump.

If you can't decide, default up.

### 2. Open a release PR

From the same checkout of `main`, branch off:

```bash
git checkout -b release/X.Y.Z
```

Edit `CHANGELOG.md`:

- Add a new `## [X.Y.Z] - YYYY-MM-DD` heading directly below `## [Unreleased]`.
- Write entries by distilling the PR titles from step 1 into the categories above.
- Leave `## [Unreleased]` empty (don't delete the heading).
- Update the link footnotes at the bottom of the file so `[X.Y.Z]` points at the compare URL and `[Unreleased]` points at `vX.Y.Z...HEAD`.

Bump the version in `package.json` by editing the `"version"` field directly (don't use `bun pm version` — it refuses on a dirty tree and would race with the CHANGELOG edit). Commit and push:

```bash
git add package.json CHANGELOG.md
git commit -m "vX.Y.Z"
git push -u origin release/X.Y.Z
```

Open the PR. Title: `vX.Y.Z`. Body: paste the new CHANGELOG section.

### 3. Merge, then tag from `main`

After the release PR is approved and merged (squash or merge — both work because the tag is created *after* the merge lands on `main`):

```bash
git checkout main
git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The tag is created on the merge commit, so it's always reachable from `main`.

### 4. Publish the GitHub release

The `.github/workflows/release.yml` workflow fires on tag push, extracts the matching `[X.Y.Z]` section from `CHANGELOG.md`, and publishes a GitHub release automatically. Watch it from the Actions tab and confirm the release page renders correctly.

If you need to publish by hand (workflow disabled, broken, etc.):

```bash
VERSION=X.Y.Z
NOTES=$(mktemp)
awk -v v="$VERSION" '
  $0 ~ "^## \\[" v "\\]" { in_section=1; next }
  in_section && /^## \[/ { exit }
  in_section && /^\[.*\]:/ { exit }
  in_section { print }
' CHANGELOG.md > "$NOTES"
gh release create "v$VERSION" --title "v$VERSION" --notes-file "$NOTES"
rm "$NOTES"
```

Don't use `--generate-notes` — it duplicates work and produces lower-quality notes than the curated CHANGELOG section.

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
