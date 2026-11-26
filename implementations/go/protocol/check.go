// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"regexp"
	"strings"
)

// The small checks every validator in this package is built from: a validator reports every problem it finds
// through add(path, code, message), and these are the common shapes of one problem (a required text, a value from a
// list, a count), so the same words and the same codes come out as in the TypeScript reference.
//
// A value that is absent is "required"; one of the wrong JSON type is "type" (with a hint saying what it was); the
// right type but not acceptable is the code that says why ("empty", "enum", "range", ...).

type checker struct{ issues []Issue }

func newChecker() *checker { return &checker{issues: []Issue{}} }

func (c *checker) add(path, code, message string) {
	c.issues = append(c.issues, Issue{Path: path, Code: code, Message: message})
}

func (c *checker) addHint(path, code, message, hint string) {
	c.issues = append(c.issues, Issue{Path: path, Code: code, Message: message, Hint: hint})
}

func isCount(v any) bool  { return isInteger(v) && v.(float64) >= 0 }
func isAmount(v any) bool { return finite(v) && v.(float64) >= 0 }

// wrongType is "required" when v is absent, otherwise "type" with what was received.
func (c *checker) wrongType(path string, v any, message string) {
	if isUndefined(v) {
		c.add(path, CodeRequired, message)
	} else {
		c.addHint(path, CodeType, message, "got "+jsonType(v))
	}
}

func (c *checker) text(path string, v any) { c.textMsg(path, v, "must be a non-empty string") }

func (c *checker) textMsg(path string, v any, message string) {
	if s, ok := asString(v); !ok {
		c.wrongType(path, v, message)
	} else if s == "" {
		c.add(path, CodeEmpty, message)
	}
}

// filled is textMsg where a string of only whitespace is empty too.
func (c *checker) filled(path string, v any, message string) {
	if s, ok := asString(v); !ok {
		c.wrongType(path, v, message)
	} else if trim(s) == "" {
		c.add(path, CodeEmpty, message)
	}
}

func (c *checker) oneOf(path string, v any, allowed []string) {
	c.oneOfMsg(path, v, allowed, "must be one of "+strings.Join(allowed, ", "))
}

func (c *checker) oneOfMsg(path string, v any, allowed []string, message string) {
	if s, ok := asString(v); ok && contains(allowed, s) {
		return
	}
	if isUndefined(v) {
		c.add(path, CodeRequired, message)
	} else if hint := DidYouMean(v, allowed); hint != "" {
		c.addHint(path, CodeEnum, message, hint)
	} else {
		c.add(path, CodeEnum, message)
	}
}

func (c *checker) count(path string, v any) {
	message := "must be a non-negative integer"
	if _, ok := v.(float64); !ok {
		c.wrongType(path, v, message)
	} else if !isCount(v) {
		c.add(path, CodeRange, message)
	}
}

func (c *checker) amount(path string, v any) {
	message := "must be a non-negative number"
	if _, ok := v.(float64); !ok {
		c.wrongType(path, v, message)
	} else if !isAmount(v) {
		c.add(path, CodeRange, message)
	}
}

// finiteNumber is a finite number: "type" for anything that is not a number, "range" for one that is not finite.
func (c *checker) finiteNumber(path string, v any, message string) {
	if _, ok := v.(float64); !ok {
		c.wrongType(path, v, message)
	} else if !finite(v) {
		c.add(path, CodeRange, message)
	}
}

// finiteBetween is a finite number inside [lo, hi]: "type" for a non-number, "range" for one outside.
func (c *checker) finiteBetween(path string, v any, lo, hi float64, message string) {
	if _, ok := v.(float64); !ok {
		c.wrongType(path, v, message)
	} else if !(finite(v) && v.(float64) >= lo && v.(float64) <= hi) {
		c.add(path, CodeRange, message)
	}
}

// short is a string of at most limit UTF-16 units: "type", else "length".
func (c *checker) short(path string, v any, limit int, message string) {
	if s, ok := asString(v); !ok {
		c.wrongType(path, v, message)
	} else if jsLength(s) > limit {
		c.add(path, CodeLength, message)
	}
}

// pattern is a string that matches re: "type" for a non-string, "format" for one that does not match.
func (c *checker) pattern(path string, v any, re *regexp.Regexp, message string) {
	if s, ok := asString(v); !ok {
		c.wrongType(path, v, message)
	} else if !re.MatchString(s) {
		c.add(path, CodeFormat, message)
	}
}

func (c *checker) object(path string, v any) { c.objectMsg(path, v, "must be an object") }

func (c *checker) objectMsg(path string, v any, message string) {
	if !isObject(v) {
		c.wrongType(path, v, message)
	}
}

func (c *checker) str(path string, v any) { c.strMsg(path, v, "must be a string") }

func (c *checker) strMsg(path string, v any, message string) {
	if !isString(v) {
		c.wrongType(path, v, message)
	}
}

func (c *checker) boolean(path string, v any) {
	if _, ok := v.(bool); !ok {
		c.wrongType(path, v, "must be a boolean")
	}
}

// cardResult is the result a card validator returns for the issues it collected: valid when there are none.
// Error is the first message; Expected is its hint when the code is "required" or "exclusive" (a sample of a valid value).
func cardResult(issues []Issue) CardResult {
	if len(issues) == 0 {
		return CardResult{OK: true}
	}
	first := issues[0]
	result := CardResult{Error: first.Message, Issues: issues}
	if first.Code == CodeRequired || first.Code == CodeExclusive {
		result.Expected = first.Hint
	}
	return result
}
