// Runs conformance/protocol.v1.json against a program in any language. The program is started once; for every case the
// runner writes one JSON line to its stdin and reads one JSON line from its stdout. Nothing else is shared, so a new
// implementation (Swift, Kotlin, .NET, ...) needs a loop of about twenty lines, not a test harness of its own.
//
//   node scripts/conformance-run.mjs --command "go run ./implementations/go/conformance-shim"
//
// The protocol is in docs/CONFORMANCE-RUNNER.md. In short:
//   request   {"id": 7, "section": "plugin_manifest", "case": {"value": ...}}     (the case without its `expect`)
//   response  {"id": 7, "result": ...}          what the program computed; compared to the case's `expect`
//             {"id": 7, "unsupported": true}     the program does not implement this section (reported, not failed)
//             {"id": 7, "error": "message"}      the program failed on this case (a failure)
// A section is a top-level list of cases. `issue_codes`, `protocol` and `plot_fallback_message` are constants: one case
// `{}` whose `expect` is the constant.
//
// Exit code: 0 when nothing failed (and, with --require-all, nothing was unsupported), 1 when a case failed, 2 when the
// runner itself could not run (bad arguments, the program could not start, did not answer in time or died).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CONSTANTS = ["issue_codes", "protocol", "plot_fallback_message"];
const USAGE = `usage: node scripts/conformance-run.mjs --command "<program>" [--file <protocol.v1.json>] [--section a,b] [--require-all] [--json] [--timeout <seconds>] [--show <n>]`;

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { file: fileURLToPath(new URL("../conformance/protocol.v1.json", import.meta.url)), sections: null, requireAll: false, json: false, timeout: 120, show: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) usageError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--command") options.command = value();
    else if (arg === "--file") options.file = value();
    else if (arg === "--section") options.sections = value().split(",").filter(Boolean);
    else if (arg === "--require-all") options.requireAll = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--timeout") options.timeout = Number(value());
    else if (arg === "--show") options.show = Number(value());
    else usageError(`unknown argument ${arg}`);
  }
  if (!options.command) usageError("--command is required");
  if (!(options.timeout > 0)) usageError("--timeout must be a positive number of seconds");
  if (!Number.isInteger(options.show) || options.show < 0) usageError("--show must be a non-negative integer");
  return options;
}

/** JSON equality: objects compare by key, not by the order the keys were written in. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** The requests for a data file: one per case of every section, constants included. */
function requestsFor(data, only) {
  const requests = [];
  const section = (name, cases) => {
    if (only && !only.includes(name)) return;
    cases.forEach(({ expect, ...input }, index) => requests.push({ id: requests.length, section: name, index, case: input, expect }));
  };
  for (const [name, value] of Object.entries(data)) {
    if (CONSTANTS.includes(name)) section(name, [{ expect: value }]);
    else if (Array.isArray(value) && value.every((c) => c !== null && typeof c === "object" && "expect" in c)) section(name, value);
  }
  return requests;
}

const short = (value) => {
  const text = JSON.stringify(value);
  return text !== undefined && text.length > 300 ? `${text.slice(0, 300)}... (${text.length} characters)` : text;
};

