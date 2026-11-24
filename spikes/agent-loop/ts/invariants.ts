// The rules of RUN-EVENTS.md that are about a whole stream, as code. Used on every expected stream in the
// cases and on what the real runAgent produced. Returns a list of problems; empty means the stream is sound.

type Ev = { type: string; [k: string]: any };

export function checkStream(events: Ev[]): string[] {
  const problems: string[] = [];
  const bad = (m: string) => problems.push(m);

  if (events[0]?.type !== "run-start") bad("first event must be run-start");
  const finishes = events.filter((e) => e.type === "run-finish");
  if (finishes.length !== 1) bad(`exactly one run-finish expected, got ${finishes.length}`);
  if (events.at(-1)?.type !== "run-finish") bad("run-finish must be the last event");

  // Steps count from 0 and go up by one.
  let expectedStep = 0;
  for (const e of events) if (e.type === "step-start") { if (e.step !== expectedStep) bad(`step-start ${e.step}, expected ${expectedStep}`); expectedStep += 1; }

  // Per call: tool-call, then (awaiting-user, user-responded), then exactly one tool-result.
  const called = new Set<string>();
  const awaiting = new Set<string>();
  const resulted = new Set<string>();
  let openCalls = 0;
  for (const e of events) {
    switch (e.type) {
      case "step-start":
        if (openCalls !== 0) bad("a step-start came before all tool-results of the step before it");
        break;
      case "tool-call":
        called.add(e.callId);
        openCalls += 1;
        break;
      case "awaiting-user":
        if (!called.has(e.callId)) bad(`awaiting-user for ${e.callId} before its tool-call`);
        awaiting.add(e.callId);
        break;
      case "user-responded":
        if (!awaiting.has(e.callId)) bad(`user-responded for ${e.callId} without awaiting-user`);
        break;
      case "tool-result":
        if (!called.has(e.callId)) bad(`tool-result for ${e.callId} before its tool-call`);
        if (resulted.has(e.callId)) bad(`second tool-result for ${e.callId}`);
        resulted.add(e.callId);
        openCalls -= 1;
        break;
    }
  }
  // A run that ended must not leave a call without a result, unless the stream ended by error or cancel
  // before the results could come (the machine never does that, runAgent never does).
  if (openCalls !== 0) bad(`${openCalls} tool-call(s) without a tool-result`);

  // Usage is counted once: the sum of `usage` events is the run's total.
  const sum: Record<string, number> = {};
  for (const e of events) if (e.type === "usage") for (const [k, v] of Object.entries(e.usage ?? {})) sum[k] = (sum[k] ?? 0) + (v as number);
  const total = finishes[0]?.usage ?? {};
  for (const k of new Set([...Object.keys(sum), ...Object.keys(total)])) if ((sum[k] ?? 0) !== (total[k] ?? 0)) bad(`usage.${k}: events add up to ${sum[k] ?? 0}, run-finish says ${total[k] ?? 0}`);

  return problems;
}
