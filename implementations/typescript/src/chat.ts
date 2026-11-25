/**
 * The chat-plugin contract. A host (super-chat, or any other chat UI) loads a
 * `ChatPlugin` without knowing which framework, license or vendor is behind it.
 * Rendering is framework-neutral: a plugin mounts into a DOM element, and each
 * host adapts that to React, Vue, Svelte, and so on.
 */
import { bool, oneOf } from "./check.js";
import { adder, type Issue } from "./issue.js";
import { validatePluginManifest, type PluginManifest } from "./plugin.js";
import type { CardRef, CardRefEvent, CardRefResult } from "./ref.js";
import type { HostTheme } from "./theme.js";
import type { CardPlacement } from "./placement.js";

/**
 * `error` and `expected` are written for the model (so it can send a corrected
 * spec) and for developer logs. A host never shows them to the user.
 *
 * `issues` is every problem found, in the order the validator checks; `error` is the message of the first one and
 * `expected` its example when it has one (a `required` or `exclusive` issue whose `hint` is a sample of a valid
 * value). Optional so a validator written before issues existed still fits: read `error` when `issues` is absent.
 */
export type CardValidationResult = { ok: true } | { ok: false; error: string; expected?: string; issues?: Issue[] };

/** The result a card validator returns for the issues it collected: valid when there are none. */
export function cardResult(issues: Issue[]): CardValidationResult {
  const first = issues[0];
  if (first === undefined) return { ok: true };
  const example = (first.code === "required" || first.code === "exclusive") && first.hint !== undefined ? { expected: first.hint } : {};
  return { ok: false, error: first.message, ...example, issues };
}

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
  /**
   * Where the card is shown (see `placement.ts`). Absent from a host that predates placements,
   * which shows every card inline. A mount adapts its chrome to it and never refuses a placement.
   */
  placement?: CardPlacement;
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
  /**
   * Optional. Text in the conversation points into this card (see `ref.ts`). `enter` and `leave` are the reader
   * hovering or focusing the link: show and clear a highlight, and change nothing else. `activate` is a click, Enter
   * or tap: bring the part into view and move focus to it. `null` clears every highlight. Answer `ok: false` with a
   * code and reason when nothing in the card matches, so the host can show the link as plain text.
   */
  ref?(ref: CardRef | null, event: CardRefEvent): CardRefResult;
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
  /**
   * A `panel` capability with a `cardKind` says that kind is made for the host's side panel (a
   * document editor, a chart workspace): a host may open it there by default. The same mount draws it.
   */
  manifest: PluginManifest;
  cardKinds?: CardKindDefinition[];
  /** Mount functions keyed by card kind. */
  mounts?: Record<string, CardMount>;
  tools?: PluginTool[];
}

/** Checks the manifest and that every declared capability is actually implemented. */
export function validateChatPlugin(plugin: ChatPlugin): Issue[] {
  const issues = validatePluginManifest(plugin?.manifest);
  if (issues.length) return issues;
  const add = adder(issues);
  const kinds = new Set((plugin.cardKinds ?? []).map((k) => k.kind));
  const tools = new Set((plugin.tools ?? []).map((t) => t.name));
  plugin.manifest.capabilities.forEach((cap, i) => {
    const p = `capabilities[${i}]`;
    if (cap.surface === "card") {
      if (!kinds.has(cap.cardKind!)) add(`${p}.cardKind`, "reference", `plugin does not define card kind "${cap.cardKind}"`);
      if (typeof plugin.mounts?.[cap.cardKind!] !== "function") add(`${p}.cardKind`, "reference", `plugin has no mount for card kind "${cap.cardKind}"`);
    }
    if (cap.surface === "panel" && cap.cardKind !== undefined) {
      if (!kinds.has(cap.cardKind)) add(`${p}.cardKind`, "reference", `plugin does not define card kind "${cap.cardKind}"`);
      if (typeof plugin.mounts?.[cap.cardKind] !== "function") add(`${p}.cardKind`, "reference", `plugin has no mount for card kind "${cap.cardKind}"`);
    }
    if (cap.surface === "tool" && !tools.has(cap.toolName!)) add(`${p}.toolName`, "reference", `plugin does not define tool "${cap.toolName}"`);
  });
  (plugin.tools ?? []).forEach((tool, i) => {
    // A missing authority is allowed here so older plugins still load; hosts keep such a tool out of every preset.
    if (tool.authority !== undefined && pluginToolAuthority(tool) === null) oneOf(add, `tools[${i}].authority`, tool.authority, PLUGIN_TOOL_AUTHORITIES);
    if (tool.confirm !== undefined) bool(add, `tools[${i}].confirm`, tool.confirm);
  });
  return issues;
}

/** The card kinds a plugin declared for the side panel (its `panel` capabilities that name one). */
export function panelCardKinds(plugin: Pick<ChatPlugin, "manifest">): string[] {
  const kinds: string[] = [];
  for (const cap of plugin?.manifest?.capabilities ?? []) {
    if (cap.surface === "panel" && typeof cap.cardKind === "string" && cap.cardKind !== "" && !kinds.includes(cap.cardKind)) kinds.push(cap.cardKind);
  }
  return kinds;
}
