// Scenarios for conformance/agent-loop-replay.v0.json (the "shadow replay"): what goes over the wire, written by hand.
//
// A scenario is everything the outside world does in one run: the bytes each model call answers with (an SSE body, or an
// HTTP error), what each tool does and how long it takes, what the person answers. Super Chat's real `runAgent`, with its
// real OpenAI Chat Completions adapter, is run over it (scripts/export-agent-replay.mjs) and the events and request
// bodies it produced are written next to it. Any other implementation must produce the same events from the same bytes
// and the same request bodies from the same history. The expected values are therefore not typed here: they are what the
// TypeScript loop did.
//
// Scenario shape:
//   { name, description,
//     config: { maxSteps?, stopWhen?, interactive? },
//     system: "...", messages: [Message],                       // what the host passes in
//     tools: [{ name, side, description, parameters, script: [ { output?, failure?, error?, delayMs? } ] }],
//     // one entry per model call, in order:
//     calls: [ { chunks: [<bytes as a string, or { b64 }>] } | { status, body } ],
//     actions: { "<callId>": { type, value? } } }              // the person's answers to approval cards

const SYSTEM = "You are a test agent.";
const user = (text) => [{ role: "user", parts: [{ type: "text", text }] }];

/** One Chat Completions chunk. */
const chunk = (delta, finish = null, extra = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const usageChunk = (prompt, completion, extra = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...extra },
});
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";
/** A whole well-formed body, one SSE frame per chunk. */
const body = (...objs) => ({ chunks: [...objs.map(frame), DONE] });
const toolCall = (index, fields) => ({ tool_calls: [{ index, ...fields }] });
const fn = (name, args) => ({ type: "function", function: { name, arguments: args } });

const echo = {
  name: "echo",
  side: "read",
  description: "Echo the text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  script: [{ output: { echoed: "hi" } }],
};
const slow = (name, delayMs, output) => ({
  name,
  side: "read",
  description: `Look up ${name}.`,
  parameters: { type: "object", properties: { q: { type: "string" } } },
  script: [{ output, delayMs }],
});

