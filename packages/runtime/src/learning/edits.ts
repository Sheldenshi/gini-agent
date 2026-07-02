// Bounded skill-body edits (ADR skill-learning-from-outcomes.md).
//
// The optimizer proposes SkillOpt-style edits — append / insert_after /
// replace / delete — over a skill's markdown body. This is the pure application
// of those ops: it operates only on the body string, matches `anchor`/`target`
// as EXACT substrings, and SKIPS (records) rather than throws on a no-match so
// a stale proposal degrades gracefully instead of failing the whole apply.

import type { SkillEditOp } from "../types";
import type { ApplyEditsResult } from "./types";

export function applySkillEdits(body: string, ops: SkillEditOp[]): ApplyEditsResult {
  let next = body;
  let applied = 0;
  const skipped: SkillEditOp[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "append": {
        // Always applies — appends to the end with a separating blank line when
        // the body doesn't already end with one.
        const sep = next.length === 0 || next.endsWith("\n\n") ? "" : next.endsWith("\n") ? "\n" : "\n\n";
        next = `${next}${sep}${op.content}`;
        applied += 1;
        break;
      }
      case "insert_after": {
        const at = next.indexOf(op.anchor);
        if (at === -1) {
          skipped.push(op);
          break;
        }
        const cut = at + op.anchor.length;
        next = `${next.slice(0, cut)}\n${op.content}${next.slice(cut)}`;
        applied += 1;
        break;
      }
      case "replace": {
        const at = next.indexOf(op.target);
        if (at === -1) {
          skipped.push(op);
          break;
        }
        next = `${next.slice(0, at)}${op.content}${next.slice(at + op.target.length)}`;
        applied += 1;
        break;
      }
      case "delete": {
        const at = next.indexOf(op.target);
        if (at === -1) {
          skipped.push(op);
          break;
        }
        next = `${next.slice(0, at)}${next.slice(at + op.target.length)}`;
        applied += 1;
        break;
      }
      default: {
        // An unknown op shape (defensive — the validator should have caught it).
        skipped.push(op);
      }
    }
  }

  return { body: next, applied, skipped };
}
