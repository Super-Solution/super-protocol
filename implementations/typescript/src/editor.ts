/**
 * How an editor document travels through chat: the card kind, its spec and its
 * validator. The editor package (any license) implements the renderer; hosts
 * and agents only need this file to produce and route the card.
 */
import { cardResult, type CardKindDefinition, type CardValidationResult } from "./chat.js";
import { isHttpUrl, isObject, oneOf, str, text, wrongType } from "./check.js";
import { collector } from "./issue.js";

export const EDITOR_CARD_KIND = "super-editor.document";

export interface EditorCardSpec {
  kind: typeof EDITOR_CARD_KIND;
  title?: string;
  mode?: "view" | "edit";
  /**
   * The document inline (schemaVersion 1 report document). Opaque to the
   * protocol; the editor validates it in full when it mounts.
   */
  document?: { schemaVersion: 1; id: string; title: string; blocks: unknown[]; [key: string]: unknown };
  /** Or a reference to a document held by a running editor service (read-only in v0). */
  service?: { baseUrl: string; documentId: string };
}

const MODES = ["view", "edit"] as const;
const DOCUMENT = "document must be a schemaVersion 1 report document with id, title and blocks.";
const SERVICE = "service needs an http(s) baseUrl and a documentId.";

export function validateEditorCardSpec(spec: unknown): CardValidationResult {
  const { issues, add } = collector();
  if (!isObject(spec)) {
    wrongType(add, "", spec, "Editor card spec must be an object.");
    return cardResult(issues);
  }
  oneOf(add, "kind", spec.kind, [EDITOR_CARD_KIND], `kind must be "${EDITOR_CARD_KIND}".`);
  if (spec.title !== undefined) str(add, "title", spec.title, "title must be a string.");
  if (spec.mode !== undefined) oneOf(add, "mode", spec.mode, MODES, 'mode must be "view" or "edit".');
  const hasDocument = spec.document !== undefined;
  const hasService = spec.service !== undefined;
  if (hasDocument === hasService) add("", "exclusive", "Provide exactly one of `document` or `service`.", "document: {...} | service: { baseUrl, documentId }");
  if (hasService && spec.mode === "edit") add("mode", "exclusive", "A service-backed document is read-only for now: use an inline document to edit.");
  if (hasDocument) {
    const d = spec.document;
    if (!isObject(d)) wrongType(add, "document", d, DOCUMENT);
    else {
      if (d.schemaVersion !== 1) add("document.schemaVersion", d.schemaVersion === undefined ? "required" : "enum", DOCUMENT);
      if (typeof d.id !== "string") wrongType(add, "document.id", d.id, DOCUMENT);
      if (typeof d.title !== "string") wrongType(add, "document.title", d.title, DOCUMENT);
      if (!Array.isArray(d.blocks)) wrongType(add, "document.blocks", d.blocks, DOCUMENT);
    }
  }
  if (hasService) {
    const v = spec.service;
    if (!isObject(v)) wrongType(add, "service", v, SERVICE);
    else {
      if (typeof v.baseUrl !== "string") wrongType(add, "service.baseUrl", v.baseUrl, SERVICE);
      else if (!isHttpUrl(v.baseUrl)) add("service.baseUrl", "format", SERVICE);
      text(add, "service.documentId", v.documentId, SERVICE);
    }
  }
  return cardResult(issues);
}

export const editorCardKind: CardKindDefinition = {
  kind: EDITOR_CARD_KIND,
  summary: "A research document the user can read and edit in place: headings, text, tables, charts and citations.",
  schema: {
    type: "object",
    required: ["kind"],
    properties: {
      kind: { const: EDITOR_CARD_KIND },
      title: { type: "string" },
      mode: { enum: ["view", "edit"] },
      document: { type: "object", description: "A schemaVersion 1 report document." },
      service: { type: "object", properties: { baseUrl: { type: "string" }, documentId: { type: "string" } }, required: ["baseUrl", "documentId"] },
    },
  },
  validate: validateEditorCardSpec,
};
