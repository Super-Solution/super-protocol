/**
 * The small checks every validator in this package is built from. A validator reports every problem it finds
 * through `add(path, code, message, hint?)`; these helpers are the common shapes of one problem (a required text,
 * a value from a list, a count), so the same words and the same codes come out everywhere, and the same in the Go
 * and Python ports.
 *
 * A value that is absent is `required`; one of the wrong JSON type is `type` (with a hint saying what it was); the
 * right type but not acceptable is the code that says why (`empty`, `enum`, `range`, ...).
 */
import { didYouMean, jsonType, type Add } from "./issue.js";

export type Fields = Record<string, unknown>;

export const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
export const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
export const isAmount = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Whether `v` parses as an `http:` or `https:` URL. */
export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** `required` when `v` is absent, otherwise `type` with what was received. */
export function wrongType(add: Add, path: string, v: unknown, message: string): void {
  if (v === undefined) add(path, "required", message);
  else add(path, "type", message, `got ${jsonType(v)}`);
}

export function text(add: Add, path: string, v: unknown, message = "must be a non-empty string"): void {
  if (typeof v !== "string") wrongType(add, path, v, message);
  else if (v === "") add(path, "empty", message);
}
/** Like `text`, but a string of only whitespace is `empty` too. */
export function filled(add: Add, path: string, v: unknown, message: string): void {
  if (typeof v !== "string") wrongType(add, path, v, message);
  else if (v.trim() === "") add(path, "empty", message);
}
/** A finite number: `type` for anything that is not a number, `range` for one that is not finite. */
export function finite(add: Add, path: string, v: unknown, message: string): void {
  if (typeof v !== "number") wrongType(add, path, v, message);
  else if (!Number.isFinite(v)) add(path, "range", message);
}
/** A finite number inside `[min, max]`: `type` for a non-number, `range` for one outside (or not finite). */
export function finiteBetween(add: Add, path: string, v: unknown, [min, max]: readonly [number, number], message: string): void {
  if (typeof v !== "number") wrongType(add, path, v, message);
  else if (!(Number.isFinite(v) && v >= min && v <= max)) add(path, "range", message);
}
/** A string no longer than `max` UTF-16 units: `type`, else `length`. */
export function short(add: Add, path: string, v: unknown, max: number, message: string): void {
  if (typeof v !== "string") wrongType(add, path, v, message);
  else if (v.length > max) add(path, "length", message);
}
export function oneOf(add: Add, path: string, v: unknown, allowed: readonly string[], message = `must be one of ${allowed.join(", ")}`): void {
  if (typeof v === "string" && allowed.includes(v)) return;
  if (v === undefined) add(path, "required", message);
  else add(path, "enum", message, didYouMean(v, allowed));
}
export function count(add: Add, path: string, v: unknown): void {
  const message = "must be a non-negative integer";
  if (typeof v !== "number") wrongType(add, path, v, message);
  else if (!isCount(v)) add(path, "range", message);
}
export function amount(add: Add, path: string, v: unknown): void {
  const message = "must be a non-negative number";
  if (typeof v !== "number") wrongType(add, path, v, message);
  else if (!isAmount(v)) add(path, "range", message);
}
export function str(add: Add, path: string, v: unknown, message = "must be a string"): void {
  if (typeof v !== "string") wrongType(add, path, v, message);
}
export function bool(add: Add, path: string, v: unknown, message = "must be a boolean"): void {
  if (typeof v !== "boolean") wrongType(add, path, v, message);
}
export function arr(add: Add, path: string, v: unknown): void {
  if (!Array.isArray(v)) wrongType(add, path, v, "must be an array");
}
/** A string that matches `re`: `type` for a non-string, `format` for one that does not match. */
export function pattern(add: Add, path: string, v: unknown, re: RegExp, message: string): void {
  if (typeof v !== "string") wrongType(add, path, v, message);
  else if (!re.test(v)) add(path, "format", message);
}
export function obj(add: Add, path: string, v: unknown, message = "must be an object"): void {
  if (!isObject(v)) wrongType(add, path, v, message);
}
