// The spike's cases, replayed against Super Chat's real runAgent through a scripted provider and scripted
// tools. This is the check that the spec describes the loop that exists, not the loop its author imagined.
// It compares EVENTS only: runAgent exposes no effects (history is private), which is itself a finding.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentError,
  ContextBuilder,
  ToolRegistry,
  afterTool,
  consecutiveFailures,
  runAgent,
  stepCountIs,
  tokenBudgetExceeded,
  userDeclined,
  type Provider,
  type StopCondition,
  type StreamEvent,
  type ToolDefinition,
} from "@supersolutions/super-chat-core";
import { checkStream } from "../ts/invariants.ts";

type Obj = Record<string, any>;
const file = JSON.parse(readFileSync(new URL("../cases/agent-loop.v0.json", import.meta.url), "utf8"));

const stopFrom = (c: Obj): StopCondition => {
  switch (c.kind) {
    case "stepCountIs": return stepCountIs(c.n);
    case "afterTool": return afterTool(...c.names);
    case "tokenBudgetExceeded": return tokenBudgetExceeded(c.maxTotal);
    case "consecutiveFailures": return consecutiveFailures(c.n);
    case "userDeclined": return userDeclined;
    default: throw new Error(`unknown stop condition ${c.kind}`);
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function replay(c: Obj): Promise<Obj[]> {
  const inputs: Obj[] = c.steps.map((s: Obj) => s.in);
  const models = inputs.filter((i) => i.kind === "model-result" || i.kind === "model-error");
  const controller = new AbortController();

  // Tool behaviour, from the script: completion order = script order, a failure is a throw, a cancel aborts first.
  const outcomes = new Map<string, { rank: number; input: Obj; abortFirst: boolean }>();
  inputs.forEach((inp, idx) => {
    if (inp.kind === "tool-outcome") outcomes.set(inp.callId, { rank: outcomes.size, input: inp, abortFirst: inputs[idx - 1]?.kind === "cancel" });
  });
  const actions = new Map<string, Obj>(inputs.filter((i) => i.kind === "user-action").map((i) => [i.callId, i.action]));

  const exec = async (name: string, _in: unknown, ctx: { callId: string }) => {
    const o = outcomes.get(ctx.callId);
    if (!o) throw new Error(`script has no outcome for ${ctx.callId}`);
    await sleep(o.rank * 15);
    const { output, failure } = o.input;
    if (o.abortFirst) controller.abort();
    if (failure === "execution-error") throw new Error(output.error);
    if (failure === "denied" && output.kind === "cancelled") throw new AgentError("cancelled", output.error);
    return failure ? { output, failure } : { output };
  };

  const defs: ToolDefinition[] = c.config.tools.map((t: Obj) => ({
    name: t.name,
    description: `Scripted tool ${t.name}.`,
    inputSchema: { type: "object", properties: {} },
    side: t.side,
    execute: (input: unknown, ctx: { callId: string }) => exec(t.name, input, ctx),
  }));

  let modelCall = 0;
  const provider: Provider = {
    id: "script",
    label: "script",
    capabilities: { streaming: true, backgroundJobs: false, resumableStreams: false, tools: true, parallelToolCalls: true, images: false, files: false, audio: false, reasoning: false, strictJsonSchema: false, serverSideHistory: false, fileUpload: false },
    transport: { kind: "custom", credentialSafe: true, fetch: async () => { throw new Error("no network"); } } as never,
    generate: async () => { throw new Error("sync not used"); },
    async *stream(): AsyncGenerator<StreamEvent> {
      const m = models[modelCall++];
      if (!m) throw new Error("script ran out of model results");
      if (m.kind === "model-error") throw new AgentError(m.error.kind, m.error.message);
      yield { type: "start", modelId: "script-1" };
      for (const p of m.parts) {
        if (p.type === "text") yield { type: "text-delta", delta: p.text };
        else {
          yield { type: "tool-call-start", callId: p.callId, name: p.name };
          yield { type: "tool-call-end", callId: p.callId, name: p.name, input: p.input };
        }
      }
      yield { type: "usage", usage: m.usage };
      yield { type: "finish", finishReason: m.finishReason, usage: m.usage };
    },
  };

  const registry = new ToolRegistry().registerAll(defs, ["observer"]);
  const events: Obj[] = [];
  for await (const e of runAgent([], {
    provider,
    model: "script-1",
    contextBuilder: new ContextBuilder({ identity: "test", contextWindow: 32_000 }),
    tools: registry,
    toolResolution: { presets: ["observer"] },
    mode: "stream",
    ...(c.config.maxSteps ? { maxSteps: c.config.maxSteps } : {}),
    ...(c.config.stopWhen ? { stopWhen: c.config.stopWhen.map(stopFrom) } : {}),
    ...(c.config.interactive
      ? { onUserDecision: async (callId: string) => ({ cardId: `approval:${callId}`, callId, kind: "confirm", at: 0, ...actions.get(callId) }) as never }
      : {}),
    signal: controller.signal,
  })) events.push(e as Obj);
  return normalize(events);
}

/** Drop what the spec leaves to the host, and put the rest in the spec's shape. */
function normalize(events: Obj[]): Obj[] {
  const calls = new Map<string, Obj>();
  const out: Obj[] = [];
  for (const raw of events) {
    const e = JSON.parse(JSON.stringify(raw)) as Obj; // the wire view: undefined keys gone, AgentError flattened
    if (e.type === "context-built" || e.type === "metering" || e.type === "tool-call-input-delta") continue;
    if (e.type === "run-start" || e.type === "run-finish") e.runId = "run_1";
    if (e.type === "tool-call") calls.set(e.callId, e);
    if (e.type === "tool-result") e.ms = 0;
    if (e.type === "awaiting-user") {
      const call = calls.get(e.callId)!;
      e.card = { id: `approval:${e.callId}`, callId: e.callId, spec: { kind: e.card.spec.kind, tool: call.name, input: call.input } };
    }
    if (e.type === "user-responded") e.action = { type: e.action.type, ...(e.action.value !== undefined ? { value: e.action.value } : {}) };
    if (e.type === "error") e.error = { kind: raw.error.kind, message: raw.error.message }; // JSON.stringify drops an Error's message
    if (e.type === "message") {
      const m = /Reached the (\d+)-step limit/.exec(e.parts[0]?.text ?? "");
      if (m) e.parts = [{ type: "notice", code: "step-limit", steps: Number(m[1]) }];
    }
    out.push(e);
  }
  return out;
}

describe("Super Chat's real runAgent, against the spike's cases", () => {
  for (const c of file.cases) {
    if (c.steps.some((s: Obj) => s.reject)) continue; // a refused input is a property of the machine's API, not of runAgent
    it(c.name, async () => {
      // `ms` is how long a tool took on a real clock: the spec echoes it, so only its presence is compared.
      const expected = c.steps.flatMap((s: Obj) => s.events).map((e: Obj) => (e.type === "tool-result" ? { ...e, ms: 0 } : e));
      const actual = await replay(c);
      expect(checkStream(actual)).toEqual([]);
      expect(actual).toEqual(expected);
    });
  }
});
