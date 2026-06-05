import type { CliContext } from "../context";
import { restAfter, flagValue } from "../args";
import { api } from "../api";
import { print } from "../output";

// `gini contacts import|list|count|show|get|upsert|relate|relations|mutual|delete`
// — the CLI face of the people-CRM contacts store (ADR people-crm-store.md).
// Each subcommand maps to a /api/contacts route so the CLI shares the exact
// contract the agent tools and web client use.
export async function contacts(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1];

  if (!sub) {
    throw new Error(
      "Usage: gini contacts import|list|count|show|upsert|relate|relations|mutual|delete <args>"
    );
  }

  // Build a query string from the filter flags shared by list/count.
  const queryParams = (): URLSearchParams => {
    const params = new URLSearchParams();
    for (const flag of [
      "company", "companyContains", "title", "location",
      "nameContains", "emailContains", "q", "connectedAfter",
      "connectedBefore", "limit", "offset"
    ] as const) {
      const value = flagValue(cliArgs, `--${flag}`);
      if (value) params.set(flag, value);
    }
    const hasCompany = flagValue(cliArgs, "--hasCompany");
    if (hasCompany) params.set("hasCompany", hasCompany);
    return params;
  };

  if (sub === "import") {
    const path = restAfter(cliArgs, sub).find((arg) => !arg.startsWith("--"));
    if (!path) throw new Error("Usage: gini contacts import <workspace-path> [--source TAG]");
    const source = flagValue(cliArgs, "--source");
    print(await api(config, "/api/contacts/import", { method: "POST", body: JSON.stringify({ path, source }) }));
    return;
  }

  if (sub === "list") {
    const qs = queryParams().toString();
    print(await api(config, `/api/contacts${qs ? `?${qs}` : ""}`));
    return;
  }

  if (sub === "count") {
    const params = queryParams();
    const breakdown = flagValue(cliArgs, "--breakdown");
    if (breakdown) params.set("breakdown", breakdown);
    const qs = params.toString();
    print(await api(config, `/api/contacts/count${qs ? `?${qs}` : ""}`));
    return;
  }

  if (sub === "show" || sub === "get") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini contacts show <contact-id>");
    print(await api(config, `/api/contacts/${id}`));
    return;
  }

  if (sub === "upsert") {
    const body: Record<string, unknown> = {};
    for (const flag of ["id", "fullName", "firstName", "lastName", "company", "title", "location", "email", "linkedinUrl", "connectedAt", "notes", "source"] as const) {
      const value = flagValue(cliArgs, `--${flag}`);
      if (value !== undefined) body[flag] = value;
    }
    if (!body.id && !body.fullName && !body.firstName && !body.lastName) {
      throw new Error("Usage: gini contacts upsert --fullName NAME [--company C --title T --location L --email E --linkedinUrl U --notes N] (or --id to update)");
    }
    print(await api(config, "/api/contacts", { method: "POST", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "relate") {
    const from = flagValue(cliArgs, "--from");
    const to = flagValue(cliArgs, "--to");
    if (!from || !to) throw new Error("Usage: gini contacts relate --from NAME_OR_ID --to NAME_OR_ID [--relationType T --note N]");
    const body = JSON.stringify({
      from,
      to,
      relationType: flagValue(cliArgs, "--relationType"),
      note: flagValue(cliArgs, "--note")
    });
    print(await api(config, "/api/contacts/relations", { method: "POST", body }));
    return;
  }

  if (sub === "relations") {
    const id = restAfter(cliArgs, sub).find((arg) => !arg.startsWith("--"));
    if (!id) throw new Error("Usage: gini contacts relations <contact-id>");
    print(await api(config, `/api/contacts/${id}/relations`));
    return;
  }

  if (sub === "mutual") {
    const a = flagValue(cliArgs, "--a");
    const b = flagValue(cliArgs, "--b");
    if (!a || !b) throw new Error("Usage: gini contacts mutual --a CONTACT_ID --b CONTACT_ID");
    print(await api(config, `/api/contacts/mutual?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`));
    return;
  }

  if (sub === "delete") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini contacts delete <contact-id>");
    print(await api(config, `/api/contacts/${id}`, { method: "DELETE" }));
    return;
  }

  throw new Error(
    `Unknown subcommand: gini contacts ${sub}. ` +
      `Available: import | list | count | show | upsert | relate | relations | mutual | delete.`
  );
}
