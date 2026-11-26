// Writes conformance/interop-ai-sdk.v0.json (DRAFT, like the agent-loop files: not part of protocol.v1.json and not stable):
// what the run-event <-> AI SDK UI message stream adapter in implementations/typescript/src/interop/ai-sdk.ts produces for a
// set of runs, and what it makes of the chunks a real AI SDK backend streams.
//
// The real `ai` package (a devDependency, never a runtime one) is used three ways:
//   - every chunk in the file must pass its `uiMessageChunkSchema`;
//   - what the adapter writes is fed to `readUIMessageStream`, the code a `useChat` UI folds a stream with, and the message
//     it makes is written next to the chunks (`ui_message`), so the file shows what a UI would show;
//   - the chunks the decoder reads are made by `streamText` with a mock model and `toUIMessageStream`, not typed by hand
//     (the ones the SDK does not make from a mock run, such as `data-*` parts, sources and aborts, are written by hand and
//     validated the same way). The one random id the SDK makes, an approval id, is replaced by a fixed one.
//
// Run `pnpm build` first (the generator imports the built package). `--check` is what scripts/check-all.sh runs.
import { fileURLToPath } from "node:url";
import { adapterOptions, devVersion, importDev, writeGolden } from "./lib/golden.mjs";
import { runScenarios } from "./lib/interop-scenarios.mjs";
import * as aiSdk from "../implementations/typescript/dist/interop/ai-sdk.js";

const NOW = 1700000000000;
const ai = await importDev("ai");
const aiTest = await importDev("ai/test");
const { z } = await importDev("zod");
const chunkSchema = ai.asSchema(ai.uiMessageChunkSchema);

// The headers the adapter says go with the stream are the SDK's own.
for (const [name, value] of Object.entries(ai.UI_MESSAGE_STREAM_HEADERS)) {
  if (aiSdk.UI_MESSAGE_STREAM_HEADERS[name] !== value) throw new Error(`UI_MESSAGE_STREAM_HEADERS differs from the SDK's at ${name}`);
}
if (Object.keys(ai.UI_MESSAGE_STREAM_HEADERS).length !== Object.keys(aiSdk.UI_MESSAGE_STREAM_HEADERS).length) throw new Error("UI_MESSAGE_STREAM_HEADERS differs from the SDK's");

async function validate(chunks, label) {
  for (const [i, chunk] of chunks.entries()) {
    const result = await chunkSchema.validate(structuredClone(chunk));
    if (!result.success) throw new Error(`${label}[${i}] ${chunk.type}: ${result.error.message}`);
  }
}

/** What a `useChat` UI makes of the chunks: the SDK's own reducer. It works on copies: the reducer updates the objects it is given. */
async function uiMessage(chunks) {
  const errors = [];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(structuredClone(chunk));
      controller.close();
    },
  });
  let last = null;
  for await (const message of ai.readUIMessageStream({ stream, onError: (e) => errors.push(String(e?.message ?? e)), terminateOnError: false })) last = message;
  return { message: last, errors };
}

const encode = [];
for (const scenario of runScenarios) {
  const losses = [];
  const expect = aiSdk.encode(scenario.events, adapterOptions(scenario.options, losses));
  await validate(expect, scenario.name);
  const { message, errors } = await uiMessage(expect);
  const back = [];
  const roundtrip = aiSdk.decode(expect, adapterOptions({ ...scenario.options, runId: scenario.options?.runId ?? "run_1", now: NOW }, back));
  encode.push({ name: scenario.name, note: scenario.note, ...(scenario.options ? { options: scenario.options } : {}), events: scenario.events, expect, loss: losses, ui_message: message, ui_errors: errors, roundtrip, roundtrip_loss: back });
}

// ---- chunks the decoder reads ----------------------------------------------------------------------------------------------
const usage = { inputTokens: { total: 3, noCache: 3 }, outputTokens: { total: 10, text: 10 } };
const finish = (reason = "stop") => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const streamParts = (parts) => ({ stream: aiTest.convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...parts]) });
const chunksOf = async (result, options) => {
  const out = [];
  for await (const chunk of result.toUIMessageStream(options)) out.push(chunk);
  return JSON.parse(JSON.stringify(out).replace(/aitxt-[A-Za-z0-9]+/g, "approval_1"));
};

