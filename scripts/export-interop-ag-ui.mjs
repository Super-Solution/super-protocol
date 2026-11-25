// Writes conformance/interop-ag-ui.v0.json (DRAFT, like the agent-loop files: not part of protocol.v1.json and not stable):
// what the run-event <-> AG-UI adapter in implementations/typescript/src/interop/ag-ui.ts produces for a set of runs,
// and what it makes of AG-UI streams.
//
// Every AG-UI event in the file is checked here against the real `@ag-ui/core` schemas (a devDependency, never a runtime
// one): it must parse, and parsing must not drop a field, so the adapter never writes a field AG-UI does not know. The
// events are also checked for the order AG-UI asks for (RUN_STARTED first, messages and tool calls opened, filled and closed,
// nothing after the last event of the run). The AG-UI streams that the decoder reads are written by hand, from the shapes the
// schemas accept: `@ag-ui/core` has no generator of events.
//
// Run `pnpm build` first (the generator imports the built package). `--check` is what scripts/check-all.sh runs.
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { adapterOptions, devVersion, importDev, writeGolden } from "./lib/golden.mjs";
import { runScenarios } from "./lib/interop-scenarios.mjs";
import * as agUi from "../implementations/typescript/dist/interop/ag-ui.js";

const schemas = await importDev("@ag-ui/core/schemas");
const { EventSchemas, PROTOCOL_VERSION } = schemas.EventSchemas ? schemas : schemas.default;
const NOW = 1700000000000;

/** Parses with the real schema and refuses what the schema would silently drop. */
function validate(events, label, { joined = false } = {}) {
  const open = { text: new Set(), reasoning: new Set(), tools: new Set() };
  let step = null;
  let ended = false;
  events.forEach((event, i) => {
    const where = `${label}[${i}] ${event.type}`;
    const parsed = EventSchemas.parse(event);
    deepStrictEqual(JSON.parse(JSON.stringify(parsed)), event, `${where}: the schema does not know every field`);
    if (ended && event.type !== "RUN_STARTED") throw new Error(`${where}: after the last event of the run`);
    if (event.type === "RUN_STARTED") ended = false;
    if (i === 0 && !joined && event.type !== "RUN_STARTED") throw new Error(`${where}: a run starts with RUN_STARTED`);
    const need = (set, id, what) => {
      if (!set.has(id)) throw new Error(`${where}: ${what} ${id} is not open`);
    };
    switch (event.type) {
      case "TEXT_MESSAGE_START": open.text.add(event.messageId); break;
      case "TEXT_MESSAGE_CONTENT": need(open.text, event.messageId, "message"); if (event.delta === "") throw new Error(`${where}: empty delta`); break;
      case "TEXT_MESSAGE_END": need(open.text, event.messageId, "message"); open.text.delete(event.messageId); break;
      case "REASONING_START": open.reasoning.add(event.messageId); break;
      case "REASONING_MESSAGE_CONTENT": need(open.reasoning, event.messageId, "reasoning"); break;
      case "REASONING_END": need(open.reasoning, event.messageId, "reasoning"); open.reasoning.delete(event.messageId); break;
      case "TOOL_CALL_START": open.tools.add(event.toolCallId); break;
      case "TOOL_CALL_ARGS": need(open.tools, event.toolCallId, "tool call"); break;
      case "TOOL_CALL_END": need(open.tools, event.toolCallId, "tool call"); open.tools.delete(event.toolCallId); break;
      case "STEP_STARTED": if (step !== null) throw new Error(`${where}: step ${step} is still open`); step = event.stepName; break;
      case "STEP_FINISHED": if (step !== event.stepName && !(joined && step === null)) throw new Error(`${where}: finishes ${event.stepName} but ${step} is open`); step = null; break;
      case "RUN_FINISHED":
      case "RUN_ERROR": ended = true; break;
      default:
    }
    if ((event.type === "STEP_FINISHED" || ended) && (open.text.size > 0 || open.reasoning.size > 0)) throw new Error(`${where}: a message is still open`);
  });
  const stopped = !ended && events.length > 0;
  if (stopped && (open.text.size > 0 || open.reasoning.size > 0 || open.tools.size > 0)) throw new Error(`${label}: the stream stops with something open`);
}

