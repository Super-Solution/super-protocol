// SPDX-License-Identifier: Apache-2.0

package protocol

import "regexp"

// ThemeTokens are the colour and font tokens a host may pass to plugin cards, in the order the reference lists them.
var ThemeTokens = []string{
	"background", "surface", "surface-raised", "border", "text", "text-muted", "accent", "accent-contrast",
	"positive", "negative", "warning", "info", "font-sans", "font-mono", "radius",
}

// ThemeValueMaxLength is the longest token value, in UTF-16 code units.
const ThemeValueMaxLength = 256

// HostTheme is a host's mode and the tokens it set.
type HostTheme struct {
	Mode   string            `json:"mode"`
	Tokens map[string]string `json:"tokens"`
}

// unsafeThemeValue rejects what could end a CSS declaration or fetch a resource. The pattern spells out the
// letters of url, expression and import in both cases and the whitespace of JavaScript's \s, because Go's (?i)
// folds more characters than JavaScript's /i does (U+017F folds to s) and Go's \s is narrower.
var unsafeThemeValue = regexp.MustCompile(`[;{}<>\\]|/\*|[uU][rR][lL][` + regexp.QuoteMeta(jsWhitespace) + `]*\(|[eE][xX][pP][rR][eE][sS][sS][iI][oO][nN][` + regexp.QuoteMeta(jsWhitespace) + `]*\(|@[iI][mM][pP][oO][rR][tT]`)

// IsThemeValue reports whether a value may be used as a token value.
func IsThemeValue(v any) bool {
	s, ok := asString(v)
	return ok && trim(s) != "" && jsLength(s) <= ThemeValueMaxLength && !unsafeThemeValue.MatchString(s)
}

// ReadHostTheme reads an untrusted theme. Unknown tokens and unsafe values are dropped one by one, so a bad value
// costs that token and never the card. It returns nil when the mode is not "light" or "dark".
func ReadHostTheme(value any) *HostTheme {
	mode, _ := get(value, "mode")
	if mode != "light" && mode != "dark" {
		return nil
	}
	theme := &HostTheme{Mode: mode.(string), Tokens: map[string]string{}}
	tokens, _ := get(value, "tokens")
	for _, token := range ThemeTokens {
		if candidate, _ := get(tokens, token); IsThemeValue(candidate) {
			theme.Tokens[token] = trim(candidate.(string))
		}
	}
	return theme
}

// ThemeVariables is the theme as CSS custom properties: {"--super-text": "#111"}. Unsafe values are left out.
func ThemeVariables(theme HostTheme) map[string]string {
	out := map[string]string{}
	for _, token := range ThemeTokens {
		if v, ok := theme.Tokens[token]; ok && IsThemeValue(v) {
			out["--super-"+token] = trim(v)
		}
	}
	return out
}
