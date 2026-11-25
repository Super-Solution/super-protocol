// SPDX-License-Identifier: Apache-2.0

package protocol

import "strings"

// The small checks every validator in this package is built from: a validator reports every problem it finds
// through add(path, message), and these are the common shapes of one problem (a required text, a value from a
// list, a count), so the same words come out as in the TypeScript reference.

type checker struct{ issues []ManifestIssue }

func (c *checker) add(path, message string) {
	c.issues = append(c.issues, ManifestIssue{Path: path, Message: message})
}

func isCount(v any) bool  { return isInteger(v) && v.(float64) >= 0 }
func isAmount(v any) bool { return finite(v) && v.(float64) >= 0 }

func (c *checker) text(path string, v any) {
	if s, ok := asString(v); !ok || s == "" {
		c.add(path, "must be a non-empty string")
	}
}

func (c *checker) oneOf(path string, v any, allowed []string) {
	if s, ok := asString(v); !ok || !contains(allowed, s) {
		c.add(path, "must be one of "+strings.Join(allowed, ", "))
	}
}

func (c *checker) count(path string, v any) {
	if !isCount(v) {
		c.add(path, "must be a non-negative integer")
	}
}

func (c *checker) object(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
	}
}

func (c *checker) str(path string, v any) {
	if !isString(v) {
		c.add(path, "must be a string")
	}
}

func (c *checker) boolean(path string, v any) {
	if _, ok := v.(bool); !ok {
		c.add(path, "must be a boolean")
	}
}
