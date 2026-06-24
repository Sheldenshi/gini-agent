# Requesty

Requesty is an OpenAI-compatible API-key provider that routes a single key to
models from many vendors. Gini talks to `https://router.requesty.ai/v1` and
authenticates with a Bearer key.

## Step 1 — Get an API key

1. Sign in at [requesty.ai](https://requesty.ai/).
2. Create a key on the [API keys page](https://app.requesty.ai/api-keys) and copy it.
3. Add credit (Requesty is pay-as-you-go and bills per model). See the
   [Requesty docs](https://docs.requesty.ai/) for the model catalog.

See the [Requesty docs](https://docs.requesty.ai/) for the full API reference.

## Step 2 — Set the key

Gini reads the key from the `REQUESTY_API_KEY` environment variable. Set it in
your shell or in `~/.gini/secrets.env` for persistence:

```bash
# ~/.gini/secrets.env  (created mode 0600)
REQUESTY_API_KEY=rqsty-sk-...
```

The web Add Provider form writes this for you.

## Step 3 — Configure the provider in Gini

### CLI

```bash
gini provider set requesty openai/gpt-4o-mini
```

Requesty uses `provider/model` slugs (e.g. `openai/gpt-4o-mini`,
`anthropic/claude-opus-4-8`). The base URL defaults to
`https://router.requesty.ai/v1`; override it only for a proxy with `--base-url`.

### Web

Open **Settings → Add provider → Requesty**, paste the key, and pick or type a
model slug.

## Re-authentication

Requesty is an API-key provider, so a credential failure surfaces Requesty's own
message and links to **Settings → Providers** to paste a new key. Rotate keys on
the [API keys page](https://app.requesty.ai/api-keys). See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