const encode = [];
for (const scenario of runScenarios) {
  const losses = [];
  const options = adapterOptions(scenario.options, losses);
  const expect = agUi.encode(scenario.events, options);
  validate(expect, scenario.name, { joined: scenario.options?.runId !== undefined && scenario.events[0]?.type !== "run-start" });
  const back = [];
  const roundtrip = agUi.decode(expect, adapterOptions({ ...scenario.options, now: NOW }, back));
  encode.push({ name: scenario.name, note: scenario.note, ...(scenario.options ? { options: scenario.options } : {}), events: scenario.events, expect, loss: losses, roundtrip, roundtrip_loss: back });
}

// ---- AG-UI streams the decoder reads -------------------------------------------------------------------------------------
const card = { id: "card_ask", callId: "call_ask", spec: { kind: "super.form", title: "Which region?" } };
const snapshot = (c) => ({ type: "ACTIVITY_SNAPSHOT", messageId: c.id, activityType: "super-card", content: c, replace: true });
const decodeScenarios = [
  {
    name: "plain-text-run",
    note: "The shortest AG-UI run: a run, a step, one message. The step name is not ours, so steps count from 0.",
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "STEP_STARTED", stepName: "plan" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " there" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "STEP_FINISHED", stepName: "plan" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1", outcome: { type: "success" } },
    ],
  },
  {
    name: "tool-call-with-split-arguments",
    note: "Arguments arrive in pieces and are one input when the call ends; the duration comes from the events' timestamps.",
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r2" },
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search", timestamp: 1000 },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"q":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '"cats"}' },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
      { type: "TOOL_CALL_RESULT", messageId: "tm1", toolCallId: "tc1", content: "3 results", role: "tool", timestamp: 1250 },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r2" },
    ],
  },
  {
    name: "arguments-that-are-not-json",
    note: "A call whose arguments are not JSON keeps their text as the input and says so.",
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r3" },
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "run" },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: "{not json" },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
    ],
  },
  {
    name: "result-of-a-call-that-never-started",
    note: "A result with no call before it is not invented a call for.",
    events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r4" }, { type: "TOOL_CALL_RESULT", messageId: "tm1", toolCallId: "ghost", content: "x", role: "tool" }],
  },
  {
    name: "interrupt-then-resume",
    note: "The run ends with an interrupt and the person's answer comes back as `resume`: one answers, one cancels.",
    now: NOW,
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r5" },
      { type: "TOOL_CALL_START", toolCallId: "call_ask", toolCallName: "ask" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call_ask", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "call_ask" },
      snapshot(card),
      { type: "RUN_FINISHED", threadId: "t1", runId: "r5", outcome: { type: "interrupt", interrupts: [{ id: "call_ask", reason: "input_required", toolCallId: "call_ask" }, { id: "other", reason: "confirmation", toolCallId: "nowhere" }] } },
    ],
    resume: [{ interruptId: "call_ask", status: "resolved", payload: { region: "eu" } }, { interruptId: "other", status: "cancelled" }, { interruptId: "unknown", status: "cancelled" }],
  },
  {
    name: "resume-inside-run-started",
    note: "A resumed run says what it resumes in RUN_STARTED.input.resume; the decoder reads it from there.",
    now: NOW,
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r6" },
      snapshot({ id: "card_confirm", callId: "call_confirm", spec: { kind: "super.confirm" } }),
      { type: "RUN_FINISHED", threadId: "t1", runId: "r6", outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "confirmation", toolCallId: "call_confirm" }] } },
      { type: "RUN_STARTED", threadId: "t1", runId: "r7", input: { threadId: "t1", runId: "r7", messages: [], tools: [], context: [], resume: [{ interruptId: "i1", status: "resolved", payload: true }] } },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r7" },
    ],
  },
  {
    name: "failed-run",
    note: "RUN_ERROR ends the run: the decoder gives the error and the run-finish a run sends after it.",
    events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r8" }, { type: "RUN_ERROR", message: "boom", code: "E42" }],
  },
  {
    name: "cancelled-run",
    note: "A cancelled outcome.",
    events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r9" }, { type: "RUN_FINISHED", threadId: "t1", runId: "r9", outcome: { type: "cancelled" } }],
  },
  {
    name: "events-with-no-run-event",
    note: "State, patches, raw events, sub-agents, chunk forms and an unknown custom event are not a run's output.",
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r10" },
      { type: "STATE_SNAPSHOT", snapshot: { count: 1 } },
      { type: "STATE_DELTA", delta: [{ op: "replace", path: "/count", value: 2 }] },
      { type: "RAW", event: { anything: true } },
      { type: "CUSTOM", name: "someone-else.event", value: 1 },
      { type: "ACTIVITY_SNAPSHOT", messageId: "a1", activityType: "plan", content: { steps: [] } },
      { type: "ACTIVITY_DELTA", messageId: "a1", activityType: "plan", patch: [] },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "chunked" },
      { type: "TOOL_CALL_CHUNK", toolCallId: "tc1", toolCallName: "x", delta: "{}" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r10", result: { done: true }, usage: [{ inputTokens: 3 }] },
    ],
  },
  {
    name: "message-of-the-user",
    note: "A user message in the stream is not output of the run.",
    events: [{ type: "RUN_STARTED", threadId: "t1", runId: "r11" }, { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" }, { type: "TEXT_MESSAGE_END", messageId: "u1" }],
  },
  {
    name: "messages-snapshot",
    note: "A snapshot of the conversation: the assistant's text and the cards become a run-snapshot, the rest is not the run's.",
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r12" },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "Hi, how can I help?" },
          { id: "card_ask", role: "activity", activityType: "super-card", content: card },
          { id: "x1", role: "activity", activityType: "plan", content: {} },
        ],
      },
    ],
  },
  {
    name: "events-sent-as-custom",
    note: "What the encoder sends as CUSTOM super.<type> comes back as that run event; a failure sent before a result rides on it.",
    events: [
      { type: "RUN_STARTED", threadId: "t1", runId: "r13" },
      { type: "CUSTOM", name: "super.usage", value: { usage: { inputTokens: 2 } } },
      { type: "CUSTOM", name: "super.metering", value: { record: { model: "m" } } },
      { type: "CUSTOM", name: "super.error", value: { error: "retrying", recoverable: true } },
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "fetch" },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
      { type: "CUSTOM", name: "super.tool-failure", value: { toolCallId: "tc1", failure: "timeout", ms: 77 } },
      { type: "TOOL_CALL_RESULT", messageId: "tc1:result", toolCallId: "tc1", content: "timeout", role: "tool" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r13" },
    ],
  },
];

