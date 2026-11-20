/**
 * The chat-plugin contract. A host (super-chat, or any other chat UI) loads a
 * `ChatPlugin` without knowing which framework, license or vendor is behind it.
 * Rendering is framework-neutral: a plugin mounts into a DOM element, and each
 * host adapts that to React, Vue, Svelte, and so on.
 */
import { validatePluginManifest, type ManifestIssue, type PluginManifest } from "./plugin.js";
import type { HostTheme } from "./theme.js";

/**
 * `error` and `expected` are written for the model (so it can send a corrected
 * spec) and for developer logs. A host never shows them to the user.
 */
export type CardValidationResult = { ok: true } | { ok: false; error: string; expected?: string };

/** Structurally identical to super-chat's `CardKindDefinition`, so a host can register it as is. */
export interface CardKindDefinition {
  kind: string;
  /** One line shown to the model when it chooses a card kind. */
  summary: string;
  /** JSON Schema of the spec the model may send. */
  schema: Record<string, unknown>;
  validate(spec: unknown): CardValidationResult;
  /** Interactive cards ask the user something and must render at top level. */
  interactive?: boolean;
}

/** What the user did with an interactive card; the host turns it into the tool result. */
export interface CardResponse {
  type: "submit" | "select" | "confirm" | "cancel" | "dismiss";
  /** Selected option ids, form values, or nothing for confirm/cancel. */
  value?: unknown;
}

export interface CardMountContext {
  theme: "light" | "dark";
  /** The host's colours and fonts. Absent on hosts that only report light or dark. */
  hostTheme?: HostTheme;
  locale?: string;
  /** The spec is still streaming in: valid, but more is coming. */
  partial?: boolean;
  /** Present for interactive cards: report what the user did. */
  respond?: (action: CardResponse) => void;
}

export interface CardMountHandle {
  update(spec: unknown, context: CardMountContext): void;
  destroy(): void;
}

/**
 * Mounts one card into `container`. Must not touch anything outside it.
 * Whatever lands in `container` is seen by the user: when the spec cannot be
 * drawn, show a plain sentence there and send the technical reason to the
 * developer log, never into the container. A host that catches a throwing
 * mount logs the error and shows its own plain fallback, not the error text.
 */
export type CardMount = (container: HTMLElement, spec: unknown, context: CardMountContext) => CardMountHandle;

/**
 * What running a tool can do, which decides who may be offered it:
 * - `read` changes nothing.
 * - `draft` produces or marks up something the user reviews; nothing leaves the card or document in front of them.
 * - `act` changes or removes existing state on the user's behalf.
 */
export type PluginToolAuthority = "read" | "draft" | "act";

export const PLUGIN_TOOL_AUTHORITIES: readonly PluginToolAuthority[] = ["read", "draft", "act"];

/** The capability presets that grant each authority. A preset not listed here grants nothing. */
export const PLUGIN_TOOL_PRESETS: Readonly<Record<PluginToolAuthority, readonly string[]>> = {
  read: ["observer", "draft", "executor"],
  draft: ["draft", "executor"],
  act: ["executor"],
};

export interface PluginToolRunContext {
  signal?: AbortSignal;
  /** True only when the host asked the user about this exact call and the user agreed. */
  confirmed?: boolean;
}

export interface PluginTool {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
  /**
   * Required for a host to offer the tool. A tool with a missing or unknown
   * authority stays out of every preset: authority is never assumed.
   */
  authority?: PluginToolAuthority;
  /** The host must get the user's agreement before each run and then pass `confirmed: true`. */
  confirm?: boolean;
  run(input: unknown, context: PluginToolRunContext): Promise<unknown>;
}

/** The tool's declared authority, or null when it is missing or not one this protocol version knows. */
export function pluginToolAuthority(tool: Pick<PluginTool, "authority">): PluginToolAuthority | null {
  const value: unknown = tool?.authority;
  return PLUGIN_TOOL_AUTHORITIES.includes(value as PluginToolAuthority) ? (value as PluginToolAuthority) : null;
}

export interface ChatPlugin {
  manifest: PluginManifest;
  cardKinds?: CardKindDefinition[];
  /** Mount functions keyed by card kind. */
  mounts?: Record<string, CardMount>;
  tools?: PluginTool[];
}

/** Checks the manifest and that every declared capability is actually implemented. */
export function validateChatPlugin(plugin: ChatPlugin): ManifestIssue[] {
  const issues = validatePluginManifest(plugin?.manifest);
  if (issues.length) return issues;
  const add = (path: string, message: string) => issues.push({ path, message });
  const kinds = new Set((plugin.cardKinds ?? []).map((k) => k.kind));
  const tools = new Set((plugin.tools ?? []).map((t) => t.name));
  plugin.manifest.capabilities.forEach((cap, i) => {
    const p = `capabilities[${i}]`;
    if (cap.surface === "card") {
      if (!kinds.has(cap.cardKind!)) add(`${p}.cardKind`, `plugin does not define card kind "${cap.cardKind}"`);
      if (typeof plugin.mounts?.[cap.cardKind!] !== "function") add(`${p}.cardKind`, `plugin has no mount for card kind "${cap.cardKind}"`);
    }
    if (cap.surface === "tool" && !tools.has(cap.toolName!)) add(`${p}.toolName`, `plugin does not define tool "${cap.toolName}"`);
  });
  (plugin.tools ?? []).forEach((tool, i) => {
    // A missing authority is allowed here so older plugins still load; hosts keep such a tool out of every preset.
    if (tool.authority !== undefined && pluginToolAuthority(tool) === null) add(`tools[${i}].authority`, `must be one of ${PLUGIN_TOOL_AUTHORITIES.join(", ")}`);
    if (tool.confirm !== undefined && typeof tool.confirm !== "boolean") add(`tools[${i}].confirm`, "must be a boolean");
  });
  return issues;
}
