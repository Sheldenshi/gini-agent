import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mutateState } from "../state";
import { writeSecret } from "../state/secrets";
import type { ConnectorRecord, McpServerRecord, RuntimeConfig } from "../types";
import { resolveMcpHeaders } from "./mcp";

const ROOT = "/tmp/gini-mcp-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo" as const, model: "echo" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

function newConnector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_linear",
    instance: "dev",
    name: "linear",
    provider: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

function makeServer(overrides: Partial<McpServerRecord>): McpServerRecord {
  return {
    id: "mcp_linear",
    instance: "dev",
    name: "linear",
    command: "",
    args: [],
    envKeys: [],
    status: "configured",
    exposedTools: [],
    createdAt: "",
    updatedAt: "",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    headers: {
      Authorization: "Bearer ${LINEAR_API_KEY}",
      "MCP-Protocol-Version": "2025-06-18"
    },
    ...overrides
  };
}

describe("resolveMcpHeaders", () => {
  test("substitutes ${LINEAR_API_KEY} from a configured connector", async () => {
    const instance = "mcp-resolve-ok";
    const config = makeConfig(instance);
    const ref = writeSecret(instance, "id_linear_ok", "token", "lin_api_FAKE_FOR_TESTS");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear_ok", instance, secretRefs: [ref] }));
    });
    const server = makeServer({ instance });
    const headers = await resolveMcpHeaders(config, server);
    expect(headers["Authorization"]).toBe("Bearer lin_api_FAKE_FOR_TESTS");
    expect(headers["MCP-Protocol-Version"]).toBe("2025-06-18");
  });

  test("throws missing-credential when no connector exists", async () => {
    const instance = "mcp-resolve-missing";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      // No linear connector here.
      state.connectors = [];
    });
    const server = makeServer({ instance });
    // Strip a process.env fallback so the test doesn't accidentally pick up
    // the developer's exported LINEAR_API_KEY and resolve the placeholder.
    const saved = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      await expect(resolveMcpHeaders(config, server)).rejects.toThrow(/Missing credential/);
    } finally {
      if (saved !== undefined) process.env.LINEAR_API_KEY = saved;
    }
  });

  test("returns empty when the server has no headers", async () => {
    const instance = "mcp-resolve-empty";
    const config = makeConfig(instance);
    const server = makeServer({ instance, headers: undefined });
    const headers = await resolveMcpHeaders(config, server);
    expect(headers).toEqual({});
  });
});
