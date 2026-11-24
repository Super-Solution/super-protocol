// Writes agent-loop.v0.json from cases.src.mjs. Run: node cases/build.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.src.mjs";

const out = fileURLToPath(new URL("./agent-loop.v0.json", import.meta.url));
writeFileSync(out, `${JSON.stringify({ version: "agent-loop.v0", cases }, null, 1)}\n`);
console.log(`wrote ${cases.length} cases to ${out}`);
