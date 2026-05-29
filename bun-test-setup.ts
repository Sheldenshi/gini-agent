import { jest } from "bun:test";

// bun's bunfig.toml has no `[test] timeout` key (only the --timeout CLI flag
// and the per-test third arg exist), so the global default test timeout is set
// here and wired in via `[test] preload` in bunfig.toml. Any test exceeding 10s
// fails — a regression guard against the slow paths just removed (real model
// loads, CDP probe timeouts, full-tick poll waits). A test that legitimately
// needs longer can still override via the third arg to test().
jest.setTimeout(10000);
