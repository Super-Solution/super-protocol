// Source of agent-loop.v0.json. Written by hand, on purpose: the expected events are what the SPEC says,
// not what any implementation printed. `node cases/build.mjs` turns this into the JSON the ports read.
//
// A case is a transcript. `steps[i].in` is what the outside world feeds the machine, `events` and `effects`
// are what it must answer, exactly, in order. See ../SPEC.md.

const U = (i, o) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });
const text = (t) => ({ type: "text", text: t });
const call = (callId, name, input = {}) => ({ type: "tool-call", callId, name, input });

// inputs
const start = (messages = []) => ({ kind: "start", runId: "run_1", mode: "stream", messages });
const model = (parts, finishReason, usage) => ({ kind: "model-result", parts, finishReason, usage });
const modelError = (kind, message, usage) => ({ kind: "model-error", error: { kind, message }, ...(usage ? { usage } : {}) });
const out = (callId, output, failure, ms = 0) => ({ kind: "tool-outcome", callId, output, ...(failure ? { failure } : {}), ms });
const act = (callId, type, value) => ({ kind: "user-action", callId, action: { type, ...(value !== undefined ? { value } : {}) } });
const cancel = { kind: "cancel" };

// events
const ev = {
  runStart: { type: "run-start", runId: "run_1", mode: "stream" },
  stepStart: (step) => ({ type: "step-start", step }),
  delta: (delta) => ({ type: "text-delta", delta }),
  usage: (usage) => ({ type: "usage", usage }),
  stepFinish: (step, finishReason, usage) => ({ type: "step-finish", step, finishReason, usage }),
  toolCall: (callId, name, input = {}) => ({ type: "tool-call", callId, name, input }),
  result: (callId, name, output, failure, ms = 0) => ({ type: "tool-result", callId, name, output, ...(failure ? { failure } : {}), ms }),
  awaiting: (callId, name, input = {}) => ({ type: "awaiting-user", callId, card: { id: `approval:${callId}`, callId, spec: { kind: "confirm", tool: name, input } } }),
  responded: (callId, type, value) => ({ type: "user-responded", callId, action: { type, ...(value !== undefined ? { value } : {}) } }),
  limit: (steps) => ({ type: "message", parts: [{ type: "notice", code: "step-limit", steps }] }),
  error: (kind, message) => ({ type: "error", error: { kind, message }, recoverable: false }),
  finish: (finishReason, usage, steps) => ({ type: "run-finish", runId: "run_1", finishReason, usage, steps }),
};

// effects
const fx = {
  callModel: (step, toolNames) => ({ kind: "call-model", step, toolNames }),
  runTool: (callId, name, input = {}) => ({ kind: "run-tool", callId, name, input }),
  ask: (callId) => ({ kind: "ask-user", callId }),
  appendAssistant: (parts) => ({ kind: "append", message: { role: "assistant", parts } }),
  appendTools: (results) => ({ kind: "append", message: { role: "tool", parts: results.map((r) => ({ type: "tool-result", ...r })) } }),
  done: { kind: "done" },
};

const step = (input, events = [], effects = []) => ({ in: input, events, effects });

const READ = (name) => ({ name, side: "read" });
const CONFIRM = (name) => ({ name, side: "confirm" });

