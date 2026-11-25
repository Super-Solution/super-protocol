// Source of conformance/agent-loop.v0.json. Written by hand, on purpose: the expected events are what
// docs/AGENT-LOOP.md says, not what any implementation printed. `node scripts/export-agent-loop.mjs` turns this
// into the JSON every implementation reads.
//
// A case is a transcript. `steps[i].in` is what the outside world feeds the machine, `events` and `effects`
// are what it must answer, exactly, in order. `requires` names the optional features a case needs (an
// implementation that lacks one skips the case); `fresh: true` on a step means "the process died: build a new
// machine from the case's config, then feed this". See docs/AGENT-LOOP.md.

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
  checkpoint: (state) => ({ kind: "checkpoint", state }),
};

const step = (input, events = [], effects = []) => ({ in: input, events, effects });

const READ = (name) => ({ name, side: "read" });
const WRITE = (name) => ({ name, side: "write" });
const CONFIRM = (name) => ({ name, side: "confirm" });

/** What the loop tells the model when the repeat guard blocks a call. */
const REPEATED = (name) => ({ error: `Repeated call: "${name}" was already called with the same input in this run. Use that result or change the arguments.` });

// checkpoint and resume
const SNAPSHOT = { kind: "snapshot" };
const resume = (state) => ({ kind: "resume", state });
const call3 = (callId, name, input = {}) => ({ callId, name, input });
/** A checkpoint of run_1 at step 0 with nothing else remembered. Override what the case needs. */
const state = (over) => ({ v: 0, runId: "run_1", mode: "stream", step: 0, attempted: 1, usage: {}, streaks: [], seen: [], ...over });
const askState = state({ usage: U(1, 1), phase: "ask", stepFinish: "tool-calls", calls: [call3("c1", "rename", { title: "Q3" })], results: [], approved: [], asking: "c1" });
const approvedState = state({ usage: U(1, 1), phase: "tools", stepFinish: "tool-calls", calls: [call3("c1", "rename", { title: "Q3" })], results: [], approved: ["c1"] });
const streakState = state({ step: 1, attempted: 2, usage: U(1, 1), streaks: [1], seen: [{ name: "fetch", input: { id: 1 } }], phase: "model" });

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
      "A declined confirm tool does not run; the model is told so and the run goes on. A person's no is a result the model reads, not the end of the run, unless the host adds userDeclined (next case).",
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
    name: "confirm-tool-declined-with-user-declined-stop",
    description: "The same decline with userDeclined in stopWhen: the run ends right after the result, finishReason stop, no second model call.",
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
        [ev.responded("c1", "cancel"), ev.result("c1", "rename", { error: "The user declined." }, "denied"), ev.finish("stop", U(1, 1), 1)],
        [fx.appendTools([{ callId: "c1", name: "rename", output: { error: "The user declined." }, failure: "denied" }]), fx.done],
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

  // ---- who counts as "the person said no" ---------------------------------------------------------------
  {
    name: "user-declined-from-a-tool-that-asks-for-itself",
    description: "userDeclined also fires on output.cancelled === true, the answer a tool that asks for itself gets back and returns.",
    config: { stopWhen: [{ kind: "userDeclined" }], tools: [WRITE("pick")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["pick"])]),
      step(
        model([call("c1", "pick")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "pick")],
        [fx.appendAssistant([call("c1", "pick")]), fx.runTool("c1", "pick")],
      ),
      step(
        out("c1", { cancelled: true, reason: "The user declined." }),
        [ev.result("c1", "pick", { cancelled: true, reason: "The user declined." }), ev.finish("stop", U(1, 1), 1)],
        [fx.appendTools([{ callId: "c1", name: "pick", output: { cancelled: true, reason: "The user declined." } }]), fx.done],
      ),
    ],
  },
  {
    name: "user-declined-an-interactive-card",
    description: "userDeclined also fires on output.response.cancelled === true, what a declined interactive card (visualize) returns.",
    config: { stopWhen: [{ kind: "userDeclined" }], tools: [WRITE("visualize")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["visualize"])]),
      step(
        model([call("c1", "visualize", { kind: "confirm" })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "visualize", { kind: "confirm" })],
        [fx.appendAssistant([call("c1", "visualize", { kind: "confirm" })]), fx.runTool("c1", "visualize", { kind: "confirm" })],
      ),
      step(
        out("c1", { ok: true, kind: "confirm", response: { cancelled: true } }),
        [ev.result("c1", "visualize", { ok: true, kind: "confirm", response: { cancelled: true } }), ev.finish("stop", U(1, 1), 1)],
        [fx.appendTools([{ callId: "c1", name: "visualize", output: { ok: true, kind: "confirm", response: { cancelled: true } } }]), fx.done],
      ),
    ],
  },
  {
    name: "a-denial-that-is-not-the-persons-does-not-stop-the-run",
    description: "A tool that says denied for its own reasons is not the person saying no: userDeclined does not fire and the run goes on.",
    config: { stopWhen: [{ kind: "userDeclined" }], tools: [WRITE("send")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["send"])]),
      step(
        model([call("c1", "send")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "send")],
        [fx.appendAssistant([call("c1", "send")]), fx.runTool("c1", "send")],
      ),
      step(
        out("c1", { error: "Not allowed on this account." }, "denied"),
        [ev.result("c1", "send", { error: "Not allowed on this account." }, "denied"), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "send", output: { error: "Not allowed on this account." }, failure: "denied" }]), fx.callModel(1, ["send"])],
      ),
      step(
        model([text("I could not send it.")], "stop", U(1, 1)),
        [ev.delta("I could not send it."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("I could not send it.")]), fx.done],
      ),
    ],
  },

  // ---- what a call looks like to the model after repair --------------------------------------------------
  {
    name: "repaired-flag-reaches-the-tool-call-event",
    description: "A tool-call part the provider layer had to repair says so (repaired: true); the tool-call event repeats it, and the part is written to history as it came.",
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(
        model([{ ...call("c1", "echo", { value: "ping" }), repaired: true }], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), { ...ev.toolCall("c1", "echo", { value: "ping" }), repaired: true }],
        [fx.appendAssistant([{ ...call("c1", "echo", { value: "ping" }), repaired: true }]), fx.runTool("c1", "echo", { value: "ping" })],
      ),
      step(
        out("c1", { echoed: "ping" }),
        [ev.result("c1", "echo", { echoed: "ping" }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "echo", output: { echoed: "ping" } }]), fx.callModel(1, ["echo"])],
      ),
      step(
        model([text("Ping.")], "stop", U(1, 1)),
        [ev.delta("Ping."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("Ping.")]), fx.done],
      ),
    ],
  },

  // ---- repeated-call guard (requires: repeat-guard) -------------------------------------------------------
  {
    name: "repeat-guard-blocks-an-identical-call",
    description: "With repeatGuard, a second call with the same name and the same input (key order does not matter) is answered at once as denied and never reaches the driver. A different input still runs.",
    requires: ["repeat-guard"],
    config: { repeatGuard: true, tools: [READ("lookup")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["lookup"])]),
      step(
        model([call("c1", "lookup", { q: 1, r: 2 })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "lookup", { q: 1, r: 2 })],
        [fx.appendAssistant([call("c1", "lookup", { q: 1, r: 2 })]), fx.runTool("c1", "lookup", { q: 1, r: 2 })],
      ),
      step(
        out("c1", { hit: true }),
        [ev.result("c1", "lookup", { hit: true }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "lookup", output: { hit: true } }]), fx.callModel(1, ["lookup"])],
      ),
      step(
        model([call("c2", "lookup", { r: 2, q: 1 }), call("c3", "lookup", { q: 2 })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(1, "tool-calls", U(1, 1)),
          ev.toolCall("c2", "lookup", { r: 2, q: 1 }),
          ev.toolCall("c3", "lookup", { q: 2 }),
          ev.result("c2", "lookup", REPEATED("lookup"), "denied"),
        ],
        [fx.appendAssistant([call("c2", "lookup", { r: 2, q: 1 }), call("c3", "lookup", { q: 2 })]), fx.runTool("c3", "lookup", { q: 2 })],
      ),
      step(
        out("c3", { hit: false }),
        [ev.result("c3", "lookup", { hit: false }), ev.stepStart(2)],
        [
          fx.appendTools([
            { callId: "c2", name: "lookup", output: REPEATED("lookup"), failure: "denied" },
            { callId: "c3", name: "lookup", output: { hit: false } },
          ]),
          fx.callModel(2, ["lookup"]),
        ],
      ),
      step(
        model([text("Done.")], "stop", U(1, 1)),
        [ev.delta("Done."), ev.usage(U(1, 1)), ev.stepFinish(2, "stop", U(1, 1)), ev.finish("stop", U(3, 3), 3)],
        [fx.appendAssistant([text("Done.")]), fx.done],
      ),
    ],
  },
  {
    name: "repeat-guard-within-one-step",
    description: "Two identical calls in one step: the first runs, the second is blocked. Results are written back in call order.",
    requires: ["repeat-guard"],
    config: { repeatGuard: true, tools: [READ("lookup")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["lookup"])]),
      step(
        model([call("c1", "lookup", { q: 1 }), call("c2", "lookup", { q: 1 })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(0, "tool-calls", U(1, 1)),
          ev.toolCall("c1", "lookup", { q: 1 }),
          ev.toolCall("c2", "lookup", { q: 1 }),
          ev.result("c2", "lookup", REPEATED("lookup"), "denied"),
        ],
        [fx.appendAssistant([call("c1", "lookup", { q: 1 }), call("c2", "lookup", { q: 1 })]), fx.runTool("c1", "lookup", { q: 1 })],
      ),
      step(
        out("c1", { hit: true }),
        [ev.result("c1", "lookup", { hit: true }), ev.stepStart(1)],
        [
          fx.appendTools([
            { callId: "c1", name: "lookup", output: { hit: true } },
            { callId: "c2", name: "lookup", output: REPEATED("lookup"), failure: "denied" },
          ]),
          fx.callModel(1, ["lookup"]),
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
    name: "repeat-guard-blocks-a-repeat-of-a-declined-call",
    description: "A call the person declined counts as made. Repeating it is blocked without showing the card again.",
    requires: ["repeat-guard"],
    config: { interactive: true, repeatGuard: true, tools: [CONFIRM("rename")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename"])]),
      step(
        model([call("c1", "rename", { title: "Q3" })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "rename", { title: "Q3" }), ev.awaiting("c1", "rename", { title: "Q3" })],
        [fx.appendAssistant([call("c1", "rename", { title: "Q3" })]), fx.ask("c1")],
      ),
      step(
        act("c1", "cancel"),
        [ev.responded("c1", "cancel"), ev.result("c1", "rename", { error: "The user declined." }, "denied"), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "rename", output: { error: "The user declined." }, failure: "denied" }]), fx.callModel(1, ["rename"])],
      ),
      step(
        model([call("c2", "rename", { title: "Q3" })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(1, "tool-calls", U(1, 1)), ev.toolCall("c2", "rename", { title: "Q3" }), ev.result("c2", "rename", REPEATED("rename"), "denied"), ev.stepStart(2)],
        [
          fx.appendAssistant([call("c2", "rename", { title: "Q3" })]),
          fx.appendTools([{ callId: "c2", name: "rename", output: REPEATED("rename"), failure: "denied" }]),
          fx.callModel(2, ["rename"]),
        ],
      ),
      step(
        model([text("Understood.")], "stop", U(1, 1)),
        [ev.delta("Understood."), ev.usage(U(1, 1)), ev.stepFinish(2, "stop", U(1, 1)), ev.finish("stop", U(3, 3), 3)],
        [fx.appendAssistant([text("Understood.")]), fx.done],
      ),
    ],
  },
  {
    name: "identical-calls-run-when-the-guard-is-off",
    description: "Without repeatGuard nothing is compared: an identical call in a later step runs again.",
    config: { tools: [READ("lookup")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["lookup"])]),
      step(
        model([call("c1", "lookup", { q: 1 })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "lookup", { q: 1 })],
        [fx.appendAssistant([call("c1", "lookup", { q: 1 })]), fx.runTool("c1", "lookup", { q: 1 })],
      ),
      step(
        out("c1", { hit: true }),
        [ev.result("c1", "lookup", { hit: true }), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "lookup", output: { hit: true } }]), fx.callModel(1, ["lookup"])],
      ),
      step(
        model([call("c2", "lookup", { q: 1 })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(1, "tool-calls", U(1, 1)), ev.toolCall("c2", "lookup", { q: 1 })],
        [fx.appendAssistant([call("c2", "lookup", { q: 1 })]), fx.runTool("c2", "lookup", { q: 1 })],
      ),
      step(
        out("c2", { hit: true }),
        [ev.result("c2", "lookup", { hit: true }), ev.stepStart(2)],
        [fx.appendTools([{ callId: "c2", name: "lookup", output: { hit: true } }]), fx.callModel(2, ["lookup"])],
      ),
      step(
        model([text("Done.")], "stop", U(1, 1)),
        [ev.delta("Done."), ev.usage(U(1, 1)), ev.stepFinish(2, "stop", U(1, 1)), ev.finish("stop", U(3, 3), 3)],
        [fx.appendAssistant([text("Done.")]), fx.done],
      ),
    ],
  },

  // ---- checkpoint and resume (requires: checkpoint) ------------------------------------------------------
  {
    name: "checkpoint-while-the-model-is-called",
    description: "A snapshot taken while the model call is outstanding, then a new process resumes from it: the model is asked again for the same step, and no event is repeated.",
    requires: ["checkpoint"],
    config: { tools: [READ("echo")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      step(SNAPSHOT, [], [fx.checkpoint(state({ phase: "model" }))]),
      { fresh: true, ...step(resume(state({ phase: "model" })), [], [fx.callModel(0, ["echo"])]) },
      step(
        model([text("Hello.")], "stop", U(1, 1)),
        [ev.delta("Hello."), ev.usage(U(1, 1)), ev.stepFinish(0, "stop", U(1, 1)), ev.finish("stop", U(1, 1), 1)],
        [fx.appendAssistant([text("Hello.")]), fx.done],
      ),
    ],
  },
  {
    name: "resume-reruns-only-the-calls-with-no-result",
    description: "Two parallel tools; one has reported when the process dies. After resume only the other is run again (same callId, so a tool can use it as an idempotency key). The finished one is not.",
    requires: ["checkpoint"],
    config: { tools: [READ("a"), READ("b")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["a", "b"])]),
      step(
        model([call("c1", "a"), call("c2", "b")], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "a"), ev.toolCall("c2", "b")],
        [fx.appendAssistant([call("c1", "a"), call("c2", "b")]), fx.runTool("c1", "a"), fx.runTool("c2", "b")],
      ),
      step(out("c2", { v: "B" }), [ev.result("c2", "b", { v: "B" })]),
      step(
        SNAPSHOT,
        [],
        [
          fx.checkpoint(
            state({
              usage: U(1, 1),
              phase: "tools",
              stepFinish: "tool-calls",
              calls: [call3("c1", "a"), call3("c2", "b")],
              results: [{ callId: "c2", name: "b", output: { v: "B" }, ms: 0 }],
              approved: [],
            }),
          ),
        ],
      ),
      {
        fresh: true,
        ...step(
          resume(
            state({
              usage: U(1, 1),
              phase: "tools",
              stepFinish: "tool-calls",
              calls: [call3("c1", "a"), call3("c2", "b")],
              results: [{ callId: "c2", name: "b", output: { v: "B" }, ms: 0 }],
              approved: [],
            }),
          ),
          [],
          [fx.runTool("c1", "a")],
        ),
      },
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
        model([text("Both.")], "stop", U(1, 1)),
        [ev.delta("Both."), ev.usage(U(1, 1)), ev.stepFinish(1, "stop", U(1, 1)), ev.finish("stop", U(2, 2), 2)],
        [fx.appendAssistant([text("Both.")]), fx.done],
      ),
    ],
  },
  {
    name: "resume-while-asking-asks-again",
    description: "The process dies while the person is deciding. After resume the approval card is announced again (a new follower needs it) and the machine waits for the answer.",
    requires: ["checkpoint"],
    config: { interactive: true, tools: [CONFIRM("rename")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename"])]),
      step(
        model([call("c1", "rename", { title: "Q3" })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "rename", { title: "Q3" }), ev.awaiting("c1", "rename", { title: "Q3" })],
        [fx.appendAssistant([call("c1", "rename", { title: "Q3" })]), fx.ask("c1")],
      ),
      step(SNAPSHOT, [], [fx.checkpoint(askState)]),
      { fresh: true, ...step(resume(askState), [ev.awaiting("c1", "rename", { title: "Q3" })], [fx.ask("c1")]) },
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
    name: "resume-after-approval-runs-the-tool-without-asking-again",
    description: "The person already said yes and the tool was running when the process died. After resume the tool is run again (same callId); the person is not asked a second time.",
    requires: ["checkpoint"],
    config: { interactive: true, tools: [CONFIRM("rename")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["rename"])]),
      step(
        model([call("c1", "rename", { title: "Q3" })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "rename", { title: "Q3" }), ev.awaiting("c1", "rename", { title: "Q3" })],
        [fx.appendAssistant([call("c1", "rename", { title: "Q3" })]), fx.ask("c1")],
      ),
      step(act("c1", "confirm"), [ev.responded("c1", "confirm")], [fx.runTool("c1", "rename", { title: "Q3" })]),
      step(SNAPSHOT, [], [fx.checkpoint(approvedState)]),
      { fresh: true, ...step(resume(approvedState), [], [fx.runTool("c1", "rename", { title: "Q3" })]) },
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
    name: "resume-keeps-the-failure-streak-and-the-call-history",
    description: "What a stop condition and the repeat guard remember across steps survives a resume: one failed step before the crash, a blocked repeat after it, and the streak reaches two.",
    requires: ["checkpoint", "repeat-guard"],
    config: { repeatGuard: true, stopWhen: [{ kind: "consecutiveFailures", n: 2 }], tools: [READ("fetch")] },
    steps: [
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["fetch"])]),
      step(
        model([call("c1", "fetch", { id: 1 })], "tool-calls", U(1, 1)),
        [ev.usage(U(1, 1)), ev.stepFinish(0, "tool-calls", U(1, 1)), ev.toolCall("c1", "fetch", { id: 1 })],
        [fx.appendAssistant([call("c1", "fetch", { id: 1 })]), fx.runTool("c1", "fetch", { id: 1 })],
      ),
      step(
        out("c1", { error: "no key", kind: "unknown" }, "execution-error"),
        [ev.result("c1", "fetch", { error: "no key", kind: "unknown" }, "execution-error"), ev.stepStart(1)],
        [fx.appendTools([{ callId: "c1", name: "fetch", output: { error: "no key", kind: "unknown" }, failure: "execution-error" }]), fx.callModel(1, ["fetch"])],
      ),
      step(SNAPSHOT, [], [fx.checkpoint(streakState)]),
      { fresh: true, ...step(resume(streakState), [], [fx.callModel(1, ["fetch"])]) },
      step(
        model([call("c2", "fetch", { id: 1 })], "tool-calls", U(1, 1)),
        [
          ev.usage(U(1, 1)),
          ev.stepFinish(1, "tool-calls", U(1, 1)),
          ev.toolCall("c2", "fetch", { id: 1 }),
          ev.result("c2", "fetch", REPEATED("fetch"), "denied"),
          ev.finish("stop", U(2, 2), 2),
        ],
        [fx.appendAssistant([call("c2", "fetch", { id: 1 })]), fx.appendTools([{ callId: "c2", name: "fetch", output: REPEATED("fetch"), failure: "denied" }]), fx.done],
      ),
    ],
  },
  {
    name: "checkpoint-and-resume-are-refused-out-of-turn",
    description: "A snapshot with nothing to save, a resume of a state this version does not know, a resume on a machine that has started, and a snapshot after the run ended are all driver bugs: refused, nothing emitted.",
    requires: ["checkpoint"],
    config: { tools: [READ("echo")] },
    steps: [
      { in: SNAPSHOT, reject: true },
      { fresh: true, in: resume({ ...state({ phase: "model" }), v: 1 }), reject: true },
      step(start(), [ev.runStart, ev.stepStart(0)], [fx.callModel(0, ["echo"])]),
      { in: resume(state({ phase: "model" })), reject: true },
      step(
        model([text("Hello.")], "stop", U(1, 1)),
        [ev.delta("Hello."), ev.usage(U(1, 1)), ev.stepFinish(0, "stop", U(1, 1)), ev.finish("stop", U(1, 1), 1)],
        [fx.appendAssistant([text("Hello.")]), fx.done],
      ),
      { in: SNAPSHOT, reject: true },
    ],
  },
];
