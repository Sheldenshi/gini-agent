import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
  AnthropicLogo,
  AzureLogo,
  BedrockLogo,
  DeepSeekLogo,
  OllamaLogo,
  OpenAILogo,
  PROVIDER_ICONS,
  providerIcon
} from "./provider-logos";

describe("provider-logos", () => {
  test("each brand logo renders an svg with a path and forwards className", () => {
    for (const Logo of [AnthropicLogo, AzureLogo, BedrockLogo, DeepSeekLogo, OllamaLogo, OpenAILogo]) {
      const { container, unmount } = render(<Logo className="size-5" />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("class")).toBe("size-5");
      expect(svg?.querySelector("path")).not.toBeNull();
      unmount();
    }
  });

  test("providerIcon maps catalog names to their brand icon and falls back for unknowns", () => {
    expect(providerIcon("openai")).toBe(OpenAILogo);
    expect(providerIcon("bedrock")).toBe(BedrockLogo);
    for (const name of Object.keys(PROVIDER_ICONS)) {
      expect(providerIcon(name)).toBe(PROVIDER_ICONS[name]!);
    }
    // Unknown provider and no selection both get the generic model mark.
    const fallback = providerIcon(undefined);
    expect(providerIcon("acme-llm")).toBe(fallback);
    const { container } = render(<>{(() => { const Icon = fallback; return <Icon className="size-4" />; })()}</>);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
