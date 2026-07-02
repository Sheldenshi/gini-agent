"use client";

import { createContext, useContext, type ReactNode } from "react";

// Carries the eagerly-fetched set of already-sent Gmail draft ids down to the
// deeply-nested EmailDraftCard. ChatSurface fires the fetch (useSentDrafts) on
// chat mount and provides the result here, so a draft card can resolve its
// "Sent" state from context on first render instead of waiting on its own mount
// query — which is what removes the "Send" flash on refresh. `loaded` is false
// until the query settles; the default (no provider) is an empty, unloaded set.
type SentDraftsValue = { sentIds: Set<string>; loaded: boolean };

const SentDraftsContext = createContext<SentDraftsValue>({ sentIds: new Set(), loaded: false });

export function SentDraftsProvider({
  value,
  children
}: {
  value: SentDraftsValue;
  children: ReactNode;
}) {
  return <SentDraftsContext.Provider value={value}>{children}</SentDraftsContext.Provider>;
}

export function useSentDraftIds(): SentDraftsValue {
  return useContext(SentDraftsContext);
}
