// Unit tests for the cache-warmer slider math. Three surfaces to pin:
//   - positionToMinutes / minutesToPosition: the piecewise mapping that
//     splits the 0..1000 nominal track into a 0..60 min lower half
//     (1-min snap) and a 60..1440 min upper half (5-min snap).
//   - formatMinutes: "Off" / "N min" / "H h" / "H h M min" rendering.
//   - formatRefresh: minutes × 54 seconds, formatted with sub-minute
//     precision so a 5-min interval reads "4 min 30 sec".
//
// These are pure-JS tests (no React/DOM) — they import the helper
// module directly and exercise its return values.

import { describe, expect, test } from "bun:test";
import {
  LOWER_BREAKPOINT_MIN,
  SPLIT,
  TRACK_MAX,
  UPPER_BREAKPOINT_MIN,
  formatMinutes,
  formatRefresh,
  minutesToPosition,
  positionToMinutes
} from "./cache-warmer-math";

describe("constants", () => {
  test("track and breakpoints match the slider contract", () => {
    // Pinning these guards against an accidental scale change that would
    // silently re-interpret every persisted minute value.
    expect(TRACK_MAX).toBe(1000);
    expect(SPLIT).toBe(500);
    expect(LOWER_BREAKPOINT_MIN).toBe(60);
    expect(UPPER_BREAKPOINT_MIN).toBe(1440);
  });
});

describe("positionToMinutes", () => {
  test("pos=0 maps to 0 minutes (Off)", () => {
    expect(positionToMinutes(0)).toBe(0);
  });

  test("pos=SPLIT lands exactly on the lower breakpoint", () => {
    // The SPLIT position is the junction between the two halves; both
    // branches must agree on LOWER_BREAKPOINT_MIN there.
    expect(positionToMinutes(SPLIT)).toBe(LOWER_BREAKPOINT_MIN);
  });

  test("pos=TRACK_MAX maps to the upper breakpoint", () => {
    expect(positionToMinutes(TRACK_MAX)).toBe(UPPER_BREAKPOINT_MIN);
  });

  test("lower half uses a 1-min snap", () => {
    // 500 nominal positions / 60 minute-values = 25/3 positions per
    // minute. pos = 25/3 * 5 = 125/3 ≈ 41.6667 should round to 5 min.
    expect(positionToMinutes(125 / 3)).toBe(5);
    // pos=250 sits at exactly half of the lower half: (250/500)*60 = 30.
    expect(positionToMinutes(250)).toBe(30);
  });

  test("upper half uses a 5-min snap", () => {
    // raw = 60 + ((750-500)/500) * 1380 = 60 + 0.5*1380 = 750 → 750.
    expect(positionToMinutes(750)).toBe(750);
    // raw = 60 + ((800-500)/500) * 1380 = 60 + 0.6*1380 = 888;
    // round(888/5)*5 = round(177.6)*5 = 178*5 = 890.
    expect(positionToMinutes(800)).toBe(890);
  });
});

describe("minutesToPosition", () => {
  test("min=0 maps to pos=0", () => {
    expect(minutesToPosition(0)).toBe(0);
  });

  test("negative minutes clamp to pos=0", () => {
    // Defensive: persisted state should never be negative, but a
    // hand-edited record shouldn't render off-track.
    expect(minutesToPosition(-1)).toBe(0);
  });

  test("min=LOWER_BREAKPOINT_MIN lands exactly on SPLIT", () => {
    expect(minutesToPosition(LOWER_BREAKPOINT_MIN)).toBe(SPLIT);
  });

  test("min=UPPER_BREAKPOINT_MIN lands exactly on TRACK_MAX", () => {
    expect(minutesToPosition(UPPER_BREAKPOINT_MIN)).toBe(TRACK_MAX);
  });

  test("lower-half interpolation: 30 min sits at (30/60)*500 = 250", () => {
    expect(minutesToPosition(30)).toBe(250);
  });

  test("upper-half interpolation: 720 min sits at 500 + (720-60)/(1440-60) * 500", () => {
    // Exact rational: 500 + 660/1380 * 500 = 500 + 11/23 * 500
    //   = 500 + 5500/23 = 500 + 239.1304347826087
    //   = 739.1304347826087
    expect(minutesToPosition(720)).toBe(500 + (660 / 1380) * 500);
    expect(minutesToPosition(720)).toBe(739.1304347826087);
  });
});

describe("position ↔ minutes round-trip at TICKS boundaries", () => {
  // The TICKS array in CacheWarmerCard renders labels at 0, 30, 60, 720,
  // 1440 min. Each must round-trip cleanly so the tick label sits on top
  // of the snapped value.
  for (const min of [0, 30, 60, 720, 1440]) {
    test(`min=${min} round-trips through minutesToPosition → positionToMinutes`, () => {
      expect(positionToMinutes(minutesToPosition(min))).toBe(min);
    });
  }
});

describe("formatMinutes", () => {
  test("0 minutes renders 'Off'", () => {
    expect(formatMinutes(0)).toBe("Off");
  });

  test("sub-hour values render 'N min'", () => {
    expect(formatMinutes(5)).toBe("5 min");
    expect(formatMinutes(59)).toBe("59 min");
  });

  test("whole-hour values render 'H h'", () => {
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(1440)).toBe("24 h");
  });

  test("hour + remainder renders 'H h M min'", () => {
    expect(formatMinutes(65)).toBe("1 h 5 min");
  });
});

describe("formatRefresh", () => {
  test("0 minutes renders an empty string (caller hides the line)", () => {
    expect(formatRefresh(0)).toBe("");
  });

  test("1 minute renders '54 sec' (1 × 54 = 54 sec)", () => {
    expect(formatRefresh(1)).toBe("54 sec");
  });

  test("5 minutes renders '4 min 30 sec' (5 × 54 = 270 sec)", () => {
    // 270 sec = 4 min 30 sec — the sub-minute precision exists so the
    // probe is visibly scheduled before the expiry, not on top of it.
    expect(formatRefresh(5)).toBe("4 min 30 sec");
  });

  test("30 minutes renders '27 min' (30 × 54 = 1620 sec)", () => {
    // 1620 sec = 27 min 0 sec; the trailing '0 sec' is suppressed.
    expect(formatRefresh(30)).toBe("27 min");
  });

  test("60 minutes renders '54 min' (60 × 54 = 3240 sec)", () => {
    // 3240 sec = 54 min 0 sec — still under an hour after the × 0.9.
    expect(formatRefresh(60)).toBe("54 min");
  });

  test("720 minutes renders '10 h 48 min' (720 × 54 = 38880 sec)", () => {
    // 38880 sec = 10 h 48 min 0 sec.
    expect(formatRefresh(720)).toBe("10 h 48 min");
  });

  test("1440 minutes renders '21 h 36 min' (1440 × 54 = 77760 sec)", () => {
    // 77760 sec = 21 h 36 min 0 sec.
    expect(formatRefresh(1440)).toBe("21 h 36 min");
  });
});
