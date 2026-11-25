// The TypeScript machine against conformance/agent-loop.v0.json, the data implementations/rust-agent-loop is
// tested against, and every expected stream against the whole-stream rules of docs/RUN-EVENTS.md.
// Edit the cases in scripts/agent-loop/cases.mjs and run `node scripts/export-agent-loop.mjs`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkStream } from "./invariants.js";
import { LoopMachine } from "./machine.js";

type Case = { name: string; description: string; requires?: string[]; config: any; steps: any[] };
const file = JSON.parse(readFileSync(new URL("../../../../conformance/agent-loop.v0.json", import.meta.url), "utf8")) as { version: string; cases: Case[] };

describe("agent-loop.v0 conformance", () => {
  it("has the cases the spec promises", () => {
    expect(file.version).toBe("agent-loop.v0");
    expect(file.cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(file.cases.map((c) => c.name)).size).toBe(file.cases.length);
  });

  for (const c of file.cases) {
    it(`machine: ${c.name}`, () => {
      let m = new LoopMachine(c.config);
      for (const [i, step] of c.steps.entries()) {
        if (step.fresh) m = new LoopMachine(c.config);
        if (step.reject) {
          expect(() => m.feed(step.in), `step ${i} should be refused`).toThrow(/illegal-input/);
          continue;
        }
        expect(m.feed(step.in), `step ${i} (${step.in.kind})`).toEqual({ events: step.events, effects: step.effects });
      }
    });

    // A case that ends in a refused input stops mid-run on purpose; its stream is not meant to be complete.
    it.skipIf(c.steps.some((s) => s.reject))(`fixture is a sound stream: ${c.name}`, () => {
      expect(checkStream(c.steps.flatMap((s) => s.events ?? []))).toEqual([]);
    });
  }
});

describe("the machine", () => {
  it("is deterministic: the same inputs give the same answers on a second machine", () => {
    for (const c of file.cases) {
      if (c.steps.some((s) => s.reject || s.fresh)) continue;
      const a = new LoopMachine(c.config);
      const b = new LoopMachine(c.config);
      for (const s of c.steps) expect(a.feed(s.in)).toEqual(b.feed(s.in));
    }
  });
});
