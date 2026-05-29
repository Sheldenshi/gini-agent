// Pure math + formatting helpers backing the cache-warmer slider in
// CacheWarmerCard. Extracted into a sibling module so the piecewise
// position↔minutes mapping and the human formatters can be unit-tested
// without a React/DOM environment.
//
// Piecewise slider scale: prompt cache TTLs cluster heavily in the
// 5-60 min range, so the lower half of the track maps to 0-60 min in
// 1-min snap and the upper half maps to 60-1440 min in 5-min snap. The
// native <input type="range"> still moves linearly across the underlying
// 0-1000 nominal position; we translate position → minutes for display
// and only the snapped minute value is persisted.

export const TRACK_MAX = 1000;
export const SPLIT = 500;
export const LOWER_BREAKPOINT_MIN = 60;
export const UPPER_BREAKPOINT_MIN = 1440;

// Lower half (0..SPLIT positions) covers 0-60 min in 1-min snap, upper
// half (SPLIT..TRACK_MAX) covers 60-1440 min in 5-min snap. The 1-min
// lower-half granularity is intentional: with a 5-min snap, 500 nominal
// positions / 12 minute-values = 41.67 positions per value-change, which
// felt like the slider was ignoring small drags. 1-min snap brings that
// down to 500/60 = 8.33 positions per value-change, so the displayed
// number ticks visibly as the thumb moves.
export function positionToMinutes(pos: number): number {
  if (pos <= SPLIT) {
    return Math.round((pos / SPLIT) * LOWER_BREAKPOINT_MIN);
  }
  const raw =
    LOWER_BREAKPOINT_MIN +
    ((pos - SPLIT) / SPLIT) * (UPPER_BREAKPOINT_MIN - LOWER_BREAKPOINT_MIN);
  return Math.round(raw / 5) * 5;
}

export function minutesToPosition(min: number): number {
  if (min <= 0) return 0;
  return min <= LOWER_BREAKPOINT_MIN
    ? (min / LOWER_BREAKPOINT_MIN) * SPLIT
    : SPLIT +
        ((min - LOWER_BREAKPOINT_MIN) /
          (UPPER_BREAKPOINT_MIN - LOWER_BREAKPOINT_MIN)) *
          SPLIT;
}

export function formatMinutes(min: number): string {
  if (min === 0) return "Off";
  const hours = Math.floor(min / 60);
  const remainder = min % 60;
  if (hours === 0) return `${remainder} min`;
  if (remainder === 0) return `${hours} h`;
  return `${hours} h ${remainder} min`;
}

// Refresh is fixed at 90% of the chosen interval — exactly minutes × 54
// seconds. Format with sub-minute precision so a 5-min interval reads
// "4 min 30 sec", not the misleading "5 min" that would land the probe
// at the exact expiry instead of before it.
export function formatRefresh(min: number): string {
  const seconds = min * 54;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (sec > 0) parts.push(`${sec} sec`);
  return parts.join(" ");
}
