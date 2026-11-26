// SPDX-License-Identifier: Apache-2.0

package protocol

import "unicode/utf8"

// What a validator says about a value it refuses: where (Path), what kind of problem (Code), a sentence for a person
// or a model (Message) and, sometimes, how to fix it (Hint). Code is the contract: a small closed set that is the same
// in every language, so a program can branch on it. Message is for reading and is pinned by the conformance data byte
// for byte; do not parse it. docs/ISSUES.md says when each code is used.

// The vocabulary of Issue.Code. Adding one is a protocol change.
const (
	CodeRequired  = "required"
	CodeType      = "type"
	CodeEmpty     = "empty"
	CodeEnum      = "enum"
	CodeRange     = "range"
	CodeLength    = "length"
	CodeLimit     = "limit"
	CodeFormat    = "format"
	CodeUnique    = "unique"
	CodeExclusive = "exclusive"
	CodeOrder     = "order"
	CodeReference = "reference"
	CodeShape     = "shape"
)

// IssueCodes is every code, in the order of the reference's ISSUE_CODES.
var IssueCodes = []string{
	CodeRequired, CodeType, CodeEmpty, CodeEnum, CodeRange, CodeLength, CodeLimit, CodeFormat, CodeUnique,
	CodeExclusive, CodeOrder, CodeReference, CodeShape,
}

// Issue is one problem found in a value. Hint is left out of the JSON when there is none.
type Issue struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

// ManifestIssue is the name this package used before issues carried a code; it is the same type.
type ManifestIssue = Issue

// undefinedValue stands for a key that is not there. The reference tells `undefined` from `null`: an absent value is
// "required", a null of the wrong type is "type".
type undefinedValue struct{}

var undefined any = undefinedValue{}

func isUndefined(v any) bool { _, ok := v.(undefinedValue); return ok }

// field is `obj[key]`: undefined when obj has no such key.
func field(obj any, key string) any {
	if v, present := get(obj, key); present {
		return v
	}
	return undefined
}

// jsonType is the JSON type of a value as a person would name it.
func jsonType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	}
	return "undefined"
}

// editDistance is the edit distance between two strings, counted in code points.
func editDistance(a, b string) int {
	x, y := []rune(a), []rune(b)
	row := make([]int, len(y)+1)
	for j := range row {
		row[j] = j
	}
	for i := 1; i <= len(x); i++ {
		next := make([]int, len(y)+1)
		next[0] = i
		for j := 1; j <= len(y); j++ {
			cost := 1
			if x[i-1] == y[j-1] {
				cost = 0
			}
			next[j] = min(row[j]+1, next[j-1]+1, row[j-1]+cost)
		}
		row = next
	}
	return row[len(y)]
}

// DidYouMean is the hint of an enum issue: `did you mean "x"?` for a string that is within two edits of one of
// allowed (the first of equally close ones), or "" when value is not a string or nothing is close.
func DidYouMean(value any, allowed []string) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	best, bestDistance := "", 3
	for _, candidate := range allowed {
		if d := utf8.RuneCountInString(candidate) - utf8.RuneCountInString(s); d > 2 || d < -2 {
			continue
		}
		if d := editDistance(s, candidate); d < bestDistance {
			best, bestDistance = candidate, d
		}
	}
	if bestDistance > 2 {
		return ""
	}
	return `did you mean "` + best + `"?`
}
