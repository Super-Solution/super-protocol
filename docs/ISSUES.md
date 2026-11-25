# Issues: how a validator says what is wrong

Every validator in this package returns **all** the problems it finds, never just the first, and an empty list means
the value is valid. One problem is an `Issue`:

```ts
{ path: "capabilities[1].surface", code: "enum", message: "must be one of card, panel, tool, canvas", hint: 'did you mean "card"?' }
```

| Field | What it is | Contract |
| --- | --- | --- |
| `path` | Where the problem is (`bars[3].open`, `service.baseUrl`; `""` for the value itself). | Pinned by the conformance data. |
| `code` | What kind of problem it is. One of 13 words, below. | **Branch on this.** The same in TypeScript, Go and Python. |
| `message` | A sentence for a person or a model. | Pinned byte for byte so a port reproduces it. Do not parse it. |
| `hint` | How to fix it, when there is something to say beyond the message. Left out when there is none. | A `did you mean` for `enum`, `got <type>` for `type`, a sample for `required` and `exclusive`. |

`message` texts did not change when codes were added: a program that read `path` and `message` keeps working, and a
program that wants to react (retry with a fix, show a field error, tell a model what to change) reads `code`.

## The codes

The set is closed: adding one is a protocol change, and every code is exercised by `conformance/protocol.v1.json`
(`issue_codes` pins the list; every issue in the other sections carries one). A consumer should still treat a code it
does not know as a plain problem, since a later version may add one.

| `code` | Use it for | Example | `hint` |
| --- | --- | --- | --- |
| `required` | The value is absent (the key is not there). | a manifest with no `name` | A sample of a valid value, only where the validator has one (a plot card without `spec` or `alt`). |
| `type` | The value is there but is the wrong JSON type. | `title: 5` where a string is wanted | `got <type>`: `null`, `array`, `object`, `string`, `number` or `boolean`. |
| `empty` | Right type, nothing in it: `""`, a string of only whitespace where the message says so, an empty array. | `runId: ""` | none |
| `enum` | Not one of the accepted values. | `mode: "strem"`, an unknown event type | `did you mean "stream"?` when it is within two edits of one accepted value. |
| `range` | A number outside what is accepted: negative, not an integer, not finite, outside a minimum and maximum. | `height: 5`, `steps: -1` | none |
| `length` | Text longer than allowed, counted in UTF-16 units like a JavaScript `length`. | an `alt` over 2048 characters | none |
| `limit` | More items or entries than allowed. | 21 000 inline bars, 13 indicators | none |
| `format` | A string that does not parse as what it must be. | `baseUrl: "nope"`, a package name, a semver, a tool name | none |
| `unique` | A value that must appear once appears twice. | two capabilities with one id, a repeated tool call id | none |
| `exclusive` | Fields that cannot go together, or exactly one of which must be given. | a chart card with both `bars` and `feed` (or neither) | A sample of the choice (`bars: [...] \| feed: { id }`). |
| `order` | Items in the wrong order. | chart bars not sorted oldest first | none |
| `reference` | Points at something that does not exist. | a tool result whose `tool_call_id` no assistant message made; a capability naming a card kind the plugin does not define | none |
| `shape` | The right type, but the parts do not fit together. | a bar whose high is below its close, a `level` annotation with two anchors, an `input_schema` whose type is not `object` | none |

Two rules keep the codes the same everywhere:

- A value that is **absent** is `required`; one of the **wrong JSON type** is `type`; one of the right type that is
  not acceptable is the code that says why (`empty`, `enum`, `range`, ...). `null` is a value, not an absence.
- `enum` covers any value that is not on the list, of any type, so `mode: 5` is `enum`, not `type`.

## Card validators

`validateEditorCardSpec`, `validateChartCardSpec` and `validatePlotCardSpec` keep their result shape and add the list:

```ts
{ ok: false, error: string, expected?: string, issues?: Issue[] }
```

- `issues` is every problem, in the order the validator checks.
- `error` is the message of the first issue, exactly the sentence these validators have always returned.
- `expected` is that first issue's `hint` when its code is `required` or `exclusive` (a sample of a valid value, as before).
- `issues` is optional in the type so a card kind written before it existed still fits `CardKindDefinition`; read
  `error` when it is absent.

`validatePeriod`, `validateSymbol`, `validateMarketBar`, `validateChartAnnotation` and `validateChartAnnotations`
still return the first problem as a sentence (or `null`); `validateChartCardSpec` is the way to get all of them.

## Where it lives

| | Issue | Codes | Hint |
| --- | --- | --- | --- |
| TypeScript | `Issue`, `IssueCode` | `ISSUE_CODES` | `didYouMean(value, allowed)` |
| Go | `protocol.Issue` (`ManifestIssue` is the same type) | `protocol.IssueCodes`, `protocol.CodeRequired`, ... | `protocol.DidYouMean(value, allowed)` |
| Python | `super_protocol.Issue` (`ManifestIssue` is the same type) | `ISSUE_CODES` | `did_you_mean(value, allowed)` |

The `did you mean` hint is the first allowed value within two edits, measured in code points; a tie goes to the one listed
first. `conformance/protocol.v1.json` pins it as `did_you_mean`.

A port reproduces `path`, `code`, `message` and `hint` for every case. One known difference: the Go port decodes a JSON
object into a map, which has no order, so it walks the entries of `annotation.params` in sorted order where TypeScript
and Python use the order of the JSON text. The conformance data keeps to cases where the two agree.
