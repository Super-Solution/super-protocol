/**
 * Which version of the protocol a piece of data was written against, and which features this build of the package
 * knows. A plugin manifest and a run (`run-start`) may say it in an optional `protocol` field, so a host can ask "what
 * did this plugin or this stream assume?" without reading the npm lockfile (docs/VERSIONING.md).
 *
 * A protocol version is `major.minor`, two plain numbers with no sign, no leading zero and at most nine digits each:
 * "0.5" and "1.12" are versions, "0.05", "1", "1.2.3" and "v1.2" are not. A patch release never changes it.
 */

/** The protocol version this package implements: the shapes, validators and conformance data it ships. */
export const PROTOCOL_VERSION = "0.5";

/**
 * What this package implements, one `name@major.minor` per feature, where the version is the protocol version the
 * feature first appeared in. A host asks `PROTOCOL_FEATURES.includes("run@0.4")` instead of comparing package versions.
 */
export const PROTOCOL_FEATURES: readonly string[] = [
  "tools@0.2",
  "theme@0.2",
  "ref@0.3",
  "plot@0.3",
  "run@0.4",
  "placement@0.4",
  "issues@0.5",
  "mapping@0.5",
];

export interface ParsedProtocolVersion {
  major: number;
  minor: number;
}

export interface ParsedProtocolFeature {
  name: string;
  version: ParsedProtocolVersion;
}

/** Matches a protocol version; the checks and the parse below use the same pattern. */
export const PROTOCOL_VERSION_PATTERN = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const FEATURE = /^([a-z][a-z0-9-]*)@(.+)$/;

/** `{ major, minor }` of a protocol version, or `null` when `value` is not one (including anything that is not a string). */
export function parseProtocolVersion(value: unknown): ParsedProtocolVersion | null {
  if (typeof value !== "string") return null;
  const m = PROTOCOL_VERSION_PATTERN.exec(value);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b`; `null` when either is not a protocol version. */
export function compareProtocolVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseProtocolVersion(a);
  const y = parseProtocolVersion(b);
  if (x === null || y === null) return null;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  return 0;
}

/** `{ name, version }` of a feature such as `run@0.4`, or `null` when `value` is not one. */
export function parseProtocolFeature(value: unknown): ParsedProtocolFeature | null {
  if (typeof value !== "string") return null;
  const m = FEATURE.exec(value);
  const version = m ? parseProtocolVersion(m[2]) : null;
  return m && version ? { name: m[1]!, version } : null;
}
