import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AnthropicLogo, DeepSeekLogo, OllamaLogo, OpenAILogo } from "./provider-logos";

describe("provider-logos", () => {
  test("each brand logo renders an svg with a path and forwards className", () => {
    for (const Logo of [AnthropicLogo, DeepSeekLogo, OllamaLogo, OpenAILogo]) {
      const { container, unmount } = render(<Logo className="size-5" />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("class")).toBe("size-5");
      expect(svg?.querySelector("path")).not.toBeNull();
      unmount();
    }
  });
});
