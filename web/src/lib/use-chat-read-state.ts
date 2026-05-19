"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatSession } from "./view-types";

// Per-browser tracking of when the user last viewed each chat session.
// A session is "unread" when its `updatedAt` is newer than `lastReadAt`.
// State lives in localStorage so it survives reloads but is intentionally
// per-device — read state on the runtime would require a multi-client sync
// model the gateway doesn't have yet.

const STORAGE_KEY = "gini.chat.lastRead";
const INIT_FLAG_KEY = "gini.chat.lastRead.init";

type ReadMap = Record<string, string>;

interface State {
  map: ReadMap;
  initialized: boolean;
}

let cache: State | null = null;
const listeners = new Set<() => void>();

function readStorage(): State {
  if (typeof window === "undefined") return { map: {}, initialized: false };
  let map: ReadMap = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") map = parsed as ReadMap;
    }
  } catch {
    map = {};
  }
  const initialized = window.localStorage.getItem(INIT_FLAG_KEY) === "1";
  return { map, initialized };
}

function persist(state: State) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.map));
    if (state.initialized) window.localStorage.setItem(INIT_FLAG_KEY, "1");
  } catch {
    // Quota or disabled storage — silently ignore.
  }
}

function getState(): State {
  if (cache === null) cache = readStorage();
  return cache;
}

function setState(next: State) {
  cache = next;
  persist(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): State {
  return getState();
}

const SERVER_STATE: State = { map: {}, initialized: false };
function getServerSnapshot(): State {
  return SERVER_STATE;
}

export function useChatReadState(sessions: ChatSession[] | undefined) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // First-run initialization: if the user has never seen this UI before,
  // seed read timestamps for every existing session so they don't all
  // flash unread on first load after the feature ships. Sessions that
  // arrive after init has run will correctly default to unread.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessions) return;
    const current = getState();
    if (current.initialized) return;
    const map: ReadMap = { ...current.map };
    for (const s of sessions) {
      if (!map[s.id]) map[s.id] = s.updatedAt ?? s.createdAt;
    }
    setState({ map, initialized: true });
  }, [sessions]);

  const markRead = useCallback((session: ChatSession) => {
    const at = session.updatedAt ?? session.createdAt;
    const current = getState();
    if (current.map[session.id] === at) return;
    setState({
      map: { ...current.map, [session.id]: at },
      initialized: true
    });
  }, []);

  const isUnread = useCallback(
    (session: ChatSession) => {
      if (!state.initialized) return false;
      const at = session.updatedAt ?? session.createdAt;
      const seen = state.map[session.id];
      if (!seen) return true;
      return at > seen;
    },
    [state]
  );

  return { isUnread, markRead };
}