export const scenarios = [
  {
    name: "text-only-streamed",
    description: "One model call, text in three fragments, usage in its own final chunk.",
    config: {},
    system: SYSTEM,
    messages: user("Say hello."),
    tools: [echo],
    calls: [body(chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ content: "lo, " }), chunk({ content: "wörld 你好." }), chunk({}, "stop"), usageChunk(12, 6))],
  },
  {
    name: "tool-then-answer",
    description: "The arguments arrive in two fragments; the tool result goes back; the second call answers.",
    config: {},
    system: SYSTEM,
    messages: user("Echo hi."),
    tools: [echo],
    calls: [
      body(
        chunk({ role: "assistant", content: "" }),
        chunk(toolCall(0, { id: "call_a", ...fn("echo", "") })),
        chunk(toolCall(0, { function: { arguments: '{"text":' } })),
        chunk(toolCall(0, { function: { arguments: '"hi"}' } })),
        chunk({}, "tool_calls"),
        usageChunk(10, 5),
      ),
      body(chunk({ role: "assistant", content: "It said " }), chunk({ content: "hi." }), chunk({}, "stop"), usageChunk(20, 3)),
    ],
  },
  {
    name: "text-before-tool-call",
    description: "The model says something and then calls a tool; the assistant message keeps both, text first.",
    config: {},
    system: SYSTEM,
    messages: user("Echo hi."),
    tools: [echo],
    calls: [
      body(chunk({ role: "assistant", content: "Let me check." }), chunk(toolCall(0, { id: "call_a", ...fn("echo", '{"text":"hi"}') })), chunk({}, "tool_calls"), usageChunk(10, 9)),
      body(chunk({ content: "Done." }), chunk({}, "stop"), usageChunk(25, 2)),
    ],
  },
  {
    name: "parallel-calls-interleaved",
    description: "Two calls whose fragments interleave by index; the second tool finishes first, so tool-result events come in completion order and the history in call order.",
    config: {},
    system: SYSTEM,
    messages: user("Look up both."),
    tools: [slow("first", 120, { v: 1 }), slow("second", 5, { v: 2 })],
    calls: [
      body(
        chunk({ role: "assistant", content: "" }),
        chunk(toolCall(0, { id: "call_1", ...fn("first", "") })),
        chunk(toolCall(1, { id: "call_2", ...fn("second", "") })),
        chunk(toolCall(1, { function: { arguments: '{"q":"b"' } })),
        chunk(toolCall(0, { function: { arguments: '{"q":"a"}' } })),
        chunk(toolCall(1, { function: { arguments: "}" } })),
        chunk({}, "tool_calls"),
        usageChunk(30, 20),
      ),
      body(chunk({ content: "Both done." }), chunk({}, "stop"), usageChunk(60, 4)),
    ],
  },
  {
    name: "name-and-id-on-later-fragments",
    description: "The tool name is split across fragments and the id arrives after the first fragment (the first one is positional only).",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [echo],
    calls: [
      body(
        chunk(toolCall(0, { function: { name: "ec" } })),
        chunk(toolCall(0, { id: "call_late", function: { name: "ho", arguments: '{"text"' } })),
        chunk(toolCall(0, { function: { arguments: ':"x"}' } })),
        chunk({}, "tool_calls"),
        usageChunk(8, 8),
      ),
      body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(16, 1)),
    ],
  },
  {
    name: "call-without-id-gets-positional-id",
    description: "A server that sends no tool call id: the call is named call_<index> and the result is matched to it.",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [echo],
    calls: [
      body(chunk(toolCall(0, { ...fn("echo", '{"text":"hi"}') })), chunk({}, "tool_calls"), usageChunk(8, 4)),
      body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(16, 1)),
    ],
  },
  {
    name: "repaired-arguments",
    description: "Arguments in a markdown fence with a trailing comma: repaired, flagged, run.",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [echo],
    calls: [
      body(chunk(toolCall(0, { id: "call_fix", ...fn("echo", '```json\n{"text": "hi",}\n```') })), chunk({}, "tool_calls"), usageChunk(8, 9)),
      body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(24, 1)),
    ],
  },
  {
    name: "unrepairable-arguments",
    description: "Arguments that cannot be repaired: the call goes on with what the repair left, and the tool answers for itself.",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [{ ...echo, script: [{ failure: "execution-error", error: "text is required" }] }],
    calls: [
      body(chunk(toolCall(0, { id: "call_bad", ...fn("echo", "this is not json at all") })), chunk({}, "tool_calls"), usageChunk(8, 9)),
      body(chunk({ content: "Sorry." }), chunk({}, "stop"), usageChunk(30, 1)),
    ],
  },
  {
    name: "unknown-tool",
    description: "A tool the host never declared: answered by the loop itself, the model sees what is available.",
    config: {},
    system: SYSTEM,
    messages: user("Do it."),
    tools: [echo],
    calls: [
      body(chunk(toolCall(0, { id: "call_n", ...fn("nope", "{}") })), chunk({}, "tool_calls"), usageChunk(8, 4)),
      body(chunk({ content: "I cannot." }), chunk({}, "stop"), usageChunk(20, 2)),
    ],
  },
  {
    name: "tool-name-with-router-prefix",
    description: "A router that prefixes the tool name (default_api:echo): TypeScript's registry still finds the tool.",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [echo],
    calls: [
      body(chunk(toolCall(0, { id: "call_p", ...fn("default_api:echo", '{"text":"hi"}') })), chunk({}, "tool_calls"), usageChunk(8, 4)),
      body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(20, 1)),
    ],
  },
  {
    name: "tool-throws",
    description: "A tool that throws is a result with a failure, not an error: the run goes on and the model reads it.",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [{ ...echo, script: [{ failure: "execution-error", error: "boom" }] }],
    calls: [
      body(chunk(toolCall(0, { id: "call_t", ...fn("echo", '{"text":"hi"}') })), chunk({}, "tool_calls"), usageChunk(8, 4)),
      body(chunk({ content: "It failed." }), chunk({}, "stop"), usageChunk(24, 3)),
    ],
  },
  {
    name: "output-key-order-and-strings",
    description: "Tool output with keys out of alphabetical order, nested values and non-ASCII text, and one tool whose output is a plain string: the request body carries them exactly as JSON.stringify writes them.",
    config: {},
    system: SYSTEM,
    messages: user("Look up both."),
    tools: [
      slow("rows", 5, { z: 1, a: { y: [3, 2, 1], b: null }, 名: "值", n: 1.5, big: 100000000, t: true }),
      slow("plain", 30, "just a string, with \"quotes\""),
    ],
    calls: [
      body(
        chunk(toolCall(0, { id: "call_r", ...fn("rows", '{"q":"x"}') })),
        chunk(toolCall(1, { id: "call_s", ...fn("plain", '{"b":2,"a":1}') })),
        chunk({}, "tool_calls"),
        usageChunk(9, 9),
      ),
      body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(60, 1)),
    ],
  },
  {
    name: "tools-listed-in-locale-order",
    description: "Tools registered in a jumbled order are declared to the model in localeCompare order (not byte order): punctuation, digits, then letters, lowercase before uppercase.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: ["b", "B", "a1", "a_b", "Ab", "a-b", "aB", "a"].map((name) => ({ ...echo, name })),
    calls: [body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(5, 1))],
  },
  {
    name: "frames-after-done-are-ignored",
    description: "Nothing after the [DONE] sentinel counts, even a well-formed frame.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ chunks: [frame(chunk({ content: "kept" })), frame(chunk({}, "stop")), frame(usageChunk(5, 1)), DONE, frame(chunk({ content: " IGNORED" })), frame(usageChunk(99, 99))] }],
  },
  {
    name: "usage-with-details",
    description: "Cached input tokens and reasoning tokens ride along in the usage of the step and of the run.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [body(chunk({ content: "ok" }), chunk({}, "stop"), usageChunk(100, 20, { prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 12 } }))],
  },
  {
    name: "tool-throws-timeout-and-network",
    description: "A thrown error's kind is read from its words: a timeout and a network failure are told apart from the rest.",
    config: {},
    system: SYSTEM,
    messages: user("Look up both."),
    tools: [
      { ...slow("slowpoke", 5, null), script: [{ failure: "execution-error", error: "The request timed out after 30s.", delayMs: 5 }] },
      { ...slow("flaky", 60, null), script: [{ failure: "execution-error", error: "fetch failed: ECONNRESET", delayMs: 60 }] },
    ],
    calls: [
      body(chunk(toolCall(0, { id: "call_1", ...fn("slowpoke", '{"q":"a"}') })), chunk(toolCall(1, { id: "call_2", ...fn("flaky", '{"q":"b"}') })), chunk({}, "tool_calls"), usageChunk(9, 9)),
      body(chunk({ content: "Both failed." }), chunk({}, "stop"), usageChunk(60, 3)),
    ],
  },
  {
    name: "confirm-approved",
    description: "A confirm tool in an interactive run: the card is announced, the person says yes, the tool runs.",
    config: { interactive: true },
    system: SYSTEM,
    messages: user("Send it."),
    tools: [{ name: "send", side: "confirm", description: "Send a message.", parameters: { type: "object", properties: { to: { type: "string" } } }, script: [{ output: { sent: true } }] }],
    calls: [
      body(chunk(toolCall(0, { id: "call_c", ...fn("send", '{"to":"ann"}') })), chunk({}, "tool_calls"), usageChunk(8, 6)),
      body(chunk({ content: "Sent." }), chunk({}, "stop"), usageChunk(30, 1)),
    ],
    actions: { call_c: { type: "submit", value: { confirmed: true } } },
  },
  {
    name: "confirm-declined",
    description: "The person says no: the tool does not run, the model reads that, the run goes on.",
    config: { interactive: true },
    system: SYSTEM,
    messages: user("Send it."),
    tools: [{ name: "send", side: "confirm", description: "Send a message.", parameters: { type: "object", properties: { to: { type: "string" } } }, script: [{ output: { sent: true } }] }],
    calls: [
      body(chunk(toolCall(0, { id: "call_c", ...fn("send", '{"to":"ann"}') })), chunk({}, "tool_calls"), usageChunk(8, 6)),
      body(chunk({ content: "Understood, not sending." }), chunk({}, "stop"), usageChunk(30, 4)),
    ],
    actions: { call_c: { type: "cancel" } },
  },
  {
    name: "confirm-without-a-person",
    description: "A confirm tool in a run that cannot ask: denied at once, the tool never runs.",
    config: { interactive: false },
    system: SYSTEM,
    messages: user("Send it."),
    tools: [{ name: "send", side: "confirm", description: "Send a message.", parameters: { type: "object", properties: { to: { type: "string" } } }, script: [{ output: { sent: true } }] }],
    calls: [
      body(chunk(toolCall(0, { id: "call_c", ...fn("send", '{"to":"ann"}') })), chunk({}, "tool_calls"), usageChunk(8, 6)),
      body(chunk({ content: "I cannot send." }), chunk({}, "stop"), usageChunk(30, 4)),
    ],
  },
  {
    name: "step-limit",
    description: "The model keeps calling a tool; maxSteps 2 ends the run with the step-limit notice.",
    config: { maxSteps: 2 },
    system: SYSTEM,
    messages: user("Loop."),
    tools: [echo],
    calls: [
      body(chunk(toolCall(0, { id: "call_1", ...fn("echo", '{"text":"a"}') })), chunk({}, "tool_calls"), usageChunk(8, 4)),
      body(chunk(toolCall(0, { id: "call_2", ...fn("echo", '{"text":"b"}') })), chunk({}, "tool_calls"), usageChunk(20, 4)),
    ],
  },
  {
    name: "stop-after-tool",
    description: "stopWhen afterTool: the run ends after that tool, with finishReason stop and no further model call.",
    config: { stopWhen: [{ kind: "afterTool", names: ["echo"] }] },
    system: SYSTEM,
    messages: user("Echo once."),
    tools: [echo],
    calls: [body(chunk(toolCall(0, { id: "call_1", ...fn("echo", '{"text":"a"}') })), chunk({}, "tool_calls"), usageChunk(8, 4))],
  },
  {
    name: "finish-length-no-usage",
    description: "The model is cut off by its output limit and reports no usage.",
    config: {},
    system: SYSTEM,
    messages: user("Write a lot."),
    tools: [echo],
    calls: [body(chunk({ role: "assistant", content: "A long answer that stops" }), chunk({}, "length"))],
  },
  {
    name: "stream-ends-without-finish-reason",
    description: "The stream ends after the text with no finish_reason and no [DONE]: finishes as stop.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ chunks: [frame(chunk({ content: "Hi there." })), frame(usageChunk(5, 3))] }],
  },
  {
    name: "sse-framing",
    description: "CRLF line ends, comment lines, a data field split over two lines, an event named by an event: line, a malformed frame, and frames cut mid-line.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [
      {
        chunks: [
          ": keep-alive\r\n\r\n",
          `event: message\r\ndata: ${JSON.stringify(chunk({ content: "a" }))}\r\n\r\n`,
          "data: {this is not json}\n\n",
          // one JSON value written over two data: lines joins with a newline, which JSON allows between tokens
          `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model",\ndata: "choices":[{"index":0,"delta":{"content":"b"},"finish_reason":null}]}\n\n`,
          // a frame cut in the middle of a line, and of an event
          `data: ${JSON.stringify(chunk({ content: "c" })).slice(0, 40)}`,
          `${JSON.stringify(chunk({ content: "c" })).slice(40)}\n`,
          "\n",
          frame(chunk({}, "stop")),
          frame(usageChunk(7, 3)),
          DONE,
        ],
      },
    ],
  },
  {
    name: "utf8-split-across-reads",
    description: "A multi-byte character cut in half between two reads of the body.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ split: "你好🙂", chunks: [] }], // built by the exporter: the bytes of one frame, cut inside the first character
  },
  {
    name: "http-401",
    description: "The provider refuses the key: one error event naming the provider's own message.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ status: 401, body: { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } } }],
  },
  {
    name: "http-429-text-body",
    description: "A rate limit whose body is not JSON: the body text is the message.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ status: 429, text: "slow down" }],
  },
  {
    name: "http-400-context-length",
    description: "A 400 whose message names the context window is context-length, not invalid-request.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens." } } }],
  },
  {
    name: "http-500-on-second-step",
    description: "The second model call fails: the first step's usage and tool result stand, the run ends in error.",
    config: {},
    system: SYSTEM,
    messages: user("Echo."),
    tools: [echo],
    calls: [
      body(chunk(toolCall(0, { id: "call_a", ...fn("echo", '{"text":"hi"}') })), chunk({}, "tool_calls"), usageChunk(8, 4)),
      { status: 500, body: { error: { message: "The server had an error." } } },
    ],
  },
  {
    name: "content-filter-message",
    description: "An error whose message mentions a content filter is classified as content-filter whatever the status.",
    config: {},
    system: SYSTEM,
    messages: user("Hi."),
    tools: [echo],
    calls: [{ status: 400, body: { error: { message: "Blocked by the content filter." } } }],
  },
  {
    name: "history-with-earlier-turns",
    description: "Earlier turns in the history: a user message with two text parts, an assistant message with a tool call that was answered, and one that was not (dropped from the request).",
    config: {},
    system: SYSTEM,
    messages: [
      { role: "user", parts: [{ type: "text", text: "First" }, { type: "text", text: "second part" }] },
      { role: "assistant", parts: [{ type: "text", text: "Checking." }, { type: "tool-call", callId: "old_1", name: "echo", input: { text: "x" }, status: "done" }] },
      { role: "tool", parts: [{ type: "tool-result", callId: "old_1", name: "echo", output: { echoed: "x" } }] },
      { role: "assistant", parts: [{ type: "tool-call", callId: "old_2", name: "echo", input: { text: "y" }, status: "pending" }] },
      { role: "assistant", parts: [{ type: "text", text: "Done." }] },
      { role: "user", parts: [{ type: "text", text: "Now?" }] },
    ],
    tools: [echo],
    calls: [body(chunk({ content: "Now." }), chunk({}, "stop"), usageChunk(50, 1))],
  },
];
