// Writes conformance/tool-repair.v0.json: what `repairToolArguments` and `normalizeToolName` of Super Chat's
// core (packages/core/src/tools/repair.ts, the TypeScript reference) return for a fixed corpus of malformed model
// output. Every other implementation (implementations/rust-agent-loop) must return the same, exactly.
//
//   SUPER_CHAT_DIR=/path/to/super-chat node scripts/export-tool-repair.mjs [--check]
//
// repair.ts imports nothing, so Node runs it as it is (Node 22.18+; older Node: --experimental-strip-types).
// Super Chat keeps a copy of the written file and tests against it (packages/core/src/tools/repair.conformance.test.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const chat = process.env.SUPER_CHAT_DIR;
if (!chat) throw new Error("Set SUPER_CHAT_DIR to a Super Chat checkout.");
const { repairToolArguments, normalizeToolName } = await import(pathToFileURL(`${chat}/packages/core/src/tools/repair.ts`).href);

// ---- a small seeded generator (mulberry32: the same sequence on every machine) ---------------------------------
let seed = 0x7e9a1;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n) => Math.floor(rand() * n);
const pick = (a) => a[int(a.length)];

const WORDS = ["SUI", "price", "line one\nline two", "tab\there", "quote \" inside", "back\\slash", "None of the above", "True story", "它漲了", "naïve café", "it's", "a,b", "x:y", "{not json}", "", "  spaced  "];
const KEYS = ["symbol", "limit", "note", "query", "ok", "items", "range", "name", "k"];
function value(depth) {
  const r = int(depth > 2 ? 5 : 8);
  if (r === 0) return pick(WORDS);
  if (r === 1) return int(2000) - 500;
  if (r === 2) return int(100) / 8;
  if (r === 3) return pick([true, false, null]);
  if (r === 4) return pick(WORDS);
  if (r === 5) return Array.from({ length: int(4) }, () => value(depth + 1));
  return object(depth + 1);
}
function object(depth = 0) {
  const o = {};
  for (let i = 0, n = 1 + int(4); i < n; i++) o[pick(KEYS) + (i > 3 ? i : "")] = value(depth);
  return o;
}

// Each mutator turns JSON text into one of the ways a model gets it wrong.
const mutators = {
  fence: (s) => `\`\`\`${pick(["json", "JSON", ""])}\n${s}\n\`\`\``,
  fenceOpenOnly: (s) => `\`\`\`json\n${s}`,
  prose: (s) => `${pick(["Sure! Here are the arguments: ", "I will call the tool with ", "Arguments:\n"])}${s}${pick([" Hope this helps.", "", "\nLet me know."])}`,
  rawNewline: (s) => s.replace(/\\n/g, "\n"),
  rawTab: (s) => s.replace(/\\t/g, "\t"),
  trailingComma: (s) => s.replace(/([}\]])/g, (m, c, off) => (rand() < 0.5 ? `,${pick(["", " ", "\n"])}${c}` : m)),
  python: (s) => s.replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None"),
  singleQuotes: (s) => s.replace(/"/g, "'"),
  doubleEncode: (s) => JSON.stringify(s),
  truncate: (s) => s.slice(0, int(s.length + 1)),
  padded: (s) => `${pick(["", " ", "\n", "\t\n "])}${s}${pick(["", " ", "\n"])}`,
  bom: (s) => `﻿${s}`,
};

const handwritten = [
  // not strings
  null, 0, 1, 3.5, true, false, {}, { a: 1 }, [], [1, "two"],
  // empty and trivial
  "", " ", "\n", "null", " null ", "{}", " {} ", "[]", "[1,2]", "0", "true", '"text"', '"{\\"a\\":1}"', '"not json"', "\"\"",
  // valid
  '{"a":1}', ' {"symbol":"SUI","limit":10} ', '{"a":{"b":[1,2,{"c":null}]}}', '{"a":1,"a":2}', '{"x":"中文"}',
  // each repair, plain
  '```json\n{"a":1}\n```', '```\n{"a":1}\n```', '```JSON {"a":1}```', '{"a":1}```', '```json\n{"a":1}',
  '{"note":"line one\nline two"}', '{"note":"tab\there"}', '{"note":"bell\u0007"}', '{"a":1,}', '{"a":[1,2,],}', '{"a":1 , }', '{"a":[1,2 ,\n]}',
  '{"a":True,"b":False,"c":None}', '{"a":"None of the above"}', '{"a":"True story","b":True}', "{'a': 'b'}", "{'a':1,'b':'it'}", "{'a': 'it's'}",
  'Sure, here you go: {"a":1} thanks', 'text before {"a":{"b":"}"}} text after', 'no braces at all', '{"a":1', '{"a":', '{', '}', '{"a":"unterminated', '["a",',
  // more than one thing wrong
  '```json\n{"a":1,}\n```', 'Here: ```json\n{"a":True}\n```', "{'a': True, 'b': None,}", '```{"note":"x\ny",}```',
  '﻿{"a":1}', ' {"a":1} ', ' {"a":1}', '\u0085{"a":1}',
  // long failure (the message keeps 200 characters)
  `nonsense ${"x".repeat(300)}`,
  `{"a": ${"9".repeat(5)}, "b": [` + "1,".repeat(5) + "]",
  // a lone-looking array as the argument
  '[{"a":1}]', "```json\n[1,2,]\n```",
];

const generated = [];
const names = Object.keys(mutators);
for (let i = 0; i < 700; i++) {
  let text = JSON.stringify(object());
  const n = 1 + int(3);
  for (let k = 0; k < n; k++) text = mutators[pick(names)](text);
  generated.push(text);
}

const NUMBER_RUN = /\d{16,}/;
const loneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
const jsonSafe = (v) => {
  const t = JSON.stringify(v);
  return t !== undefined && !NUMBER_RUN.test(t) && !loneSurrogate(t);
};

const repair = [];
for (const input of [...handwritten, ...generated]) {
  if (!jsonSafe(input) && typeof input !== "string") continue;
  if (typeof input === "string" && (NUMBER_RUN.test(input) || loneSurrogate(input))) continue;
  const got = repairToolArguments(input);
  if (!jsonSafe(got.value) || (got.error !== undefined && loneSurrogate(got.error))) continue;
  repair.push({ input, expect: { value: got.value, repaired: got.repaired, ...(got.error !== undefined ? { error: got.error } : {}) } });
}

const names_in = ["getPrice", "functions.getPrice", "mcp_search", "default_api:lookup", "default_api.lookup", "tool:run", "tool.run", "  padded  ", "functions.mcp_x", "tool:functions.y", "Functions.x", "mcp_", "", "toolbox", "functionsX"];
const normalize_name = names_in.map((input) => ({ input, expect: normalizeToolName(input) }));

const tally = { valid: 0, repaired: 0, failed: 0 };
for (const c of repair) (c.expect.error ? (tally.failed += 1) : c.expect.repaired ? (tally.repaired += 1) : (tally.valid += 1));

const out = fileURLToPath(new URL("../conformance/tool-repair.v0.json", import.meta.url));
// One case per line, so a diff reads like a list.
const lines = (a) => a.map((c) => JSON.stringify(c)).join(",\n");
const text = `{"version":"tool-repair.v0","repair":[\n${lines(repair)}\n],"normalize_name":[\n${lines(normalize_name)}\n]}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("conformance/tool-repair.v0.json is not what Super Chat's repair.ts produces; regenerate and review the diff");
    process.exit(1);
  }
  console.log("tool-repair.v0.json matches repair.ts", tally);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${repair.length} repair cases and ${normalize_name.length} name cases`, tally);
}
