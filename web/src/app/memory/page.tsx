"use client";

import { PageHeader } from "@/components/PageHeader";
import { useStatus } from "@/lib/queries";
import { HindsightPanel } from "./_components/HindsightPanel";

// The legacy "user-curated MemoryRecord rows" panel was removed
// alongside the state.memories consolidation. USER.md and SOUL.md are
// the human-curated layers; Hindsight is the recall-on-demand layer
// shown below. See ADR memory-surface-consolidation.md.
export default function MemoryPage() {
  const status = useStatus();
  const activeAgentName = status.data?.activeAgent?.name;

  return (
    <>
      <PageHeader
        title="Memory"
        description={activeAgentName
          ? `Hindsight — long-term memory for agent: ${activeAgentName}`
          : "Hindsight — long-term memory recall"}
      />
      <div className="flex-1 space-y-6 overflow-auto p-6">
        <HindsightPanel />
      </div>
    </>
  );
}
