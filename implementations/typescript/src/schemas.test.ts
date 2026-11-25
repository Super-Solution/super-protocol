// The JSON Schemas in schemas/ (written by scripts/export-schemas.mjs) against the validators and the conformance data.
//
// Two promises, both checked on every case of conformance/protocol.v1.json:
//   1. A value the validator accepts validates against the schema. A schema stricter than the validator would refuse
//      data the protocol allows, so this is exact: no case is excused.
//   2. A value the validator refuses is refused by the schema too, except for what a schema cannot say: a rule across
//      fields (`unique`, `reference`) or a URL that has to parse (`format` on a URL). For the hand-written schemas that
//      is the whole list. The three card schemas are the ones the model is shown and are written by hand per card kind;
//      for them only promise 1 is held, and how loose they are is reported, not hidden (see docs/SCHEMAS.md).
import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  STREAM_EVENT_TYPES,
  readHostTheme,
  validateChartCardSpec,
  validateEditorCardSpec,
  validateInferenceMessage,
  validateInferenceRequest,
  validatePlotCardSpec,
  validatePluginManifest,
  validateRunEvent,
  validateStreamEvent,
  chartCardKind,
  editorCardKind,
  plotCardKind,
} from "./index.js";

const schemaDir = new URL("../../../schemas/", import.meta.url);
const data = JSON.parse(readFileSync(new URL("../../../conformance/protocol.v1.json", import.meta.url), "utf8"));

const files = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const schemas = new Map<string, Record<string, unknown>>();
for (const file of files) {
  const schema = JSON.parse(readFileSync(new URL(file, schemaDir), "utf8")) as Record<string, unknown>;
  const name = file.replace(/\.schema\.json$/, "");
  schemas.set(name, schema);
  validators.set(name, ajv.compile(schema));
}
const check = (name: string, value: unknown): boolean => validators.get(name)!(value) as boolean;

type Issue = { path: string; code: string };
const issuesOf = (expectation: unknown): Issue[] => {
  if (Array.isArray(expectation)) return expectation as Issue[];
  const issues = (expectation as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues as Issue[]) : [];
};

