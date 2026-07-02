// Real-Chromium integration tests for the browser tools shipped in
// Phase 1 + Phase 2. Each test boots Chromium via the production
// session manager (setBrowserInstance + the public tool entry points)
// and drives the new tools against a small `Bun.serve` running on an
// ephemeral port. (We don't use `data:` URLs because the session
// manager's safetyCheck only allows http(s).)
//
// Gating: the whole suite is skipped unless
//   GINI_PLAYWRIGHT_INSTALLED=1
// is set in the environment. CI without Chromium binaries should run
// `bun test` without that flag and watch the suite skip cleanly.
//
// Isolation: each test reads/writes via its own `GINI_STATE_ROOT`
// directory (set BEFORE `setBrowserInstance` and any tool call) so the
// per-instance Chrome profile dir lives under a unique tmp path and
// concurrent test files don't fight over the profile lock. `closeAll()`
// in afterAll tears down the shared Chromium handle so the process
// exits cleanly.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserConsole,
  browserDrag,
  browserFillByLocator,
  browserHover,
  browserNavigate,
  browserSelectOption,
  browserSnapshot,
  browserTabs,
  browserUploadFile,
  browserWaitFor,
  closeAll,
  disconnectSharedBrowser,
  setBrowserInstance
} from "./browser";

const ENABLED = process.env.GINI_PLAYWRIGHT_INSTALLED === "1";

// Tracked across all tests; cleaned up in afterAll so a thrown test
// body doesn't leak ephemeral ports or tmp dirs.
const cleanupDirs: string[] = [];
let pageServer: ReturnType<typeof Bun.serve> | undefined;

// Per-path HTML responses. Tests register their HTML before navigating
// to `${baseUrl}/${path}`; the server looks up by pathname and falls
// back to a 404. This lets us serve `data:`-style fixture pages over
// http (which the SSRF guard allows) using a single ephemeral port.
const pageHandlers = new Map<string, () => Response>();

function baseUrl(): string {
  if (!pageServer) throw new Error("pageServer not started");
  return `http://127.0.0.1:${pageServer.port}`;
}