export const cases = [
  {
    name: "text-only-answer",
    description: "One model call, no tools: the whole run is one step.",
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([text("Hello.")], "stop", U(10, 5)),
        [ev.delta("Hello."), ev.usage(U(10, 5)), ev.stepFinish(0, "stop", U(10, 5)), ev.finish("stop", U(10, 5), 1)],
        [fx.appendAssistant([text("Hello.")]), fx.done],
      ),
    ],
  },
  {
    name: "one-tool-then-answer",
    description: "A tool step, then an answer. Usage is added up once per model call; run-finish carries the total.",
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([call("c1", "echo", { value: "ping" })], "tool-calls", U(100, 30)),
        [ev.usage(U(100, 30)), ev.stepFinish(0, "tool-calls", U(100, 30)), ev.toolCall("c1", "echo", { value: "ping" })],
        [fx.appendAssistant([call("c1", "echo", { value: "ping" })]), fx.runTool("c1", "echo", { value: "ping" })],
      ),
      step(
        out("c1", { echoed: "ping" }),
        [ev.result("c1", "echo", { echoed: "ping" }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "echo", output: { echoed: "ping" } }]), fx.callModel(1, ["echo"])],
      ),
      step(
        model([text("It said ping.")], "stop", U(150, 12)),
        [ev.delta("It said ping."), ev.usage(U(150, 12)), ev.stepFinish(1, "stop", U(150, 12)), ev.finish("stop", U(250, 42), 2)],
        [fx.appendAssistant([text("It said ping.")]), fx.done],
      ),
    ],
  },
  {
    name: "parallel-tools-complete-out-of-order",
    description: "Results are reported in completion order; the message written back to history keeps call order.",
    config: { tools: [READ("a"), READ("b")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["a", "b"])]),
      step(
        model([call("c1", "a"), call("c2", "b")], "tool-calls", U(10, 10)),
        [ev.usage(U(10, 10)), ev.stepFinish(0, "tool-calls", U(10, 10)), ev.toolCall("c1", "a"), ev.toolCall("c2", "b")],
        [fx.appendAssistant([call("c1", "a"), call("c2", "b")]), fx.runTool("c1", "a"), fx.runTool("c2", "b")],
      ),
      step(out("c2", { v: "B" }), [ev.result("c2", "b", { v: "B" })]),
      step(
        out("c1", { v: "A" }),
        [ev.result("c1", "a", { v: "A" }), ev.stepStart(1)],
        [
          fx.appendTools([
            { callId: "c1", name: "a", output: { v: "A" } },
            { callId: "c2", name: "b", output: { v: "B" } },
          ]),
          fx.callModel(1, ["a", "b"]),
        ],
      ),
      step(
        model([text("Both.")], "stop", U(5, 1)),
        [ev.delta("Both."), ev.usage(U(5, 1)), ev.stepFinish(1, "stop", U(5, 1)), ev.finish("stop", U(15, 11), 2)],
        [fx.appendAssistant([text("Both.")]), fx.done],
      ),
    ],
  },
  {
    name: "unknown-tool-names-the-ones-that-exist",
    description: "A call to a tool that is not there never reaches the driver: the loop answers it, listing the real names.",
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([call("c1", "ecko", { value: 1 })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(0, "tool-calls", U(1, 1)),
          ev.toolCall("c1", "ecko", { value: 1 }),
          ev.result("c1", "ecko", { error: 'Unknown tool "ecko".', availableTools: ["echo"] }, "not-found"),
          ev.stepStart(1),
        ],
        [
          fx.appendAssistant([call("c1", "ecko", { value: 1 })]),
          fx.appendTools([{ callId: "c1", name: "ecko", output: { error: 'Unknown tool "ecko".', availableTools: ["echo"] }, failure: "not-found" }]),
          fx.callModel(1, ["echo"]),
        ],
      ),
      step(
        model([text("Sorry.")], "stop", U(1, 1)),
        [ev.delta("Sorry."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("Sorry.")]), fx.done],
      ),
    ],
  },
  {
    name: "tool-failure-goes-back-to-the-model",
    description: "A failed tool is a result, not a crash: the run goes on and the model sees the failure.",
    config: { tools: [READ("fetch")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["fetch"])]),
      step(
        model([call("c1", "fetch", { id: 7 })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "fetch", { id: 7 })],
        [fx.appendAssistant([call("c1", "fetch", { id: 7 })]), fx.runTool("c1", "fetch", { id: 7 })],
      ),
      step(
        out("c1", { error: "boom", kind: "unknown" }, "execution-error", 12),
        [ev.result("c1", "fetch", { error: "boom", kind: "unknown" }, "execution-error", 12), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "fetch", output: { error: "boom", kind: "unknown" }, failure: "execution-error" }]), fx.callModel(1, ["fetch"])],
      ),
      step(
        model([text("It failed.")], "stop", U(2, 2)),
        [ev.delta("It failed."), ev.usage(U(2, 2)), ev.stepFinish(1, "stop", U(2, 2)), ev.finish("stop", U(3, 3), 2)],
        [fx.appendAssistant([text("It failed.")]), fx.done],
      ),
    ],
  },
  {
    name: "step-limit-while-still-working",
    description: "At maxSteps with the model still calling tools, the run says it is cut short (a notice, not prose) and ends tool-calls.",
    config: { maxSteps: 2, tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([call("c1", "echo")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "echo")],
        [fx.appendAssistant([call("c1", "echo")]), fx.runTool("c1", "echo")],
      ),
      step(
        out("c1", { ok: 1 }),
        [ev.result("c1", "echo", { ok: 1 }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "echo", output: { ok: 1 } }]), fx.callModel(1, ["echo"])],
      ),
      step(
        model([call("c2", "echo")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(1, "tool-calls", U(1, 1)), ev.toolCall("c2", "echo")],
        [fx.appendAssistant([call("c2", "echo")]), fx.runTool("c2", "echo")],
      ),
      step(
        out("c2", { ok: 2 }),
        [ev.result("c2", "echo", { ok: 2 }), ev.limit(2), ev.finish("tool-calls", U(2, 2), 2)],
        [fx.appendTools([{ callId: "c2", name: "echo", output: { ok: 2 } }]), fx.done],
      ),
    ],
  },
  {
    name: "confirm-tool-approved",
    description: "A confirm tool asks first. awaiting-user, then user-responded, then the tool runs.",
    config: { interactive: true, tools: [CONFIRM("rename")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename"])]),
      step(
        model([call("c1", "rename", { title: "Q3" })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(0, "tool-calls", U(1, 1)),
          ev.toolCall("c1", "rename", { title: "Q3" }),
          ev.awaiting("c1", "rename", { title: "Q3" }),
        ],
        [fx.appendAssistant([call("c1", "rename", { title: "Q3" })]), fx.ask("c1")],
      ),
      step(act("c1", "confirm"), [ev.responded("c1", "confirm")], [fx.runTool("c1", "rename", { title: "Q3" })]),
      step(
        out("c1", { renamed: true }),
        [ev.result("c1", "rename", { renamed: true }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "rename", output: { renamed: true } }]), fx.callModel(1, ["rename"])],
      ),
      step(
        model([text("Renamed.")], "stop", U(1, 1)),
        [ev.delta("Renamed."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("Renamed.")]), fx.done],
      ),
    ],
  },
  {
    name: "confirm-tool-declined",
    description:
      "A declined confirm tool does not run; the model is told so. The userDeclined stop condition does NOT fire here (it looks for output.cancelled, which only a tool that asks for itself returns), so the run goes on.",
    config: { interactive: true, stopWhen: [{ kind: "userDeclined" }], tools: [CONFIRM("rename")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename"])]),
      step(
        model([call("c1", "rename", { title: "Q3" })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(0, "tool-calls", U(1, 1)),
          ev.toolCall("c1", "rename", { title: "Q3" }),
          ev.awaiting("c1", "rename", { title: "Q3" }),
        ],
        [fx.appendAssistant([call("c1", "rename", { title: "Q3" })]), fx.ask("c1")],
      ),
      step(
        act("c1", "cancel"),
        [ev.responded("c1", "cancel"), ev.result("c1", "rename", { error: "The user declined." }, "denied"), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "rename", output: { error: "The user declined." }, failure: "denied" }]), fx.callModel(1, ["rename"])],
      ),
      step(
        model([text("Understood.")], "stop", U(1, 1)),
        [ev.delta("Understood."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("Understood.")]), fx.done],
      ),
    ],
  },
  {
    name: "confirm-tool-with-no-way-to-ask",
    description: "A host that cannot ask never runs a confirm tool, and never shows a card.",
    config: { interactive: false, tools: [CONFIRM("rename")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename"])]),
      step(
        model([call("c1", "rename")], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(0, "tool-calls", U(1, 1)),
          ev.toolCall("c1", "rename"),
          ev.result("c1", "rename", { error: `"rename" needs the user's approval and this host cannot ask for it.` }, "denied"),
          ev.stepStart(1),
        ],
        [
          fx.appendAssistant([call("c1", "rename")]),
          fx.appendTools([{ callId: "c1", name: "rename", output: { error: `"rename" needs the user's approval and this host cannot ask for it.` }, failure: "denied" }]),
          fx.callModel(1, ["rename"]),
        ],
      ),
      step(
        model([text("I could not.")], "stop", U(1, 1)),
        [ev.delta("I could not."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("I could not.")]), fx.done],
      ),
    ],
  },
  {
    name: "confirm-tool-runs-after-the-parallel-ones",
    description: "In one step, ordinary tools run together first; confirm tools run one at a time after, so their results come last.",
    config: { interactive: true, tools: [CONFIRM("rename"), READ("lookup")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename", "lookup"])]),
      step(
        model([call("c1", "rename", { title: "X" }), call("c2", "lookup", { q: 1 })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(0, "tool-calls", U(1, 1)),
          ev.toolCall("c1", "rename", { title: "X" }),
          ev.toolCall("c2", "lookup", { q: 1 }),
        ],
        [fx.appendAssistant([call("c1", "rename", { title: "X" }), call("c2", "lookup", { q: 1 })]), fx.runTool("c2", "lookup", { q: 1 })],
      ),
      step(out("c2", { found: true }), [ev.result("c2", "lookup", { found: true }), ev.awaiting("c1", "rename", { title: "X" })], [fx.ask("c1")]),
      step(act("c1", "confirm"), [ev.responded("c1", "confirm")], [fx.runTool("c1", "rename", { title: "X" })]),
      step(
        out("c1", { renamed: true }),
        [ev.result("c1", "rename", { renamed: true }), ev.stepStart(1)],
        [
          fx.appendTools([
            { callId: "c1", name: "rename", output: { renamed: true } },
            { callId: "c2", name: "lookup", output: { found: true } },
          ]),
          fx.callModel(1, ["rename", "lookup"]),
        ],
      ),
      step(
        model([text("Done.")], "stop", U(1, 1)),
        [ev.delta("Done."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("Done.")]), fx.done],
      ),
    ],
  },
  {
    name: "consecutive-failures-stop-the-run",
    description: "Two steps in a row where every tool failed: stop, finishReason stop, no third model call.",
    config: { stopWhen: [{ kind: "consecutiveFailures", n: 2 }], tools: [READ("fetch")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["fetch"])]),
      step(
        model([call("c1", "fetch")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "fetch")],
        [fx.appendAssistant([call("c1", "fetch")]), fx.runTool("c1", "fetch")],
      ),
      step(
        out("c1", { error: "no key", kind: "unknown" }, "execution-error"),
        [ev.result("c1", "fetch", { error: "no key", kind: "unknown" }, "execution-error"), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "fetch", output: { error: "no key", kind: "unknown" }, failure: "execution-error" }]), fx.callModel(1, ["fetch"])],
      ),
      step(
        model([call("c2", "fetch")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(1, "tool-calls", U(1, 1)), ev.toolCall("c2", "fetch")],
        [fx.appendAssistant([call("c2", "fetch")]), fx.runTool("c2", "fetch")],
      ),
      step(
        out("c2", { error: "no key", kind: "unknown" }, "execution-error"),
        [ev.result("c2", "fetch", { error: "no key", kind: "unknown" }, "execution-error"), ev.finish("stop", U(2, 2), 2)],
        [fx.appendTools([{ callId: "c2", name: "fetch", output: { error: "no key", kind: "unknown" }, failure: "execution-error" }]), fx.done],
      ),
    ],
  },
  {
    name: "after-tool-stops-the-run",
    description: "afterTool: the run ends right after that tool succeeds. No further model call.",
    config: { stopWhen: [{ kind: "afterTool", names: ["save"] }], tools: [READ("save")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["save"])]),
      step(
        model([call("c1", "save", { doc: 1 })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "save", { doc: 1 })],
        [fx.appendAssistant([call("c1", "save", { doc: 1 })]), fx.runTool("c1", "save", { doc: 1 })],
      ),
      step(
        out("c1", { saved: true }),
        [ev.result("c1", "save", { saved: true }), ev.finish("stop", U(1, 1), 1)],
        [fx.appendTools([{ callId: "c1", name: "save", output: { saved: true } }]), fx.done],
      ),
    ],
  },
  {
    name: "token-budget-stops-the-run",
    description: "tokenBudgetExceeded is checked after the tools of a step, against the running total.",
    config: { stopWhen: [{ kind: "tokenBudgetExceeded", maxTotal: 100 }], tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([call("c1", "echo")], "tool-calls", U(80, 30)),
        [ev.usage(U(80, 30)), ev.stepFinish(0, "tool-calls", U(80, 30)), ev.toolCall("c1", "echo")],
        [fx.appendAssistant([call("c1", "echo")]), fx.runTool("c1", "echo")],
      ),
      step(
        out("c1", { ok: 1 }),
        [ev.result("c1", "echo", { ok: 1 }), ev.finish("stop", U(80, 30), 1)],
        [fx.appendTools([{ callId: "c1", name: "echo", output: { ok: 1 } }]), fx.done],
      ),
    ],
  },
  {
    name: "model-error-ends-the-run-as-error",
    description: "A failed model call: error (not recoverable), then run-finish error. Steps counts the attempt.",
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([call("c1", "echo")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "echo")],
        [fx.appendAssistant([call("c1", "echo")]), fx.runTool("c1", "echo")],
      ),
      step(
        out("c1", { ok: 1 }),
        [ev.result("c1", "echo", { ok: 1 }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "echo", output: { ok: 1 } }]), fx.callModel(1, ["echo"])],
      ),
      step(
        modelError("overloaded", "Provider is busy."),
        [ev.error("overloaded", "Provider is busy."), ev.finish("error", U(1, 1), 2)],
        [fx.done],
      ),
    ],
  },
  {
    name: "cancel-while-tools-run",
    description: "Cancel arrives while a tool is running. The tool settles, then the loop stops before the next step: error cancelled, run-finish cancelled, no step-start.",
    config: { tools: [READ("slow")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["slow"])]),
      step(
        model([call("c1", "slow")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "slow")],
        [fx.appendAssistant([call("c1", "slow")]), fx.runTool("c1", "slow")],
      ),
      step(cancel),
      step(
        out("c1", { error: "Run was cancelled.", kind: "cancelled" }, "denied"),
        [ev.result("c1", "slow", { error: "Run was cancelled.", kind: "cancelled" }, "denied"), ev.error("cancelled", "Run was cancelled."), ev.finish("cancelled", U(1, 1), 1)],
        [fx.appendTools([{ callId: "c1", name: "slow", output: { error: "Run was cancelled.", kind: "cancelled" }, failure: "denied" }]), fx.done],
      ),
    ],
  },
  {
    name: "illegal-input-is-refused",
    description: "An input that answers nothing the machine asked for is a driver bug. It is refused, and nothing is emitted.",
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      { in: out("c9", {}), reject: true },
    ],
  },
];
