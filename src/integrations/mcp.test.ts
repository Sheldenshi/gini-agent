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

  test("rejects an unhealthy probe-based connector even if a secret is on disk", async () => {
    // Linear is a probe-based provider. A connector that's `configured`
    // but still `health: "unknown"` (probe never ran, or hasn't run yet
    // for a newly-rotated token) must not supply credentials to an MCP
    // header — mirrors the same gate as `resolveSkillEnv` and
    // `isSkillActive`. Prevents a freshly-created bad-token connector
    // from poisoning a working MCP entry.
    const instance = "mcp-resolve-unhealthy-probe";
    const config = makeConfig(instance);
    const ref = writeSecret(instance, "id_linear_unhealthy", "token", "lin_api_BAD");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear_unhealthy", instance, secretRefs: [ref], health: "unknown" }));
    });
    const server = makeServer({ instance });
    const saved = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      await expect(resolveMcpHeaders(config, server)).rejects.toThrow(/Missing credential/);
    } finally {
      if (saved !== undefined) process.env.LINEAR_API_KEY = saved;
    }
  });

  test("does NOT fall back to process.env for connector-bound vars like LINEAR_API_KEY", async () => {
    // Trust property: deleting/disabling a Linear connector while the
    // operator's shell still exports `LINEAR_API_KEY` must NOT keep an
    // auto-registered MCP row authenticated. The MCP row would otherwise
    // bypass the `connector.secret.use` audit and remain functional
    // after the connector is gone.
    const instance = "mcp-resolve-no-env-fallback";
    const config = makeConfig(instance);
    // No connector for linear, but env var is set.
    await mutateState(instance, (state) => {
      state.connectors = [];
    });
    const server = makeServer({ instance });
    const saved = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_FROM_SHELL_SHOULD_BE_IGNORED";
    try {
      await expect(resolveMcpHeaders(config, server)).rejects.toThrow(/Missing credential/);
    } finally {
      if (saved !== undefined) process.env.LINEAR_API_KEY = saved;
      else delete process.env.LINEAR_API_KEY;
    }
  });

  test("permits process.env fallback for vars no provider claims", async () => {
    // Conversely: a user-supplied passthrough header like
    // `MCP-Foo: ${SOME_GENERIC_VAR}` is fair game for process.env
    // fallback, since SOME_GENERIC_VAR is not declared by any provider's
    // envBindings.
    const instance = "mcp-resolve-passthrough";
    const config = makeConfig(instance);
    const ref = writeSecret(instance, "id_linear_pass", "token", "lin_api_pass");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear_pass", instance, secretRefs: [ref] }));
    });
    const server = makeServer({
      instance,
      headers: {
        Authorization: "Bearer ${LINEAR_API_KEY}",
        "X-Custom": "${GINI_TEST_GENERIC_VAR}"
      }
    });
    const saved = process.env.GINI_TEST_GENERIC_VAR;
    process.env.GINI_TEST_GENERIC_VAR = "from-shell";
    try {
      const headers = await resolveMcpHeaders(config, server);
      expect(headers["Authorization"]).toBe("Bearer lin_api_pass");
      expect(headers["X-Custom"]).toBe("from-shell");
    } finally {
      if (saved !== undefined) process.env.GINI_TEST_GENERIC_VAR = saved;
      else delete process.env.GINI_TEST_GENERIC_VAR;
    }
  });
});
