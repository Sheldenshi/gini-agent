import { describe, expect, test } from "bun:test";
import { parseGwsAuthStatus } from "./gws-session";

// parseGwsAuthStatus is the pure half of gwsSessionStatus (the subprocess
// boundary is isolated in the cached async wrapper). These tests pin the
// liveness derivation: signedIn := token_valid===true, clientConfigured :=
// client_config_exists===true, and the human message for each state.

describe("parseGwsAuthStatus", () => {
  test("signed in when token_valid is true; scopes map to per-service grants", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: true,
        has_refresh_token: true,
        scopes: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/gmail.modify"
        ]
      })
    );
    expect(status).toEqual({
      installed: true,
      clientConfigured: true,
      signedIn: true,
      services: { calendar: true, gmail: true, drive: false, docs: false, sheets: false, forms: false, meet: false },
      message: "Signed in to Google"
    });
  });

  test("docs/sheets/meet resolve from their Google scope names", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: true,
        scopes: [
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/meetings.space.created"
        ]
      })
    );
    expect(status.services).toEqual({
      calendar: false, gmail: false, drive: false, docs: true, sheets: true, forms: false, meet: true
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
      services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
      message: "Google sign-in needed"
    });
  });

  test("non-JSON output (gws missing / errored) → not installed", () => {
    const status = parseGwsAuthStatus("zsh: command not found: gws\n");
    expect(status).toEqual({
      installed: false,
      clientConfigured: false,
      signedIn: false,
      services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
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
