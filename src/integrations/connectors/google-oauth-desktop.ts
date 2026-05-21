import type { ProviderModule } from "./types";

// Google OAuth Desktop client provider. The user creates a Desktop OAuth
// app in their own Google Cloud project (Cloud Console → Credentials →
// OAuth client ID → Desktop app) and pastes the resulting Client ID +
// Client Secret into the Add Connector / Connect dialog. The runtime
// binds the two values into the `gws` CLI's expected env vars so the
// downstream `gws auth login` flow can run without a `client_secret.json`
// file on disk.
//
// No probe — there is no remote endpoint that can validate an OAuth
// client's id/secret pair without running the full OAuth code grant
// flow (which requires a user interaction). The next step in the setup
// skill (`gws auth login`) is the real validation: if the credentials
// are wrong, the CLI fails with a clear error from Google's OAuth
// server. Health falls back to the configured-status check via
// `checkConnector`'s presence-only branch (see
// src/integrations/connectors/index.ts around the probe dispatch).
export const googleOauthDesktopProvider: ProviderModule = {
  id: "google-oauth-desktop",
  label: "Google OAuth Desktop client",
  description:
    "Client ID and secret for a Desktop OAuth app in your Google Cloud project. Used by gws for Workspace API authentication.",
  fields: [
    {
      name: "client_id",
      label: "Client ID",
      description: "Looks like 1234567890-abcdef.apps.googleusercontent.com",
      secret: false,
      required: true,
      placeholder: "1234567890-abcdef.apps.googleusercontent.com"
    },
    {
      name: "client_secret",
      label: "Client secret",
      description: "Starts with GOCSPX-",
      secret: true,
      required: true,
      placeholder: "GOCSPX-..."
    }
  ],
  secrets: {
    purposes: ["client_id", "client_secret"],
    envBindings: {
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "client_id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "client_secret"
    }
  }
};
