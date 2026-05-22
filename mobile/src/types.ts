// UI-shaped types for the mobile client. Mirrors the wire shapes the
// runtime gateway sends; we keep only the fields the mobile screens
// actually read so a runtime field rename doesn't silently fan out
// across the app.

// ChatBlock is the typed conversation block the runtime emits over the
// /api/chat/:id/blocks (and /stream) endpoints. We re-export from
// `@runtime/types` so the mobile client cannot drift from the wire
// contract — adding a new block kind to src/types.ts immediately fans
// out into the renderer's exhaustive switch here.
export type {
  ChatBlock,
  ChatBlockKind,
  UserTextBlock,
  AssistantTextBlock,
  ToolCallBlock,
  ToolCallStatus,
  ToolResultBlock,
  PhaseBlock,
  ApprovalRequestedBlock,
  SystemNoteBlock
} from "@runtime/types";

export interface ChatSession {
  id: string;
  instance: string;
  agentId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  runIds?: string[];
  summary?: string;
  source?: string;
  // Server-computed latest user_text / assistant_text content for the
  // session, truncated to ~140 chars on the runtime side. Null when the
  // session has no qualifying blocks yet (empty chat). Used by the chat
  // list to render a one-line subtitle below the title.
  lastMessagePreview?: string | null;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  instance: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  status: TaskStatus;
  currentStep?: string;
  summary?: string;
  agentId?: string;
}

export interface AgentRecord {
  id: string;
  instance: string;
  name: string;
  status: string;
  providerName?: string;
  model?: string;
  toolsets?: unknown[];
  messagingTargets?: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentsResponse {
  activeAgentId?: string;
  agents: AgentRecord[];
}

export interface RuntimeStatus {
  instance?: string;
  activeAgent?: { id: string; name: string } | null;
}

export type ChatSessionDetail = ChatSession & {
  messages: ChatMessage[];
  tasks: Task[];
};
