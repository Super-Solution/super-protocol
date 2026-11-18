/**
 * The host theme contract. A host describes its colours and fonts once with
 * these tokens; each plugin maps them onto its own variables, so a card follows
 * the host without either side knowing the other's CSS.
 *
 * The variables use the `--super-` prefix on purpose: `--sc-` already means
 * different things in Super Chat and Super Chart.
 */

export const THEME_TOKENS = [
  "background",
  "surface",
  "surface-raised",
  "border",
  "text",
  "text-muted",
  "accent",
  "accent-contrast",
  "positive",
  "negative",
  "warning",
  "info",
  "font-sans",
  "font-mono",
  "radius",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export type ThemeTokens = Partial<Record<ThemeToken, string>>;

export interface HostTheme {
  mode: "light" | "dark";
  /** Any subset; a plugin keeps its own default for a token that is absent. */
  tokens: ThemeTokens;
}

export const THEME_VALUE_MAX_LENGTH = 256;

/** The CSS custom property of a token, for example `--super-text-muted`. */
export const themeTokenVariable = (token: ThemeToken): `--super-${ThemeToken}` => `--super-${token}`;

// Rejects what could end a declaration or fetch a resource; the value is otherwise the host's own CSS.
const UNSAFE_VALUE = /[;{}<>\\]|\/\*|url\s*\(|expression\s*\(|@import/i;

/** Whether a string may be used as a token value. */
export function isThemeValue(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= THEME_VALUE_MAX_LENGTH && !UNSAFE_VALUE.test(value);
}

/**
 * Reads an untrusted theme. Unknown tokens and unsafe values are dropped one by
 * one, so a bad value costs that token and never the card. Returns null when
 * the mode is not `light` or `dark`.
 */
export function readHostTheme(value: unknown): HostTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, tokens } = value as { mode?: unknown; tokens?: unknown };
  if (mode !== "light" && mode !== "dark") return null;
  const out: ThemeTokens = {};
  if (typeof tokens === "object" && tokens !== null) {
    for (const token of THEME_TOKENS) {
      const candidate = (tokens as Record<string, unknown>)[token];
      if (isThemeValue(candidate)) out[token] = candidate.trim();
    }
  }
  return { mode, tokens: out };
}

/** The theme as CSS custom properties: `{ "--super-text": "#111" }`. Unsafe values are left out. */
export function themeVariables(theme: HostTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = theme.tokens[token];
    if (isThemeValue(value)) out[themeTokenVariable(token)] = value.trim();
  }
  return out;
}
