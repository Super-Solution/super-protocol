/**
 * Plugin manifest v0 — what a super-chat plugin (editor, chart, ...) declares
 * so a host can load it without depending on the plugin's package or license.
 * Apache-2.0 on purpose: a host licensed under Apache-2.0 may import this
 * package, while the plugin itself may be GPL/AGPL or commercial.
 */

import { filled, isHttpUrl, isObject, obj, oneOf, pattern, text, wrongType } from "./check.js";
import { collector, jsonType, type Issue } from "./issue.js";
import { PROTOCOL_VERSION_PATTERN } from "./version.js";

export const PLUGIN_MANIFEST_VERSION = 0 as const;

export type PluginSurface = "card" | "panel" | "tool" | "canvas";

export interface PluginCapability {
  /** Stable id, namespaced by plugin, e.g. "editor.document". */
  id: string;
  surface: PluginSurface;
  /**
   * For `card` capabilities (required): the card `kind` the host routes to this plugin. For `panel`
   * capabilities (optional): the card kind made for the side panel, drawn by the same mount.
   */
  cardKind?: string;
  /** For `tool` capabilities: the tool name offered to the model. */
  toolName?: string;
  /** JSON Schema for the data the host passes to the plugin. Opaque to the protocol. */
  inputSchema?: Record<string, unknown>;
}

export interface PluginManifest {
  manifestVersion: typeof PLUGIN_MANIFEST_VERSION;
  /** npm-style name, e.g. "@supersolutions/super-editor-chat-plugin". */
  name: string;
  version: string;
  /** SPDX expression of the plugin itself, e.g. "GPL-3.0-or-later". */
  license: string;
  capabilities: PluginCapability[];
  /** Where the plugin's own backend lives; absent for purely client-side plugins. */
  service?: { baseUrl: string };
  /** The protocol version (`major.minor`, see `version.ts`) the plugin was written against. Optional. */
  protocol?: string;
}

export interface ManifestIssue {
  path: string;
  message: string;
}

const NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PROTOCOL_MESSAGE = "must be a protocol version such as 0.5";
const SURFACES: readonly string[] = ["card", "panel", "tool", "canvas"];

/** Returns every problem found; an empty array means the manifest is valid. */
export function validatePluginManifest(value: unknown): Issue[] {
  const { issues, add } = collector();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    wrongType(add, "", value, "manifest must be an object");
    return issues;
  }
  const m = value as Record<string, unknown>;
  if (m.manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    if (m.manifestVersion === undefined) add("manifestVersion", "required", `must be ${PLUGIN_MANIFEST_VERSION}`);
    else add("manifestVersion", "enum", `must be ${PLUGIN_MANIFEST_VERSION}`);
  }
  pattern(add, "name", m.name, NAME, "must be a valid npm package name");
  pattern(add, "version", m.version, SEMVER, "must be a semver string");
  filled(add, "license", m.license, "must be a non-empty SPDX expression");
  if (m.protocol !== undefined) pattern(add, "protocol", m.protocol, PROTOCOL_VERSION_PATTERN, PROTOCOL_MESSAGE);
  if (!Array.isArray(m.capabilities)) wrongType(add, "capabilities", m.capabilities, "must be a non-empty array");
  else if (m.capabilities.length === 0) add("capabilities", "empty", "must be a non-empty array");
  else {
    const seen = new Set<string>();
    m.capabilities.forEach((c: unknown, i) => {
      const p = `capabilities[${i}]`;
      if (typeof c !== "object" || c === null) return wrongType(add, p, c, "must be an object");
      const cap = c as Record<string, unknown>;
      if (typeof cap.id !== "string" || !CAPABILITY_ID.test(cap.id)) pattern(add, `${p}.id`, cap.id, CAPABILITY_ID, "must be a dotted lowercase id such as editor.document");
      else if (seen.has(cap.id)) add(`${p}.id`, "unique", "duplicate capability id");
      else seen.add(cap.id);
      oneOf(add, `${p}.surface`, cap.surface, SURFACES, `must be one of ${SURFACES.join(", ")}`);
      if (cap.surface === "card") text(add, `${p}.cardKind`, cap.cardKind, "is required for card capabilities");
      if (cap.surface === "panel" && cap.cardKind !== undefined) text(add, `${p}.cardKind`, cap.cardKind, "must be a non-empty card kind when given");
      if (cap.surface === "tool") text(add, `${p}.toolName`, cap.toolName, "is required for tool capabilities");
      if (cap.inputSchema !== undefined) obj(add, `${p}.inputSchema`, cap.inputSchema);
    });
  }
  if (m.service !== undefined) {
    const s = m.service;
    const message = "must be an http(s) URL";
    if (!isObject(s)) add("service.baseUrl", "type", message, `got ${jsonType(s)}`);
    else if (typeof s.baseUrl !== "string") wrongType(add, "service.baseUrl", s.baseUrl, message);
    else if (!isHttpUrl(s.baseUrl)) add("service.baseUrl", "format", message);
  }
  return issues;
}
