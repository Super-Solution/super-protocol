// Writes schemas/*.schema.json: JSON Schema (2020-12) for the shapes a program that is not written in TypeScript has to
// produce or read: the plugin manifest, a run event, a card and its answer, an inference request, message and stream event,
// and a host theme. The word lists come from the built package, so a new run event type or finish reason cannot be added
// to the validator and forgotten here; the card kinds' own `schema` is used as it is. The rest is a small field table below.
//
// A schema says what a value looks like, not everything that makes it valid: rules that look at two fields (a duplicate
// capability id, a tool result that answers no call, bars out of order) are checked by the validators and pinned by
// conformance/protocol.v1.json only. The test implementations/typescript/src/schemas.test.ts holds the schemas to that:
// every value the validators accept validates here, and the structural mistakes the validators name are refused here too.
//
// Run `pnpm build` first (the generator imports the built package). `--check` fails when schemas/ is not what this
// script writes, which is what scripts/check-all.sh runs.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXECUTION_STATUSES,
  INFERENCE_FINISH_REASONS,
  PLUGIN_MANIFEST_VERSION,
  PLUGIN_SURFACES,
  PROTOCOL_VERSION_PATTERN,
  RUN_CARD_ACTION_TYPES,
  RUN_EVENT_TYPES,
  RUN_FINISH_REASONS,
  RUN_JOB_STATUSES,
  RUN_MODES,
  STREAM_EVENT_TYPES,
  THEME_TOKENS,
  THEME_VALUE_MAX_LENGTH,
  chartCardKind,
  editorCardKind,
  plotCardKind,
} from "../implementations/typescript/dist/index.js";

const dir = fileURLToPath(new URL("../schemas/", import.meta.url));
const ID_BASE = "https://raw.githubusercontent.com/Super-Solution/super-protocol/main/schemas/";

// ---- the small field table -----------------------------------------------------------------------------------------
// One entry per kind of field a validator checks. `text` is `text()` in check.ts, `count` is `count()`, and so on.
const text = { type: "string", minLength: 1 };
const str = { type: "string" };
const bool = { type: "boolean" };
const count = { type: "integer", minimum: 0 };
const amount = { type: "number", minimum: 0 };
const positive = { type: "integer", minimum: 1 };
const object = { type: "object" };
const filled = { type: "string", pattern: "\\S" };
const oneOf = (list) => ({ enum: [...list] });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });
const ref = (name) => ({ $ref: `#/$defs/${name}` });
/** An object with these required and optional fields; unknown extra keys are allowed, as the validators allow them. */
const shape = (required, optional = {}, extra = {}) => ({
  type: "object",
  ...(Object.keys(required).length > 0 ? { required: Object.keys(required) } : {}),
  properties: { ...required, ...optional },
  ...extra,
});
/** A pattern for text that a JavaScript regex matches with the `i` flag (a JSON Schema pattern has no flags). */
const insensitive = (s) => s.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

// Patterns. They are the sources of the regexes in plugin.ts and router.ts; schemas.test.ts runs every conformance case
// through them, so a drift shows as a failing case.
const NAME = "^(@[a-z0-9\\-~][a-z0-9\\-._~]*/)?[a-z0-9\\-~][a-z0-9\\-._~]*$";
const SEMVER = "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.\\-]+)?(\\+[0-9A-Za-z.\\-]+)?$";
const CAPABILITY_ID = "^[a-z][a-z0-9\\-]*(\\.[a-z][a-z0-9\\-]*)+$";
const TOOL_NAME = "^[A-Za-z0-9_\\-]{1,64}$";
// A URL has to parse as one; the schema only checks the scheme, so it is never stricter than the validator.
const HTTP_URL = `^${insensitive("http")}${insensitive("s")}?:`;
const IMAGE_URL = `^(?:${insensitive("https")}:|data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$)`;
// readHostTheme drops a value that could end a declaration or fetch a resource (UNSAFE_VALUE in theme.ts, flag `i`).
const UNSAFE_THEME_VALUE = `[;{}<>\\\\]|/\\*|${insensitive("url")}\\s*\\(|${insensitive("expression")}\\s*\\(|${insensitive("@import")}`;

