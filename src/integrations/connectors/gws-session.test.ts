import { describe, expect, test } from "bun:test";
import { parseGwsAuthStatus } from "./gws-session";

// parseGwsAuthStatus is the pure half of gwsSessionStatus (the subprocess
// boundary is isolated in the cached async wrapper). These tests pin the
// liveness derivation: signedIn := token_valid===true, clientConfigured :=
// client_config_exists===true, and the human message for each state.

describe("parseGwsAuthStatus", () => {
  test("signed in when token_valid is true", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: true, has_refresh_token: true })
    );
    expect(status).toEqual({
      installed: true,
      clientConfigured: true,
      signedIn: true,
      message: "Signed in to Google"
    });
  });

  test("provisioned but expired session → needs re-auth", () => {
    // The live fixture: client creds present, user token expired.
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: false,
        token_error: "reauth related error (invalid_rapt)",
        has_refresh_token: true
      })
    );
    expect(status.installed).toBe(true);
    expect(status.clientConfigured).toBe(true);
    expect(status.signedIn).toBe(false);
    expect(status.message).toBe("Google sign-in expired — re-auth needed");
  });

  test("no client config and no valid token → sign-in needed", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: false, token_valid: false })
    );
    expect(status).toEqual({
      installed: true,
      clientConfigured: false,
      signedIn: false,
      message: "Google sign-in needed"
    });
  });

  test("non-JSON output (gws missing / errored) → not installed", () => {
    const status = parseGwsAuthStatus("zsh: command not found: gws\n");
    expect(status).toEqual({
      installed: false,
      clientConfigured: false,
      signedIn: false,
      message: "gws not installed"
    });
  });

  test("empty output → not installed", () => {
    expect(parseGwsAuthStatus("").signedIn).toBe(false);
    expect(parseGwsAuthStatus("").installed).toBe(false);
  });

  test("JSON that is not an object (e.g. a bare number) → not installed", () => {
    expect(parseGwsAuthStatus("42").installed).toBe(false);
  });

  test("missing token_valid key defaults to signed out (not crash)", () => {
    const status = parseGwsAuthStatus(JSON.stringify({ client_config_exists: true }));
    expect(status.installed).toBe(true);
    expect(status.clientConfigured).toBe(true);
    expect(status.signedIn).toBe(false);
  });
});
