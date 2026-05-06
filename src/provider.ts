import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MemoryRecord, ProviderConfig, ProviderResult, RuntimeConfig } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_CODEX_AUTH_PATH = "~/.codex/auth.json";

export function providerHealth(config: RuntimeConfig) {
  const provider = normalizeProvider(config.provider);
  if (provider.name === "echo") {
    return {
      ok: true,
      provider,
      configured: true,
      message: "Echo provider is deterministic and does not require credentials."
    };
  }

  if (provider.name === "codex") {
    const credentials = readCodexCredentials(provider);
    return {
      ok: credentials.ok,
      provider,
      configured: credentials.ok,
      authPath: credentials.authPath,
      credentialType: credentials.credentialType,
      message: credentials.ok
        ? `Codex credentials are available from ${credentials.authPath}.`
        : credentials.message
    };
  }

  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const configured = Boolean(process.env[envName]);
  return {
    ok: configured,
    provider,
    configured,
    message: configured ? "OpenAI provider key is present." : `Set ${envName} to use the OpenAI provider.`
  };
}

export async function generateTaskSummary(config: RuntimeConfig, input: string, memories: MemoryRecord[]): Promise<ProviderResult> {
  const provider = normalizeProvider(config.provider);
  if (provider.name === "echo") {
    const memoryText = memories.length > 0 ? ` Active memory: ${memories.map((memory) => memory.content).join(" | ")}` : "";
    return {
      provider,
      text: `Gini handled: ${input}${memoryText}`
    };
  }

  return callOpenAI(provider, input, memories);
}

export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  if (provider.name === "openai") {
    return {
      name: "openai",
      model: provider.model || "gpt-5.4-mini",
      baseUrl: provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
      apiKeyEnv: provider.apiKeyEnv ?? "OPENAI_API_KEY"
    };
  }
  if (provider.name === "codex") {
    return {
      name: "codex",
      model: provider.model || DEFAULT_CODEX_MODEL,
      baseUrl: provider.baseUrl ?? DEFAULT_CODEX_BASE_URL,
      apiKeyEnv: provider.apiKeyEnv
    };
  }
  return {
    name: "echo",
    model: provider.model || "gini-echo-v0"
  };
}

async function callOpenAI(provider: ProviderConfig, input: string, memories: MemoryRecord[]): Promise<ProviderResult> {
  const bearer = provider.name === "codex" ? readCodexBearer(provider) : readOpenAIBearer(provider);
  const headers = provider.name === "codex" ? codexHeaders(bearer) : {};

  const memoryBlock = memories.length > 0
    ? memories.map((memory) => `- (${memory.scope}) ${memory.content}`).join("\n")
    : "No active memories.";

  const isCodex = provider.name === "codex";
  const response = await fetch(`${provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: isCodex ? "text/event-stream" : "application/json",
      ...headers
    },
    body: JSON.stringify({
      model: provider.model,
      store: false,
      stream: isCodex,
      instructions: [
        "You are Gini, a local-first personal agent runtime.",
        "Return a concise task summary for the control plane.",
        "Do not claim to have performed side effects. Risky side effects are handled by tools and approvals."
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Active memories:\n${memoryBlock}\n\nTask:\n${input}`
            }
          ]
        }
      ]
    })
  });

  if (isCodex) {
    return readCodexStream(response, provider);
  }

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `OpenAI API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    throw new Error(error);
  }

  return {
    provider,
    text: extractOutputText(payload) || "The model returned no text output.",
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined
  };
}

async function readCodexStream(response: Response, provider: ProviderConfig): Promise<ProviderResult> {
  const raw = await response.text();
  if (!response.ok) {
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Codex API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    throw new Error(error);
  }

  const events = parseSseEvents(raw);
  const deltaTextParts: string[] = [];
  const finalTextParts: string[] = [];
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const event of events) {
    const payload = parseJsonObject(event.data);
    if (!responseId && typeof payload.response_id === "string") responseId = payload.response_id;
    if (!responseId && isRecord(payload.response) && typeof payload.response.id === "string") responseId = payload.response.id;
    if (isRecord(payload.response) && isRecord(payload.response.usage)) usage = payload.response.usage;
    if (typeof payload.delta === "string") deltaTextParts.push(payload.delta);
    if (isRecord(payload.item) && Array.isArray(payload.item.content)) {
      for (const content of payload.item.content) {
        if (isRecord(content) && typeof content.text === "string") finalTextParts.push(content.text);
      }
    }
  }

  const text = (deltaTextParts.length > 0 ? deltaTextParts.join("") : finalTextParts.join("")).trim();
  if (!text) {
    throw new Error("Codex stream completed without text output.");
  }

  return {
    provider,
    text,
    responseId,
    usage
  };
}

function parseSseEvents(raw: string): Array<{ event?: string; data: string }> {
  return raw
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLines = lines.filter((line) => line.startsWith("data:"));
      return {
        event: eventLine?.slice("event:".length).trim(),
        data: dataLines.map((line) => line.slice("data:".length).trim()).join("\n")
      };
    })
    .filter((event) => event.data && event.data !== "[DONE]");
}

function codexHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0 (Gini Agent)",
    originator: "codex_cli_rs"
  };
  const accountId = chatgptAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

function chatgptAccountId(accessToken: string): string | undefined {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = isRecord(decoded["https://api.openai.com/auth"]) ? decoded["https://api.openai.com/auth"] : undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readOpenAIBearer(provider: ProviderConfig): string {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(`OpenAI provider is configured but ${envName} is not set.`);
  }
  return apiKey;
}

function readCodexBearer(provider: ProviderConfig): string {
  const credentials = readCodexCredentials(provider);
  if (!credentials.ok || !credentials.bearer) {
    throw new Error(credentials.message);
  }
  return credentials.bearer;
}

function readCodexCredentials(provider: ProviderConfig): {
  ok: boolean;
  bearer?: string;
  authPath: string;
  credentialType?: "api_key" | "access_token";
  message: string;
} {
  const authPath = codexAuthPath(provider);
  if (!existsSync(authPath)) {
    return {
      ok: false,
      authPath,
      message: `No Codex credentials found at ${authPath}. Run codex --login or set CODEX_AUTH_JSON.`
    };
  }

  try {
    const raw = readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : undefined;
    if (apiKey) {
      return {
        ok: true,
        bearer: apiKey,
        authPath,
        credentialType: "api_key",
        message: "Codex generated API key is available."
      };
    }

    const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
    const accessToken = tokens && typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    if (accessToken) {
      return {
        ok: true,
        bearer: accessToken,
        authPath,
        credentialType: "access_token",
        message: "Codex OAuth access token is available."
      };
    }

    return {
      ok: false,
      authPath,
      message: `Codex auth file exists at ${authPath}, but it does not contain OPENAI_API_KEY or tokens.access_token.`
    };
  } catch (error) {
    return {
      ok: false,
      authPath,
      message: `Could not read Codex credentials at ${authPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function codexAuthPath(provider: ProviderConfig): string {
  const raw = provider.apiKeyEnv && process.env[provider.apiKeyEnv]
    ? process.env[provider.apiKeyEnv]
    : process.env.CODEX_AUTH_JSON ?? DEFAULT_CODEX_AUTH_PATH;
  const path = raw ?? DEFAULT_CODEX_AUTH_PATH;
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentItem of content) {
      if (isRecord(contentItem) && typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function readOpenAIError(payload: Record<string, unknown>): string | undefined {
  if (!isRecord(payload.error)) return undefined;
  return typeof payload.error.message === "string" ? payload.error.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
