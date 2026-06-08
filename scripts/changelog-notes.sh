#!/usr/bin/env bash
# Print the CHANGELOG.md section body for a given version to stdout.
#
# Usage: scripts/changelog-notes.sh <version>      # e.g. 0.3.0 (no leading "v")
#
# Reads the repo's CHANGELOG.md, finds the `## [<version>]` heading, and prints
# everything under it up to the next version heading or the link-footnote block.
# Exits 0 with empty output if the section is missing; callers decide whether
# that is fatal. Single-sourced so the release workflows and the docs agree on
# exactly what the GitHub release notes contain.
set -euo pipefail

version="${1:?usage: changelog-notes.sh <version>}"
changelog="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CHANGELOG.md"

awk -v v="$version" '
  $0 ~ "^## \\[" v "\\]" { in_section = 1; next }
  in_section && /^## \[/ { exit }
  in_section && /^\[.*\]:/ { exit }
  in_section { print }
' "$changelog"
