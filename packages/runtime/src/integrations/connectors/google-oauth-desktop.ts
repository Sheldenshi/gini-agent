import type { ProviderModule } from "./types";
import { readGoogleAccounts } from "../../state/google-accounts";

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
  // Help page surfaced as a "how to obtain these" link under the Connect /
  // manual-entry forms — covers creating the Desktop OAuth client in Cloud
  // Console (Step 5) and the common pitfalls (Desktop vs Web app, no card
  // needed). Rendered inline as a doc slide-over via DocReference.
  docsUrl: "https://gini.lilaclabs.ai/docs/connectors/google-services/set-up",
  fields: [
    {
      // Marked secret so the request_connector dialog routes it into
      // `secrets` (→ a secretRef under purpose "client_id") rather than
      // dropping it as a non-secret metadata field. The OAuth client id is a
      // credential component the runtime resolves into the gws CLI env, so it
      // must survive the dialog→/complete seam alongside client_secret. It is
      // stored encrypted like every other secret.
      name: "client_id",
      label: "Client ID",
      description: "Looks like 1234567890-abcdef.apps.googleusercontent.com",
      secret: true,
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
  // Canonical credential handle skills + the migration reference by name. NOT
  // the module id ("google-oauth-desktop"): the LOCKED name is the workspace
  // handle so a fresh UI-created credential, the request /complete path, and
  // the migration output all agree (surfaced through canonicalCredentialName
  // in connectors/registry.ts).
  credentialName: "google-workspace-oauth",
  // A registered machine-global Google account (ADR google-multi-account.md)
  // satisfies the workspace credential without any connector record. For the
  // read/operate Workspace skills each account's config dir carries its own
  // OAuth client + tokens, so the gws CLI needs no client env vars on that
  // path — which is why `bindingsForCredentials` is untouched. The exception
  // is google-account-login's fresh-login flow, which mints a NEW config dir
  // and still needs this connector's GOOGLE_WORKSPACE_CLI_CLIENT_ID/_SECRET
  // bindings. Presence-only by design: sign-in expiry is handled by the
  // skill recipes at run time (`gws auth status` / re-login guidance), not
  // by this gate.
  credentialExternallySatisfied: () => readGoogleAccounts().length > 0,
  // The setup flow is non-trivial — install gws, install gcloud, gcloud
  // auth login, project provisioning, APIs enable, THEN capture the
  // OAuth client credentials. The `google-workspace-setup` skill owns
  // the full walkthrough and calls `request_connector` at the end. The
  // runtime advertises this skill in the "skills that need connection"
  // system-prompt block so the model invokes the setup skill instead of
  // dropping a bare Connect form on the user.
  setupSkill: "google-workspace-setup"
};