const NOTE =
  "Structure only. A value this schema accepts can still be refused by the validator: rules across fields (duplicates, a tool result that answers no call, ordering, limits that count UTF-16 units) are checked by the validators and pinned by conformance/protocol.v1.json, not here. A value the validators accept always validates.";

/** Wrap a schema's body as one published file: dialect, id, title and the note on what a schema cannot say. */
function file(name, title, summary, body) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${ID_BASE}${name}.schema.json`,
    title,
    description: `${summary} ${NOTE}`,
    ...body,
  };
}

// ---- shared pieces -------------------------------------------------------------------------------------------------
const usage = shape({}, { inputTokens: amount, outputTokens: amount, totalTokens: amount, cachedInputTokens: amount, reasoningTokens: amount });
const cardSpec = shape({ kind: text });
const cardAction = shape({ cardId: text, kind: text, type: oneOf(RUN_CARD_ACTION_TYPES), at: amount }, { callId: text, value: {} });
const runCard = shape({ id: text, spec: ref("cardSpec") }, { expired: bool, callId: text, action: ref("cardAction") });
const part = shape({ type: text });
const handle = shape({ provider: text, id: text });
const runDefs = { usage, cardSpec, cardAction, runCard, part, handle };

const toolCall = shape({ id: text, name: { type: "string", pattern: TOOL_NAME }, arguments: str });
const contentPart = {
  oneOf: [
    shape({ type: { const: "text" }, text: str }),
    shape({ type: { const: "image" }, url: { type: "string", pattern: IMAGE_URL } }, { detail: oneOf(["auto", "low", "high"]) }),
  ],
};
const inferenceMessage = {
  oneOf: [
    shape({ role: { const: "system" }, content: str }),
    shape({ role: { const: "user" }, content: str }),
    shape({ role: { const: "user" }, content: array(ref("contentPart"), { minItems: 1 }) }),
    shape({ role: { const: "assistant" }, content: str }, { tool_calls: false }),
    shape({ role: { const: "assistant" }, tool_calls: array(ref("toolCall"), { minItems: 1 }) }, { content: str }),
    shape({ role: { const: "tool" }, tool_call_id: text, content: str }, { is_error: bool }),
  ],
};
const meters = shape({ input: count, cached: count, cache_write: count, output: count }, { images: count, video_ms: count, audio_ms: count, tasks: count });
const inferenceUsage = shape({ status: text }, { meters: ref("meters") });
const inferenceDefs = { toolCall, contentPart, inferenceMessage, meters, inferenceUsage };

// ---- the files -----------------------------------------------------------------------------------------------------
const schemas = {};

schemas["plugin-manifest"] = file("plugin-manifest", "Plugin manifest", "What a plugin declares so a host can load it: its name, licence, capabilities and optional service and protocol version.", {
  ...shape(
    {
      manifestVersion: { const: PLUGIN_MANIFEST_VERSION },
      name: { type: "string", pattern: NAME },
      version: { type: "string", pattern: SEMVER },
      license: filled,
      capabilities: array(ref("capability"), { minItems: 1 }),
    },
    { service: shape({ baseUrl: { type: "string", pattern: HTTP_URL } }), protocol: { type: "string", pattern: PROTOCOL_VERSION_PATTERN.source } },
  ),
  $defs: {
    capability: {
      ...shape({ id: { type: "string", pattern: CAPABILITY_ID }, surface: oneOf(PLUGIN_SURFACES) }, { inputSchema: object }),
      allOf: [
        { if: { properties: { surface: { const: "card" } }, required: ["surface"] }, then: { required: ["cardKind"], properties: { cardKind: text } } },
        { if: { properties: { surface: { const: "panel" } }, required: ["surface"] }, then: { properties: { cardKind: text } } },
        { if: { properties: { surface: { const: "tool" } }, required: ["surface"] }, then: { required: ["toolName"], properties: { toolName: text } } },
      ],
    },
  },
});

const event = (type, required = {}, optional = {}) => shape({ type: { const: type }, ...required }, { ...optional, seq: count });
schemas["run-event"] = file("run-event", "Run event", "One event of an agent run, as it is streamed. A reader skips an event type it does not know; a producer checks what it sends against this.", {
  oneOf: [
    event("run-start", { runId: text, mode: oneOf(RUN_MODES) }, { threadId: text, protocol: { type: "string", pattern: PROTOCOL_VERSION_PATTERN.source } }),
    event("run-snapshot", { parts: array(ref("part")), cards: array(ref("runCard")) }, { usage: ref("usage"), steps: count }),
    event("context-built", { trace: object, system: str, toolNames: array(str) }),
    event("step-start", { step: count }),
    event("text-delta", { delta: str }, { id: text }),
    event("reasoning-delta", { delta: str }, { id: text }),
    event("tool-call-input-delta", { callId: text, name: text }, { partialInput: {}, partialCard: ref("cardSpec"), loading: object }),
    event("tool-call", { callId: text, name: text }, { input: {}, repaired: bool, loading: object }),
    event("awaiting-user", { callId: text, card: ref("runCard") }),
    event("user-responded", { callId: text, action: ref("cardAction") }),
    event("tool-result", { callId: text, name: text, ms: amount }, { output: {}, failure: str }),
    event("card", { card: ref("runCard") }),
    event("card-updated", { cardId: text, spec: ref("cardSpec") }),
    event("step-finish", { step: count, finishReason: oneOf(RUN_FINISH_REASONS) }, { usage: ref("usage") }),
    event("job-started", { handle: ref("handle") }),
    event("job-status", { handle: ref("handle"), status: oneOf(RUN_JOB_STATUSES) }),
    event("message", { parts: array(ref("part")) }),
    event("metering", { record: object }),
    event("usage", { usage: ref("usage") }),
    event("run-finish", { runId: text, finishReason: oneOf(RUN_FINISH_REASONS), usage: ref("usage"), steps: count }),
    event("error", { recoverable: bool }, { error: {} }),
  ],
  $defs: runDefs,
});

schemas["run-card"] = file("run-card", "Run card", "A card in a run: its id, its spec (the `kind` routes it to a renderer) and, once the person answered, what they answered.", {
  ...runCard,
  $defs: runDefs,
});

schemas["card-spec"] = file("card-spec", "Card spec", "The envelope every card spec shares: a `kind` that routes it to a renderer. The rest belongs to that kind (see the card-* schemas).", cardSpec);

schemas["card-response"] = file("card-response", "Card response", "What the person did with an interactive card; the host turns it into the tool result.", {
  ...shape({ type: oneOf(["submit", "select", "confirm", "cancel", "dismiss"]) }, { value: {} }),
});

// A card kind's own `schema` is the one the model is shown; it is published as it is so there is one source for it.
for (const [name, definition] of [
  ["card-super-plot", plotCardKind],
  ["card-super-chart", chartCardKind],
  ["card-super-editor", editorCardKind],
]) {
  schemas[name] = file(name, `Card spec: ${definition.kind}`, `The spec of a \`${definition.kind}\` card. ${definition.summary}`, definition.schema);
}

