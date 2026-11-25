// Writes conformance/agent-loop.v0.json from scripts/agent-loop/cases.mjs. The cases are written by hand on
// purpose: the expected events and effects are what docs/AGENT-LOOP.md says, not what an implementation printed.
// Every implementation (implementations/typescript/src/agent-loop, implementations/rust-agent-loop) must
// reproduce them exactly. `--check` fails if the file on disk is not what the source builds.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cases } from "./agent-loop/cases.mjs";

const out = fileURLToPath(new URL("../conformance/agent-loop.v0.json", import.meta.url));
const text = `${JSON.stringify({ version: "agent-loop.v0", cases }, null, 1)}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("conformance/agent-loop.v0.json is not what scripts/agent-loop/cases.mjs builds; run node scripts/export-agent-loop.mjs and review the diff");
    process.exit(1);
  }
  console.log(`agent-loop.v0.json matches its source (${cases.length} cases)`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${cases.length} cases to ${out}`);
}
