// Unit tests for the pure helpers of the call-watch hook script.
//
// Only the side-effect-free exports are covered here: deciding the tick's
// hook output from {state, payload} and building the untrusted result item.
// No network.

import { describe, expect, test } from "bun:test";
import {
  buildCallResultItem,
  buildLookupFailureOutput,
  buildMissingCredentialOutput,
  evaluateCallWatch,
  isCallFinished
} from "../call-watch";

describe("evaluateCallWatch", () => {
  test("done state short-circuits silently with no payload (post-delivery backstop)", () => {
    expect(evaluateCallWatch({ done: true })).toEqual({
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: { done: true }
    });
  });

  test("in-progress call short-circuits silently and stays not-done", () => {
    expect(evaluateCallWatch(null, { call_id: "c-123", status: "in-progress", completed: false })).toEqual({
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: {}
    });
  });

  test("completed call returns one untrusted context item and done state", () => {
    const result = evaluateCallWatch(
      {},
      {
        call_id: "c-123",
        status: "completed",
        completed: true,
        answered_by: "human",
        call_length: 2.4,
        summary: "Booked a table for two at 7pm.",
        concatenated_transcript: "assistant: Hi. user: Hello."
      }
    );
    expect(result.kind).toBe("context");
    expect(result.state).toEqual({ done: true });
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0]?.untrusted).toBe(true);
    expect(result.items?.[0]?.text).toContain("Booked a table for two at 7pm.");
  });

  test("failed call is terminal too (never polls a dead call forever)", () => {
    const result = evaluateCallWatch(null, {
      call_id: "c-123",
      status: "failed",
      completed: false,
      error_message: "Call was not answered."
    });
    expect(result.kind).toBe("context");
    expect(result.state).toEqual({ done: true });
    expect(result.items?.[0]?.text).toContain("Call was not answered.");
  });
});

describe("isCallFinished", () => {
  test("finished on completed flag, any terminal status, or a populated error_message", () => {
    expect(isCallFinished({ completed: true })).toBe(true);
    expect(isCallFinished({ completed: false, status: "completed" })).toBe(true);
    expect(isCallFinished({ completed: false, status: "failed" })).toBe(true);
    expect(isCallFinished({ completed: false, status: "busy" })).toBe(true);
    expect(isCallFinished({ completed: false, status: "no-answer" })).toBe(true);
    expect(isCallFinished({ completed: false, status: "canceled" })).toBe(true);
    expect(isCallFinished({ completed: false, error_message: "busy" })).toBe(true);
    expect(isCallFinished({ completed: false, status: "in-progress" })).toBe(false);
    expect(isCallFinished({ completed: false, status: "unknown" })).toBe(false);
    expect(isCallFinished({ completed: false })).toBe(false);
    expect(isCallFinished({ completed: false, error_message: "" })).toBe(false);
  });
});

describe("buildLookupFailureOutput", () => {
  test("4xx is terminal: untrusted context item with HTTP status and Bland message, done state", () => {
    const output = buildLookupFailureOutput(404, "Call not found.");
    expect(output.kind).toBe("context");
    expect(output.state).toEqual({ done: true });
    expect(output.items).toHaveLength(1);
    expect(output.items?.[0]?.untrusted).toBe(true);
    expect(output.items?.[0]?.text).toContain("HTTP 404");
    expect(output.items?.[0]?.text).toContain("Call not found.");
  });

  test("falls back to the HTTP status when Bland sends no message", () => {
    const output = buildLookupFailureOutput(401);
    expect(output.kind).toBe("context");
    expect(output.state).toEqual({ done: true });
    expect(output.items?.[0]?.text).toContain("Bland API returned HTTP 401");
  });
});

describe("buildMissingCredentialOutput", () => {
  test("missing BLAND_API_KEY is terminal: untrusted context item, done state (never a transient retry)", () => {
    const output = buildMissingCredentialOutput();
    expect(output.kind).toBe("context");
    expect(output.state).toEqual({ done: true });
    expect(output.items).toHaveLength(1);
    expect(output.items?.[0]?.untrusted).toBe(true);
    expect(output.items?.[0]?.text).toContain("BLAND_API_KEY");
    expect(output.items?.[0]?.text).toContain("cannot be retrieved");
  });
});

describe("buildCallResultItem", () => {
  test("maps snake_case fields, omits absent ones, and rides the transcript last", () => {
    const item = buildCallResultItem({
      call_id: "c-123",
      status: "completed",
      answered_by: "human",
      call_length: 2.4, // Bland reports MINUTES, not seconds
      summary: "Booked.",
      concatenated_transcript: "assistant: Hi.",
      recording_url: "https://example.com/rec.mp3" // not part of the item
    });
    expect(item.untrusted).toBe(true);
    const payload = JSON.parse(item.text.slice(item.text.indexOf("{")));
    expect(payload).toEqual({
      callId: "c-123",
      status: "completed",
      answeredBy: "human",
      callLengthMinutes: 2.4,
      summary: "Booked.",
      transcript: "assistant: Hi."
    });
    // Transcript last, so the hook runner's char cap truncates it, never the summary.
    expect(Object.keys(payload).at(-1)).toBe("transcript");
  });
});
