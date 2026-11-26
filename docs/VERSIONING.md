# Protocol version and features

The npm package version says which *release* you have. The **protocol version** says which *shapes and rules* a piece
of data was written against. They are different numbers: a host reading a plugin manifest or a run stream should not
have to read a lockfile to learn what the other side assumed.

```ts
import { PROTOCOL_VERSION, PROTOCOL_FEATURES, compareProtocolVersions } from "@supersolutions/super-protocol/version";

PROTOCOL_VERSION; // "0.5"
PROTOCOL_FEATURES.includes("run@0.4"); // true: this build knows the run events
compareProtocolVersions(manifest.protocol, "0.4"); // 1, 0, -1, or null when it is not a version
```

Go has `ProtocolVersion`, `ProtocolFeatures`, `ParseProtocolVersion`, `CompareProtocolVersions` and
`ParseProtocolFeature`; Python has `PROTOCOL_VERSION`, `PROTOCOL_FEATURES`, `parse_protocol_version`,
`compare_protocol_versions` and `parse_protocol_feature`. The values come from `conformance/protocol.v1.json`
(`protocol`), and `protocol_version` pins the parsing and comparison, so all three agree.

## What a protocol version is

`major.minor`: two plain numbers, no sign, no leading zero, at most nine digits each, compared as numbers
(`0.10` is newer than `0.9`). `"0.5"` and `"1.12"` are versions; `"0.05"`, `"1"`, `"1.2.3"`, `"v1.2"` and `" 0.5"` are not.
There is no patch part: a patch release of the package never changes it.

`PROTOCOL_VERSION` moves when the shapes, validators or conformance data change in a way a reader could observe:
a new section of conformance data, a new optional field, a new feature. It is **not** a promise that older data
stops validating; the package version and its changelog say whether a release breaks anything.

## Where data says its version

| Where | Field | Meaning |
| --- | --- | --- |
| Plugin manifest | `protocol` (optional) | The protocol version the plugin was written against. |
| `run-start` run event | `protocol` (optional) | The protocol version the producer of the stream was written against. |

Both are optional and checked only when present: a value that is not a protocol version is a `format` issue (a
non-string is `type`), with the message `must be a protocol version such as 0.5`. Absent means "not said", never
"oldest": a reader must not infer a version from a missing field.

A reader that sees a version *newer* than its own `PROTOCOL_VERSION` should still read what it understands and ignore
unknown optional fields (the package never rejects unknown keys). It decides for itself whether to warn.

## Features

`PROTOCOL_FEATURES` lists what a build implements, one `name@major.minor` per feature, where the version is the
protocol version the feature first appeared in:

| Feature | Since | What it is |
| --- | --- | --- |
| `tools` | 0.2 | Tool authority and the chat plugin shapes |
| `theme` | 0.2 | Host theme tokens |
| `ref` | 0.3 | `ref:` card references |
| `plot` | 0.3 | The `super.plot` card |
| `run` | 0.4 | Run events |
| `placement` | 0.4 | Card placement |
| `issues` | 0.5 | Issue codes and `issues` on every validator result |
| `mapping` | 0.5 | Gateway-to-run conversions |

A host asks `PROTOCOL_FEATURES.includes("run@0.4")` instead of comparing package versions. A feature entry is never
removed from the list while the feature is Active (below). There is no negotiation message: this is a statement a
build makes about itself, for the other side to read.

## Deprecation policy (draft, for the owner to decide)

Nothing in the protocol is deprecated today and this section changes no behaviour. It is a proposal for how a
feature leaves, so that the answer to "can I rely on this?" is written down before the first removal.

| State | Meaning | What changes |
| --- | --- | --- |
| Active | Part of the protocol. | Nothing. |
| Deprecated | Still validated and still in the conformance data; new data should not use it. | The feature stays in `PROTOCOL_FEATURES`; the docs and the changelog name the replacement and the version it was deprecated in. |
| Removed | No longer validated. | The feature leaves `PROTOCOL_FEATURES`; the conformance cases for it are removed or changed in the same release, in all three languages. |

**How long a feature stays Deprecated before it is Removed: not decided.** The owner picks the window (a number of
protocol versions, or a period of time); until then no feature is deprecated.

### Tension with ADR 0013 (for the owner)

[ADR 0013](https://github.com/Super-Solution/super-dev-docs/blob/main/docs/40-decisions/0013-versioning-and-release-policy.md)
says that, while a package is `0.x`, a minor release may break, and that a *wire version identifier* changes only for a
breaking wire change, independently of the npm version. `PROTOCOL_VERSION` is a second number that moves for
additive changes too, so it is **not** the "wire version identifier" of that ADR (that is `manifestVersion`,
`*.v1.json`). The two readings can be reconciled in one of two ways, and the choice is the owner's:

1. Keep it as written here: `PROTOCOL_VERSION` is informational (what the data assumed), moves with features, and
   `manifestVersion` stays the breaking-change marker.
2. Tie it to the ADR: `PROTOCOL_VERSION` moves only on a breaking wire change, and features carry the additive part.

This change does not bump the package version (`0.4.x` stays what `package.json` says); `PROTOCOL_VERSION` being
`0.5` ahead of it is only a statement that the next minor release will carry these features.
