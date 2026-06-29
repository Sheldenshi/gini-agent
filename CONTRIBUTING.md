# Contributing to Gini Agent

Thanks for your interest in contributing. This guide covers the basics for outside contributors. Repository-wide conventions live in [`AGENTS.md`](AGENTS.md); please read that first.

## Reporting issues

- **Bugs**: open an issue using the Bug Report template. Include OS, Bun version, instance name, and relevant `~/.gini/instances/<instance>/logs/` output.
- **Security vulnerabilities**: do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Feature ideas**: open an issue using the Feature Request template, or browse [`ROADMAP.md`](ROADMAP.md) first.

## Development setup

Prerequisites: [Bun](https://bun.sh) (latest), Git, macOS or Linux.

```bash
git clone https://github.com/Open-Curiosity/gini-agent
cd gini-agent
bun install
bun run gini install
bun run gini start
```

Each repo worktree gets an isolated instance derived from the directory name, so you can run multiple checkouts in parallel without colliding with the installed `default` instance. See [`README.md`](README.md#from-source) for details.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Make your change. Prefer editing existing files and following nearby patterns.
3. Update or add an ADR under `docs/adr/` if you're changing architecture — see [AGENTS.md](AGENTS.md#adrs).
4. Run the verification commands below.
5. Open a PR against `main` using the PR template.

### Branch names

Use `<type>/<kebab-case-topic>`, where `<type>` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, or `test`. Examples: `feat/profile-switcher`, `fix/chat-title-overflow`, `docs/release-process`.

## Verification

Before opening a PR:

```bash
bun run typecheck
bun test
bun run gini smoke
```

For UI changes, exercise the affected screen in a browser. Typecheck and unit tests don't catch broken layouts or regressed flows.

For docs-only changes, sweep for stale links and terminology:

```bash
rg -n "v0|v1|v2|v3|lane|v1-readiness|single HTML|src/state\\.ts|src/api" README.md docs
```

## Commit and PR messages

Describe the technical change, not the process that produced it. See [AGENTS.md](AGENTS.md#commits-and-pr-titles) for examples of what to write and what to avoid.

If you iterate with multiple review-fix commits, squash to a clean narrative before merging.


## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