describe("schemas/", () => {
  it("is the set the generator writes, every file a standalone 2020-12 schema with its own $id", () => {
    expect(files).toEqual([
      "card-response.schema.json",
      "card-spec.schema.json",
      "card-super-chart.schema.json",
      "card-super-editor.schema.json",
      "card-super-plot.schema.json",
      "host-theme.schema.json",
      "inference-message.schema.json",
      "inference-request.schema.json",
      "plugin-manifest.schema.json",
      "run-card.schema.json",
      "run-event.schema.json",
      "stream-event.schema.json",
    ]);
    const ids = new Set<unknown>();
    for (const [name, schema] of schemas) {
      expect(schema.$schema, name).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(String(schema.$id), name).toMatch(new RegExp(`/schemas/${name}\\.schema\\.json$`));
      expect(typeof schema.title, name).toBe("string");
      // The header says what a schema cannot: cross-field rules live in the validators and the conformance data.
      expect(String(schema.description), name).toContain("conformance/protocol.v1.json");
      ids.add(schema.$id);
    }
    expect(ids.size).toBe(files.length);
  });

  it("refuses what is plainly not the shape (a control, so a schema that accepts everything cannot pass)", () => {
    expect(check("plugin-manifest", {})).toBe(false);
    expect(check("plugin-manifest", [])).toBe(false);
    expect(check("run-event", { type: "no-such-event" })).toBe(false);
    expect(check("run-event", { type: "run-start", runId: "r", mode: "stream" })).toBe(true);
    expect(check("run-event", { type: "run-start", runId: "r", mode: "stream", protocol: "0.05" })).toBe(false);
    expect(check("stream-event", { type: "output.delta", request_id: "r", sequence: -1, text: "" })).toBe(false);
    expect(check("inference-message", { role: "assistant", content: "x", tool_calls: [] })).toBe(false);
    expect(check("card-response", { type: "decline" })).toBe(false);
    expect(check("host-theme", { mode: "dark", tokens: { text: "url(x)" } })).toBe(false);
  });

  // Where the schema is allowed to accept what the validator refuses, and why.
  const crossField = (issue: Issue): boolean => issue.code === "unique" || issue.code === "reference";
  const urlShape = (issue: Issue): boolean => issue.code === "format" && /(\.|^)(baseUrl|url)$/.test(issue.path);

  const handWritten: Array<[section: string, schema: string, validate: (value: unknown) => Issue[]]> = [
    ["plugin_manifest", "plugin-manifest", validatePluginManifest],
    ["run_event", "run-event", validateRunEvent],
    ["inference_request", "inference-request", validateInferenceRequest],
    ["inference_message", "inference-message", validateInferenceMessage],
    ["stream_event", "stream-event", validateStreamEvent],
  ];
  for (const [section, schema, validate] of handWritten) {
    it(`${section}: the schema accepts everything the validator accepts and refuses every structural mistake it names`, () => {
      expect(data[section].length).toBeGreaterThan(20);
      for (const [i, c] of (data[section] as Array<{ value: unknown; expect: unknown }>).entries()) {
        const issues = validate(c.value);
        // The conformance data is what the validator says; this guards the harness itself.
        expect(issues, `${section}[${i}] expectation`).toEqual(c.expect);
        const valid = check(schema, c.value);
        if (issues.length === 0) expect(valid, `${section}[${i}] is valid but ${schema} refuses it: ${JSON.stringify(validators.get(schema)!.errors?.[0])}`).toBe(true);
        else if (valid) expect(issues.every((x) => crossField(x) || urlShape(x)), `${section}[${i}] ${JSON.stringify(issues)} is refused by the validator, accepted by ${schema}`).toBe(true);
      }
    });
  }

  const cards: Array<[section: string, schema: string, validate: (value: unknown) => { ok: boolean }]> = [
    ["editor_card", "card-super-editor", validateEditorCardSpec],
    ["chart_card", "card-super-chart", validateChartCardSpec],
    ["plot_card", "card-super-plot", validatePlotCardSpec],
  ];
  for (const [section, schema, validate] of cards) {
    it(`${section}: ${schema} is never stricter than the validator`, () => {
      expect(data[section].length).toBeGreaterThan(5);
      for (const [i, c] of (data[section] as Array<{ value: unknown; expect: { ok: boolean } }>).entries()) {
        expect(validate(c.value).ok, `${section}[${i}]`).toBe(c.expect.ok);
        if (c.expect.ok) expect(check(schema, c.value), `${section}[${i}] is valid but ${schema} refuses it: ${JSON.stringify(validators.get(schema)!.errors?.[0])}`).toBe(true);
      }
    });
  }

  it("a card kind's published schema is the one its definition shows the model", () => {
    for (const [name, definition] of [
      ["card-super-plot", plotCardKind],
      ["card-super-chart", chartCardKind],
      ["card-super-editor", editorCardKind],
    ] as const) {
      const { $schema, $id, title, description, ...body } = schemas.get(name)!;
      expect([$schema, $id, title, description].every((x) => typeof x === "string")).toBe(true);
      expect(body).toEqual(JSON.parse(JSON.stringify(definition.schema)));
    }
  });

  it("host_theme: every theme a host reader returns is a theme the schema accepts, and a reader's null is a schema refusal", () => {
    expect(data.host_theme.length).toBeGreaterThan(10);
    for (const [i, c] of (data.host_theme as Array<{ value: unknown; expect: { theme: unknown } | null }>).entries()) {
      const theme = readHostTheme(c.value);
      if (theme === null) expect(check("host-theme", c.value), `host_theme[${i}] is not a theme but the schema accepts it`).toBe(false);
      else expect(check("host-theme", theme), `host_theme[${i}] ${JSON.stringify(theme)}: ${JSON.stringify(validators.get("host-theme")!.errors?.[0])}`).toBe(true);
    }
  });

  it("run-event and stream-event name every type the package knows, and the card envelope routes by kind", () => {
    for (const [name, known] of [
      ["run-event", RUN_EVENT_TYPES],
      ["stream-event", STREAM_EVENT_TYPES],
    ] as const) {
      const variants = (schemas.get(name)!.oneOf as Array<{ properties: { type: { const: string } } }>).map((v) => v.properties.type.const);
      expect([...variants].sort(), name).toEqual([...known].sort());
    }
    expect(check("card-spec", { kind: "super.plot" })).toBe(true);
    expect(check("card-spec", { kind: "" })).toBe(false);
    expect(check("run-card", { id: "c1", spec: { kind: "super.plot" } })).toBe(true);
    expect(check("run-card", { id: "c1", spec: {} })).toBe(false);
  });
});
