"use client";

import { createContext, useContext } from "react";

// Lets a card rendered deep in the message list (e.g. the inline email-draft
// card) hand an action back to the chat without prop-drilling through the
// MarkdownContent → BlockRenderer tree. ChatSurface provides it; non-chat
// surfaces that also render MarkdownContent (doc viewer, file preview, the
// skills page) leave it null, so those cards render read-only.
export interface ChatActions {
  sessionId: string;
  // Posts a user message to the current chat session via the same send path the
  // composer uses, so the action runs through Gini's normal flow.
  sendUserMessage: (text: string) => void;
}

const ChatActionsContext = createContext<ChatActions | null>(null);

export function ChatActionsProvider({
  value,
  children
}: {
  value: ChatActions;
  children: React.ReactNode;
}) {
  return <ChatActionsContext.Provider value={value}>{children}</ChatActionsContext.Provider>;
}

export function useChatActions(): ChatActions | null {
  return useContext(ChatActionsContext);
}
