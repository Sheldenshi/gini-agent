import { describe, expect, test } from "bun:test";
import { googleOauthDesktopProvider } from "./google-oauth-desktop";
import { getProvider } from "./registry";

describe("googleOauthDesktopProvider", () => {
  test("declares the expected id, label, and description", () => {
    expect(googleOauthDesktopProvider.id).toBe("google-oauth-desktop");
    expect(googleOauthDesktopProvider.label).toBe("Google OAuth Desktop client");
    expect(googleOauthDesktopProvider.description).toMatch(/Desktop OAuth/);
    expect(googleOauthDesktopProvider.description.length).toBeGreaterThan(0);
  });

  test("declares client_id as a required non-secret field", () => {
    const field = googleOauthDesktopProvider.fields.find((f) => f.name === "client_id");
    expect(field).toBeDefined();
    expect(field!.label).toBe("Client ID");
    expect(field!.secret).toBe(false);
    expect(field!.required).toBe(true);
    expect(field!.placeholder).toMatch(/apps\.googleusercontent\.com/);
  });

  test("declares client_secret as a required secret field", () => {
    const field = googleOauthDesktopProvider.fields.find((f) => f.name === "client_secret");
    expect(field).toBeDefined();
    expect(field!.label).toBe("Client secret");
    expect(field!.secret).toBe(true);
    expect(field!.required).toBe(true);
    expect(field!.placeholder).toMatch(/GOCSPX-/);
  });

  test("maps env bindings to the gws CLI's expected variable names", () => {
    expect(googleOauthDesktopProvider.secrets).toBeDefined();
    expect(googleOauthDesktopProvider.secrets!.purposes).toEqual([
      "client_id",
      "client_secret"
    ]);
    expect(googleOauthDesktopProvider.secrets!.envBindings).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "client_id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "client_secret"
    });
  });

  test("defines no probe — OAuth client validation happens in `gws auth login`", () => {
    // Health falls back to the presence-only branch in `checkConnector`,
    // which marks the connector healthy when `status === "configured"`.
    // The downstream `gws auth login` is the real validation step.
    expect(googleOauthDesktopProvider.probe).toBeUndefined();
  });

  test("registers under its declared id in the provider registry", () => {
    const found = getProvider("google-oauth-desktop");
    expect(found).toBeDefined();
    expect(found!.id).toBe("google-oauth-desktop");
    expect(found!.label).toBe(googleOauthDesktopProvider.label);
  });

  test("declares a project_id requestParam and a multi-step requestInstructions template", () => {
    // The template owns the user-visible instructions for the
    // `request_connector` flow — the model was unreliable about embedding
    // URLs in its `reason` field, so the runtime substitutes here instead.
    expect(googleOauthDesktopProvider.requestParams).toBeDefined();
    const projectIdParam = googleOauthDesktopProvider.requestParams!.find((p) => p.name === "project_id");
    expect(projectIdParam).toBeDefined();
    expect(projectIdParam!.required).toBe(true);

    expect(typeof googleOauthDesktopProvider.requestInstructions).toBe("string");
    const template = googleOauthDesktopProvider.requestInstructions!;
    // The placeholder must be a literal `${project_id}` so the runtime
    // substitutor can find it (i.e. no JS-side interpolation crept in).
    expect(template).toContain("${project_id}");
    // Both Cloud Console URLs must be present in the template.
    expect(template).toContain("https://console.cloud.google.com/apis/credentials/consent?project=${project_id}");
    expect(template).toContain("https://console.cloud.google.com/apis/credentials?project=${project_id}");
  });

  test("requestInstructions template substitutes project_id deterministically", () => {
    // Mirror the runtime's substitution loop so the provider unit test pins
    // the contract end-to-end: same regex, same replacement semantics.
    const template = googleOauthDesktopProvider.requestInstructions!;
    const rendered = template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
      const params: Record<string, string> = { project_id: "gini-workspace-1234567" };
      return name in params ? params[name] : match;
    });
    expect(rendered).not.toContain("${project_id}");
    expect(rendered).toContain("project=gini-workspace-1234567");
    // Two URLs → two substitutions.
    const occurrences = rendered.match(/project=gini-workspace-1234567/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
