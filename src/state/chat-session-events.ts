// Chat-session record pub/sub. Companion to chat-blocks.ts pub/sub:
// chat_blocks streams per-block updates, this stream emits per-session
// record updates (currently: title renames). The SSE route in src/http.ts
// fans both out on the same /api/chat/:id/stream connection so the
// mobile client only opens one socket.
//
// Publishers are the chat-session mutators in src/execution/chat.ts;
// they call publishChatSession AFTER mutateState resolves so subscribers
// only ever see durable, committed records (matches the chat-blocks
// post-commit semantics — observers never glimpse a value the on-disk
// state doesn't yet have).
//
// Listeners are best-effort: a throwing handler is logged via
// console.warn and other subscribers continue to receive the event.

import { EventEmitter } from "node:events";
import type { ChatSessionRecord, Instance } from "../types";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function subscriptionKey(instance: Instance, sessionId: string): string {
  return `${instance}::${sessionId}`;
}

export function subscribeChatSession(
  instance: Instance,
  sessionId: string,
  handler: (session: ChatSessionRecord) => void
): () => void {
  const key = subscriptionKey(instance, sessionId);
  const wrapped = (session: ChatSessionRecord): void => {
    try {
      handler(session);
    } catch (error) {
      console.warn(
        `[chat-sessions] subscriber for ${key} threw:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  emitter.on(key, wrapped);
  return () => {
    emitter.off(key, wrapped);
  };
}

export function publishChatSession(
  instance: Instance,
  session: ChatSessionRecord
): void {
  emitter.emit(subscriptionKey(instance, session.id), session);
}
