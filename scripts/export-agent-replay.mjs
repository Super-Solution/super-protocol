// Writes conformance/agent-loop-replay.v0.json: the shadow replay of the agent loop.
//
// Every scenario of scripts/agent-loop/replay-scenarios.mjs is run through Super Chat's REAL `runAgent` with its
// REAL OpenAI Chat Completions adapter, over a fake transport that answers with the scenario's bytes. What comes out
// (the run's events, and the body of every request the adapter sent) is written next to the scenario. Another
// implementation of the loop passes when the same bytes give it the same events and the same request bodies.
//
//   SUPER_CHAT_DIR=/path/to/super-chat node scripts/export-agent-replay.mjs [--check]
//
// Needs Super Chat's core built (pnpm --filter @supersolutions/super-chat-core build): it imports its dist.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenarios } from "./agent-loop/replay-scenarios.mjs";

const chat = process.env.SUPER_CHAT_DIR;
if (!chat) throw new Error("Set SUPER_CHAT_DIR to a Super Chat checkout (with packages/core built).");
const core = await import(pathToFileURL(`${chat}/packages/core/dist/index.js`).href);
const { runAgent, ToolRegistry, ContextBuilder, createOpenAIProvider, afterTool, stepCountIs, tokenBudgetExceeded, consecutiveFailures, userDeclined } = core;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** Chunks as the data file keeps them: a string when the bytes are valid UTF-8 on their own, else { b64 }. */
function dataChunk(bytes) {
  try {
    return dec.decode(bytes);
  } catch {
    return { b64: Buffer.from(bytes).toString("base64") };
  }
}
const bytesOf = (c) => (typeof c === "string" ? enc.encode(c) : new Uint8Array(Buffer.from(c.b64, "base64")));

/** `split` scenarios: one frame cut inside its first multi-byte character. */
function expandCalls(s) {
  return s.calls.map((call) => {
    if (!call.split) return call;
    const text = JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { content: call.split }, finish_reason: null }] });
    const all = enc.encode(`data: ${text}\n\n`);
    const first = all.indexOf(0xe4); // the lead byte of 你
    const cut = first + 1; // after the lead byte: the character is in two reads
    const stop = enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    return { chunks: [dataChunk(all.slice(0, cut)), dataChunk(all.slice(cut)), dataChunk(stop)] };
  });
}

const stopFrom = (c) => {
  switch (c.kind) {
    case "stepCountIs": return stepCountIs(c.n);
    case "afterTool": return afterTool(...c.names);
    case "tokenBudgetExceeded": return tokenBudgetExceeded(c.maxTotal);
    case "consecutiveFailures": return consecutiveFailures(c.n);
    case "userDeclined": return userDeclined;
    default: throw new Error(`unknown stop condition ${c.kind}`);
  }
};

/** What the data keeps of a run's events: the same normalisation the loop cases use, and text-deltas joined. */
function normalize(events) {
  const calls = new Map();
  const out = [];
  for (const raw of events) {
    const e = JSON.parse(JSON.stringify(raw));
    if (e.type === "context-built" || e.type === "metering" || e.type === "tool-call-input-delta") continue;
    if (e.type === "run-start" || e.type === "run-finish") e.runId = "run_1";
    if (e.type === "tool-call") calls.set(e.callId, e);
    if (e.type === "tool-result") e.ms = 0;
    if (e.type === "awaiting-user") {
      const call = calls.get(e.callId);
      e.card = { id: `approval:${e.callId}`, callId: e.callId, spec: { kind: e.card.spec.kind, tool: call.name, input: call.input } };
    }
    if (e.type === "user-responded") e.action = { type: e.action.type, ...(e.action.value !== undefined ? { value: e.action.value } : {}) };
    if (e.type === "error") e.error = { kind: raw.error.kind, message: raw.error.message };
    if (e.type === "message") {
      const m = /Reached the (\d+)-step limit/.exec(e.parts[0]?.text ?? "");
      if (m) e.parts = [{ type: "notice", code: "step-limit", steps: Number(m[1]) }];
    }
    const prev = out[out.length - 1];
    if (e.type === "text-delta" && prev?.type === "text-delta") prev.delta += e.delta; // the loop reports a text part, a UI may see it in pieces
    else out.push(e);
  }
  return out;
}

