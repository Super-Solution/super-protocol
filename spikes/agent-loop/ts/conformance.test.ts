import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkStream } from "./invariants.ts";
import { LoopMachine } from "./machine.ts";

const file = JSON.parse(readFileSync(new URL("../cases/agent-loop.v0.json", import.meta.url), "utf8"));

for (const c of file.cases) {
  test(`machine: ${c.name}`, () => {
    const m = new LoopMachine(c.config);
    for (const [i, step] of c.steps.entries()) {
      if (step.reject) {
        assert.throws(() => m.feed(step.in), /illegal-input/, `step ${i} should be refused`);
        continue;
      }
      assert.deepEqual(m.feed(step.in), { events: step.events, effects: step.effects }, `step ${i} (${step.in.kind})`);
    }
  });

  // A case that ends in a refused input stops mid-run on purpose; its stream is not meant to be complete.
  test(`fixture is a sound stream: ${c.name}`, { skip: c.steps.some((s: any) => s.reject) }, () => {
    const events = c.steps.flatMap((s: any) => s.events ?? []);
    assert.deepEqual(checkStream(events), []);
  });
}
