/// <reference lib="dom" />

// AppShell picks the layout from the route: /pair (and /pair/*) renders children
// bare (no app chrome); every other route wraps children in the full shell
// (Sidebar + MobileTopBar). Only usePathname drives that branch.
//
// LEAK SAFETY + COVERAGE SCOPE: mock.module is process-wide in `bun test`, so we
// only mock specifiers that no OTHER test renders as its subject:
//   - next/navigation (node_module; spread + usePathname override; reverted so it
//     can't leak — node_modules aren't counted for coverage)
//   - @/components/Sidebar (no other test imports it, so the stub needs no revert)
// We deliberately do NOT import the real @/components/Sidebar: pulling that src
// file in would register it (and its heavy AgentSwitcher / CreateAgentDialog /
// TunnelMenu deps) for the 100% coverage gate without covering it. The stub fully
// replaces it. The tunnel chrome now lives INSIDE Sidebar (its own footer row),
// so the shell branch is observable purely via the Sidebar / MobileTopBar stubs —
// AppShell no longer mounts TunnelMenu directly, so there's no on-mount fetch to
// drain here.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";

const realNav = await import("next/navigation");

let pathname: string | null = "/";
let AppShell: typeof import("./AppShell").AppShell;

beforeAll(async () => {
  mock.module("next/navigation", () => ({ ...realNav, usePathname: () => pathname }));
  mock.module("@/components/Sidebar", () => ({
    Sidebar: () => <div data-testid="sidebar-stub" />,
    MobileTopBar: () => <div data-testid="mobile-topbar-stub" />
  }));
  // The query suffix is a runtime cache-bust; keep it in a variable so tsc treats
  // the dynamic import as `any` instead of trying to resolve the suffixed path.
  const appShellPath = "./AppShell?appshell-test";
  ({ AppShell } = (await import(appShellPath)) as typeof import("./AppShell"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
});

const CHILD = <div data-testid="child">child content</div>;

function renderShell() {
  return render(<AppShell>{CHILD}</AppShell>);
}

beforeEach(() => {
  pathname = "/";
});

describe("AppShell", () => {
  test("normal route: wraps children in the full shell (Sidebar + MobileTopBar)", () => {
    pathname = "/chat";
    const { container } = renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(screen.queryByTestId("mobile-topbar-stub")).not.toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
    // The shell's distinctive flex container is present on non-/pair routes.
    expect(container.querySelector(".flex.h-screen")).not.toBeNull();
  });

  test("/pair: renders only children, no app chrome", () => {
    pathname = "/pair";
    const { container } = renderShell();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(screen.queryByTestId("mobile-topbar-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
  });

  test("a /pair-prefixed route like /pairing still gets the full shell (exact match, not prefix)", () => {
    pathname = "/pairing";
    const { container } = renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(container.querySelector(".flex.h-screen")).not.toBeNull();
  });

  test("/pair/* subpaths also render bare", () => {
    pathname = "/pair/done";
    const { container } = renderShell();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
  });

  test("a null pathname falls through to the full shell", () => {
    pathname = null;
    renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
  });
});
