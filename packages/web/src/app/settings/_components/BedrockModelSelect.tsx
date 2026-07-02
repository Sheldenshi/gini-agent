"use client";

// Model picker for the Bedrock provider. Bedrock's model space is the open set
// of cross-region inference-profile ids, so rather than make the user type one,
// this renders the catalog ids as a dropdown grouped by model family, plus a
// "Custom model id…" escape hatch that reveals a free-text input for an id the
// catalog doesn't list (a region geo we don't enumerate, a brand-new model).
// The current value is always reachable: if it isn't one of the catalog ids the
// picker opens in custom mode with that value prefilled.

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

const CUSTOM = "__custom__";

// id segment (after an optional geo prefix) -> human family label.
const FAMILY_LABEL: Record<string, string> = {
  anthropic: "Anthropic Claude",
  amazon: "Amazon Nova",
  meta: "Meta Llama",
  mistral: "Mistral AI",
  deepseek: "DeepSeek",
  cohere: "Cohere",
  ai21: "AI21 Labs",
  writer: "Writer",
  qwen: "Qwen"
};

// Geo prefixes used by cross-region inference profiles (us.anthropic.…, etc.).
const GEO_PREFIXES = new Set(["us", "eu", "apac", "global", "us-gov", "ca", "sa", "apne"]);

function familyOf(id: string): string {
  const parts = id.split(".");
  const provider = parts.length > 1 && GEO_PREFIXES.has(parts[0]!) ? parts[1]! : parts[0]!;
  if (!provider) return "Other";
  return FAMILY_LABEL[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Bucket a flat id list into ordered family groups, preserving first-seen order.
export function groupBedrockModels(models: string[]): { label: string; models: string[] }[] {
  const order: string[] = [];
  const byFamily = new Map<string, string[]>();
  for (const id of models) {
    const family = familyOf(id);
    if (!byFamily.has(family)) {
      byFamily.set(family, []);
      order.push(family);
    }
    byFamily.get(family)!.push(id);
  }
  return order.map((label) => ({ label, models: byFamily.get(label)! }));
}

export function BedrockModelSelect({
  models,
  value,
  onChange,
  disabled,
  id,
  triggerClassName
}: {
  models: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  triggerClassName?: string;
}) {
  const groups = groupBedrockModels(models);
  const isKnown = models.includes(value);
  const [custom, setCustom] = useState(!isKnown && value.trim() !== "");

  // Resync the custom-mode flag when the controlled value (or catalog) changes
  // externally — e.g. a background status refetch resets the edit form. Keyed on
  // value/models, it never fires on the in-component "Custom…" toggle (which
  // leaves value untouched), so it can't yank the user out of custom mode.
  useEffect(() => {
    setCustom(!models.includes(value) && value.trim() !== "");
  }, [value, models]);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setCustom(true);
      return;
    }
    setCustom(false);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <Select value={custom ? CUSTOM : value} onValueChange={handleSelect} disabled={disabled}>
        <SelectTrigger id={id} className={triggerClassName}>
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent className="max-h-[340px]">
          {groups.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.models.map((m) => (
                <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectGroup>
            <SelectLabel>Other</SelectLabel>
            <SelectItem value={CUSTOM}>Custom model id…</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {custom ? (
        <Input
          aria-label="Custom Bedrock model id"
          type="text"
          autoComplete="off"
          placeholder="us.anthropic.claude-opus-4-8"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={triggerClassName ? `${triggerClassName} font-mono` : "font-mono"}
        />
      ) : null}
    </div>
  );
}
