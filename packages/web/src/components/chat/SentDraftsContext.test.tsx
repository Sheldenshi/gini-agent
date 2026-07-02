/// <reference lib="dom" />

// SentDraftsProvider carries the eagerly-fetched sent-draft id set down to the
// nested EmailDraftCard. These tests pin that a consumer reads the provided
// value, and that the hook falls back to an empty, unloaded set with no
// provider mounted (the default a card sees outside ChatSurface).

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { SentDraftsProvider, useSentDraftIds } from "./SentDraftsContext";

function Probe() {
  const { sentIds, loaded } = useSentDraftIds();
  return (
    <div>
      <span data-testid="ids">{[...sentIds].join(",") || "none"}</span>
      <span data-testid="loaded">{String(loaded)}</span>
    </div>
  );
}

describe("SentDraftsProvider", () => {
  test("a consumer reads the provided sent ids and loaded flag", () => {
    render(
      <SentDraftsProvider value={{ sentIds: new Set(["rA", "rB"]), loaded: true }}>
        <Probe />
      </SentDraftsProvider>
    );
    expect(screen.getByTestId("ids").textContent).toBe("rA,rB");
    expect(screen.getByTestId("loaded").textContent).toBe("true");
  });

  test("useSentDraftIds defaults to an empty, unloaded set with no provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("ids").textContent).toBe("none");
    expect(screen.getByTestId("loaded").textContent).toBe("false");
  });
});