schemas["inference-message"] = file("inference-message", "Inference message", "One message of an inference request: a system, user, assistant or tool message.", {
  ...inferenceMessage,
  $defs: inferenceDefs,
});

schemas["inference-request"] = file("inference-request", "Inference request", "What a gateway accepts: the service, the customer, the messages and, optionally, the tools the model may call.", {
  ...shape(
    { service: text, customer_id: text, messages: array(ref("inferenceMessage"), { minItems: 1 }) },
    {
      service_version: count,
      tools: array(ref("tool")),
      tool_choice: { oneOf: [oneOf(["auto", "none", "required"]), shape({ name: { type: "string", pattern: TOOL_NAME } })] },
      max_output_tokens: positive,
      timeout_ms: positive,
    },
  ),
  $defs: {
    ...inferenceDefs,
    tool: shape({ name: { type: "string", pattern: TOOL_NAME }, input_schema: shape({ type: { const: "object" } }) }, { description: str }),
  },
});

const streamEvent = (type, required = {}, optional = {}) => shape({ type: { const: type }, request_id: text, sequence: count, ...required }, optional);
schemas["stream-event"] = file("stream-event", "Inference stream event", "One event of a gateway's stream. A consumer skips an event type it does not know.", {
  oneOf: [
    streamEvent("request.started", { service_version: count }),
    streamEvent("output.delta", { text: str }),
    streamEvent("output.tool_call.delta", { index: count, arguments_delta: str }, { id: text, name: { type: "string", pattern: TOOL_NAME } }),
    streamEvent("output.tool_call.completed", { index: count, id: text, name: { type: "string", pattern: TOOL_NAME }, arguments: str }),
    streamEvent("request.completed", { execution_status: oneOf(EXECUTION_STATUSES), billing_status: text }, { finish_reason: oneOf(INFERENCE_FINISH_REASONS), usage: ref("inferenceUsage") }),
    streamEvent("request.failed", {}, { execution_status: oneOf(EXECUTION_STATUSES), billing_status: text, error: shape({ code: text }), usage: ref("inferenceUsage") }),
    streamEvent("request.replayed"),
  ],
  $defs: { meters, inferenceUsage },
});

