/// <reference lib="dom" />

// TopicPanelProvider holds the currently-open Topic for the right-side drawer.
// These tests pin the open/close transitions and that useTopicPanel returns
// null with no provider mounted (the chip's deep-link fallback path).

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TopicPanelProvider, useTopicPanel } from "./TopicPanelContext";

function Probe() {
  const panel = useTopicPanel();
  return (
    <div>
      <span data-testid="open-id">{panel?.openTopicId ?? "none"}</span>
      <button type="button" onClick={() => panel?.openTopic("topic-1")}>
        open
      </button>
      <button type="button" onClick={() => panel?.closeTopic()}>
        close
      </button>
    </div>
  );
}

describe("TopicPanelProvider", () => {
  test("openTopic sets the open topic and closeTopic clears it", () => {
    render(
      <TopicPanelProvider>
        <Probe />
      </TopicPanelProvider>
    );
    expect(screen.getByTestId("open-id").textContent).toBe("none");

    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("open-id").textContent).toBe("topic-1");

    fireEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("open-id").textContent).toBe("none");
  });

  test("useTopicPanel returns null with no provider", () => {
    render(<Probe />);
    // No provider: the hook yields null, so the probe shows the fallback label.
    expect(screen.getByTestId("open-id").textContent).toBe("none");
  });
});
