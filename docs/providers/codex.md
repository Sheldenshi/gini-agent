# Codex

Codex is an OAuth/CLI provider. Gini does not store Codex credentials: auth
lives in your host install — `~/.codex/auth.json` (written by `codex login`), or
the `OPENAI_API_KEY` environment variable as an alternative. The runtime reads
whichever is present on each turn and writes nothing to Gini config.

Because the token is owned by the Codex CLI, there is no key field in
**Settings → Providers** for Codex. Re-authentication happens in a terminal.

## Re-authentication

When a chat turn fails with `Codex authentication failed` (the underlying
provider message is usually `Provided authentication token is expired. Please
try signing in again.`), refresh the token:

1. Open a terminal.
2. Run `codex`.
3. Type `/logout` and press Enter. This signs you out and ends the session.
4. Run `codex` again. It prompts you to sign in.
5. Complete the sign-in in the browser. Codex writes the refreshed token to
   `~/.codex/auth.json`; Gini picks it up on the next chat turn — no gateway
   restart needed.

### If you authenticate with `OPENAI_API_KEY` instead

If your Codex install uses `OPENAI_API_KEY` rather than OAuth, update that
environment variable with a valid key and restart the gateway
(`gini stop` / `gini run`) so the new value is read.
