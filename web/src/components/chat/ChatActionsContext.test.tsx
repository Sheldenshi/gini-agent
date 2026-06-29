/// <reference lib="dom" />

// ChatActionsContext lets a card rendered deep in the message list reach the
// chat's send path. These tests pin both branches the consuming cards depend on:
// outside a provider the hook returns null (so a card renders read-only), and
// inside the provider it returns the supplied actions.

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ChatActionsProvider, useChatActions } from "./ChatActionsContext";

function Probe() {
  const actions = useChatActions();
  return <div>{actions ? `session:${actions.sessionId}` : "no-context"}</div>;
}

describe("useChatActions", () => {
  test("returns null when rendered outside a provider", () => {
    render(<Probe />);
    expect(screen.getByText("no-context")).not.toBeNull();
  });

  test("returns the provided actions inside the provider", () => {
    render(
      <ChatActionsProvider value={{ sessionId: "s1", sendUserMessage: () => {} }}>
        <Probe />
      </ChatActionsProvider>
    );
    expect(screen.getByText("session:s1")).not.toBeNull();
  });
});