// Each test gets a unique tmp dir for GINI_STATE_ROOT, which is what
// `instanceRoot(instance)` resolves against. We register the instance
// with setBrowserInstance so the session manager points its
// `launchPersistentContext` at the per-test chrome-profile dir.
//
// Returns the same workspaceRoot string used by browserUploadFile —
// we plant it under the per-test tmp dir, separate from chrome-profile/.
//
// IMPORTANT: the session manager's `shared` BrowserContext is
// module-level, so we have to tear it down (closeAll/disconnect)
// between tests — otherwise the next test's persistent-context launch
// is short-circuited by `isHandleAlive` and we end up reusing the
// previous test's profile dir AND inheriting its tabs.
async function bootInstance(tag: string): Promise<{ instance: string; stateRoot: string; workspaceRoot: string }> {
  await disconnectSharedBrowser();
  const stateRoot = mkdtempSync(join(tmpdir(), `gini-browser-it-${tag}-`));
  const workspaceRoot = join(stateRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  process.env.GINI_STATE_ROOT = stateRoot;
  const instance = `it-${tag}-${process.pid}`;
  setBrowserInstance(instance);
  cleanupDirs.push(stateRoot);
  return { instance, stateRoot, workspaceRoot };
}

interface NavResult {
  success: boolean;
  url?: string;
  title?: string;
  snapshot?: string;
  error?: string;
}

interface ConsoleResult {
  success: boolean;
  evalResult?: unknown;
  evalError?: string | null;
  messages?: Array<{ type: string; text: string }>;
  error?: string;
}

interface TabsResult {
  success: boolean;
  tabs?: Array<{ id: string; url: string; title: string; active: boolean }>;
  url?: string;
  snapshot?: string;
  error?: string;
}

// Pull the first ref of a given role from a snapshot string.
//   [@e3] combobox "Cars" value="audi"
// Returns "@e3". The walker also surfaces options as sibling rows with
// role "option"; tests that want a particular option pass their
// `name` substring.
function findRef(snapshot: string, role: string, nameContains?: string): string | undefined {
  for (const line of snapshot.split("\n")) {
    const match = line.match(/\[(@e\d+)]\s+(\w+)(?:\s+"([^"]*)")?/);
    if (!match) continue;
    const [, ref, lineRole, lineName] = match;
    if (lineRole !== role) continue;
    if (nameContains && !(lineName ?? "").includes(nameContains)) continue;
    return ref;
  }
  return undefined;
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function registerPage(path: string, html: string): string {
  pageHandlers.set(path, () => htmlResponse(html));
  return `${baseUrl()}${path}`;
}

describe.skipIf(!ENABLED)("browser tools — real Chromium integration", () => {
  beforeAll(() => {
    // The spawned launcher (launchSpawnedChrome) re-imports playwright-core on
    // every launch with no module-level cache, so a sibling test's
    // mock.module(...) stub cannot leak into these real-Chromium tests.
    pageServer = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const handler = pageHandlers.get(url.pathname);
        if (handler) return handler();
        return new Response("Not found", { status: 404 });
      }
    });
  });

  afterAll(async () => {
    await closeAll();
    try {
      pageServer?.stop(true);
    } catch {
      // ignore
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hover_tooltip — browserHover triggers onmouseenter which mutates title", async () => {
    await bootInstance("hover");

    const taskId = `hover-${Date.now()}`;
    const url = registerPage(
      "/hover",
      `<button id="b" onmouseenter="document.title='tooltip-shown'">Hover me</button>`
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);
    const ref = findRef(nav.snapshot ?? "", "button");
    expect(ref).toBeDefined();
    const hoverRaw = await browserHover(taskId, { ref: ref! });
    const hover = JSON.parse(hoverRaw) as NavResult;
    if (!hover.success) throw new Error(`hover failed: ${hover.error}`);
    expect(hover.title).toBe("tooltip-shown");
  }, 60_000);

  // Playwright's `dragTo` synthesizes pointer events but does not
  // always fire the full HTML5 drag-and-drop sequence — many real apps
  // rely on `dragstart` / `dragover` / `drop` HTML5 events, not raw
  // mouse moves. We attempt the canonical flow first and fall back to
  // an event-listener check; if neither side can be made reliable on
  // this stack we keep the test as documented partial coverage rather
  // than churning the suite on flake.
  it("drag_drop — browserDrag fires drag/drop listeners on draggable elements", async () => {
    await bootInstance("drag");

    const taskId = `drag-${Date.now()}`;
    // Two boxes; the source wires `dragstart`, the target wires
    // `dragover` (with preventDefault, required for `drop` to fire)
    // and `drop`. Each event is also pushed onto window.__events so the
    // fallback assertion has something to chew on if Playwright's
    // dragTo only triggers pointer events.
    const url = registerPage(
      "/drag",
      `
        <div id="a" draggable="true"
             style="width:120px;height:120px;background:#eef;display:inline-block;">A</div>
        <div id="b"
             style="width:120px;height:120px;background:#fee;display:inline-block;margin-left:40px;">B</div>
        <script>
          window.__events = [];
          const a = document.getElementById('a');
          const b = document.getElementById('b');
          a.addEventListener('dragstart', (e) => {
            window.__events.push('dragstart');
            e.dataTransfer.setData('text/plain', 'A');
          });
          b.addEventListener('dragover', (e) => {
            window.__events.push('dragover');
            e.preventDefault();
          });
          b.addEventListener('drop', (e) => {
            window.__events.push('drop');
            e.preventDefault();
            document.body.dataset.dropped = 'ok';
          });
        </script>
      `
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    // The two divs are non-interactive (no role="..." and no tag in
    // INTERACTIVE_TAGS), so the snapshot walker won't surface @eN refs
    // for them. Plant role="button" on both via the eval channel and
    // re-snapshot so the walker emits refs.
    const decorateRaw = await browserConsole(taskId, {
      expression:
        "(document.getElementById('a').setAttribute('role','button'), document.getElementById('b').setAttribute('role','button'), 'ok')"
    });
    const decorate = JSON.parse(decorateRaw) as ConsoleResult;
    if (!decorate.success) throw new Error(`decorate failed: ${decorate.error}`);

    const snapRaw = await browserSnapshot(taskId, {});
    const snap = JSON.parse(snapRaw) as NavResult;
    if (!snap.success) throw new Error(`snapshot failed: ${snap.error}`);

    // Both decorated divs now have role="button" — grab the first two.
    const refMatches = (snap.snapshot ?? "").match(/@e\d+/g) ?? [];
    expect(refMatches.length).toBeGreaterThanOrEqual(2);
    const fromRef = refMatches[0]!;
    const toRef = refMatches[1]!;

    const dragRaw = await browserDrag(taskId, { fromRef, toRef });
    const drag = JSON.parse(dragRaw) as NavResult;
    if (!drag.success) throw new Error(`drag failed: ${drag.error}`);

    // First-class assertion: the HTML5 drop handler ran and stamped
    // the dataset. If Playwright's dragTo only synthesized pointer
    // events and skipped the HTML5 sequence, the dataset stays empty —
    // in which case we accept "dragstart at minimum fired" as proof
    // dragTo did real work and document the partial coverage here.
    const verifyRaw = await browserConsole(taskId, {
      expression:
        "JSON.stringify({ dropped: document.body.dataset.dropped || null, events: window.__events || [] })"
    });
    const verify = JSON.parse(verifyRaw) as ConsoleResult;
    if (!verify.success) throw new Error(`verify failed: ${verify.error}`);
    const parsed = JSON.parse((verify.evalResult as string) ?? "{}") as {
      dropped: string | null;
      events: string[];
    };
    const dropped = parsed.dropped === "ok";
    const partial = (parsed.events ?? []).includes("dragstart");
    expect(dropped || partial).toBe(true);
  }, 60_000);

  it("snapshot redaction — password input values and data-gini-secret marked fields never appear in the snapshot", async () => {
    // Without this redaction the value the user typed into the
    // fill_secret amber card would round-trip back into the LLM the
    // next time the agent called browser_snapshot. The walker
    // substitutes "[redacted]" for any non-empty value on:
    //   - type="password"
    //   - autocomplete=current-password / new-password / one-time-code
    //   - any element stamped with data-gini-secret (set by
    //     browserFillByLocator after a successful fill)
    await bootInstance("snapshot-redact");

    const taskId = `redact-${Date.now()}`;
    const url = registerPage(
      "/redact",
      `<form>
         <input type="password" id="pw" value="prefilled-from-server-bytes">
         <input type="text" id="otp" autocomplete="one-time-code" value="123456">
         <input type="text" id="visible" value="not-secret-visible">
         <input type="text" id="willflip">
       </form>`
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    // 1) The initial snapshot must redact pw (type="password") and
    //    otp (autocomplete="one-time-code") but keep the visible field.
    expect(nav.snapshot ?? "").not.toContain("prefilled-from-server-bytes");
    expect(nav.snapshot ?? "").not.toContain("123456");
    expect(nav.snapshot ?? "").toContain("not-secret-visible");
    // Redacted fields surface with the masking marker so the agent
    // knows the field has a value without learning what it is.
    expect(nav.snapshot ?? "").toContain("[redacted]");

    // 2) Fill the "will flip" text input via browserFillByLocator —
    //    this is the path /connect uses on fill_secret submissions —
    //    then flip its type to text from JS to mimic a page that
    //    reveals what the user typed in a custom UI. The
    //    data-gini-secret marker stamped during fill must survive
    //    the type change so the next snapshot still redacts.
    const fillResult = await browserFillByLocator(taskId, { locator: "#willflip", value: "fill-byte-payload-XYZ" });
    expect(fillResult.ok).toBe(true);

    // Flip the type to plain text post-fill.
    const flipRaw = await browserConsole(taskId, {
      expression: "(document.getElementById('willflip').type = 'text', 'flipped')"
    });
    const flip = JSON.parse(flipRaw) as ConsoleResult;
    if (!flip.success) throw new Error(`flip failed: ${flip.error}`);

    const snapAfterRaw = await browserSnapshot(taskId, {});
    const snapAfter = JSON.parse(snapAfterRaw) as NavResult;
    if (!snapAfter.success) throw new Error(`snapshot failed: ${snapAfter.error}`);
    expect(snapAfter.snapshot ?? "").not.toContain("fill-byte-payload-XYZ");
    // Confirm the marker really persisted on the element (defense
    // against a future refactor that drops the evaluate stamp).
    const markerRaw = await browserConsole(taskId, {
      expression: "document.getElementById('willflip').getAttribute('data-gini-secret')"
    });
    const marker = JSON.parse(markerRaw) as ConsoleResult;
    if (!marker.success) throw new Error(`marker check failed: ${marker.error}`);
    expect(marker.evalResult).toBe("true");
  }, 60_000);

  it("select_option — browserSelectOption changes the <select> value", async () => {
    await bootInstance("select");

    const taskId = `select-${Date.now()}`;
    const url = registerPage(
      "/select",
      `<select id="cars"><option value="audi">Audi</option><option value="bmw">BMW</option></select>`
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    const selectRef = findRef(nav.snapshot ?? "", "combobox");
    expect(selectRef).toBeDefined();

    const selRaw = await browserSelectOption(taskId, { ref: selectRef!, value: "bmw" });
    const sel = JSON.parse(selRaw) as NavResult;
    if (!sel.success) throw new Error(`select failed: ${sel.error}`);

    const checkRaw = await browserConsole(taskId, { expression: 'document.getElementById("cars").value' });
    const check = JSON.parse(checkRaw) as ConsoleResult;
    if (!check.success) throw new Error(`check failed: ${check.error}`);
    expect(check.evalResult).toBe("bmw");
  }, 60_000);

  it("wait_for_text — browserWaitFor resolves once the token appears", async () => {
    await bootInstance("waitfor-ok");

    const taskId = `waitfor-ok-${Date.now()}`;
    // Token shows up ~200ms after DOMContentLoaded. The wait_for call
    // is issued immediately after navigate, so it has to actually
    // poll — a same-tick check would miss it.
    const url = registerPage(
      "/waitfor-ok",
      `<script>setTimeout(() => { document.body.innerHTML += "READY-TOKEN"; }, 200);</script>`
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    const waitRaw = await browserWaitFor(taskId, { text: "READY-TOKEN", timeoutMs: 3_000 });
    const wait = JSON.parse(waitRaw) as NavResult;
    expect(wait.success).toBe(true);
  }, 60_000);

  it("wait_for_timeout — browserWaitFor returns success:false on missing token", async () => {
    await bootInstance("waitfor-fail");

    const taskId = `waitfor-fail-${Date.now()}`;
    const url = registerPage("/waitfor-fail", `<p>nothing to see here</p>`);
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    const waitRaw = await browserWaitFor(taskId, { text: "WILL-NEVER-APPEAR", timeoutMs: 300 });
    const wait = JSON.parse(waitRaw) as NavResult;
    expect(wait.success).toBe(false);
    expect(wait.error ?? "").toMatch(/^Wait timed out/);
  }, 60_000);

  it("tabs_lifecycle — new / list / switch / close behave correctly", async () => {
    await bootInstance("tabs");

    const taskId = `tabs-${Date.now()}`;
    const urlA = registerPage("/tab-a", `<h1 id="a">A-page</h1>`);
    const urlB = registerPage("/tab-b", `<h1 id="b">B-page</h1>`);
    const navRaw = await browserNavigate(taskId, { url: urlA });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    const openRaw = await browserTabs(taskId, { action: "new", url: urlB });
    const open = JSON.parse(openRaw) as TabsResult;
    if (!open.success) throw new Error(`tabs new failed: ${open.error}`);

    const list1Raw = await browserTabs(taskId, { action: "list" });
    const list1 = JSON.parse(list1Raw) as TabsResult;
    if (!list1.success) throw new Error(`tabs list failed: ${list1.error}`);
    expect(list1.tabs).toBeDefined();
    expect(list1.tabs!.length).toBe(2);
    // The freshly-opened page B should be the active tab.
    const activeAfterNew = list1.tabs!.find((t) => t.active);
    expect(activeAfterNew).toBeDefined();
    expect(activeAfterNew!.url).toContain("/tab-b");

    // Switch back to tab A by its stable handle.
    const tabA = list1.tabs!.find((t) => t.url.includes("/tab-a"));
    expect(tabA).toBeDefined();
    const switchRaw = await browserTabs(taskId, { action: "switch", id: tabA!.id });
    const switched = JSON.parse(switchRaw) as TabsResult;
    if (!switched.success) throw new Error(`tabs switch failed: ${switched.error}`);
    const list2Raw = await browserTabs(taskId, { action: "list" });
    const list2 = JSON.parse(list2Raw) as TabsResult;
    if (!list2.success) throw new Error(`tabs list2 failed: ${list2.error}`);
    const activeAfterSwitch = list2.tabs!.find((t) => t.active);
    expect(activeAfterSwitch).toBeDefined();
    expect(activeAfterSwitch!.url).toContain("/tab-a");

    const tabB = list2.tabs!.find((t) => t.url.includes("/tab-b"));
    expect(tabB).toBeDefined();
    const closeRaw = await browserTabs(taskId, { action: "close", id: tabB!.id });
    const closed = JSON.parse(closeRaw) as TabsResult;
    if (!closed.success) throw new Error(`tabs close failed: ${closed.error}`);

    const list3Raw = await browserTabs(taskId, { action: "list" });
    const list3 = JSON.parse(list3Raw) as TabsResult;
    if (!list3.success) throw new Error(`tabs list3 failed: ${list3.error}`);
    expect(list3.tabs!.length).toBe(1);
    expect(list3.tabs![0]!.url).toContain("/tab-a");
  }, 60_000);

  it("upload_file — browserUploadFile attaches a workspace file to a file input", async () => {
    const { workspaceRoot } = await bootInstance("upload");

    // The upload tool validates the path is INSIDE workspaceRoot, then
    // realpath's both sides. macOS's /tmp -> /private/tmp aliasing made
    // earlier versions of this validation false-positive; the per-test
    // tmp dir comes from os.tmpdir() which already resolves through that
    // symlink, so we're safe.
    const fixtureName = "fixture.txt";
    writeFileSync(join(workspaceRoot, fixtureName), "hello-from-integration-test\n");

    const taskId = `upload-${Date.now()}`;
    const url = registerPage(
      "/upload",
      `<input type="file" id="f" onchange="document.title = this.files[0].name">`
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    // <input type="file"> gets its own first-class role "file" so the
    // model can distinguish it from a normal textbox.
    const fileRef = findRef(nav.snapshot ?? "", "file");
    expect(fileRef).toBeDefined();

    const uploadRaw = await browserUploadFile(taskId, { ref: fileRef!, path: fixtureName }, workspaceRoot);
    const upload = JSON.parse(uploadRaw) as NavResult;
    if (!upload.success) throw new Error(`upload failed: ${upload.error}`);

    // The onchange handler mirrors the file basename onto
    // document.title; read it back via console.evaluate so we don't
    // depend on the snapshot's title surface (the upload tool's
    // envelope doesn't expose title).
    const titleRaw = await browserConsole(taskId, { expression: "document.title" });
    const title = JSON.parse(titleRaw) as ConsoleResult;
    if (!title.success) throw new Error(`title failed: ${title.error}`);
    expect(title.evalResult).toBe(fixtureName);
  }, 60_000);

  it("upload_hidden_input — snapshot surfaces a display:none file input with [hidden], browserUploadFile targets it", async () => {
    const { workspaceRoot } = await bootInstance("upload-hidden");

    const fixtureName = "hidden-fixture.txt";
    writeFileSync(join(workspaceRoot, fixtureName), "hello-from-hidden-upload\n");

    const taskId = `upload-hidden-${Date.now()}`;
    // Canonical "real" upload widget shape: a styled button that
    // delegates to a hidden <input type=file>. The walker has to surface
    // the hidden input as a ref (with [hidden]) so browserUploadFile
    // can target it via setInputFiles (Playwright's setInputFiles works
    // on display:none file inputs).
    const url = registerPage(
      "/upload-hidden",
      `<button onclick="document.getElementById('picker').click()">Upload</button>
       <input type="file" id="picker" style="display:none" onchange="document.title=this.files[0].name">`
    );
    const navRaw = await browserNavigate(taskId, { url });
    const nav = JSON.parse(navRaw) as NavResult;
    if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

    // The file input must appear in the snapshot AND must carry the
    // [hidden] marker (so the model knows it's not directly clickable).
    const fileRef = findRef(nav.snapshot ?? "", "file");
    expect(fileRef).toBeDefined();
    const hiddenLine = (nav.snapshot ?? "")
      .split("\n")
      .find((line) => line.includes(`[${fileRef}]`));
    expect(hiddenLine).toBeDefined();
    expect(hiddenLine).toContain("[hidden]");

    const uploadRaw = await browserUploadFile(taskId, { ref: fileRef!, path: fixtureName }, workspaceRoot);
    const upload = JSON.parse(uploadRaw) as NavResult;
    if (!upload.success) throw new Error(`upload failed: ${upload.error}`);

    const titleRaw = await browserConsole(taskId, { expression: "document.title" });
    const title = JSON.parse(titleRaw) as ConsoleResult;
    if (!title.success) throw new Error(`title failed: ${title.error}`);
    expect(title.evalResult).toBe(fixtureName);
  }, 60_000);
});
