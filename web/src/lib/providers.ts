// Shared provider-catalog types and display helpers.
//
// Both the settings route (ProviderCard / EditProviderDialog / Add Provider)
// and the per-agent chat Settings tab consume the `/providers/catalog` payload,
// so the row shape and the brand-label helper live here rather than inside any
// one route's private component.

import type { ProviderCatalogItem as RuntimeProviderCatalogItem } from "@runtime/types";

// The `/providers/catalog` payload is the runtime ProviderCatalogItem enriched
// with a per-row `configured` flag (see providerCatalogWithStatus). Derive the
// client shape from the runtime type so the fields can't drift; `configured` is
// the only client-side addition.
//
// `configured` is true when credentials for this provider are available in the
// running gateway (env var set, codex auth.json present, or local explicitly
// activated). Settings hides un-configured rows; Add Provider treats the flag
// as informational.
export type ProviderCatalogItem = Pick<
  RuntimeProviderCatalogItem,
  "id" | "name" | "displayName" | "baseUrl" | "auth" | "models"
> & { configured?: boolean };

// Trim suffixes that the static catalog stacks on top of the brand name.
// The Pencil mocks reference providers by short name (OpenAI, OpenRouter,
// Codex, …); the auth badge alongside each row carries the "how" (OAuth /
// API key / Local) so the brand label doesn't need to repeat it.
export function displayProviderName(item: { displayName: string; name: string }): string {
  if (item.name === "local") return "Local";
  if (item.name === "codex") return "Codex";
  return item.displayName.replace(/\s+Compatible$/i, "");
}