const decode = decodeScenarios.map((scenario) => {
  validate(scenario.events, scenario.name, { joined: scenario.events[0]?.type !== "RUN_STARTED" });
  const losses = [];
  const decoder = agUi.createDecoder(adapterOptions({ now: scenario.now }, losses));
  const expect = [];
  for (const event of scenario.events) expect.push(...decoder.push(event));
  if (scenario.resume) expect.push(...decoder.resume(scenario.resume));
  expect.push(...decoder.end());
  const { name, note, now, events, resume } = scenario;
  return { name, note, ...(now !== undefined ? { options: { now } } : {}), events, ...(resume ? { resume } : {}), expect, loss: losses };
});

writeGolden(
  fileURLToPath(new URL("../conformance/interop-ag-ui.v0.json", import.meta.url)),
  {
    version: 0,
    status: "draft",
    note: "DRAFT, not stable and not part of protocol.v1.json. Generated by scripts/export-interop-ag-ui.mjs from implementations/typescript/src/interop/ag-ui.ts; every AG-UI event in it parses with the @ag-ui/core schemas. `encode`: run events -> AG-UI events (`expect`), what was lost (`loss`) and what decoding the result gives back (`roundtrip`). `decode`: AG-UI events (and `resume` entries) -> run events. An option `now` is the clock of the decoder in milliseconds.",
    generated_with: { "@ag-ui/core": devVersion("@ag-ui/core"), agui_protocol_version: PROTOCOL_VERSION },
    encode,
    decode,
  },
  "export-interop-ag-ui.mjs",
);
