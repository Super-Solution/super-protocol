# Running the conformance data against any language

`conformance/protocol.v1.json` is the contract. The Go and Python ports each read it with a test of their own. A new
implementation (Swift, Kotlin, .NET, Java, ...) does not have to write a harness: `scripts/conformance-run.mjs` reads the
file, starts **your program once**, and talks to it over stdin and stdout, one JSON line per case.

```bash
node scripts/conformance-run.mjs --command "go run ./implementations/go/conformance-shim"
node scripts/conformance-run.mjs --command "python3 implementations/python/conformance-shim/shim.py" --require-all
```

Node 20 or newer; the runner has no dependencies. The runner does not publish anything and the data file stays the
contract: it only moves cases to your program and compares what comes back.

## The protocol

Your program reads lines until end of input. For each line it writes one line.

**Request** (one JSON object per line):

```json
{"id": 7, "section": "plugin_manifest", "case": {"value": {"manifestVersion": 0, "name": "x"}}}
```

`section` is a top-level key of the data file that is a list of cases. `case` is that case **without its `expect`**: the
fields the case carries are the inputs (`value`, `a` and `b`, `events`, `chunks` and `max_frame_bytes`, `fn`, ...), and
which ones a section has is in [`conformance/README.md`](../conformance/README.md). Three sections are constants, with one
case `{}` each: `issue_codes` (expect `{ "codes": [...] }`), `protocol` (expect `{ "version", "features" }`) and
`plot_fallback_message` (expect the text).

**Response** (one JSON object per line, in any order; `id` is the request's):

| Response | Meaning |
| --- | --- |
| `{"id": 7, "result": <json>}` | What your program computed, in the shape `expect` has. The runner compares the two as JSON: the order of an object's keys does not matter, nothing else is forgiven (no missing key, no `null` for an absent one). |
| `{"id": 7, "unsupported": true}` | Your program does not implement this section. Reported per section; not a failure unless you pass `--require-all`. |
| `{"id": 7, "error": "message"}` | Your program failed on this case (it threw). A failure. |

Flush after every line or at least at end of input; the runner reads while it writes, so a program that answers as it
goes never waits on a full pipe. Anything your program writes to stderr is shown as it is.

A validator's `result` is its list of issues (`[]` for a valid value); a card validator's is `{ "ok": true }` or
`{ "ok": false, "error", "issues", "expected"? }`. [`docs/ISSUES.md`](ISSUES.md) says what an issue is.

## The report and the exit code

```
plugin_manifest           148 passed
chart_card                257 passed
sse                       376 passed

3702 cases: 3702 passed, 0 failed, 0 unsupported, 0 unanswered
```

A failure prints the case, what was expected and what came back (`--show <n>` prints more per section, `--json` writes
the whole report, failures included, as JSON). Options: `--file <path>` (another file of the same shape),
`--section a,b` (only these), `--require-all`, `--timeout <seconds>` (default 120).

| Exit | Meaning |
| --- | --- |
| 0 | No case failed (and, with `--require-all`, none was unsupported). |
| 1 | A case failed, or `--require-all` and a section is unsupported. |
| 2 | The runner could not run: bad arguments, the program did not start, wrote a line that is not JSON, died, or did not answer every case in time. |

## The two shims

`implementations/go/conformance-shim/main.go` and `implementations/python/conformance-shim/shim.py` answer the runner
with the Go and Python ports. They are short because the ports already have the functions: read a line, look the section
up in a table, call the function, write the line. Both answer every section, and `scripts/check-all.sh` runs them with
`--require-all`, so the runner is tested against two independent implementations on every change. The runner itself is
tested by `scripts/conformance-run-selftest.mjs` with programs that answer wrongly, partly, with errors or not at all.

## What it does not cover

Only `conformance/protocol.v1.json`. The agent loop files (`agent-loop.v0.json` and the others `*.v0.json`) are drafts with a
different shape and their own checks. The data's stability promise is unchanged: the file is the contract, this is a way
to run it.
