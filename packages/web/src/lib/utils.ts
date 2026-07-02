import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Exhaustiveness guard for discriminated unions. A `default` branch assigns its
// value to `never` and calls this so the compiler flags any unhandled variant.
// Lives here (under the coverage-ignored `src/lib/**`) because Bun never marks
// a bare `throw` statement line as covered, which would drag a 100%-threshold
// component below the bar for a line that is unreachable in typed code.
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`)
}
