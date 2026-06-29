---
name: yc-cli
description: "Operator's guide to the YC CLI (`yc`) for the Gini batch demo — scoped to the yc commands the demo actually uses: the validated browser-forward login flow (tmux + browser_connect) and investor research against Bookface. Assumes yc is installed but NOT logged in yet. Load before staging or running the demo."
license: MIT
compatibility: "macOS and Linux. Installs the yc CLI if missing (binary at ~/.yc/bin/yc or ~/.local/bin/yc); requires tmux for the login flow."
allowed-tools: "terminal_exec browser_connect browser_navigate"
metadata:
  gini:
    version: 1.0.0
    author: Sheldon + Wilson
    platforms: [macos, linux]
    prerequisites:
      commands: [yc, tmux]
---

# YC CLI (`yc`) — demo operator's guide

`yc` is the Y Combinator CLI; it talks to **Bookface** over an authenticated
API. In our demo it's the **investor-research source** behind Step 5: pulling a
fund's track record (check size, YC conversion, recent deals) from the terminal.
This guide covers only the parts the demo touches.

## 0. Install + PATH (do this first)

Before using `yc`, check whether it's installed and decide whether to install
it — you (the agent) own this judgment; don't blindly run an install.

1. **Check if it's available.** Put the usual install locations on PATH first,
   since the binary often isn't there in a non-interactive shell, then look:
   ```bash
   export PATH="$HOME/.yc/bin:$HOME/.local/bin:$PATH"
   yc --version   # or: ycp --version
   ```
   If that prints a version, it's installed — skip to login. If it errors with
   "command not found", continue.

2. **Confirm it's genuinely missing, not just off PATH.** A bare `yc` can fail
   just because PATH wasn't set. Before installing, verify the binary truly
   isn't on disk (e.g. check `~/.yc/bin/yc` and `~/.local/bin/yc`). Only if it's
   actually absent do you install.

3. **Install only when missing:**
   ```bash
   curl -fsSL https://bookface.ycombinator.com/cli/install.sh | bash
   ```
   Then re-export PATH (step 1) so the current shell sees the new binary, and
   re-run `yc --version` to confirm.

Notes:
- If an existing `yc` command was detected at install time, the CLI may be
  installed as **`ycp`** instead — try `ycp` if `yc` is absent.
- Non-interactive SSH shells don't source `~/.zshrc`, so set the
  `export PATH=...` line at the top of any script before calling `yc`.

## 1. The optimal login flow (VALIDATED — use this)

We are NOT logged in yet. This is the flow we rehearsed to convergence — it's
the demo's Step 5 trust beat: the agent forwards its browser to the user, the
user signs in on their own device, the agent never sees the password. `yc login`
spins a local callback listener on `localhost:19876`; the agent's forwarded
browser can't reach that localhost, so we keep `yc login` alive in **tmux** and
let the CLI catch the callback directly while the user signs in.

> **Keep tmux backstage — do NOT mention it to the user.** tmux is an
> implementation detail of how we hold the login process open; it is not part
> of the story. In user-facing messages, say things like "starting the YC
> login" and "opening the sign-in page for you," never "spinning up a tmux
> session," "capturing the pane," or "sending keys to tmux." Run the tmux
> commands silently and narrate only the user-meaningful beats: login started →
> here's your sign-in → you're signed in. Same for the demo: the audience sees
> a clean sign-in hand-off, not terminal plumbing.

**4 steps, no redundancy:**

1. **Parallel logout** — clear both the CLI and the YC browser session:
   ```bash
   yc logout
   ```
   and in the same turn `browser_navigate` to the YC logout/session-clear URL so
   the next sign-in is fresh (no silent reuse of an existing Google session).

2. **tmux + grab the OAuth URL in one shot.** Long URLs wrap in the pane, so
   capture with `-J` (join wrapped lines) or you'll get a truncated URL:
   ```bash
   tmux kill-session -t yclogin 2>/dev/null; tmux new-session -d -s yclogin
   tmux send-keys -t yclogin 'export PATH="$HOME/.yc/bin:$HOME/.local/bin:$PATH"; yc login' Enter
   sleep 2
   tmux capture-pane -t yclogin -p -J | grep -o 'https://[^ ]*'
   ```

3. **`browser_navigate` + `browser_connect`** — open that OAuth URL and hand off
   to the user to sign in. The CLI's listener on `localhost:19876` receives the
   callback **directly** once they authorize — no manual code extraction, no
   pasting a redirect URL back.

4. **Confirm:**
   ```bash
   tmux capture-pane -t yclogin -p -J | grep -i successful
   yc me     # should print the founder + company, e.g. "Gini Agent (S26)"
   ```

Why tmux: a bare `yc login` over a non-interactive shell dies when the call
returns; tmux keeps the process alive to catch the callback. The `browser_requests`
inspection step is **not needed** — the localhost callback fires on its own.

