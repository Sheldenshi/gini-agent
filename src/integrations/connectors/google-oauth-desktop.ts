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
  },
  // The model was unreliable about embedding the Cloud Console URLs in its
  // `reason` field — it kept collapsing the multi-line instructions and
  // dropping the URLs. Declaring the template here takes that text out of
  // the model's hands: the model only supplies `project_id`, the runtime
  // substitutes the placeholders, and the user sees the same rendered
  // markdown block every time. We use string concatenation + `\n` rather
  // than a template literal so the literal `${project_id}` reaches the
  // runtime substitutor (no JS-side interpolation).
  requestParams: [
    {
      name: "project_id",
      label: "GCP project id",
      description: "The Cloud project the user just created or selected via gcloud.",
      required: true
    }
  ],
  requestInstructions:
    "Last step — complete two Cloud Console pages, then paste the credentials below.\n\n"
    + "1. Consent screen (if not configured):\n"
    + "https://console.cloud.google.com/apis/credentials/consent?project=${project_id}\n"
    + "→ User Type: External, App name \"Gini Workspace\", save through all screens, add yourself as Test user.\n\n"
    + "2. Create an OAuth client:\n"
    + "https://console.cloud.google.com/apis/credentials?project=${project_id}\n"
    + "→ Create Credentials → OAuth client ID → Application type: Desktop app.\n\n"
    + "Paste the Client ID and Client Secret below."
};
