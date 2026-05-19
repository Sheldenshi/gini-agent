"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatSession } from "./view-types";

// Per-browser tracking of when the user last viewed each chat session.
// A session is "unread" when its activity timestamp is newer than the
// stored lastRead. State lives in localStorage so it survives reloads
// but is intentionally per-device — runtime-side read state would
// require a multi-client sync model the gateway doesn't have yet.
//
// Activity timestamp is the max of `session.updatedAt` and the latest
// terminal-run `updatedAt`. The list endpoint reports session.updatedAt
// at message-persistence time, but messages are only materialized when
// the user is actively viewing the chat. A run's updatedAt advances on
// status transitions (including completion) regardless of who's
// watching, so checking terminal-run timestamps catches the case where
// the user clicked away mid-stream and the assistant reply finished
// while another chat was on screen.

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

// The list endpoint enriches each ChatSessionRecord with `runs`. The
// shared ChatSession type doesn't reflect that, so we narrow locally
// to just the fields we read.
interface SessionLikeRun {
  status: string;
  updatedAt: string;
}
interface SessionLike {
  id: string;
  createdAt: string;
  updatedAt: string;
  runs?: SessionLikeRun[];
}

function activityAt(session: SessionLike): string {
  let max = session.updatedAt ?? session.createdAt;
  for (const run of session.runs ?? []) {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
    if (run.updatedAt > max) max = run.updatedAt;
  }
  return max;
}

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
  //
  // `sessions === undefined` means the chat-list query hasn't resolved
  // yet — wait, otherwise we'd flip `initialized` to true with an empty
  // map and treat every real session that arrives later as unread.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessions === undefined) return;
    const current = getState();
    if (current.initialized) return;
    const map: ReadMap = { ...current.map };
    for (const s of sessions) {
      if (!map[s.id]) map[s.id] = activityAt(s as SessionLike);
    }
    setState({ map, initialized: true });
  }, [sessions]);

  const markRead = useCallback((session: ChatSession) => {
    const at = activityAt(session as SessionLike);
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
      const at = activityAt(session as SessionLike);
      const seen = state.map[session.id];
      if (!seen) return true;
      return at > seen;
    },
    [state]
  );

  // Expose activityAt so callers can wire it into effect dependencies —
  // markRead should re-fire when the selected session's activity
  // timestamp advances (e.g., its task finishes while it's open),
  // not just when `session.updatedAt` does.
  return { isUnread, markRead, activityAt: (session: ChatSession) => activityAt(session as SessionLike) };
}
