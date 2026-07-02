"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatSession } from "./view-types";

// Per-browser tracking of when the user last viewed each chat session.
// A session is "unread" when its activity timestamp is newer than the
// stored lastRead. State lives in localStorage so it survives reloads
// but is intentionally per-device — runtime-side read state would
// require a multi-client sync model the gateway doesn't have yet.
//
// Activity timestamp is the createdAt of the latest DELIVERED assistant
// message — never mid-run progress. A run carries `assistantMessageId`
// only once its terminal answer is persisted as a durable chat message
// (syncChatTaskResult / persistFinalAnswerRow), and its `updatedAt` is
// stamped to that message's createdAt at the same write. So a run with
// `assistantMessageId` set means "a final reply landed in this channel
// at run.updatedAt" — exactly the unread signal we want, and it's
// stamped server-side regardless of who's watching, which catches the
// case where the user clicked away mid-stream and the reply finished
// while another chat was on screen.
//
// We deliberately IGNORE `session.updatedAt` and bare terminal runs.
// session.updatedAt advances on dispatch, run creation, and subagent
// attach; subagent child runs go terminal one-by-one mid-parent-run.
// All of that is "something is happening" (tool calls, streaming) that
// must NOT re-flag a job channel as unread while it's still working —
// the channel should surface as unread only when the final reply lands.

// The list endpoint enriches each ChatSessionRecord with `runs`. The
// shared ChatSession type doesn't reflect that, so we narrow locally
// to just the fields we read.
interface SessionLikeRun {
  updatedAt: string;
  assistantMessageId?: string;
}
interface SessionLike {
  id: string;
  createdAt: string;
  updatedAt: string;
  runs?: SessionLikeRun[];
  origin?: "job";
}

function activityAt(session: SessionLike): string {
  // Floor at createdAt (immutable) — never session.updatedAt, which
  // advances on mid-run activity. Only delivered assistant replies
  // (runs with assistantMessageId) move the timestamp forward.
  let max = session.createdAt;
  for (const run of session.runs ?? []) {
    if (!run.assistantMessageId) continue;
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
      // Job-originated sessions stay unread until the user opens them —
      // skip seeding so they fall through to the `!seen` branch below
      // and surface as new on first load after the feature ships.
      if (s.origin === "job") continue;
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
