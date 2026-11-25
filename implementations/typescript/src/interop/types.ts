/**
 * What every adapter in `interop/` shares (DRAFT: the interop modules are not stable; see docs/INTEROP.md).
 *
 * An adapter turns run events into another protocol's chunks and back. It is a pair of small state machines with no
 * I/O and no dependency on the other protocol's package: the chunk types here are structural, so a host that has
 * `ai` or `@ag-ui/core` installed passes its own values in and out unchanged.
 *
 * Both directions have the same three calls, so the next adapter looks like the last:
 * `createEncoder(options)` / `createDecoder(options)` give a machine with `push` (one input, any number of outputs)
 * and `end` (the stream stopped: close what is open); `encode(events, options)` / `decode(chunks, options)` run a whole
 * list through a fresh machine.
 */

/** A machine that is fed one value at a time. `end` says the input stopped, and returns what that closes. */
export interface StreamMachine<In, Out> {
  push(input: In): Out[];
  end(): Out[];
}

/**
 * Something the other protocol has no place for, so it was not carried over. An adapter never drops silently when the
 * caller asks to hear about it: pass `onLoss` and every dropped event or field arrives here, once.
 */
export interface Loss {
  /** The input that lost something: a run event type, or a chunk type of the other protocol. */
  type: string;
  /** The field that was dropped; absent when the whole input was. */
  field?: string;
  /** Why, in a few words a log line can carry. */
  reason: string;
}

export interface AdapterOptions {
  /** Called for everything that did not survive the translation. */
  onLoss?: (loss: Loss) => void;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Runs a whole list through a machine and closes it. */
export function runMachine<In, Out>(machine: StreamMachine<In, Out>, inputs: Iterable<In>): Out[] {
  const out: Out[] = [];
  for (const input of inputs) out.push(...machine.push(input));
  out.push(...machine.end());
  return out;
}

/** The text of a failure that may be a string, `{ message }` (what a run's `error` event should carry) or anything. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  if (isRecord(error) && isText(error.message)) return error.message;
  const text = JSON.stringify(error);
  return text === undefined || text === "null" ? "error" : text;
}

/** `JSON.stringify` that never returns `undefined`: what a tool call's input or a result becomes when it has to be text. */
export function jsonText(value: unknown, fallback = "null"): string {
  return JSON.stringify(value) ?? fallback;
}
