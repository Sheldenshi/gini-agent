// View-only types for the web app.
//
// Anything that mirrors a runtime contract should be imported from
// `@runtime/types` directly so this app cannot drift from the runtime.
// Keep this file small — it's only for UI-shaped types that genuinely have
// no runtime counterpart, plus aliases that rename a runtime type for UI use.

import type {
  ChatSessionRecord,
  ChatMessageRecord,
  Task,
  Approval,
  AuditEvent,
  MemoryRecord,
  SkillRecord,
  JobRecord,
  IdentityRecord,
  ImprovementProposal,
  PairedDevice,
  RuntimeEvent,
  JobRunRecord
} from "@runtime/types";

// UI-friendly aliases for chat records.
export type ChatSession = ChatSessionRecord;
export type ChatMessage = ChatMessageRecord;

// UI-narrowed snapshot returned by GET /state. The runtime sends the full
// RuntimeState; the UI only consumes a subset of fields and treats some
// records as opaque arrays.
export interface RuntimeStateSnapshot {
  instance: string;
  tasks: Task[];
  approvals: Approval[];
  audit: AuditEvent[];
  memories: MemoryRecord[];
  skills: SkillRecord[];
  jobs: JobRecord[];
  identities: IdentityRecord[];
  improvements: ImprovementProposal[];
  devices: PairedDevice[];
  promotions: Array<{
    id: string;
    status: string;
    candidateRef: string;
    summary: string;
    rollbackPlan: string;
    evidencePath?: string;
    createdAt: string;
  }>;
  toolsets: unknown[];
  subagents: unknown[];
  mcpServers: unknown[];
  messagingBridges: unknown[];
  messagingMessages: unknown[];
  importReports: unknown[];
  agents: unknown[];
  activeAgentId?: string;
  relays: unknown[];
  notifications: unknown[];
  events: RuntimeEvent[];
  jobRuns: JobRunRecord[];
  chatSessions: ChatSession[];
  chatMessages: ChatMessage[];
  snapshots: unknown[];
}

// Hindsight memory views (phase 5).
//
// These mirror the SQLite-backed memory store surfaces. We don't pull the
// `HindsightMemoryUnit` type from the runtime directly because it includes a
// Float32Array embedding column that we never serialize over the wire — the
// shapes below match what /api/memory/units actually returns.
export interface HindsightUnitView {
  id: string;
  bankId: string;
  text: string;
  network: "world" | "experience" | "opinion" | "observation";
  confidence: number | null;
  metadata: Record<string, unknown>;
  occurredStart: string | null;
  occurredEnd: string | null;
  mentionedAt: string;
  status: string;
  sourceTaskId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
  kind: "hindsight";
}

export interface HindsightBankView {
  id: string;
  name: string;
  agentName: string | null;
  background: string | null;
  skepticism: number;
  literalism: number;
  empathy: number;
  biasStrength: number;
  createdAt: string;
  updatedAt: string;
}

export interface HindsightRecallView {
  units: Array<{
    unit: HindsightUnitView;
    score: number;
    channels: string[];
    subscores: Record<string, number>;
  }>;
  totalTokens: number;
  usage: Record<string, unknown>;
}

export interface HindsightReflectView {
  response: string;
  opinions: HindsightUnitView[];
  recalled: number;
  usage: Record<string, unknown>;
}

