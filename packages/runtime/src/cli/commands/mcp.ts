import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function mcp(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const tail = restAfter(cliArgs, sub);
    const { name, command, args, url, headers } = parseAddArgs(tail);
    if (!name) throw new Error("Usage: gini mcp add <name> [<command> [args...]] [--url <url>] [--header 'Key: Value']");
    if (!url && !command) throw new Error("gini mcp add: supply either --url <url> for http MCP or a <command> for stdio.");
    const payload: Record<string, unknown> = { name, exposedTools: [] };
    if (url) {
      payload.url = url;
      payload.transport = "http";
      if (headers) payload.headers = headers;
    } else {
      payload.command = command;
      payload.args = args;
    }
    print(await api(config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini mcp ${sub} <server-id-or-name>`);
    print(await api(config, `/api/mcp/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "invoke") {
    const [id, toolName, ...payloadParts] = restAfter(cliArgs, sub);
    if (!id || !toolName) throw new Error("Usage: gini mcp invoke <server-id-or-name> <tool-name> [json-input]");
    const input = payloadParts.length > 0 ? JSON.parse(payloadParts.join(" ")) : {};
    print(await api(config, `/api/mcp/${encodeURIComponent(id)}/invoke`, {
      method: "POST",
      body: JSON.stringify({ toolName, input })
    }));
    return;
  }
  print(await api(config, "/api/mcp"));
}

// Hand-rolled parser: parseSubArgs collapses repeated flags into one value,
// but `--header` is repeatable. We sweep linearly, pulling `--url` and
// `--header` out, and treat anything else positional as <name> + <command>
// + <args...> for the stdio path.
function parseAddArgs(tokens: string[]): { name?: string; command?: string; args: string[]; url?: string; headers?: Record<string, string> } {
  const positional: string[] = [];
  const headers: Record<string, string> = {};
  let url: string | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "--url") {
      url = tokens[i + 1];
      if (!url) throw new Error("Flag --url requires a value.");
      i += 1;
      continue;
    }
    if (token === "--header") {
      const value = tokens[i + 1];
      if (!value) throw new Error("Flag --header requires a value of the form 'Key: Value'.");
      const colon = value.indexOf(":");
      if (colon <= 0) throw new Error(`Invalid --header '${value}'. Expected 'Key: Value'.`);
      const key = value.slice(0, colon).trim();
      const headerValue = value.slice(colon + 1).trim();
      if (!key) throw new Error(`Invalid --header '${value}': missing key.`);
      headers[key] = headerValue;
      i += 1;
      continue;
    }
    positional.push(token);
  }
  const [name, command, ...args] = positional;
  return {
    name,
    command,
    args,
    url,
    headers: Object.keys(headers).length > 0 ? headers : undefined
  };
}
