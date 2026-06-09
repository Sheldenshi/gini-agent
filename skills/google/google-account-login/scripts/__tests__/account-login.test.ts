// Unit tests for the pure helpers of the per-account Google login script.
//
// Only the side-effect-free exports are covered here: URL scraping out of a
// realistic gws log blob and the `gws auth login` arg builder. No subprocess, no
// network, no gws — the imperative login/register orchestration is exercised
// end-to-end through a real chat turn, not here.

import { describe, expect, test } from "bun:test";
import { buildLoginArgs, extractConsentUrl } from "../account-login";

describe("extractConsentUrl", () => {
  test("finds the consent URL in a realistic gws auth login log blob", () => {
    const log = [
      "Using keyring backend: keyring",
      "Starting local server on http://localhost:54321",
      "Open this URL in your browser to authenticate:",
      "",
      "  https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc.apps.googleusercontent.com&redirect_uri=http://localhost:54321&scope=foo",
      "",
      "Waiting for authentication..."
    ].join("\n");
    expect(extractConsentUrl(log)).toBe(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc.apps.googleusercontent.com&redirect_uri=http://localhost:54321&scope=foo"
    );
  });

  test("returns null when no consent URL is present", () => {
    expect(extractConsentUrl("Using keyring backend: keyring\nStarting local server...")).toBeNull();
    expect(extractConsentUrl("")).toBeNull();
  });
});

describe("buildLoginArgs", () => {
  test("defaults to the seven-service -s list", () => {
    expect(buildLoginArgs({})).toEqual([
      "auth",
      "login",
      "-s",
      "drive,gmail,calendar,docs,sheets,meet,forms"
    ]);
  });

  test("uses the caller's services with -s when provided", () => {
    expect(buildLoginArgs({ services: ["gmail", "drive"] })).toEqual([
      "auth",
      "login",
      "-s",
      "gmail,drive"
    ]);
  });

  test("prefers --scopes (full scope URLs) over -s when supplied", () => {
    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive"
    ];
    expect(buildLoginArgs({ services: ["gmail"], scopes })).toEqual([
      "auth",
      "login",
      "--scopes",
      scopes.join(",")
    ]);
  });

  test("inserts --readonly before the scope flag", () => {
    expect(buildLoginArgs({ readonly: true, services: ["gmail"] })).toEqual([
      "auth",
      "login",
      "--readonly",
      "-s",
      "gmail"
    ]);
  });
});
