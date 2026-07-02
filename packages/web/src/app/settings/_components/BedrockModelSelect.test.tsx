import { describe, expect, test } from "bun:test";
import { groupBedrockModels } from "./BedrockModelSelect";

describe("groupBedrockModels", () => {
  test("buckets ids by family, in first-seen order, folding geo prefixes together", () => {
    const groups = groupBedrockModels([
      "us.anthropic.claude-opus-4-8",
      "eu.anthropic.claude-sonnet-4-6",
      "us.amazon.nova-pro-v1:0",
      "apac.amazon.nova-lite-v1:0",
      "us.meta.llama4-scout-17b-instruct-v1:0"
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Anthropic Claude", "Amazon Nova", "Meta Llama"]);
    expect(groups[0]!.models).toEqual(["us.anthropic.claude-opus-4-8", "eu.anthropic.claude-sonnet-4-6"]);
    expect(groups[1]!.models).toEqual(["us.amazon.nova-pro-v1:0", "apac.amazon.nova-lite-v1:0"]);
  });

  test("handles ids with no geo prefix and unknown providers", () => {
    const groups = groupBedrockModels(["anthropic.claude-opus-4-8", "us.acme.frontier-v1:0", "global.anthropic.claude-sonnet-4-6"]);
    // bare anthropic and global.anthropic fold into the same family; acme is capitalized.
    expect(groups.map((g) => g.label)).toEqual(["Anthropic Claude", "Acme"]);
    expect(groups[0]!.models).toEqual(["anthropic.claude-opus-4-8", "global.anthropic.claude-sonnet-4-6"]);
  });

  test("returns an empty list for no models", () => {
    expect(groupBedrockModels([])).toEqual([]);
  });
});
