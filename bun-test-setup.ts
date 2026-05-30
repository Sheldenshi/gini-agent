import { jest } from "bun:test";

// bun's bunfig.toml has no `[test] timeout` key (only the --timeout CLI flag
// and the per-test third arg exist), so the global default test timeout is set
// here and wired in via `[test] preload` in bunfig.toml. Any test exceeding 10s
// fails — a regression guard against the slow paths just removed (real model
// loads, CDP probe timeouts, full-tick poll waits). A test that legitimately
// needs longer can still override via the third arg to test().
jest.setTimeout(10000);

// Tunnel enable resolves a cloudflared binary via ensureCloudflaredBin(),
// which would otherwise scan PATH and, failing that, download the binary from
// GitHub on first use. Pin an always-present executable as the operator
// override so the resolver short-circuits without touching PATH or the
// network in any test — keeping the suite hermetic whether or not cloudflared
// is installed on the host (CI runners generally don't have it). Tests that
// exercise the resolver itself pass explicit `envOverride` deps to neutralize
// this. macOS and Linux both ship /bin/echo as an executable.
process.env.GINI_CLOUDFLARED_BIN = "/bin/echo";
