import { describe, expect, test } from "bun:test";
import { evaluateEdgeProbe } from "./manager";

// Pure decision function for the edge-reachability probe. The test names
// pin the four contract points so a regression in the failure-counting
// semantics is unambiguous in the failure output.

describe("evaluateEdgeProbe", () => {
  test("reachable probe yields zero failures and not-dead, regardless of prior count", () => {
    expect(evaluateEdgeProbe(0, true, 3)).toEqual({ failures: 0, dead: false });
    // A single reachable probe must reset accumulated failures — that's
    // how the manager debounces transient blips (one timeout) from a
    // persistently dead hostname.
    expect(evaluateEdgeProbe(2, true, 3)).toEqual({ failures: 0, dead: false });
  });

  test("first failure under the threshold increments to one and stays not-dead", () => {
    expect(evaluateEdgeProbe(0, false, 3)).toEqual({ failures: 1, dead: false });
  });

  test("intermediate failure under the threshold increments but stays not-dead", () => {
    expect(evaluateEdgeProbe(1, false, 3)).toEqual({ failures: 2, dead: false });
  });

  test("failure that reaches the threshold flips dead to true", () => {
    expect(evaluateEdgeProbe(2, false, 3)).toEqual({ failures: 3, dead: true });
  });

  test("reachable probe after accumulated failures resets the counter", () => {
    // Mid-streak recovery: two failures in a row, then a reachable probe.
    // Without the reset, the next failure would tip into dead even
    // though the edge is currently healthy.
    const step1 = evaluateEdgeProbe(0, false, 3);
    const step2 = evaluateEdgeProbe(step1.failures, false, 3);
    const recover = evaluateEdgeProbe(step2.failures, true, 3);
    expect(recover).toEqual({ failures: 0, dead: false });
  });
});
