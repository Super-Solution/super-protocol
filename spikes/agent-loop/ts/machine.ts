// The agent loop as a sans-IO state machine (spike). No clock, no ids, no network, no async: it is fed
// inputs and answers with events and effects. See ../SPEC.md. Throwaway code: its job is to be the second
// implementation of the spec (next to the Rust one) and to be checked against Super Chat's real runAgent.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: any };

export type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };

export type StopCondition =
  | { kind: "stepCountIs"; n: number }
  | { kind: "afterTool"; names: string[] }
  | { kind: "tokenBudgetExceeded"; maxTotal: number }
  | { kind: "consecutiveFailures"; n: number }
  | { kind: "userDeclined" };

export type LoopConfig = {
  maxSteps?: number;
  stopWhen?: StopCondition[];
  interactive?: boolean;
  tools: { name: string; side: "read" | "write" | "confirm" }[];
};

export type Step = { events: Obj[]; effects: Obj[] };

type Outcome = { callId: string; name: string; output: Json; failure?: string; ms: number };

const USAGE_KEYS = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"] as const;

function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {};
  for (const k of USAGE_KEYS) {
    if (a[k] === undefined && b[k] === undefined) continue;
    out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

const isEmpty = (u: Usage) => USAGE_KEYS.every((k) => u[k] === undefined);

export class LoopMachine {
  private phase: "idle" | "model" | "tools" | "ask" | "done" = "idle";
  private runId = "";
  private mode = "stream";
  private step = 0;
  private attempted = 0;
  private usage: Usage = {};
  private finishReason = "unknown";
  private stepFinish = "unknown";
  private cancelled = false;
  private calls: { callId: string; name: string; input: Json }[] = [];
  private outcomes = new Map<string, Outcome>();
  private running = new Set<string>();
  private confirmQueue: { callId: string; name: string; input: Json }[] = [];
  private asking: { callId: string; name: string; input: Json } | undefined;
  private streaks: number[];
  private events: Obj[] = [];
  private effects: Obj[] = [];

  private readonly config: LoopConfig;

  constructor(config: LoopConfig) {
    this.config = config;
    this.streaks = (config.stopWhen ?? []).map(() => 0);
  }

  private get maxSteps() {
    return this.config.maxSteps ?? 8;
  }

  private tool(name: string) {
    return this.config.tools.find((t) => t.name === name);
  }

  feed(input: Obj): Step {
    this.events = [];
    this.effects = [];
    switch (input.kind) {
      case "start":
        this.expect(this.phase === "idle", "start twice");
        this.runId = input.runId;
        this.mode = input.mode;
        this.events.push({ type: "run-start", runId: this.runId, mode: this.mode });
        this.loopTop();
        break;
      case "model-result":
        this.expect(this.phase === "model", "model-result with no model call outstanding");
        this.onModelResult(input);
        break;
      case "model-error":
        this.expect(this.phase === "model", "model-error with no model call outstanding");
        this.fail(input.error.kind, input.error.message, input.usage);
        break;
      case "tool-outcome":
        this.expect(this.running.has(input.callId), `tool-outcome for ${input.callId}, which is not running`);
        this.running.delete(input.callId);
        this.settle({ callId: input.callId, name: this.callOf(input.callId).name, output: input.output, failure: input.failure, ms: input.ms });
        this.advance();
        break;
      case "user-action":
        this.expect(this.phase === "ask" && this.asking?.callId === input.callId, `user-action for ${input.callId}, which is not asked`);
        this.onUserAction(input);
        break;
      case "cancel":
        this.expect(this.phase !== "idle" && this.phase !== "done", "cancel outside a run");
        this.cancelled = true;
        break;
      default:
        throw new Error(`illegal-input: unknown input kind ${String(input.kind)}`);
    }
    return { events: this.events, effects: this.effects };
  }

  private expect(ok: boolean, why: string) {
    if (!ok) throw new Error(`illegal-input: ${why}`);
  }

  private callOf(callId: string) {
    return this.calls.find((c) => c.callId === callId)!;
  }

  /** `while (step < maxSteps)`: the cancel check comes before step-start, and only inside the loop. */
  private loopTop() {
    if (this.step >= this.maxSteps) return this.finishRun();
    if (this.cancelled) return this.fail("cancelled", "Run was cancelled.");
    this.attempted += 1;
    this.events.push({ type: "step-start", step: this.step });
    this.effects.push({ kind: "call-model", step: this.step, toolNames: this.config.tools.map((t) => t.name) });
    this.phase = "model";
  }

  private onModelResult(input: Obj) {
    const parts: Obj[] = input.parts;
    const usage: Usage = input.usage ?? {};
    this.usage = addUsage(this.usage, usage);
    for (const p of parts) if (p.type === "text") this.events.push({ type: "text-delta", delta: p.text });
    this.events.push({ type: "usage", usage });
    this.events.push({ type: "step-finish", step: this.step, finishReason: input.finishReason, usage });
    this.stepFinish = input.finishReason;
    this.effects.push({ kind: "append", message: { role: "assistant", parts } });

    this.calls = parts.filter((p) => p.type === "tool-call").map((p) => ({ callId: p.callId, name: p.name, input: p.input }));
    if (!this.calls.length) {
      this.finishReason = input.finishReason;
      return this.finishRun();
    }
    for (const c of this.calls) this.events.push({ type: "tool-call", callId: c.callId, name: c.name, input: c.input });

    this.outcomes = new Map();
    this.running = new Set();
    this.confirmQueue = this.calls.filter((c) => this.tool(c.name)?.side === "confirm");
    for (const c of this.calls) {
      if (this.confirmQueue.includes(c)) continue;
      if (!this.tool(c.name)) {
        this.settle({
          callId: c.callId,
          name: c.name,
          output: { error: `Unknown tool "${c.name}".`, availableTools: this.config.tools.map((t) => t.name) },
          failure: "not-found",
          ms: 0,
        });
      } else {
        this.effects.push({ kind: "run-tool", callId: c.callId, name: c.name, input: c.input });
        this.running.add(c.callId);
      }
    }
    this.phase = "tools";
    this.advance();
  }

  private settle(o: Outcome) {
    this.outcomes.set(o.callId, o);
    this.events.push({ type: "tool-result", callId: o.callId, name: o.name, output: o.output, ...(o.failure ? { failure: o.failure } : {}), ms: o.ms });
  }

  /** Everything runs first; confirm tools one at a time after; then the step ends. */
  private advance() {
    if (this.running.size > 0) return;
    while (this.confirmQueue.length) {
      const next = this.confirmQueue.shift()!;
      if (!this.config.interactive) {
        this.settle({
          callId: next.callId,
          name: next.name,
          output: { error: `"${next.name}" needs the user's approval and this host cannot ask for it.` },
          failure: "denied",
          ms: 0,
        });
        continue;
      }
      this.asking = next;
      this.events.push({
        type: "awaiting-user",
        callId: next.callId,
        card: { id: `approval:${next.callId}`, callId: next.callId, spec: { kind: "confirm", tool: next.name, input: next.input } },
      });
      this.effects.push({ kind: "ask-user", callId: next.callId });
      this.phase = "ask";
      return;
    }
    this.endStep();
  }

  private onUserAction(input: Obj) {
    const { callId, action } = input;
    const asked = this.asking!;
    this.asking = undefined;
    this.events.push({ type: "user-responded", callId, action });
    const declined = action.type === "cancel" || action.type === "dismiss";
    const approved = !declined && (action.value === undefined || action.value?.confirmed === true);
    if (approved) {
      this.effects.push({ kind: "run-tool", callId, name: asked.name, input: asked.input });
      this.running.add(callId);
      this.phase = "tools";
      return;
    }
    this.settle({ callId, name: asked.name, output: { error: "The user declined." }, failure: "denied", ms: 0 });
    this.phase = "tools";
    this.advance();
  }

  private endStep() {
    const ordered = this.calls.map((c) => this.outcomes.get(c.callId)!);
    this.effects.push({
      kind: "append",
      message: {
        role: "tool",
        parts: ordered.map((o) => ({ type: "tool-result", callId: o.callId, name: o.name, output: o.output, ...(o.failure ? { failure: o.failure } : {}) })),
      },
    });
    this.step += 1;
    this.finishReason = this.stepFinish;
    if (this.shouldStop(ordered)) {
      this.finishReason = "stop";
      return this.finishRun();
    }
    this.loopTop();
  }

  /** `conditions.some(...)`: evaluated in order, first true wins. A stateful one only updates when reached. */
  private shouldStop(outcomes: Outcome[]): boolean {
    const conditions = this.config.stopWhen ?? [];
    for (let i = 0; i < conditions.length; i++) {
      const c = conditions[i]!;
      let hit = false;
      switch (c.kind) {
        case "stepCountIs":
          hit = this.step >= c.n;
          break;
        case "afterTool":
          hit = outcomes.some((o) => c.names.includes(o.name) && !o.failure);
          break;
        case "tokenBudgetExceeded":
          hit = (this.usage.totalTokens ?? (this.usage.inputTokens ?? 0) + (this.usage.outputTokens ?? 0)) >= c.maxTotal;
          break;
        case "consecutiveFailures": {
          const allFailed = outcomes.length > 0 && outcomes.every((o) => o.failure);
          this.streaks[i] = allFailed ? this.streaks[i]! + 1 : 0;
          hit = this.streaks[i]! >= c.n;
          break;
        }
        case "userDeclined":
          hit = outcomes.some((o) => typeof o.output === "object" && o.output !== null && !Array.isArray(o.output) && (o.output as Obj).cancelled === true);
          break;
      }
      if (hit) return true;
    }
    return false;
  }

  private finishRun() {
    if (this.step >= this.maxSteps && this.finishReason === "tool-calls") {
      this.events.push({ type: "message", parts: [{ type: "notice", code: "step-limit", steps: this.maxSteps }] });
    }
    this.events.push({ type: "run-finish", runId: this.runId, finishReason: this.finishReason, usage: this.usage, steps: this.attempted });
    this.effects.push({ kind: "done" });
    this.phase = "done";
  }

  private fail(kind: string, message: string, usage?: Usage) {
    if (usage && !isEmpty(usage)) {
      this.usage = addUsage(this.usage, usage);
      this.events.push({ type: "usage", usage });
    }
    this.events.push({ type: "error", error: { kind, message }, recoverable: false });
    this.events.push({
      type: "run-finish",
      runId: this.runId,
      finishReason: kind === "cancelled" ? "cancelled" : "error",
      usage: this.usage,
      steps: this.attempted,
    });
    this.effects.push({ kind: "done" });
    this.phase = "done";
  }
}