async function run(options) {
  let data;
  try {
    data = JSON.parse(readFileSync(options.file, "utf8"));
  } catch (e) {
    usageError(`cannot read ${options.file}: ${e.message}`);
  }
  const requests = requestsFor(data, options.sections);
  if (options.sections) {
    const known = new Set(requests.map((r) => r.section));
    const missing = options.sections.filter((s) => !known.has(s));
    if (missing.length > 0) usageError(`no such section: ${missing.join(", ")}`);
  }
  if (requests.length === 0) usageError("the file has no cases to run");

  const child = spawn(options.command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
  const answers = new Map();
  let fatal = null;
  let exited = false;
  let exitStatus = null;
  const done = new Promise((resolve) => {
    child.on("error", (e) => {
      fatal = `could not start the program: ${e.message}`;
      resolve();
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitStatus = signal ?? `code ${code}`;
    });
    child.on("close", resolve);
  });
  const timer = setTimeout(() => {
    fatal = `the program did not answer all ${requests.length} cases within ${options.timeout} s (${answers.size} answered)`;
    child.kill();
  }, options.timeout * 1000);

  linesOf(child).on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fatal ??= `the program wrote a line that is not JSON: ${line.slice(0, 120)}`;
      return;
    }
    if (message === null || typeof message !== "object" || !Number.isInteger(message.id) || message.id < 0 || message.id >= requests.length) {
      fatal ??= `the program answered an id the runner never sent: ${line.slice(0, 120)}`;
      return;
    }
    if (!answers.has(message.id)) answers.set(message.id, message);
  });

  child.stdin.on("error", () => {});
  const write = async (text) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) return;
    if (child.stdin.write(text)) return;
    await Promise.race([new Promise((resolve) => child.stdin.once("drain", resolve)), done]);
  };
  for (const r of requests) {
    if (exited) break;
    await write(`${JSON.stringify({ id: r.id, section: r.section, case: r.case })}\n`);
  }
  child.stdin.end();
  await done;
  clearTimeout(timer);

  const report = { file: options.file, command: options.command, sections: {}, failures: [] };
  for (const r of requests) {
    const row = (report.sections[r.section] ??= { pass: 0, fail: 0, unsupported: 0 });
    const answer = answers.get(r.id);
    if (answer === undefined) continue;
    if (answer.unsupported === true) row.unsupported++;
    else if (typeof answer.error === "string") {
      row.fail++;
      report.failures.push({ section: r.section, index: r.index, case: r.case, error: answer.error });
    } else if (Object.hasOwn(answer, "result") && same(answer.result, r.expect)) row.pass++;
    else {
      row.fail++;
      report.failures.push({ section: r.section, index: r.index, case: r.case, expect: r.expect, got: Object.hasOwn(answer, "result") ? answer.result : "(no result)" });
    }
  }
  const unanswered = requests.length - answers.size;
  const total = (key) => Object.values(report.sections).reduce((n, row) => n + row[key], 0);
  report.totals = { cases: requests.length, pass: total("pass"), fail: total("fail"), unsupported: total("unsupported"), unanswered };
  report.fatal = fatal ?? (unanswered > 0 ? `the program ${exitStatus === null ? "stopped answering" : `exited (${exitStatus})`} with ${unanswered} of ${requests.length} cases unanswered` : null);
  return report;
}

// The program's stdout, one line at a time.
function linesOf(child) {
  return createInterface({ input: child.stdout, crlfDelay: Infinity });
}

function print(report, options) {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const width = Math.max(...Object.keys(report.sections).map((s) => s.length));
  for (const [name, row] of Object.entries(report.sections)) {
    const parts = [`${row.pass} passed`];
    if (row.fail > 0) parts.push(`${row.fail} FAILED`);
    if (row.unsupported > 0) parts.push(`${row.unsupported} unsupported`);
    console.log(`${name.padEnd(width)}  ${parts.join(", ")}`);
  }
  const shown = new Map();
  for (const f of report.failures) {
    const n = shown.get(f.section) ?? 0;
    shown.set(f.section, n + 1);
    if (n >= options.show) continue;
    console.log(`\nFAIL ${f.section}[${f.index}]\n  case:   ${short(f.case)}`);
    if ("error" in f) console.log(`  error:  ${f.error}`);
    else console.log(`  expect: ${short(f.expect)}\n  got:    ${short(f.got)}`);
  }
  const hidden = report.failures.length - [...shown.values()].reduce((a, n) => a + Math.min(n, options.show), 0);
  if (hidden > 0) console.log(`\n(${hidden} more failures not shown; --show <n> shows more, --json lists all)`);
  const t = report.totals;
  console.log(`\n${t.cases} cases: ${t.pass} passed, ${t.fail} failed, ${t.unsupported} unsupported, ${t.unanswered} unanswered`);
  if (report.fatal) console.error(`error: ${report.fatal}`);
}

const options = parseArgs(process.argv.slice(2));
const report = await run(options);
print(report, options);
// Not process.exit(): it can cut off a long report that is still being written to a pipe.
if (report.fatal) process.exitCode = 2;
else if (report.totals.fail > 0) process.exitCode = 1;
else if (options.requireAll && report.totals.unsupported > 0) {
  console.error("error: --require-all and the program left some cases unsupported");
  process.exitCode = 1;
}
