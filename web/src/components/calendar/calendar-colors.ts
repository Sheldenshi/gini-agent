import type { CalendarJob as CronJob } from "./types";

export const EVENT_COLORS = ["gray", "blue", "pink", "orange"] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

export interface ColorClasses {
  bg: string;
  hover: string;
  ring: string;
  title: string;
  time: string;
  dot: string;
}

// Babyclaw used custom `cal-*` Tailwind tokens; gini doesn't define those, so
// we map to standard Tailwind colour scales here. The "gray" variant uses
// shadcn's neutral surface tokens so it adapts to dark mode; the chromatic
// variants stay on raw Tailwind palettes (light backgrounds + strong text)
// because the rest of the calendar surface is already a card-like background.
export const COLOR_CLASSES: Record<EventColor, ColorClasses> = {
  gray: {
    bg: "bg-muted/50",
    hover: "hover:bg-muted",
    ring: "ring-border",
    title: "text-foreground",
    time: "text-muted-foreground",
    dot: "bg-muted-foreground"
  },
  blue: {
    bg: "bg-blue-50 dark:bg-blue-950/40",
    hover: "hover:bg-blue-100 dark:hover:bg-blue-900/50",
    ring: "ring-blue-200 dark:ring-blue-900",
    title: "text-blue-700 dark:text-blue-200",
    time: "text-blue-600 dark:text-blue-300",
    dot: "bg-blue-500"
  },
  pink: {
    bg: "bg-pink-50 dark:bg-pink-950/40",
    hover: "hover:bg-pink-100 dark:hover:bg-pink-900/50",
    ring: "ring-pink-200 dark:ring-pink-900",
    title: "text-pink-700 dark:text-pink-200",
    time: "text-pink-600 dark:text-pink-300",
    dot: "bg-pink-500"
  },
  orange: {
    bg: "bg-orange-50 dark:bg-orange-950/40",
    hover: "hover:bg-orange-100 dark:hover:bg-orange-900/50",
    ring: "ring-orange-200 dark:ring-orange-900",
    title: "text-orange-700 dark:text-orange-200",
    time: "text-orange-600 dark:text-orange-300",
    dot: "bg-orange-500"
  }
};

export function assignJobColors(jobs: CronJob[]): Map<string, EventColor> {
  const sorted = [...jobs].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const map = new Map<string, EventColor>();
  for (let i = 0; i < sorted.length; i++) {
    map.set(sorted[i].id, EVENT_COLORS[i % EVENT_COLORS.length]);
  }
  return map;
}
