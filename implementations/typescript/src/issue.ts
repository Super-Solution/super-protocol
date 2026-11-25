/**
 * What a validator says about a value it refuses: where (`path`), what kind of problem (`code`), a sentence for a
 * person or a model (`message`) and, sometimes, how to fix it (`hint`).
 *
 * `code` is the contract: a small closed set that is the same in every language, so a program can branch on it and
 * a model can be told what to change. `message` is for reading and is also pinned by the conformance data, byte for
 * byte, so a port reproduces it; do not parse it. Adding a code is a protocol change; the set below is the whole
 * vocabulary (`docs/ISSUES.md` says when each one is used).
 */
import type { ManifestIssue } from "./plugin.js";

export const ISSUE_CODES = [
  "required",
  "type",
  "empty",
  "enum",
  "range",
  "length",
  "limit",
  "format",
  "unique",
  "exclusive",
  "order",
  "reference",
  "shape",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue extends ManifestIssue {
  code: IssueCode;
  /** How to fix it, when there is something to say beyond the message: a "did you mean", the type received, an example. */
  hint?: string;
}

/** Reports one problem. `hint` is left out of the issue when it is absent. */
export type Add = (path: string, code: IssueCode, message: string, hint?: string) => void;

/** An `Add` that appends to `issues`. */
export function adder(issues: Issue[]): Add {
  return (path, code, message, hint) => void issues.push(hint === undefined ? { path, code, message } : { path, code, message, hint });
}

/** An `Add` that collects into a new list; the list is the validator's answer. */
export function collector(): { issues: Issue[]; add: Add } {
  const issues: Issue[] = [];
  return { issues, add: adder(issues) };
}

/** The JSON type of a value as a person would name it: `null`, `array`, `object`, `string`, `number`, `boolean`. */
export function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Edit distance between two strings, counted in code points. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length]!;
}

/** The closest of `allowed` to `value` within two edits (the first of equally close ones), or undefined. */
export function closest(value: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of allowed) {
    if (Math.abs(Array.from(candidate).length - Array.from(value).length) > 2) continue;
    const d = editDistance(value, candidate);
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best;
}

/** `did you mean "x"?` for a string that is almost one of `allowed`; undefined when nothing is close. */
export function didYouMean(value: unknown, allowed: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const near = closest(value, allowed);
  return near === undefined ? undefined : `did you mean "${near}"?`;
}