### Fallbacks (only if the above stalls)
- `yc login --device` — prints a URL + code; user authenticates on another
  device. Cleanest when browser-forward is flaky, but it's NOT what we rehearsed.
- `yc login --manual` — prints the auth URL, takes the redirect URL pasted back.
- Token lives in `~/.yc/credentials.json` and refreshes automatically. If
  `yc me` already shows the right founder, do NOT re-run login.

## 2. The investor lookup (the yc beat of the demo)

Feeds Step 5. Always `--json` + a small `limit` — investor results are **huge**
(each fund embeds its full partner roster + deal history), so an unbounded call
stalls on stage.

```bash
yc search "<fund name>" --type investors        # human: columns id,link,type,users,investments
yc tools run search --input '{"entity":"investors","query":"<fund>","limit":3}'   # structured — PREFER live
```

- Pin the **exact query and fund name** during staging; confirm clean fields
  (check size, conversion, recent deals). The "accurate, not fragile" check.
- Investor research is the **high-latency step** — pre-warm it or run it while
  narrating the plan view, never into silence.
- Real-vs-fixture is decided ahead of time; if going real via `yc`, keep a
  seeded fixture as the pre-recorded fallback.

## 2a. Investor profile — required output format

When the user asks for an **investor profile**, gather the data with the three
commands below, then present it in EXACTLY the markdown format that follows.

### Data-gathering commands

```bash
# 1. Identity, bio, education, followers (profile tool, by user_id)
yc tools run profile --input '{"action":"get","user_id":{user_id}}'

# 2. Ratings, stats, tags, and portfolio company IDs
yc search "{investor_name}" --type investors --json

# 3. Bulk batch breakdown (IDs extracted from command 2's results)
yc tools run search --input '{"entity":"companies","ids":"{comma_separated_ids}"}'
```

### Required output format

```
# {investor_name}
> {tag_1} · {tag_2} · {tag_3} · ...

| Field | Value |
|---|---|
| **Location** | {location} |
| **LinkedIn** | {linkedin_url} |
| **Background** | {background} |
| **Education** | {education} |
| **Followers** | {followers} |

| Rating | Score |
|---|---|
| **YC Rating** | {yc_rating} |
| **Founder Rating** | {founder_rating} |

| Metric | Value |
|---|---|
| **Fund Type** | {fund_type} |
| **Total Investments** | {total_investments} |
| **YC Seed Investments** | {yc_seed_investments} |
| **Series A Leads** | {series_a_leads} |
| **Invests Internationally** | {invests_internationally} |

| Batch | # | Companies |
|---|---|---|
| {batch_1} | {count_1} | {companies_1} |
| {batch_2} | {count_2} | {companies_2} |
| {batch_3} | {count_3} | {companies_3} |
| {batch_4} | {count_4} | {companies_4} |
| {batch_5} | {count_5} | {companies_5} |
```

## 3. Other commands the demo might touch

```bash
yc me                              # who am I (verify auth)     | add --json
yc search "<q>" --type companies   # company lookups            | --type founders|deals|...
yc agent "<question>"              # ask the YC agent (streams)  | add --json
yc skills read <name>              # load a YC playbook by name
```

- `yc <cmd> --help` for exact current syntax — don't guess flags on stage.
- Batch filters use short names (`W25`, `S26`), never long form (`w2025`).

## 4. Logout — FULL logout means BOTH steps (always)

When the user mentions logging out of `yc` (for any reason), **always perform both steps in the same turn, without exception**:

1. **CLI logout** — clears stored credentials:
   ```bash
   export PATH="$HOME/.yc/bin:$HOME/.local/bin:$PATH"
   yc logout
   ```

2. **Browser session logout** — navigates to clear the active YC/Bookface session:
   ```bash
   browser_navigate("https://bookface.ycombinator.com/signout")
   ```
   If the page redirects to a login screen, the session is cleared. If it requires interaction, use `browser_connect` to hand off to the user.

A partial logout (CLI only, or browser only) leaves credentials or session tokens active and the user is NOT fully logged out. Both steps are required every time. Never report logout as complete until both have been executed.

## Don'ts
- Don't run the install script reflexively — check `yc --version` first, set PATH, and confirm the binary is genuinely absent before installing.
- Don't mention tmux (or pane-capture / send-keys) in user-facing messages — run it silently, narrate only login started → sign-in → signed in.
- Don't run a bare `yc login` outside tmux on the demo Mac — it dies before the callback lands.
- Don't re-run login if `yc me` already shows the right founder — it rewrites credentials for nothing.
- Don't make an unbounded `--type investors` call live — always `--json` + small `limit`.
- Don't forget `capture-pane -J` — without it the OAuth URL truncates at the pane width.
- Don't do a partial logout — if the user mentions logging out of `yc`, always run BOTH the CLI logout AND the browser session logout in the same turn, no exceptions.
- Don't report logout as done after only one step — confirm both the CLI and browser steps completed before telling the user they're logged out.
