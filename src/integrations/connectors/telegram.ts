// Telegram bot connector. Stores the bot token as an encrypted secret per
// ADR connector-secret-storage.md; the probe hits the Bot API `getMe`
// endpoint (cheapest authenticated call) to confirm the token works and
// extracts the bot username for display.
//
// The same token is used by every telegram messaging bridge that
// references this connector — resolveConnectorSecret(config, connectorId,
// "token") returns the plaintext for per-call HTTP work and never lands
// in audit evidence or trace data.

import type { ProviderModule } from "./types";

export interface TelegramProbeOk {
  ok: true;
  bot: { id: number; username: string; firstName?: string };
}

export interface TelegramProbeFail {
  ok: false;
  error: string;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

// Build the bot API URL from a token. Centralized so every caller uses
// the same shape; the token is interpolated into the path because that's
// what the Bot API expects (the entire path is sensitive — we never log
// the URL string, only the host + method).
export function telegramApiUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

export async function probeTelegram(token: string): Promise<TelegramProbeOk | TelegramProbeFail> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(telegramApiUrl(token, "getMe"), {
      method: "GET",
      signal: controller.signal
    });
    if (response.status === 401) {
      return { ok: false, error: "Telegram rejected the bot token (HTTP 401). Rotate it via connectors." };
    }
    if (!response.ok) {
      return { ok: false, error: `Telegram API returned HTTP ${response.status}` };
    }
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string; first_name?: string };
      description?: string;
    };
    if (!payload.ok || !payload.result?.id || !payload.result.username) {
      return { ok: false, error: payload.description ?? "Telegram getMe returned no bot data." };
    }
    return {
      ok: true,
      bot: {
        id: payload.result.id,
        username: payload.result.username,
        firstName: payload.result.first_name
      }
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Telegram probe timed out after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export const telegramProvider: ProviderModule = {
  id: "telegram",
  label: "Telegram",
  description: "Drive a Telegram bot via long polling. Requires a bot token from @BotFather.",
  fields: [
    {
      name: "token",
      label: "Bot token",
      description: "Create a bot with @BotFather and paste the token (looks like 12345:ABC...).",
      secret: true,
      required: true,
      placeholder: "12345:ABC..."
    }
  ],
  secrets: {
    purposes: ["token"],
    // Telegram has no canonical environment variable to expose to skills;
    // the only consumer is the bridge poller, which resolves the secret
    // directly through resolveConnectorSecret rather than reading env.
    envBindings: {}
  },
  async probe(ctx) {
    const token = await ctx.resolveSecret("token");
    if (!token) return { ok: false, message: "Missing bot token secret." };
    const result = await probeTelegram(token);
    return result.ok
      ? { ok: true, message: `Authenticated as @${result.bot.username}` }
      : { ok: false, message: result.error };
  }
};