const token = { type: "string", minLength: 1, maxLength: THEME_VALUE_MAX_LENGTH, pattern: "\\S", not: { pattern: UNSAFE_THEME_VALUE } };
schemas["host-theme"] = file("host-theme", "Host theme", "The colours and fonts a host passes to plugin cards: a mode and any subset of the tokens. A reader drops an unknown token or an unsafe value one by one; this schema describes the theme a host should send.", {
  ...shape(
    { mode: oneOf(["light", "dark"]), tokens: shape({}, Object.fromEntries(THEME_TOKENS.map((t) => [t, token]))) },
  ),
});

// A type the validator knows and a schema does not (or the other way round) is a mistake in this file, not a choice.
for (const [name, list] of [
  ["run-event", RUN_EVENT_TYPES],
  ["stream-event", STREAM_EVENT_TYPES],
]) {
  const listed = schemas[name].oneOf.map((variant) => variant.properties.type.const);
  if (JSON.stringify([...listed].sort()) !== JSON.stringify([...list].sort())) {
    throw new Error(`${name}.schema.json lists [${listed}] but the package knows [${list}]`);
  }
}

// Sorted so the files, and a diff of them, never depend on the order they were added in.
const written = Object.fromEntries(Object.keys(schemas).sort().map((name) => [`${name}.schema.json`, `${JSON.stringify(schemas[name], null, 2)}\n`]));

if (process.argv.includes("--check")) {
  let stale = false;
  let existing = [];
  try {
    existing = readdirSync(dir);
  } catch {
    /* missing */
  }
  const onDisk = new Set(existing.filter((f) => f.endsWith(".schema.json")));
  for (const [name, body] of Object.entries(written)) {
    let current = "";
    try {
      current = readFileSync(`${dir}${name}`, "utf8");
    } catch {
      /* missing */
    }
    if (current !== body) stale = true;
    onDisk.delete(name);
  }
  if (stale || onDisk.size > 0) {
    console.error("schemas/ is not what scripts/export-schemas.mjs writes; run `node scripts/export-schemas.mjs` and review the diff");
    process.exit(1);
  }
  console.log(`schemas/ matches ${Object.keys(written).length} files`);
} else {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith(".schema.json") && !(f in written)) rmSync(`${dir}${f}`);
  for (const [name, body] of Object.entries(written)) writeFileSync(`${dir}${name}`, body);
  console.log(`wrote ${Object.keys(written).length} files to ${dir}`);
}
