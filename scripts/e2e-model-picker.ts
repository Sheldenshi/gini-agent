// Live end-to-end harness for model-first selection (ADR
// model-first-selection.md): drives the REAL web UI with Playwright and
// asserts against the runtime API after every interaction.
//
// Requires a running gini runtime (gateway origin serves the web app) and
// Google Chrome installed (playwright-core launches the system Chrome via
// channel "chrome" — no browser download needed).
//
// Usage:
//   GINI_RUNTIME_BASE=http://localhost:7351 \
//   GINI_RUNTIME_TOKEN=<token> \
//   bun run scripts/e2e-model-picker.ts
//
// What it covers:
//   1. Settings "Default model" picker: pick a different model, assert the
//      two-layer write (config.provider AND the default agent's pair).
//   2. Detach-on-default-change: a follower agent (no override) gets pinned
//      to the previous default; a pinned agent is untouched.
//   3. Chat tab "Use default model": copies the current default as a new
//      pin (stays unsynced).
//   4. Route flyout: picking a non-default route persists that exact
//      (provider, providerModelId) pair. Skipped when the instance has no
//      multi-route model.
//
// State safety: the harness creates throwaway agents and changes the
// default model, then restores the original default, the original active
// agent, and deletes everything it created. Side effect that intentionally
// persists: any PRE-EXISTING follower agents get pinned to the model they
// were already using — that is the product semantics of a default change,
// and their effective model does not change.

import { chromium, type Browser, type Page } from "playwright-core";

const BASE = process.env.GINI_RUNTIME_BASE ?? "http://localhost:7351";
const TOKEN = process.env.GINI_RUNTIME_TOKEN ?? "";

const HEADERS = {
  "content-type": "application/json",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {})
};

