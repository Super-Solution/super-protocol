// Runs for the interop golden files (conformance/interop-*.v0.json): the same run events go through every adapter, so
// the files can be read side by side. Each scenario is `{ name, note, options?, events }`. `options` is what a JSON file can
// carry: `threadId`, `runId`, `confirmKinds` (card kinds that ask yes or no) and `now` (the clock of a decoder).

const start = (runId = "run_1", extra = {}) => ({ type: "run-start", runId, mode: "stream", ...extra });
const finish = (finishReason = "stop", usage = { inputTokens: 5, outputTokens: 7 }, steps = 1, runId = "run_1") => ({ type: "run-finish", runId, finishReason, usage, steps });
const askCard = { id: "card_ask", callId: "call_ask", spec: { kind: "super.form", title: "Which region?" } };
const confirmCard = { id: "card_confirm", callId: "call_confirm", spec: { kind: "super.confirm", title: "Delete the file?" } };
const plotCard = { id: "card_plot", spec: { kind: "super.plot", alt: "Revenue by region" } };

export const runScenarios = [
  {
    name: "text",
    note: "A run that answers in plain text: the message is opened at the first delta and closed at the step's end.",
    events: [start(), { type: "step-start", step: 0 }, { type: "text-delta", delta: "Hello" }, { type: "text-delta", delta: ", " }, { type: "text-delta", delta: "world." }, { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } }, { type: "step-finish", step: 0, finishReason: "stop", usage: { inputTokens: 5, outputTokens: 3 } }, finish("stop", { inputTokens: 5, outputTokens: 3 })],
  },
  {
    name: "explicit-ids-and-thread",
    note: "A producer that names its messages and its thread: those are used as they are, and a new id starts a new message.",
    events: [start("run_2", { threadId: "thread_9" }), { type: "step-start", step: 0 }, { type: "text-delta", delta: "One", id: "msg_a" }, { type: "text-delta", delta: "Two", id: "msg_b" }, { type: "step-finish", step: 0, finishReason: "stop" }, finish("stop", {}, 1, "run_2")],
  },
  {
    name: "reasoning-then-text",
    note: "Reasoning and text in one step: each is closed before the other opens.",
    events: [start(), { type: "step-start", step: 0 }, { type: "reasoning-delta", delta: "The user wants " }, { type: "reasoning-delta", delta: "a greeting." }, { type: "text-delta", delta: "Hi!" }, { type: "step-finish", step: 0, finishReason: "stop" }, finish("stop", {}, 1)],
  },
  {
    name: "tool-call-and-result",
    note: "A tool call in step 0 and its result, then an answer in step 1.",
    events: [
      start(),
      { type: "step-start", step: 0 },
      { type: "text-delta", delta: "Let me look that up." },
      { type: "tool-call", callId: "call_1", name: "search", input: { q: "protocol" } },
      { type: "tool-result", callId: "call_1", name: "search", output: { hits: 2 }, ms: 120 },
      { type: "step-finish", step: 0, finishReason: "tool-calls" },
      { type: "step-start", step: 1 },
      { type: "text-delta", delta: "Two results." },
      { type: "step-finish", step: 1, finishReason: "stop" },
      finish("stop", { inputTokens: 40, outputTokens: 12 }, 2),
    ],
  },
  {
    name: "tool-failure",
    note: "A tool that failed: the failure is a result with `failure` set.",
    events: [start(), { type: "step-start", step: 0 }, { type: "tool-call", callId: "call_2", name: "fetch", input: { url: "https://example.com" } }, { type: "tool-result", callId: "call_2", name: "fetch", output: null, failure: "timeout", ms: 5000 }, { type: "step-finish", step: 0, finishReason: "tool-calls" }, finish("stop", {}, 1)],
  },
  {
    name: "tool-input-preview",
    note: "Previews of a call's arguments while the model writes them, then the call: the previews are an object, not text.",
    events: [start(), { type: "step-start", step: 0 }, { type: "tool-call-input-delta", callId: "call_3", name: "plot", partialInput: { type: "bar" } }, { type: "tool-call-input-delta", callId: "call_3", name: "plot", partialInput: { type: "bar", data: [1, 2] }, partialCard: { kind: "super.plot" } }, { type: "tool-call", callId: "call_3", name: "plot", input: { type: "bar", data: [1, 2, 3] }, repaired: true, loading: { text: "Drawing" } }, { type: "tool-result", callId: "call_3", name: "plot", output: "ok", ms: 8 }, { type: "step-finish", step: 0, finishReason: "tool-calls" }, finish("stop", {}, 1)],
  },
  {
    name: "cards",
    note: "A card shown and then updated.",
    events: [start(), { type: "step-start", step: 0 }, { type: "text-delta", delta: "Here it is." }, { type: "card", card: plotCard }, { type: "card-updated", cardId: "card_plot", spec: { kind: "super.plot", alt: "Revenue by region, updated" } }, { type: "step-finish", step: 0, finishReason: "stop" }, finish("stop", {}, 1)],
  },
  {
    name: "waiting-for-the-person",
    note: "A card that waits: the stream stops without run-finish, and that is how the run says it is suspended.",
    events: [start(), { type: "step-start", step: 0 }, { type: "tool-call", callId: "call_ask", name: "ask", input: { question: "Which region?" } }, { type: "awaiting-user", callId: "call_ask", card: askCard }],
  },
  {
    name: "waiting-for-a-yes-or-no",
    note: "The same, with the card kind named as a yes or no question (options.confirmKinds).",
    options: { confirmKinds: ["super.confirm"] },
    events: [start(), { type: "step-start", step: 0 }, { type: "tool-call", callId: "call_confirm", name: "delete_file", input: { path: "a.txt" } }, { type: "awaiting-user", callId: "call_confirm", card: confirmCard }],
  },
  {
    name: "two-cards-waiting",
    note: "Two cards waiting in one step: AG-UI wants every open interrupt in one event.",
    events: [start(), { type: "step-start", step: 0 }, { type: "tool-call", callId: "call_ask", name: "ask", input: {} }, { type: "tool-call", callId: "call_confirm", name: "delete_file", input: {} }, { type: "awaiting-user", callId: "call_ask", card: askCard }, { type: "awaiting-user", callId: "call_confirm", card: confirmCard }],
  },
  {
    name: "answered-and-resumed",
    note: "The continuation of a run that waited: the person's answer, the tool result, the end.",
    options: { runId: "run_1", confirmKinds: ["super.confirm"] },
    events: [{ type: "user-responded", callId: "call_confirm", action: { cardId: "card_confirm", callId: "call_confirm", kind: "super.confirm", type: "confirm", at: 1700000000000 } }, { type: "tool-result", callId: "call_confirm", name: "delete_file", output: { deleted: true }, ms: 4 }, { type: "step-finish", step: 0, finishReason: "tool-calls" }, finish("stop", {}, 1)],
  },
  {
    name: "failed-run",
    note: "A run that failed: an error that is not recoverable, then run-finish with finishReason error.",
    events: [start(), { type: "step-start", step: 0 }, { type: "text-delta", delta: "Working" }, { type: "error", error: { message: "The provider refused the request.", code: "provider_error" }, recoverable: false }, finish("error", {}, 1)],
  },
  {
    name: "recoverable-error",
    note: "An error the run recovered from: the run goes on.",
    events: [start(), { type: "step-start", step: 0 }, { type: "error", error: "rate limited, retrying", recoverable: true }, { type: "text-delta", delta: "Done." }, { type: "step-finish", step: 0, finishReason: "stop" }, finish("stop", {}, 1)],
  },
  {
    name: "cancelled",
    note: "A run the person stopped.",
    events: [start(), { type: "step-start", step: 0 }, { type: "text-delta", delta: "Starting" }, finish("cancelled", {}, 1)],
  },
  {
    name: "joined-with-a-snapshot",
    note: "A follower that joined part-way: no run-start, the snapshot first. options.runId says which run it is.",
    options: { runId: "run_7", threadId: "thread_7" },
    events: [{ type: "run-snapshot", parts: [{ type: "text", text: "So far: " }, { type: "text", text: "two steps." }], cards: [plotCard], usage: { inputTokens: 9 }, steps: 2 }, { type: "step-start", step: 2 }, { type: "text-delta", delta: "Next." }, { type: "step-finish", step: 2, finishReason: "stop" }, finish("stop", {}, 3, "run_7")],
  },
  {
    name: "events-with-no-home",
    note: "Events the other protocol has no event for: usage, metering, context, jobs and extra message parts.",
    events: [
      start(),
      { type: "context-built", trace: { sources: 3 }, system: "You are brief.", toolNames: ["search"] },
      { type: "step-start", step: 0 },
      { type: "job-started", handle: { provider: "video", id: "job_1" } },
      { type: "job-status", handle: { provider: "video", id: "job_1" }, status: "in_progress" },
      { type: "metering", record: { model: "m", input: 3 } },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
      { type: "message", parts: [{ type: "source-url", sourceId: "s1", url: "https://example.com/a", title: "A" }, { type: "file", url: "https://example.com/a.png", mediaType: "image/png" }, { type: "citation", text: "unknown part" }] },
      { type: "step-finish", step: 0, finishReason: "stop" },
      finish("stop", { inputTokens: 3, outputTokens: 1 }, 1),
    ],
  },
  {
    name: "stopped-mid-text",
    note: "A stream that stopped while a message was open and a run that never finished: the message is closed, nothing is invented.",
    events: [start(), { type: "step-start", step: 0 }, { type: "text-delta", delta: "Half an ans" }],
  },
  {
    name: "unknown-and-empty",
    note: "An event type from a later version and an empty delta: skipped, not an error.",
    events: [start(), { type: "step-start", step: 0 }, { type: "text-delta", delta: "" }, { type: "from-the-future", x: 1 }, { type: "text-delta", delta: "ok" }, { type: "step-finish", step: 0, finishReason: "stop" }, finish("stop", {}, 1)],
  },
  {
    name: "sequence-numbers-and-finish-reasons",
    note: "Events that carry seq, and a run that stopped because of length.",
    events: [{ ...start(), seq: 0 }, { type: "step-start", step: 0, seq: 1 }, { type: "text-delta", delta: "Long", seq: 2 }, { type: "step-finish", step: 0, finishReason: "length", seq: 3 }, { ...finish("length", { inputTokens: 1, outputTokens: 4096 }, 1), seq: 4 }],
  },
];
