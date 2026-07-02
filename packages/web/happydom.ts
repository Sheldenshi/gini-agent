// First test preload: stand up a happy-dom browser environment BEFORE any test
// or other preload imports React Testing Library. Testing Library's `screen`
// binds to `document` at module-init time, so the DOM must exist first; the
// companion preload (test-setup.ts) imports Testing Library afterwards.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { jest } from "bun:test";

// Mirror the 10s per-test ceiling the root setup enforces (see bun-test-setup.ts).
jest.setTimeout(10000);

// happy-dom's registrator overwrites the global network primitives with its own
// implementations. The BFF logic tests (proxy/runtime/trusted-origins) depend on
// Bun's spec-accurate native Request/Response/Headers/fetch, and component tests
// never construct them, so snapshot the natives and restore them after register.
const nativeNetworkGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData
};

GlobalRegistrator.register();

Object.assign(globalThis, nativeNetworkGlobals);

// Radix popover positioning relies on ResizeObserver and matchMedia, neither of
// which happy-dom implements. Inert stubs let the popover mount in tests.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof globalThis.matchMedia;
}