async function generated() {
  const scenarios = [];
  const text = ai.streamText({ model: new aiTest.MockLanguageModelV4({ doStream: async () => streamParts([{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "Hello" }, { type: "text-delta", id: "1", delta: ", world." }, { type: "text-end", id: "1" }, finish()]) }), prompt: "hi" });
  scenarios.push({ name: "text-from-streamText", note: "streamText with a mock model. The SDK's `start` chunk has no message id, so the run id comes from options.", options: { runId: "run_ai_1" }, chunks: await chunksOf(text) });

  let calls = 0;
  const tools = { search: ai.tool({ description: "search", inputSchema: z.object({ q: z.string() }), execute: async ({ q }) => ({ hits: 2, q }) }) };
  const withTool = ai.streamText({
    model: new aiTest.MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) return streamParts([{ type: "reasoning-start", id: "r1" }, { type: "reasoning-delta", id: "r1", delta: "Need a search." }, { type: "reasoning-end", id: "r1" }, { type: "tool-call", toolCallId: "call_1", toolName: "search", input: '{"q":"protocol"}' }, finish("tool-calls")]);
        return streamParts([{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "Two results." }, { type: "text-end", id: "1" }, finish()]);
      },
    }),
    prompt: "hi",
    stopWhen: ai.stepCountIs(3),
    tools,
  });
  scenarios.push({ name: "reasoning-and-tool-from-streamText", note: "Two steps: reasoning and a tool call with its result, then the answer.", options: { runId: "run_ai_2" }, chunks: await chunksOf(withTool, { sendReasoning: true }) });

  const approval = ai.streamText({
    model: new aiTest.MockLanguageModelV4({ doStream: async () => streamParts([{ type: "tool-call", toolCallId: "call_9", toolName: "delete_file", input: '{"path":"a.txt"}' }, finish("tool-calls")]) }),
    prompt: "hi",
    tools: { delete_file: ai.tool({ inputSchema: z.object({ path: z.string() }), needsApproval: true, execute: async () => ({ ok: true }) }) },
  });
  scenarios.push({ name: "approval-from-streamText", note: "A tool that needs approval: the run is suspended on the request, the message finishes with tool-calls, and that is not the end of the run.", options: { runId: "run_ai_3" }, chunks: await chunksOf(approval) });

  const failing = ai.streamText({ model: new aiTest.MockLanguageModelV4({ doStream: async () => streamParts([{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "Wor" }, { type: "error", error: new Error("boom") }]) }), prompt: "hi", onError: () => {} });
  scenarios.push({ name: "error-from-streamText", note: "A model that fails half way.", options: { runId: "run_ai_4" }, chunks: await chunksOf(failing, { onError: (e) => e.message }) });
  return scenarios;
}

