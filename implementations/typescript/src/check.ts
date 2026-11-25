/**
 * The small checks every validator in this package is built from. A validator reports every problem it
 * finds through `add(path, message)`; these helpers are the common shapes of one problem (a required text,
 * a value from a list, a count) so the same words come out everywhere and so does the same answer in the Go
 * and Python ports.
 */

export type Add = (path: string, message: string) => void;
export type Fields = Record<string, unknown>;

export const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
export const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
export const isAmount = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function text(add: Add, path: string, v: unknown): void {
  if (typeof v !== "string" || v === "") add(path, "must be a non-empty string");
}
export function oneOf(add: Add, path: string, v: unknown, allowed: readonly string[]): void {
  if (typeof v !== "string" || !allowed.includes(v)) add(path, `must be one of ${allowed.join(", ")}`);
}
export function count(add: Add, path: string, v: unknown): void {
  if (!isCount(v)) add(path, "must be a non-negative integer");
}
export function amount(add: Add, path: string, v: unknown): void {
  if (!isAmount(v)) add(path, "must be a non-negative number");
}
export function str(add: Add, path: string, v: unknown): void {
  if (typeof v !== "string") add(path, "must be a string");
}
export function bool(add: Add, path: string, v: unknown): void {
  if (typeof v !== "boolean") add(path, "must be a boolean");
}
export function obj(add: Add, path: string, v: unknown): void {
  if (!isObject(v)) add(path, "must be an object");
}
