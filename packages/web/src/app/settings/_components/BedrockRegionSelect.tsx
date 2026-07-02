"use client";

// AWS region picker for the Bedrock provider. The region lands in the Converse
// host + SigV4 scope, so it's a fixed, known set — render it as a dropdown
// grouped by geo rather than a free-text field. The list is the Bedrock
// inference-profile region set from AWS's docs; a "Custom region…" escape hatch
// covers anything not enumerated (other GovCloud/opt-in regions, new ones), and
// a value not in the list opens the picker in custom mode prefilled.

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

const REGION_GROUPS: { label: string; regions: string[] }[] = [
  { label: "US", regions: ["us-east-1", "us-east-2", "us-west-2"] },
  { label: "US GovCloud", regions: ["us-gov-east-1"] },
  { label: "Europe", regions: ["eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3"] },
  { label: "Asia Pacific", regions: ["ap-northeast-1", "ap-northeast-2", "ap-south-1", "ap-southeast-1", "ap-southeast-2"] },
  { label: "Canada", regions: ["ca-central-1"] },
  { label: "South America", regions: ["sa-east-1"] }
];

const ALL_REGIONS = new Set(REGION_GROUPS.flatMap((g) => g.regions));

export function BedrockRegionSelect({
  value,
  onChange,
  disabled,
  id,
  triggerClassName
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  triggerClassName?: string;
}) {
  const [custom, setCustom] = useState(!ALL_REGIONS.has(value) && value.trim() !== "");

  // Resync the custom-mode flag when the controlled value changes externally
  // (e.g. a background status refetch resets the edit form). Keyed on value, it
  // never fires on the in-component "Custom region…" toggle (which leaves value
  // untouched), so it can't yank the user out of custom mode.
  useEffect(() => {
    setCustom(!ALL_REGIONS.has(value) && value.trim() !== "");
  }, [value]);

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
          <SelectValue placeholder="Select a region" />
        </SelectTrigger>
        <SelectContent className="max-h-[300px]">
          {REGION_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.regions.map((r) => (
                <SelectItem key={r} value={r} className="font-mono text-xs">{r}</SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectGroup>
            <SelectLabel>Other</SelectLabel>
            <SelectItem value={CUSTOM}>Custom region…</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {custom ? (
        <Input
          aria-label="Custom AWS region"
          type="text"
          autoComplete="off"
          placeholder="us-east-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={triggerClassName ? `${triggerClassName} font-mono` : "font-mono"}
        />
      ) : null}
    </div>
  );
}
