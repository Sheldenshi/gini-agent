// Pure activation-status logic for the Skills page. Extracted from page.tsx
// so it can be unit-tested without importing the client component (and its
// React/UI deps). page.tsx imports deriveActivation + Activation from here.

import type { ConnectorRecord, SkillRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";

export type Activation = {
  // "via <setup> setup" (label text varies by setup skill) is a deferral: the
  // skill's status TEXT lives on the setup card it points to, so we don't
  // repeat active/needs-setup wording on every dependent row. The pill's TONE
  // still mirrors that card's sign-in liveness — green when signed in, amber
  // when the session expired, muted before setup — so signing in visibly
  // changes these rows instead of leaving them permanently grey.
  label: "active" | "needs setup" | "needs sign-in" | "disabled" | "unsupported" | string;
  tone: "ok" | "warn" | "neutral" | "danger";
};

// Humanize a setup skill name for the service-skill deferral pill
// ("google-workspace-setup" → "Google Workspace setup").
export function setupSkillLabelFor(setupSkillName: string): string {
  const words = setupSkillName.replace(/-setup$/, "").split("-");
  const titled = words
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
  return `${titled} setup`;
}

// Compute the effective activation status for the Skills page. The runtime
// is the source of truth for "is this skill in the agent's set"; we replay
// the same dependency check here so users see the badge that matches what
// the agent loop sees. Mirrors src/integrations/connectors/index.ts
// isSkillActive: a skill is active when every required credential NAME maps to
// a connector that is healthy OR (when its provider has no probe) configured
// with unknown health. Without the provider info we'd diverge from the runtime
// gate for demo / generic providers, which sit at health: "unknown" at rest.
export function deriveActivation(
  skill: SkillRecord,
  byName: Map<string, ConnectorRecord[]>,
  providersById: Map<string, ProviderDescriptor>,
  providerByCredentialName: Map<string, ProviderDescriptor>,
  setupSkillProviders: Map<string, ProviderDescriptor>
): Activation {
  if (skill.validationStatus === "unsupported") return { label: "unsupported", tone: "danger" };
  if (skill.status === "disabled" || skill.status === "archived") return { label: "disabled", tone: "neutral" };

  // Setup-skill card. A skill that IS some provider's `setupSkill` (e.g.
  // google-workspace-setup) owns the connection: its pill reflects the
  // provider's sign-in LIVENESS (`session`), not the connector's
  // provisioning `health`. Without this the setup skill — which declares no
  // requiredCredentials — would read "active" unconditionally even when the
  // gws user session has expired.
  const ownedProvider = setupSkillProviders.get(skill.name);
  if (ownedProvider) {
    const credentialName = ownedProvider.credentialTemplate?.name;
    const connector = credentialName
      ? (byName.get(credentialName) ?? []).find((c) => c.status === "configured")
      : undefined;
    const session = connector?.session;
    if (session?.signedIn) return { label: "active", tone: "ok" };
    if (session?.clientConfigured) return { label: "needs sign-in", tone: "warn" };
    return { label: "needs setup", tone: "warn" };
  }

  // Service skill that defers to a setup skill. When a required credential's
  // connector belongs to a provider that owns a setup skill, the real
  // connection status lives on that setup card — render a muted deferral
  // pill instead of this skill's own active/needs-setup.
  for (const credentialName of skill.requiredCredentials ?? []) {
    const matches = byName.get(credentialName) ?? [];
    const provider =
      providersById.get(matches[0]?.provider ?? "") ??
      providerByCredentialName.get(credentialName);
    const setupSkillName = provider?.setupSkill;
    if (setupSkillName && setupSkillName !== skill.name) {
      // Tone mirrors the setup connector's sign-in liveness, narrowed to THIS
      // service's own scope: a partial consent (e.g. Gmail only) leaves the
      // other rows amber instead of falsely green. `services` keys are the
      // google-* skill suffix; fall back to the overall session when absent.
      const session = matches.find((c) => c.status === "configured")?.session;
      const serviceKey = skill.name.replace(/^google-/, "");
      const serviceConnected =
        Boolean(session?.signedIn) && (session?.services?.[serviceKey] ?? true);
      const tone: Activation["tone"] = serviceConnected
        ? "ok"
        : session?.clientConfigured
        ? "warn"
        : "neutral";
      return { label: `via ${setupSkillLabelFor(setupSkillName)}`, tone };
    }
  }

  const required = skill.requiredCredentials ?? [];
  if (required.length === 0) return { label: "active", tone: "ok" };
  for (const credentialName of required) {
    const matches = byName.get(credentialName) ?? [];
    const satisfied = matches.some((c) => {
      // Mirror the runtime gate exactly: only configured records ever
      // satisfy. Disabled (tombstoned) and error-status records are
      // excluded even if they carry a stale `health: "healthy"` from
      // a prior probe. A typed credential whose provider has no probe is
      // presence-healthy at unknown (no remote signal to refute it).
      if (c.status !== "configured") return false;
      if (c.health === "healthy") return true;
      const hasProbe = Boolean(providersById.get(c.provider)?.hasProbe);
      if (!hasProbe && c.health === "unknown") return true;
      return false;
    });
    if (!satisfied) return { label: "needs setup", tone: "warn" };
  }
  return { label: "active", tone: "ok" };
}
