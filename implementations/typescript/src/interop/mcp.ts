/**
 * Conversions between this protocol's words and MCP's, for the same things (DRAFT: the interop modules are not stable;
 * see docs/INTEROP.md). Pure functions with no dependency on an MCP SDK; nothing here renames a field of either side, and
 * nothing is guessed: where a word has no counterpart the function says so (`null` or an absent field) instead of
 * choosing one.
 *
 * Written against MCP `2026-07-28` (tool annotations, elicitation) and MCP Apps `2026-01-26` (host context).
 */
import { pluginToolAuthority, type PluginToolAuthority } from "../chat.js";
import { isCardPlacement, type CardPlacement } from "../placement.js";
import type { RunCardActionType } from "../run.js";
import { THEME_TOKENS, readHostTheme, themeVariables, type HostTheme, type ThemeToken } from "../theme.js";
import { isRecord } from "./types.js";

// ---- tool authority <-> tool annotations ----------------------------------------------------------------------------------

/** The hints of an MCP tool that say what it does to its environment (`ToolAnnotations` in MCP's schema). */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * The annotations that say what a tool's authority says. `read` does not modify its environment; `draft` modifies it but
 * only additively (the result is something a person reviews, as in `PLUGIN_TOOL_PRESETS`); `act` may be destructive.
 *
 * A missing or unknown authority gives `{}`, which is not a claim: an MCP client reads absent hints as its defaults
 * (not read-only, destructive), the cautious reading. This never invents a `read` for a tool that did not declare one.
 * `destructiveHint` is left off `read`: MCP says it means something only when `readOnlyHint` is false.
 */
export function toolAnnotationsFromAuthority(authority: unknown): McpToolAnnotations {
  switch (pluginToolAuthority({ authority } as { authority?: PluginToolAuthority })) {
    case "read":
      return { readOnlyHint: true };
    case "draft":
      return { readOnlyHint: false, destructiveHint: false };
    case "act":
      return { readOnlyHint: false, destructiveHint: true };
    default:
      return {};
  }
}

export interface AuthorityFromAnnotationsOptions {
  /**
   * Whether the server the annotations came from is trusted. MCP says a client MUST treat tool annotations as untrusted
   * unless they come from a trusted server, so the default is `false`, and then the answer is always `null`. Whether a
   * server is trusted is the host's policy; this function does not know.
   */
  trusted?: boolean;
}

/**
 * The authority that annotations from a trusted server amount to, or `null`: always for an untrusted source, and for
 * annotations that do not say (no `readOnlyHint`, or one that is not a boolean). `readOnlyHint: true` is `read`; a tool
 * that is not read-only and says `destructiveHint: false` is `draft`; a tool that is not read-only and is destructive, by
 * hint or by MCP's default of `true`, is `act`. A tool with no authority is given no preset by a host, so `null` is safe.
 */
export function authorityFromAnnotations(annotations: unknown, options: AuthorityFromAnnotationsOptions = {}): PluginToolAuthority | null {
  if (options.trusted !== true || !isRecord(annotations)) return null;
  if (annotations.readOnlyHint === true) return "read";
  if (annotations.readOnlyHint !== false) return null;
  return annotations.destructiveHint === false ? "draft" : "act";
}

// ---- host theme <-> MCP Apps host context ---------------------------------------------------------------------------------

/**
 * The CSS variables MCP Apps standardizes for a host to pass in `hostContext.styles.variables` (`McpUiStyleVariableKey`,
 * MCP Apps 2026-01-26; the draft spec has the same 76). A host may pass any subset.
 */
export const MCP_APPS_STYLE_VARIABLES = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-background-inverse",
  "--color-background-ghost",
  "--color-background-info",
  "--color-background-danger",
  "--color-background-success",
  "--color-background-warning",
  "--color-background-disabled",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-inverse",
  "--color-text-info",
  "--color-text-danger",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-disabled",
  "--color-text-ghost",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-tertiary",
  "--color-border-inverse",
  "--color-border-ghost",
  "--color-border-info",
  "--color-border-danger",
  "--color-border-success",
  "--color-border-warning",
  "--color-border-disabled",
  "--color-ring-primary",
  "--color-ring-secondary",
  "--color-ring-inverse",
  "--color-ring-info",
  "--color-ring-danger",
  "--color-ring-success",
  "--color-ring-warning",
  "--font-sans",
  "--font-mono",
  "--font-weight-normal",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--font-text-xs-size",
  "--font-text-sm-size",
  "--font-text-md-size",
  "--font-text-lg-size",
  "--font-heading-xs-size",
  "--font-heading-sm-size",
  "--font-heading-md-size",
  "--font-heading-lg-size",
  "--font-heading-xl-size",
  "--font-heading-2xl-size",
  "--font-heading-3xl-size",
  "--font-text-xs-line-height",
  "--font-text-sm-line-height",
  "--font-text-md-line-height",
  "--font-text-lg-line-height",
  "--font-heading-xs-line-height",
  "--font-heading-sm-line-height",
  "--font-heading-md-line-height",
  "--font-heading-lg-line-height",
  "--font-heading-xl-line-height",
  "--font-heading-2xl-line-height",
  "--font-heading-3xl-line-height",
  "--border-radius-xs",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-xl",
  "--border-radius-full",
  "--border-width-regular",
  "--shadow-hairline",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
] as const;

export type McpAppsStyleVariable = (typeof MCP_APPS_STYLE_VARIABLES)[number];

