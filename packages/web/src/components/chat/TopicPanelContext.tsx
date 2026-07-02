"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// Drives the right-side Topic panel. A forwarded-answer chip in the main Chat
// transcript calls `openTopic(topicId)` to open the Topic's own conversation in
// a drawer alongside the chat (instead of navigating away via `?session=`).
// `openTopicId` is the currently open topic, or null when the panel is closed.
type TopicPanelValue = {
  openTopicId: string | null;
  openTopic: (topicId: string) => void;
  closeTopic: () => void;
};

export const TopicPanelContext = createContext<TopicPanelValue | null>(null);

export function TopicPanelProvider({ children }: { children: ReactNode }) {
  const [openTopicId, setOpenTopicId] = useState<string | null>(null);
  const openTopic = useCallback((topicId: string) => setOpenTopicId(topicId), []);
  const closeTopic = useCallback(() => setOpenTopicId(null), []);
  const value = useMemo<TopicPanelValue>(
    () => ({ openTopicId, openTopic, closeTopic }),
    [openTopicId, openTopic, closeTopic]
  );
  return <TopicPanelContext.Provider value={value}>{children}</TopicPanelContext.Provider>;
}

// Returns the panel controls, or null when no provider is mounted. The chip
// falls back to its `?session=` link in that case so it still works outside the
// chat surface.
export function useTopicPanel(): TopicPanelValue | null {
  return useContext(TopicPanelContext);
}
