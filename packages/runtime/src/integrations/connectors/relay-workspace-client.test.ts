import { describe, expect, test } from "bun:test";
import {
  RELAY_WORKSPACE_CLIENT,
  buildAuthorizedUserCredential
} from "./relay-workspace-client";

describe("RELAY_WORKSPACE_CLIENT", () => {
  test("carries the Desktop client id and secret", () => {
    expect(RELAY_WORKSPACE_CLIENT.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(RELAY_WORKSPACE_CLIENT.clientSecret).toMatch(/^GOCSPX-/);
  });
});

describe("buildAuthorizedUserCredential", () => {
  test("produces the standard gws authorized_user shape with the default client", () => {
    const parsed = JSON.parse(buildAuthorizedUserCredential("rt-123")) as Record<string, string>;
    expect(parsed).toEqual({
      type: "authorized_user",
      client_id: RELAY_WORKSPACE_CLIENT.clientId,
      client_secret: RELAY_WORKSPACE_CLIENT.clientSecret,
      refresh_token: "rt-123"
    });
  });

  test("uses an injected client when provided", () => {
    const parsed = JSON.parse(
      buildAuthorizedUserCredential("rt-xyz", { clientId: "cid", clientSecret: "csec" })
    ) as Record<string, string>;
    expect(parsed).toEqual({
      type: "authorized_user",
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt-xyz"
    });
  });
});
