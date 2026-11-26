import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  isRunEventType,
  isRunTerminalEvent,
  parseSSE,
  runStreamOutcome,
  validateRunEvent,
  type RunEvent,
} from "./index.js";

const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const card = { id: "card_1", spec: { kind: "confirm", title: "Send it?" }, callId: "call_1" };
const turn: RunEvent[] = [
  { type: "run-start", runId: "run_1", mode: "stream" },
  { type: "step-start", step: 0 },
  { type: "text-delta", delta: "Let me check." },
  { type: "tool-call", callId: "call_1", name: "send_email", input: { to: "a@example.com" } },
  { type: "awaiting-user", callId: "call_1", card },
];
const rest: RunEvent[] = [
  { type: "user-responded", callId: "call_1", action: { cardId: "card_1", callId: "call_1", kind: "confirm", type: "confirm", at: 1 } },
  { type: "tool-result", callId: "call_1", name: "send_email", output: { sent: true }, ms: 120 },
  { type: "usage", usage },
  { type: "step-finish", step: 0, finishReason: "tool-calls", usage },
  { type: "run-finish", runId: "run_1", finishReason: "stop", usage, steps: 1 },
];

describe("run events", () => {
  it("accepts a whole turn", () => {
    for (const event of [...turn, ...rest]) expect(validateRunEvent(event), event.type).toEqual([]);
  });
  it("knows every type it validates", () => {
    expect(RUN_EVENT_TYPES).toHaveLength(21);
    for (const type of RUN_EVENT_TYPES) expect(validateRunEvent({ type }).some((i) => i.message === "unknown run event type"), type).toBe(false);
    expect(validateRunEvent({ type: "resync" })).toEqual([{ path: "type", code: "enum", message: "unknown run event type" }]);
    expect(isRunEventType("resync")).toBe(false);
    expect(isRunEventType("run-snapshot")).toBe(true);
  });
  it("says where an event is wrong", () => {
    expect(validateRunEvent({ type: "run-finish", runId: "", finishReason: "done", steps: 1.5 })).toEqual([
      { path: "runId", code: "empty", message: "must be a non-empty string" },
      { path: "finishReason", code: "enum", message: "must be one of stop, length, tool-calls, content-filter, cancelled, error, unknown" },
      { path: "usage", code: "required", message: "must be an object" },
      { path: "steps", code: "range", message: "must be a non-negative integer" },
    ]);
    expect(validateRunEvent({ type: "awaiting-user", callId: "c", card: { id: "k", spec: {} } })).toEqual([
      { path: "card.spec.kind", code: "required", message: "must be a non-empty string" },
    ]);
  });
  it("leaves tool input, output and card payloads alone", () => {
    expect(validateRunEvent({ type: "tool-call", callId: "c", name: "n", input: [1, { deep: null }] })).toEqual([]);
    expect(validateRunEvent({ type: "tool-result", callId: "c", name: "n", ms: 0 })).toEqual([]);
    expect(validateRunEvent({ type: "card", card: { id: "k", spec: { kind: "anything", rows: [[1]] } } })).toEqual([]);
  });
  it("only run-finish ends a run", () => {
    expect(RUN_EVENT_TYPES.filter((type) => isRunTerminalEvent({ type }))).toEqual(["run-finish"]);
  });
});

describe("a stream that stopped", () => {
  it("is finished only after run-finish", () => {
    expect(runStreamOutcome([...turn, ...rest])).toBe("finished");
    expect(runStreamOutcome([...turn, ...rest.slice(0, -1)])).toBe("interrupted");
  });
  it("is waiting for the person while a card is unanswered", () => {
    expect(runStreamOutcome(turn)).toBe("awaiting-user");
    expect(runStreamOutcome([...turn, rest[0]])).toBe("interrupted");
  });
  it("starts over at a snapshot", () => {
    const snapshot: RunEvent = { type: "run-snapshot", parts: [{ type: "text", text: "Let me check." }], cards: [card] };
    expect(runStreamOutcome([...turn, snapshot])).toBe("interrupted");
    expect(runStreamOutcome([...turn, snapshot, turn[4]])).toBe("awaiting-user");
  });
  it("skips what it does not know", () => {
    expect(runStreamOutcome([])).toBe("empty");
    expect(runStreamOutcome([{ type: "something-new" }, null, "x"])).toBe("empty");
    expect(runStreamOutcome([...turn, { type: "something-new" }])).toBe("awaiting-user");
  });
  it("reads a turn sent as server-sent events", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of turn) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const events: unknown[] = [];
    for await (const frame of parseSSE(body)) events.push(JSON.parse(frame.data));
    expect(events.flatMap((e) => validateRunEvent(e))).toEqual([]);
    expect(runStreamOutcome(events)).toBe("awaiting-user");
  });
});