async function api(path: string, init?: RequestInit & { body?: unknown }) {
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  const response = await fetch(`${BASE}${path}`, { ...init, headers: HEADERS, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

interface AgentRecord {
  id: string;
  name: string;
  providerName?: string;
  model?: string;
}

interface ModelRoute {
  provider: string;
  providerModelId: string;
  label: string;
  default: boolean;
}

interface ModelCatalogEntry {
  id: string;
  routes: ModelRoute[];
}

interface Pair {
  provider: string;
  model: string;
}

async function listAgents(): Promise<{ activeAgentId: string; agents: AgentRecord[] }> {
  return api("/api/agents");
}

async function defaultAgentPair(): Promise<{ id: string; pair: Pair }> {
  const { agents } = await listAgents();
  const row = agents.find((a) => a.id === "agent_default") ?? agents.find((a) => a.id === "profile_default");
  if (!row?.providerName || !row.model) throw new Error("default agent has no provider/model pair");
  return { id: row.id, pair: { provider: row.providerName, model: row.model } };
}

async function instancePair(): Promise<Pair> {
  const status = await api("/api/status");
  return { provider: status.provider.provider.name, model: status.provider.provider.model };
}

function samePair(a: Pair, b: Pair): boolean {
  return a.provider === b.provider && a.model === b.model;
}

// Poll until `check` resolves truthy — UI writes land via the API a beat
// after the click, so every UI assertion syncs through this.
async function until<T>(label: string, check: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Open the picker behind `triggerName` and click the row for `entryId`
// (its default route), or a specific flyout route when `routeLabel` is set.
async function pickModel(page: Page, triggerName: string | RegExp, entryId: string, routeLabel?: string) {
  await page.getByRole("button", { name: triggerName }).click();
  const search = page.getByPlaceholder("Search models…");
  await search.waitFor({ state: "visible" });
  await search.fill(entryId);
  const row = page.getByRole("option", { name: new RegExp(`^${entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first();
  await row.waitFor({ state: "visible" });
  if (routeLabel) {
    await page.getByRole("button", { name: `Choose a route for ${entryId}` }).click();
    const flyout = page.getByRole("listbox", { name: `Routes for ${entryId}` });
    await flyout.waitFor({ state: "visible" });
    await flyout.getByRole("option", { name: routeLabel }).click();
  } else {
    await row.click();
  }
}

const summary: Array<{ name: string; ok: boolean; reason: string }> = [];

function record(name: string, ok: boolean, reason = "PASS") {
  summary.push({ name, ok, reason });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${reason}`}`);
}

async function main() {
  console.log(`model-picker e2e against ${BASE}`);
  const initialActive = (await listAgents()).activeAgentId;
  const initialDefault = await defaultAgentPair();
  const models: ModelCatalogEntry[] = await api("/api/providers/models");
  if (models.length < 2) throw new Error("need at least two models in the catalog to swap between");

  // A target model whose default route differs from the current default.
  const target = models.find((entry) => {
    const route = entry.routes.find((r) => r.default) ?? entry.routes[0]!;
    return !samePair(initialDefault.pair, { provider: String(route.provider), model: route.providerModelId });
  });
  if (!target) throw new Error("no alternative model available to swap to");
  const targetRoute = target.routes.find((r) => r.default) ?? target.routes[0]!;
  const targetPair: Pair = { provider: String(targetRoute.provider), model: targetRoute.providerModelId };

  // Throwaway agents: one follower (override cleared) and one pinned.
  const stamp = Date.now();
  const follower: AgentRecord = await api("/api/agents", { method: "POST", body: { name: `e2e-follower-${stamp}` } });
  await api(`/api/agents/${follower.id}/provider`, { method: "POST", body: { providerName: "", model: "" } });
  const pinned: AgentRecord = await api("/api/agents", { method: "POST", body: { name: `e2e-pinned-${stamp}` } });
  const pinnedPair: Pair = { provider: String(pinned.providerName), model: String(pinned.model) };

  const browser: Browser = await chromium.launch({ channel: "chrome", headless: true });
  let page: Page | undefined;
  try {
    page = await browser.newPage();

    // 1. Settings picker performs the two-layer default write. The app
    //    polls continuously, so wait on elements, never on network idle.
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Default model" }).waitFor({ state: "visible", timeout: 30_000 });
    await pickModel(page, "Default model", target.id);
    await until("default change to land on both layers", async () => {
      const [agentSide, configSide] = [await defaultAgentPair(), await instancePair()];
      return samePair(agentSide.pair, targetPair) && samePair(configSide, targetPair);
    });
    const trigger = await page.getByRole("button", { name: "Default model" }).textContent();
    record(
      "settings default-model two-layer write",
      Boolean(trigger?.includes(target.id) && trigger.includes(targetRoute.label)),
      `trigger="${trigger}"`
    );

    // 2. The follower was detached — pinned to the PREVIOUS default — and
    //    the pinned agent untouched.
    const { agents } = await listAgents();
    const followerNow = agents.find((a) => a.id === follower.id);
    const pinnedNow = agents.find((a) => a.id === pinned.id);
    record(
      "default change pins follower to previous default",
      Boolean(
        followerNow?.providerName === initialDefault.pair.provider &&
          followerNow.model === initialDefault.pair.model
      ),
      `follower=${followerNow?.providerName}/${followerNow?.model}`
    );
    record(
      "default change leaves pinned agent untouched",
      Boolean(pinnedNow?.providerName === pinnedPair.provider && pinnedNow.model === pinnedPair.model),
      `pinned=${pinnedNow?.providerName}/${pinnedNow?.model}`
    );

    // 3. Chat tab: "Use default model" copies the current default as a pin.
    await api(`/api/agents/${follower.id}/use`, { method: "POST" });
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    // Let the chat surface settle (composer mounted) — a tab click during
    // the initial data load gets reset by the remount.
    await page.getByPlaceholder(/^Ask /).waitFor({ state: "visible", timeout: 30_000 });
    const settingsTab = page.getByRole("button", { name: "Settings", exact: true });
    await until("the chat Settings tab to open", async () => {
      await settingsTab.click();
      return page!
        .getByText("Pinned for this agent")
        .isVisible()
        .catch(() => false);
    });
    await page.getByRole("button", { name: "Use default model" }).click();
    await until("use-default to pin the current default", async () => {
      const row = (await listAgents()).agents.find((a) => a.id === follower.id);
      return row?.providerName === targetPair.provider && row.model === targetPair.model;
    });
    record("chat tab Use default model pins current default", true);

    // 4. Route flyout: a non-default route persists its exact pair.
    const multi = models.find((entry) => entry.routes.length > 1);
    if (multi) {
      const nonDefault = multi.routes.find((r) => !r.default)!;
      await pickModel(page, /^Model for /, multi.id, nonDefault.label);
      await until("flyout route pick to land", async () => {
        const row = (await listAgents()).agents.find((a) => a.id === follower.id);
        return row?.providerName === String(nonDefault.provider) && row.model === nonDefault.providerModelId;
      });
      record("flyout selects the exact non-default route pair", true);
    } else {
      record("flyout selects the exact non-default route pair", true, "SKIP: no multi-route model on this instance");
    }
  } catch (error) {
    // Snapshot what the browser was looking at — UI timeouts are opaque
    // without it.
    const shot = `/tmp/e2e-model-picker-failure-${Date.now()}.png`;
    await page?.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`failure screenshot: ${shot}`);
    throw error;
  } finally {
    await browser.close();
    // Restore: original default (two-layer), original active agent, and
    // remove the throwaway agents.
    await api("/api/settings/default-model", {
      method: "POST",
      body: { provider: initialDefault.pair.provider, model: initialDefault.pair.model }
    });
    await api(`/api/agents/${initialActive}/use`, { method: "POST" });
    await api(`/api/agents/${follower.id}`, { method: "DELETE" });
    await api(`/api/agents/${pinned.id}`, { method: "DELETE" });
  }

  // Restoration assert: the instance ends where it started.
  const finalDefault = await defaultAgentPair();
  const finalConfig = await instancePair();
  record(
    "harness restores the original default",
    samePair(finalDefault.pair, initialDefault.pair) && samePair(finalConfig, initialDefault.pair),
    `final=${finalDefault.pair.provider}/${finalDefault.pair.model}`
  );

  console.log("\n=== Summary ===");
  for (const row of summary) console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.name}  ${row.reason.slice(0, 160)}`);
  process.exit(summary.every((s) => s.ok) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