export const isMcpAppsStyleVariable = (name: unknown): name is McpAppsStyleVariable => MCP_APPS_STYLE_VARIABLES.includes(name as McpAppsStyleVariable);

/**
 * Which MCP Apps variable each theme token is. Two tokens have none and are in no row: `accent` and `accent-contrast`
 * (MCP Apps has no brand colour; `--color-ring-*` is the focus ring and `--color-background-inverse` is not an accent).
 * `positive`, `negative`, `warning` and `info` are one colour each, so they become the text colour of that state
 * (`--color-text-success`, ...): MCP Apps also has background, border and ring colours for each state, which one token
 * cannot fill. `surface-raised` is `--color-background-tertiary`.
 */
export const MCP_APPS_VARIABLE_OF_TOKEN: Readonly<Partial<Record<ThemeToken, McpAppsStyleVariable>>> = {
  background: "--color-background-primary",
  surface: "--color-background-secondary",
  "surface-raised": "--color-background-tertiary",
  border: "--color-border-primary",
  text: "--color-text-primary",
  "text-muted": "--color-text-secondary",
  positive: "--color-text-success",
  negative: "--color-text-danger",
  warning: "--color-text-warning",
  info: "--color-text-info",
  "font-sans": "--font-sans",
  "font-mono": "--font-mono",
  radius: "--border-radius-md",
};

/** The part of MCP Apps' `HostContext` that carries the theme. */
export interface McpAppsThemeContext {
  theme: "light" | "dark";
  styles: { variables: Partial<Record<McpAppsStyleVariable, string>> };
}

/**
 * The theme as MCP Apps' host context: `theme` is the mode and `styles.variables` has one variable for each token that
 * has one and a safe value (`themeVariables` leaves out an unsafe value). A token with no variable is left out (see
 * `MCP_APPS_VARIABLE_OF_TOKEN`). A value is passed as it is: MCP Apps asks hosts to use `light-dark()` where a value
 * depends on the mode, and a theme's value is already for its own mode.
 */
export function hostThemeToMcpAppsContext(theme: HostTheme): McpAppsThemeContext {
  const own = themeVariables(theme);
  const variables: Partial<Record<McpAppsStyleVariable, string>> = {};
  for (const token of THEME_TOKENS) {
    const variable = MCP_APPS_VARIABLE_OF_TOKEN[token];
    const value = own[`--super-${token}`];
    if (variable !== undefined && value !== undefined) variables[variable] = value;
  }
  return { theme: theme.mode, styles: { variables } };
}

/**
 * A theme from an MCP Apps host context, which is untrusted input: the variables that map to a token and hold a safe value
 * are read, every other variable and every unsafe value is dropped one by one, so a bad value costs that token and never
 * the theme. `null` when `theme` is not `light` or `dark`. Variables that no token maps to are not read.
 */
export function hostThemeFromMcpAppsContext(context: unknown): HostTheme | null {
  if (!isRecord(context)) return null;
  const variables = isRecord(context.styles) && isRecord(context.styles.variables) ? context.styles.variables : {};
  const tokens: Record<string, unknown> = {};
  for (const token of THEME_TOKENS) {
    const variable = MCP_APPS_VARIABLE_OF_TOKEN[token];
    if (variable !== undefined && Object.hasOwn(variables, variable)) tokens[token] = variables[variable];
  }
  return readHostTheme({ mode: context.theme, tokens });
}

// ---- placement <-> display mode -------------------------------------------------------------------------------------------

/** How an MCP Apps view is shown (`McpUiDisplayMode`). */
export type McpAppsDisplayMode = "inline" | "fullscreen" | "pip";

/**
 * The display mode of a placement. `inline` is `inline`. A `panel` is beside the conversation: which of `fullscreen` and
 * `pip` that is the host's choice, so the caller says (`panelAs`); there is no default. A `document` has none, because
 * MCP Apps has no place inside a document: `null`, as for anything that is not a placement.
 */
export function placementToDisplayMode(placement: unknown, panelAs: "fullscreen" | "pip"): McpAppsDisplayMode | null {
  if (!isCardPlacement(placement)) return null;
  if (placement === "inline") return "inline";
  return placement === "panel" ? panelAs : null;
}

/** The placement of a display mode: `inline` is `inline`, `fullscreen` and `pip` are a `panel`. `null` for anything else. */
export function displayModeToPlacement(mode: unknown): CardPlacement | null {
  if (mode === "inline") return "inline";
  return mode === "fullscreen" || mode === "pip" ? "panel" : null;
}

// ---- card response <-> elicitation action ---------------------------------------------------------------------------------

/** What a person did with an elicitation request (`ElicitResult.action`). */
export type McpElicitationAction = "accept" | "decline" | "cancel";

/**
 * The elicitation action of what a person did with a card. `submit`, `select` and `confirm` give an answer, so `accept`.
 * `cancel` and `dismiss` are leaving without one, so `cancel` (MCP: "dismissed without making an explicit choice").
 * Nothing here is `decline`, MCP's explicit refusal: this protocol has no action for it (today a refusal is a `cancel` on
 * a confirm card), so the function never returns it. `null` for a word that is not a response type.
 */
export function cardResponseToElicitationAction(type: unknown): McpElicitationAction | null {
  switch (type as RunCardActionType) {
    case "submit":
    case "select":
    case "confirm":
      return "accept";
    case "cancel":
    case "dismiss":
      return "cancel";
    default:
      return null;
  }
}
