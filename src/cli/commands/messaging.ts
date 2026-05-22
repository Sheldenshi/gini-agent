import type { CliContext } from "../context";
import { parseSubArgs, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

const ADD_VALUE_FLAGS = new Set(["--bot-token"]);

export async function messaging(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const tail = restAfter(cliArgs, sub);
    const parsed = parseSubArgs(tail, ADD_VALUE_FLAGS);
    const [name, kind = "demo", ...targets] = parsed.positional;
    if (!name) {
      throw new Error(
        "Usage: gini messaging add <name> [kind] [delivery-targets...] [--bot-token <token>]"
      );
    }
    const body: Record<string, unknown> = { name, kind, deliveryTargets: targets };
    if (parsed.flags["--bot-token"]) body.botToken = parsed.flags["--bot-token"];
    const bridge = await api(config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify(body)
    });
    print(bridge);
    printPairingHint(bridge);
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name>`);
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "pair") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini messaging pair <bridge-id-or-name>");
    const bridge = await api(config, `/api/messaging/${encodeURIComponent(id)}/pair`, { method: "POST" });
    print(bridge);
    printPairingHint(bridge);
    return;
  }
  if (sub === "receive" || sub === "send") {
    // CLI parses positional args plus a `--target <id>` flag. The
    // target defaults to "local" for demo bridges; Telegram and
    // Discord callers need to pass the real chat / channel id
    // because the receive/send pipelines validate it per-kind and
    // a literal "local" string would produce a "Telegram inbound
    // target must be a numeric chat_id (got 'local')" or
    // "Discord inbound target (channel id) is required" error.
    const tail = restAfter(cliArgs, sub);
    const parsed = parseSubArgs(tail, new Set(["--target"]));
    const [id, ...textParts] = parsed.positional;
    if (!id || textParts.length === 0) {
      throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name> <text> [--target <id>]`);
    }
    const target = parsed.flags["--target"] ?? "local";
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, {
      method: "POST",
      body: JSON.stringify({ text: textParts.join(" "), target })
    }));
    return;
  }
  if (sub === "messages") {
    const id = restAfter(cliArgs, sub)[0];
    print(await api(config, id ? `/api/messaging/${encodeURIComponent(id)}/messages` : "/api/messaging/messages"));
    return;
  }
  if (sub === "allow" || sub === "deny" || sub === "reject-pending") {
    const [id, chatIdStr] = restAfter(cliArgs, sub);
    if (!id || !chatIdStr) {
      throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name> <chat-id>`);
    }
    const chatId = Number(chatIdStr);
    if (!Number.isFinite(chatId)) {
      throw new Error(`chat-id must be a number (got '${chatIdStr}'). Negative ids are valid for groups.`);
    }
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, {
      method: "POST",
      body: JSON.stringify({ chatId })
    }));
    return;
  }
  if (sub === "chats") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini messaging chats <bridge-id-or-name>");
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/chats`));
    return;
  }
  print(await api(config, "/api/messaging"));
}

// Surfaced after `gini messaging add` (telegram-kind) and `gini
// messaging pair`. The bridge record already carries the code, but
// users skim the JSON output — a separate line with the code and a
// short instruction makes the next step obvious.
function printPairingHint(bridge: unknown): void {
  if (!bridge || typeof bridge !== "object") return;
  const meta = (bridge as { metadata?: { pairingCode?: unknown; pairingCodeExpiresAt?: unknown; botUsername?: unknown } }).metadata;
  if (!meta || typeof meta !== "object") return;
  const code = typeof meta.pairingCode === "string" ? meta.pairingCode : undefined;
  if (!code) return;
  const expiresRaw = typeof meta.pairingCodeExpiresAt === "string" ? meta.pairingCodeExpiresAt : undefined;
  const handle = typeof meta.botUsername === "string" ? `@${meta.botUsername}` : "your bot";
  const expiresHint = expiresRaw
    ? ` Expires at ${expiresRaw}.`
    : "";
  // eslint-disable-next-line no-console
  console.log(`\nPairing code: ${code}\nDM ${handle} on Telegram with that message to enroll your chat.${expiresHint}`);
}
