// Unit tests for the pure helpers of the place-call script.
//
// Only the side-effect-free exports are covered here: the POST /v1/calls body
// builder and the E.164 pattern. No network — the imperative place/poll flow is
// exercised end-to-end through a real chat turn, not here.

import { describe, expect, test } from "bun:test";
import { E164_PATTERN, buildCallBody } from "../place-call";

describe("buildCallBody", () => {
  test("applies defaults: wait_for_greeting true, record false, max_duration 10", () => {
    expect(buildCallBody({ phoneNumber: "+15551234567", task: "Book a table" })).toEqual({
      phone_number: "+15551234567",
      task: "Book a table",
      wait_for_greeting: true,
      record: false,
      max_duration: 10
    });
  });

  test("omits optional fields that were not supplied", () => {
    const body = buildCallBody({ phoneNumber: "+15551234567", task: "Book a table" });
    expect("voice" in body).toBe(false);
    expect("first_sentence" in body).toBe(false);
    expect("language" in body).toBe(false);
  });

  test("maps supplied optionals to Bland's snake_case fields", () => {
    expect(
      buildCallBody({
        phoneNumber: "+15551234567",
        task: "Book a table",
        voice: "maya",
        firstSentence: "Hi, I'm calling to book a table.",
        waitForGreeting: false,
        record: true,
        maxDurationMinutes: 5,
        language: "en-US"
      })
    ).toEqual({
      phone_number: "+15551234567",
      task: "Book a table",
      voice: "maya",
      first_sentence: "Hi, I'm calling to book a table.",
      wait_for_greeting: false,
      record: true,
      max_duration: 5,
      language: "en-US"
    });
  });
});

describe("E164_PATTERN", () => {
  test("accepts E.164 numbers", () => {
    expect(E164_PATTERN.test("+15551234567")).toBe(true);
    expect(E164_PATTERN.test("+442071838750")).toBe(true);
  });

  test("rejects non-E.164 numbers", () => {
    expect(E164_PATTERN.test("15551234567")).toBe(false); // missing +
    expect(E164_PATTERN.test("+05551234567")).toBe(false); // leading zero
    expect(E164_PATTERN.test("+1 555 123 4567")).toBe(false); // spaces
    expect(E164_PATTERN.test("+1234567890123456")).toBe(false); // > 15 digits
    expect(E164_PATTERN.test("")).toBe(false);
  });
});
