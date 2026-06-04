// Pure-JS tests (no React/DOM) for the Skills-page activation logic. The
// new branches under test: the setup skill's pill reflects gws sign-in
// liveness (session), and a service skill that depends on a setup-skill
// provider's credential renders a muted deferral pill.

import { describe, expect, test } from "bun:test";
import type { ConnectorRecord, SkillRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";
import { deriveActivation, setupSkillLabelFor } from "./_activation";

function skill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    id: "skill_test",
    instance: "dev",
    name: "test",
    description: "",
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: "enabled",
    version: 1,
    createdAt: "",
    updatedAt: "",
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...overrides
  };
}

function connector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_test",
    instance: "dev",
    name: "google-workspace-oauth",
    provider: "google-oauth-desktop",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

// The google-oauth-desktop provider, as the /api/connectors/providers payload
// surfaces it: owns the setup skill and seeds the credential name.
const gwsProvider: ProviderDescriptor = {
  id: "google-oauth-desktop",
  label: "Google OAuth Desktop client",
  description: "",
  fields: [],
  hasProbe: false,
  hasDetect: false,
  hasSetupSkill: true,
  setupSkill: "google-workspace-setup",
  credentialTemplate: { type: "oauth2", name: "google-workspace-oauth" }
};

function byNameOf(connectors: ConnectorRecord[]): Map<string, ConnectorRecord[]> {
  const map = new Map<string, ConnectorRecord[]>();
  for (const c of connectors) {
    const list = map.get(c.name) ?? [];
    list.push(c);
    map.set(c.name, list);
  }
  return map;
}

const providersById = new Map<string, ProviderDescriptor>([[gwsProvider.id, gwsProvider]]);
const providerByCredentialName = new Map<string, ProviderDescriptor>([
  ["google-workspace-oauth", gwsProvider]
]);
const setupSkillProviders = new Map<string, ProviderDescriptor>([
  ["google-workspace-setup", gwsProvider]
]);

function activationFor(s: SkillRecord, connectors: ConnectorRecord[]) {
  return deriveActivation(
    s,
    byNameOf(connectors),
    providersById,
    providerByCredentialName,
    setupSkillProviders
  );
}

describe("setupSkillLabelFor", () => {
  test("humanizes the skill name", () => {
    expect(setupSkillLabelFor("google-workspace-setup")).toBe("Google Workspace setup");
  });
});

describe("deriveActivation: setup skill card reflects sign-in liveness", () => {
  const setupSkill = skill({ name: "google-workspace-setup", requiredCredentials: [] });

  test("signed in → active/ok (not the unconditional active it gets today)", () => {
    const conn = connector({ session: { installed: true, clientConfigured: true, signedIn: true, message: "Signed in to Google" } });
    expect(activationFor(setupSkill, [conn])).toEqual({ label: "active", tone: "ok" });
  });

  test("client provisioned but session expired → needs sign-in/warn", () => {
    const conn = connector({ session: { installed: true, clientConfigured: true, signedIn: false, message: "Google sign-in expired — re-auth needed" } });
    expect(activationFor(setupSkill, [conn])).toEqual({ label: "needs sign-in", tone: "warn" });
  });

  test("no connector at all → needs setup/warn", () => {
    expect(activationFor(setupSkill, [])).toEqual({ label: "needs setup", tone: "warn" });
  });

  test("connector exists but gws not installed (no clientConfigured) → needs setup/warn", () => {
    const conn = connector({ session: { installed: false, clientConfigured: false, signedIn: false, message: "gws not installed" } });
    expect(activationFor(setupSkill, [conn])).toEqual({ label: "needs setup", tone: "warn" });
  });
});

describe("deriveActivation: service skill defers to the setup skill", () => {
  const serviceSkill = skill({
    name: "google-calendar",
    requiredCredentials: ["google-workspace-oauth"]
  });

  test("renders a muted deferral pill instead of its own active/needs-setup", () => {
    // Even with a healthy connector, the service skill does not claim its own
    // active — the truthful status lives on the setup card.
    const conn = connector({ session: { installed: true, clientConfigured: true, signedIn: true, message: "Signed in to Google" } });
    expect(activationFor(serviceSkill, [conn])).toEqual({
      label: "via Google Workspace setup",
      tone: "neutral"
    });
  });

  test("defers even when no connector record exists yet (routes by credential name)", () => {
    expect(activationFor(serviceSkill, [])).toEqual({
      label: "via Google Workspace setup",
      tone: "neutral"
    });
  });
});

describe("deriveActivation: non-gws skills are unaffected", () => {
  test("a skill with no required credentials stays active", () => {
    const plain = skill({ name: "some-skill", requiredCredentials: [] });
    expect(activationFor(plain, [])).toEqual({ label: "active", tone: "ok" });
  });

  test("disabled skill stays disabled", () => {
    const disabled = skill({ name: "google-workspace-setup", status: "disabled" });
    expect(activationFor(disabled, [])).toEqual({ label: "disabled", tone: "neutral" });
  });
});
