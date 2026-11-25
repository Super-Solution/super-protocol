// The agent loop as a sans-IO state machine. No clock, no ids, no network, no async: it is fed inputs and
// answers with events and effects. The rules are in docs/AGENT-LOOP.md and the transcripts that pin them are in
// conformance/agent-loop.v0.json. This file is the TypeScript reference of that spec: it is tested against the
// same data as implementations/rust-agent-loop, and Super Chat's real runAgent is checked against it too.
//
// Not exported from the package yet (no public API, nothing published): see docs/AGENT-LOOP.md, "Status".

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
  /** Whether the host can ask the person. A confirm tool in a host that cannot ask is denied at once. */
  interactive?: boolean;
  /** Block a second call with the same name and input in one run. Off by default. */
  repeatGuard?: boolean;
  tools: { name: string; side: "read" | "write" | "confirm" }[];
};

export type Step = { events: Obj[]; effects: Obj[] };

type Call = { callId: string; name: string; input: Json };
type Outcome = { callId: string; name: string; output: Json; failure?: string; ms: number };

/** The version of the checkpoint format. A machine refuses a state it does not know. */
export const CHECKPOINT_VERSION = 0;

/** The words the model reads when the person declines. `userDeclined` recognises them. */
export const USER_DECLINED = "The user declined.";

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

