// Unit tests for the pure helpers of the check-call script.
//
// Only the side-effect-free exports are covered here: mapping Bland's call
// payload to the script result and normalizing waitSeconds. No network.

import { describe, expect, test } from "bun:test";
import { mapCallDetails, normalizeWaitSeconds } from "../check-call";

describe("mapCallDetails", () => {
  test("maps a completed call, keeping call_length as minutes", () => {
    expect(
      mapCallDetails({
        call_id: "c-123",
        status: "completed",
        completed: true,
        answered_by: "human",
        call_length: 2.4, // Bland reports MINUTES, not seconds
        to: "+15551234567",
        from: "+14155550000",
        concatenated_transcript: "assistant: Hi. user: Hello.",
        summary: "Booked a table for two at 7pm.",
        recording_url: "https://example.com/rec.mp3"
      })
    ).toEqual({
      ok: true,
      callId: "c-123",
      status: "completed",
      completed: true,
      answeredBy: "human",
      callLengthMinutes: 2.4,
      to: "+15551234567",
      from: "+14155550000",
      transcript: "assistant: Hi. user: Hello.",
      summary: "Booked a table for two at 7pm.",
      recordingUrl: "https://example.com/rec.mp3"
    });
  });

  test("omits fields Bland has not populated yet (in-progress call)", () => {
    expect(
      mapCallDetails({
        call_id: "c-123",
        status: "in-progress",
        completed: false,
        concatenated_transcript: null,
        summary: null,
        recording_url: null
      })
    ).toEqual({
      ok: true,
      callId: "c-123",
      status: "in-progress",
      completed: false
    });
  });

  test("surfaces Bland's error_message on failed calls", () => {
    const result = mapCallDetails({
      call_id: "c-123",
      status: "failed",
      completed: true,
      error_message: "Call was not answered."
    });
    expect(result.ok).toBe(true);
    expect(result.errorMessage).toBe("Call was not answered.");
  });
});

describe("normalizeWaitSeconds", () => {
  test("defaults to 0 when omitted or not coercible to a finite number", () => {
    expect(normalizeWaitSeconds(undefined)).toBe(0);
    expect(normalizeWaitSeconds(null)).toBe(0);
    expect(normalizeWaitSeconds("abc")).toBe(0);
    expect(normalizeWaitSeconds(Number.NaN)).toBe(0);
    expect(normalizeWaitSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("coerces numeric strings", () => {
    expect(normalizeWaitSeconds("240")).toBe(240);
    expect(normalizeWaitSeconds("  60 ")).toBe(60);
  });

  test("clamps to the [0, 240] budget", () => {
    expect(normalizeWaitSeconds(-5)).toBe(0);
    expect(normalizeWaitSeconds(0)).toBe(0);
    expect(normalizeWaitSeconds(60)).toBe(60);
    expect(normalizeWaitSeconds(240)).toBe(240);
    expect(normalizeWaitSeconds(600)).toBe(240);
  });
});