async function run(s) {
  const calls = expandCalls(s);
  const requests = [];
  let n = 0;
  const transport = {
    kind: "custom",
    async fetch(req) {
      requests.push({ path: req.path, body: JSON.parse(JSON.stringify(req.body)) });
      const call = calls[n++];
      if (!call) throw new Error(`scenario ${s.name}: the loop made model call ${n}, the scenario has ${calls.length}`);
      if (call.status) {
        const text = call.text ?? JSON.stringify(call.body);
        return new Response(text, { status: call.status, headers: { "content-type": call.text ? "text/plain" : "application/json" } });
      }
      const parts = call.chunks.map(bytesOf);
      return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  };
  const provider = createOpenAIProvider({ transport, dialect: "chat", retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });

  const used = new Map();
  const defs = s.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    side: t.side,
    async execute() {
      const i = used.get(t.name) ?? 0;
      used.set(t.name, i + 1);
      const step = t.script[Math.min(i, t.script.length - 1)];
      if (step.delayMs) await sleep(step.delayMs);
      if (step.failure === "execution-error") throw new Error(step.error);
      return step.failure ? { output: step.output, failure: step.failure } : { output: step.output };
    },
  }));
  const registry = new ToolRegistry().registerAll(defs, ["observer"]);

  const events = [];
  for await (const e of runAgent(s.messages, {
    provider,
    model: "test-model",
    contextBuilder: new ContextBuilder({ identity: s.system, contextWindow: 32_000 }),
    tools: registry,
    toolResolution: { presets: ["observer"] },
    mode: "stream",
    ...(s.config.maxSteps ? { maxSteps: s.config.maxSteps } : {}),
    ...(s.config.stopWhen ? { stopWhen: s.config.stopWhen.map(stopFrom) } : {}),
    ...(s.config.interactive ? { onUserDecision: async (callId) => ({ cardId: `approval:${callId}`, callId, kind: "confirm", at: 0, ...(s.actions ?? {})[callId] }) } : {}),
  })) events.push(e);
  if (n !== calls.length) throw new Error(`scenario ${s.name}: ${calls.length} model calls scripted, the loop made ${n}`);
  return { calls, expected: { events: normalize(events), requests } };
}

const out = [];
for (const s of scenarios) {
  const { calls, expected } = await run(s);
  const { calls: _drop, ...rest } = s;
  out.push({ ...rest, calls: calls.map((c) => (c.chunks ? { chunks: c.chunks.map((x) => (typeof x === "string" ? x : x)) } : c)), expected });
}

const file = {
  version: "agent-loop-replay.v0",
  description: "Shadow replay of the agent loop: the bytes of each model call and what each tool does are scripted by hand; `expected` is what Super Chat's runAgent (OpenAI Chat Completions adapter) did with them. See docs/AGENT-LOOP.md section 10.",
  scenarios: out,
};
// One scenario field per line keeps a diff readable.
const text = `{\n  "version": ${JSON.stringify(file.version)},\n  "description": ${JSON.stringify(file.description)},\n  "scenarios": [\n${file.scenarios.map((s) => `    ${JSON.stringify(s)}`).join(",\n")}\n  ]\n}\n`;

const target = fileURLToPath(new URL("../conformance/agent-loop-replay.v0.json", import.meta.url));
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) {
    console.error("conformance/agent-loop-replay.v0.json differs from what Super Chat's runAgent does now; review and rerun without --check");
    process.exit(1);
  }
  console.log(`agent-loop-replay.v0.json: ${out.length} scenarios match`);
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target}: ${out.length} scenarios`);
}