/** JSON with object keys sorted: two values are the same JSON value exactly when their canonical text is the same. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Obj;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const repeated = (name: string) => ({
  error: `Repeated call: "${name}" was already called with the same input in this run. Use that result or change the arguments.`,
});

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
  private calls: Call[] = [];
  private outcomes = new Map<string, Outcome>();
  /** Settled calls in the order they settled (a snapshot keeps this order). */
  private settled: Outcome[] = [];
  private running = new Set<string>();
  private confirmQueue: Call[] = [];
  private asking: Call | undefined;
  private streaks: number[];
  /** Calls made so far in the run, as `{ name, input }`, when the repeat guard is on. */
  private seen: { name: string; input: Json }[] = [];
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

  private get toolNames() {
    return this.config.tools.map((t) => t.name);
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
      case "snapshot":
        this.expect(this.phase === "model" || this.phase === "tools" || this.phase === "ask", "snapshot with nothing in flight");
        this.effects.push({ kind: "checkpoint", state: this.checkpoint() });
        break;
      case "resume":
        this.expect(this.phase === "idle", "resume on a machine that has started");
        this.restore(input.state);
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
    this.effects.push({ kind: "call-model", step: this.step, toolNames: this.toolNames });
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

    const callParts = parts.filter((p) => p.type === "tool-call");
    this.calls = callParts.map((p) => ({ callId: p.callId, name: p.name, input: p.input }));
    if (!this.calls.length) {
      this.finishReason = input.finishReason;
      return this.finishRun();
    }
    for (const p of callParts) {
      this.events.push({ type: "tool-call", callId: p.callId, name: p.name, input: p.input, ...(p.repaired === true ? { repaired: true } : {}) });
    }

    this.outcomes = new Map();
    this.settled = [];
    this.running = new Set();
    this.confirmQueue = [];
    for (const c of this.calls) {
      if (!this.tool(c.name)) {
        this.settle({
          callId: c.callId,
          name: c.name,
          output: { error: `Unknown tool "${c.name}".`, availableTools: this.toolNames },
          failure: "not-found",
          ms: 0,
        });
        continue;
      }
      if (this.config.repeatGuard) {
        const key = canon({ name: c.name, input: c.input });
        if (this.seen.some((s) => canon(s) === key)) {
          this.settle({ callId: c.callId, name: c.name, output: repeated(c.name), failure: "denied", ms: 0 });
          continue;
        }
        this.seen.push({ name: c.name, input: c.input });
      }
      if (this.tool(c.name)!.side === "confirm") {
        this.confirmQueue.push(c);
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
    this.settled.push(o);
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
      return this.ask(next);
    }
    this.endStep();
  }

  private ask(next: Call) {
    this.asking = next;
    this.events.push({
      type: "awaiting-user",
      callId: next.callId,
      card: { id: `approval:${next.callId}`, callId: next.callId, spec: { kind: "confirm", tool: next.name, input: next.input } },
    });
    this.effects.push({ kind: "ask-user", callId: next.callId });
    this.phase = "ask";
  }

  private onUserAction(input: Obj) {
    const { callId, action } = input;
    const asked = this.asking!;
    this.asking = undefined;
    this.events.push({ type: "user-responded", callId, action });
    const declined = action.type === "cancel" || action.type === "dismiss";
    const approved = !declined && (action.value === undefined || action.value?.confirmed === true);
    this.phase = "tools";
    if (approved) {
      this.effects.push({ kind: "run-tool", callId, name: asked.name, input: asked.input });
      this.running.add(callId);
      return;
    }
    this.settle({ callId, name: asked.name, output: { error: USER_DECLINED }, failure: "denied", ms: 0 });
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
          hit = outcomes.some(isUserDecline);
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

  // ---- checkpoint and resume ----------------------------------------------------------------------------

  /** Everything a new process needs to carry on, as JSON. The cancel flag is not part of it: a cancel belongs to the driver. */
  private checkpoint(): Obj {
    const base: Obj = {
      v: CHECKPOINT_VERSION,
      runId: this.runId,
      mode: this.mode,
      step: this.step,
      attempted: this.attempted,
      usage: this.usage,
      streaks: [...this.streaks],
      seen: this.seen.map((s) => ({ name: s.name, input: s.input })),
      phase: this.phase,
    };
    if (this.phase === "model") return base;
    return {
      ...base,
      stepFinish: this.stepFinish,
      calls: this.calls.map((c) => ({ callId: c.callId, name: c.name, input: c.input })),
      results: this.settled.map((o) => ({ callId: o.callId, name: o.name, output: o.output, ...(o.failure ? { failure: o.failure } : {}), ms: o.ms })),
      // A confirm call that was asked, said yes to, and has not reported back.
      approved: this.calls.filter((c) => this.tool(c.name)?.side === "confirm" && this.running.has(c.callId)).map((c) => c.callId),
      ...(this.phase === "ask" ? { asking: this.asking!.callId } : {}),
    };
  }

  /** Rebuild the state and re-issue whatever the snapshot was waiting for. Tools run at least once: same callId. */
  private restore(state: Obj) {
    this.expect(state?.v === CHECKPOINT_VERSION, `a checkpoint of version ${String(state?.v)}`);
    this.expect(["model", "tools", "ask"].includes(state.phase), `a checkpoint in phase ${String(state.phase)}`);
    // Refuse before changing anything: a refused resume leaves the machine as it was.
    this.expect(state.phase !== "ask" || state.calls.some((c: Obj) => c.callId === state.asking), "a checkpoint that is asking about a call it does not have");
    this.runId = state.runId;
    this.mode = state.mode;
    this.step = state.step;
    this.attempted = state.attempted;
    this.usage = state.usage;
    this.streaks = [...state.streaks];
    this.seen = state.seen.map((s: Obj) => ({ name: s.name, input: s.input }));
    this.cancelled = false;

    if (state.phase === "model") {
      this.phase = "model";
      this.effects.push({ kind: "call-model", step: this.step, toolNames: this.toolNames });
      return;
    }

    this.stepFinish = state.stepFinish;
    this.calls = state.calls.map((c: Obj) => ({ callId: c.callId, name: c.name, input: c.input }));
    this.settled = state.results.map((o: Obj) => ({ callId: o.callId, name: o.name, output: o.output, ...(o.failure ? { failure: o.failure } : {}), ms: o.ms }));
    this.outcomes = new Map(this.settled.map((o) => [o.callId, o]));
    const approved = new Set<string>(state.approved);
    const pending = this.calls.filter((c) => !this.outcomes.has(c.callId));
    this.running = new Set();
    this.confirmQueue = [];
    this.asking = undefined;
    this.phase = "tools";
    for (const c of pending) {
      if (c.callId === state.asking) continue;
      if (this.tool(c.name)?.side === "confirm" && !approved.has(c.callId)) {
        this.confirmQueue.push(c);
      } else {
        this.effects.push({ kind: "run-tool", callId: c.callId, name: c.name, input: c.input });
        this.running.add(c.callId);
      }
    }
    if (state.phase === "ask") return this.ask(this.callOf(state.asking));
    this.advance();
  }
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether an outcome is the person saying no. See "Stop conditions" in docs/AGENT-LOOP.md. */
export function isUserDecline(o: { output: unknown; failure?: string }): boolean {
  if (!isObject(o.output)) return false;
  if (o.failure === "denied" && o.output.error === USER_DECLINED) return true;
  if (o.output.cancelled === true) return true;
  return isObject(o.output.response) && o.output.response.cancelled === true;
}
