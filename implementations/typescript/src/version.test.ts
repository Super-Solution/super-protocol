import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  compareProtocolVersions,
  parseProtocolFeature,
  parseProtocolVersion,
  validatePluginManifest,
  validateRunEvent,
} from "./index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("protocol version", () => {
  it("is a valid version and the package never claims a newer one than the protocol it ships", () => {
    expect(parseProtocolVersion(PROTOCOL_VERSION)).not.toBeNull();
    // The npm version is the release; the protocol version is what the shapes are. A release at 0.4.x ships protocol 0.4 or
    // later, never an earlier one, and `PROTOCOL_VERSION` does not move the package version.
    const [major, minor] = pkg.version.split(".");
    expect(compareProtocolVersions(`${major}.${minor}`, PROTOCOL_VERSION), `package ${pkg.version} vs protocol ${PROTOCOL_VERSION}`).toBeLessThanOrEqual(0);
  });
  it("lists features once each, none from a version later than the protocol", () => {
    const names = PROTOCOL_FEATURES.map((f) => parseProtocolFeature(f)?.name);
    expect(names.every((n) => n !== undefined)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    for (const f of PROTOCOL_FEATURES) expect(compareProtocolVersions(f.split("@")[1], PROTOCOL_VERSION), f).toBeLessThanOrEqual(0);
  });
  it("compares by number, not by text", () => {
    expect(compareProtocolVersions("0.9", "0.10")).toBe(-1);
    expect(compareProtocolVersions("1.0", "0.99")).toBe(1);
    expect(compareProtocolVersions("0.5", "0.5")).toBe(0);
    expect(compareProtocolVersions("0.05", "0.5")).toBeNull();
    expect(compareProtocolVersions("0.5", 0.5)).toBeNull();
  });
});

describe("the optional protocol field", () => {
  const manifest = { manifestVersion: 0, name: "p", version: "0.1.0", license: "MIT", capabilities: [{ id: "a.b", surface: "canvas" }] };
  it("is accepted on a manifest and on run-start, and a bad one says where", () => {
    expect(validatePluginManifest({ ...manifest, protocol: "0.5" })).toEqual([]);
    expect(validateRunEvent({ type: "run-start", runId: "r", mode: "stream", protocol: "0.5" })).toEqual([]);
    expect(validatePluginManifest({ ...manifest, protocol: "v0.5" })).toEqual([{ path: "protocol", code: "format", message: "must be a protocol version such as 0.5" }]);
    expect(validateRunEvent({ type: "run-start", runId: "r", mode: "stream", protocol: 5 })).toEqual([
      { path: "protocol", code: "type", message: "must be a protocol version such as 0.5", hint: "got number" },
    ]);
  });
});
