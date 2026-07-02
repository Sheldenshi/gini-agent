import { describe, expect, test } from "bun:test";
import { jobCadence } from "./format";

describe("jobCadence", () => {
  test("returns the cron expression verbatim", () => {
    expect(jobCadence({ cronExpression: "0 9 * * *" })).toBe("0 9 * * *");
  });

  test("collapses interval seconds to the largest whole unit", () => {
    expect(jobCadence({ intervalSeconds: 86400 })).toBe("Every 1d");
    expect(jobCadence({ intervalSeconds: 3600 })).toBe("Every 1h");
    expect(jobCadence({ intervalSeconds: 1800 })).toBe("Every 30m");
    expect(jobCadence({ intervalSeconds: 45 })).toBe("Every 45s");
  });

  test("falls back to Recurring with no driver", () => {
    expect(jobCadence({})).toBe("Recurring");
    expect(jobCadence({ intervalSeconds: 0 })).toBe("Recurring");
  });
});