const approvalAnswer = [{ type: "start", messageId: "run_ai_5" }, { type: "start-step" }, { type: "data-super-card", id: "card_confirm", data: { id: "card_confirm", callId: "call_c", spec: { kind: "super.confirm" } } }, { type: "tool-approval-request", approvalId: "ap_1", toolCallId: "call_c" }, { type: "finish-step" }, { type: "finish", finishReason: "tool-calls" }, { type: "tool-approval-response", approvalId: "ap_1", approved: true }, { type: "tool-approval-response", approvalId: "ghost", approved: false }];
const handWritten = [
  { name: "approval-answered", note: "A yes/no card that was shown, an approval request for its call, then the answer: the request carries the card the stream showed.", options: { now: NOW }, chunks: approvalAnswer },
  { name: "approval-denied", note: "A denied approval is a cancel, and the call's output is denied.", options: { runId: "run_ai_6", now: NOW }, chunks: [{ type: "start" }, { type: "tool-input-available", toolCallId: "call_d", toolName: "delete_file", input: {}, dynamic: true }, { type: "tool-approval-request", approvalId: "ap_2", toolCallId: "call_d", reason: "Deletes a file" }, { type: "tool-approval-response", approvalId: "ap_2", approved: false }, { type: "tool-output-denied", toolCallId: "call_d" }, { type: "finish", finishReason: "stop" }] },
  { name: "tool-failures", note: "Input that did not parse, an output that errored, an output with no call before it and a preliminary output.", options: { runId: "run_ai_7" }, chunks: [{ type: "start" }, { type: "tool-input-error", toolCallId: "c1", toolName: "calc", input: "2+", errorText: "bad input" }, { type: "tool-input-start", toolCallId: "c2", toolName: "fetch", dynamic: true }, { type: "tool-input-delta", toolCallId: "c2", inputTextDelta: '{"u' }, { type: "tool-input-available", toolCallId: "c2", toolName: "fetch", input: { u: "x" } }, { type: "tool-output-available", toolCallId: "c2", output: "partial", preliminary: true }, { type: "tool-output-error", toolCallId: "c2", errorText: "timeout" }, { type: "tool-output-available", toolCallId: "ghost", output: 1 }, { type: "finish", finishReason: "stop" }] },
  { name: "run-chunks-from-the-encoder", note: "What the encoder sends as data parts comes back as the run event; the usage and step count of the run ride on finish.", options: { runId: "run_ai_8" }, chunks: [{ type: "start" }, { type: "data-super-usage", transient: true, data: { usage: { inputTokens: 2 } } }, { type: "data-super-metering", data: { record: { model: "m" } } }, { type: "data-super-error", data: { error: "retrying", recoverable: true } }, { type: "data-super-card", id: "k1", data: { id: "k1", spec: { kind: "super.plot" } } }, { type: "data-super-card", id: "bad", data: { nope: true } }, { type: "finish", finishReason: "length", messageMetadata: { super: { usage: { inputTokens: 2, outputTokens: 9 }, steps: 3 } } }] },
  { name: "sources-and-files", note: "Sources and files are parts of a message.", options: { runId: "run_ai_9" }, chunks: [{ type: "start" }, { type: "source-url", sourceId: "s1", url: "https://example.com/a", title: "A" }, { type: "source-document", sourceId: "s2", mediaType: "application/pdf", title: "Spec", filename: "spec.pdf" }, { type: "file", url: "https://example.com/a.png", mediaType: "image/png" }, { type: "finish" }] },
  { name: "abort", note: "An abort chunk is a cancelled run.", options: { runId: "run_ai_10" }, chunks: [{ type: "start" }, { type: "start-step" }, { type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "Sta" }, { type: "abort", reason: "user" }] },
  { name: "chunks-with-no-run-event", note: "Message metadata, custom parts, reset-step, steering, unknown data parts and an empty start: not a run's output.", options: { runId: "run_ai_11" }, chunks: [{ type: "start", messageId: "m1", messageMetadata: { a: 1 } }, { type: "message-metadata", messageMetadata: { b: 2 } }, { type: "reset-step" }, { type: "custom", kind: "x.y" }, { type: "data-weather", data: { c: 1 } }, { type: "steering-message", id: "s", parts: [{ type: "text", text: "hi" }] }, { type: "finish", finishReason: "interrupted" }] },
  { name: "ids-of-the-message", note: "A part id that is the one a follower would make is left out; any other is kept. The message id is the run id.", chunks: [{ type: "start", messageId: "run_ai_12" }, { type: "start-step" }, { type: "text-start", id: "run_ai_12:0" }, { type: "text-delta", id: "run_ai_12:0", delta: "a" }, { type: "text-end", id: "run_ai_12:0" }, { type: "text-start", id: "named" }, { type: "text-delta", id: "named", delta: "b" }, { type: "text-end", id: "named" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" }] },
];

const decode = [];
for (const scenario of [...(await generated()), ...handWritten]) {
  await validate(scenario.chunks, scenario.name);
  const losses = [];
  const decoder = aiSdk.createDecoder(adapterOptions(scenario.options, losses));
  const expect = [];
  for (const chunk of scenario.chunks) expect.push(...decoder.push(chunk));
  expect.push(...decoder.end());
  decode.push({ name: scenario.name, note: scenario.note, ...(scenario.options ? { options: scenario.options } : {}), chunks: scenario.chunks, expect, loss: losses });
}

writeGolden(
  fileURLToPath(new URL("../conformance/interop-ai-sdk.v0.json", import.meta.url)),
  {
    version: 0,
    status: "draft",
    note: "DRAFT, not stable and not part of protocol.v1.json. Generated by scripts/export-interop-ai-sdk.mjs from implementations/typescript/src/interop/ai-sdk.ts; every chunk in it passes the `ai` package's uiMessageChunkSchema. `encode`: run events -> UI message chunks (`expect`), what was lost (`loss`), what readUIMessageStream makes of the chunks (`ui_message`, `ui_errors`) and what decoding them gives back (`roundtrip`). `decode`: UI message chunks -> run events; the chunks of the `*-from-streamText` cases are made by the SDK. An option `now` is the clock of the decoder in milliseconds.",
    generated_with: { ai: devVersion("ai"), stream_header: ai.UI_MESSAGE_STREAM_HEADERS["x-vercel-ai-ui-message-stream"] },
    encode,
    decode,
  },
  "export-interop-ai-sdk.mjs",
);
