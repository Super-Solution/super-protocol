// Checks scripts/conformance-run.mjs itself, with programs that answer in ways a real one should not, so a runner that
// passes everything (or fails nothing) cannot go unnoticed. Part of scripts/check-all.sh.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./conformance-run.mjs", import.meta.url));
const data = fileURLToPath(new URL("../conformance/protocol.v1.json", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "conformance-selftest-"));

const program = (name, body) => {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const data = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
const CONSTANTS = ["issue_codes", "protocol", "plot_fallback_message"];
const key = (section, input) => section + JSON.stringify(input);
const expectations = new Map();
for (const [section, value] of Object.entries(data)) {
  if (CONSTANTS.includes(section)) expectations.set(key(section, {}), value);
  else if (Array.isArray(value)) for (const { expect, ...input } of value) expectations.set(key(section, input), expect);
}
for await (const line of createInterface({ input: process.stdin })) {
  const { id, section, case: input } = JSON.parse(line);
  const expect = expectations.get(key(section, input));
  const answer = (() => { ${body} })();
  process.stdout.write(JSON.stringify({ id, ...answer }) + "\\n");
}
`,
  );
  return `node ${JSON.stringify(file)}`;
};

const run = (command, ...args) => {
  const r = spawnSync("node", [runner, "--command", command, "--json", "--timeout", "60", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    /* no report */
  }
  return { status: r.status, report, stderr: r.stderr };
};

let failed = 0;
const expectThat = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed++;
    console.log(`     ${detail}`);
  }
};

try {
  const right = run(program("right", "return { result: expect };"));
  expectThat("a program that answers every case with its expectation passes", right.status === 0 && right.report?.totals.fail === 0 && right.report.totals.pass === right.report.totals.cases && right.report.totals.cases > 3000, `exit ${right.status} ${JSON.stringify(right.report?.totals)}`);

  const wrong = run(program("wrong", 'return { result: "not what was expected" };'));
  expectThat("a program that answers every case wrongly fails every case", wrong.status === 1 && wrong.report?.totals.pass === 0 && wrong.report.totals.fail === wrong.report.totals.cases, `exit ${wrong.status} ${JSON.stringify(wrong.report?.totals)}`);

  const subtle = run(program("subtle", "return { result: typeof expect === 'string' ? expect + ' ' : expect === true ? false : expect === false ? true : Array.isArray(expect) && expect.length ? expect.slice(1) : expect };"));
  expectThat("a program that is wrong in small ways is caught", subtle.status === 1 && subtle.report?.totals.fail > 100, `exit ${subtle.status} ${JSON.stringify(subtle.report?.totals)}`);

  const reordered = run(program("reordered", "return { result: expect && typeof expect === 'object' && !Array.isArray(expect) ? Object.fromEntries(Object.entries(expect).reverse()) : expect };"));
  expectThat("the order of an object's keys does not matter", reordered.status === 0 && reordered.report?.totals.fail === 0, `exit ${reordered.status} ${JSON.stringify(reordered.report?.totals)}`);

  const failing = run(program("failing", 'return { error: "boom" };'));
  expectThat("a program that reports an error on every case fails every case", failing.status === 1 && failing.report?.failures[0]?.error === "boom", `exit ${failing.status} ${JSON.stringify(failing.report?.totals)}`);

  const unsupported = program("unsupported", "return { unsupported: true };");
  const skipped = run(unsupported);
  expectThat("unsupported sections are reported and do not fail the run", skipped.status === 0 && skipped.report?.totals.unsupported === skipped.report?.totals.cases, `exit ${skipped.status} ${JSON.stringify(skipped.report?.totals)}`);
  const strict = run(unsupported, "--require-all");
  expectThat("--require-all fails when a section is unsupported", strict.status === 1, `exit ${strict.status}`);

  const partial = run(program("partial", "return section === 'sse' ? { result: expect } : { unsupported: true };"), "--section", "sse,protocol_version");
  expectThat("--section runs only the named sections", partial.status === 0 && Object.keys(partial.report?.sections ?? {}).join() === "protocol_version,sse" && partial.report.sections.sse.pass > 300, `exit ${partial.status} ${JSON.stringify(partial.report?.sections)}`);

  const crash = run(`node -e "process.exit(3)"`);
  expectThat("a program that dies is a runner error, not a pass", crash.status === 2 && /exited/.test(crash.report?.fatal ?? ""), `exit ${crash.status} ${crash.report?.fatal}`);

  const noise = run(`node -e "console.log('hello')"`);
  expectThat("a program that writes something that is not JSON is a runner error", noise.status === 2, `exit ${noise.status}`);

  const missing = run("true", "--section", "no_such_section");
  expectThat("an unknown section is a usage error", missing.status === 2, `exit ${missing.status}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} runner self-test(s) failed`);
  process.exit(1);
}
console.log("conformance runner self-test passed");
