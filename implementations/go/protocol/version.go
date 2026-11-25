// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"regexp"
	"strconv"
)

// Which version of the protocol a piece of data was written against, and which features this build knows (see
// version.ts in the TypeScript reference and docs/VERSIONING.md). A protocol version is "major.minor": two plain
// numbers with no sign, no leading zero and at most nine digits each.

// ProtocolVersion is the protocol version this port implements.
const ProtocolVersion = "0.5"

// ProtocolFeatures is what this port implements, one "name@major.minor" per feature, where the version is the protocol
// version the feature first appeared in.
var ProtocolFeatures = []string{"tools@0.2", "theme@0.2", "ref@0.3", "plot@0.3", "run@0.4", "placement@0.4", "issues@0.5", "mapping@0.5"}

var (
	protocolVersionRe = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	featureRe         = regexp.MustCompile(`^([a-z][a-z0-9-]*)@(.+)$`)
)

const protocolMessage = "must be a protocol version such as 0.5"

// ParseProtocolVersion is the major and minor of a protocol version; ok is false when v is not one, including anything
// that is not a string.
func ParseProtocolVersion(v any) (major, minor int, ok bool) {
	s, isStr := asString(v)
	if !isStr {
		return 0, 0, false
	}
	m := protocolVersionRe.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, false
	}
	major, _ = strconv.Atoi(m[1])
	minor, _ = strconv.Atoi(m[2])
	return major, minor, true
}

// CompareProtocolVersions is -1, 0 or 1 as a is older than, the same as or newer than b; ok is false when either is not
// a protocol version.
func CompareProtocolVersions(a, b any) (order int, ok bool) {
	aMajor, aMinor, aOK := ParseProtocolVersion(a)
	bMajor, bMinor, bOK := ParseProtocolVersion(b)
	if !aOK || !bOK {
		return 0, false
	}
	switch {
	case aMajor != bMajor:
		order = 1
		if aMajor < bMajor {
			order = -1
		}
	case aMinor != bMinor:
		order = 1
		if aMinor < bMinor {
			order = -1
		}
	}
	return order, true
}

// ParseProtocolFeature is the name and version of a feature such as "run@0.4"; ok is false when v is not one.
func ParseProtocolFeature(v any) (name string, major, minor int, ok bool) {
	s, isStr := asString(v)
	if !isStr {
		return "", 0, 0, false
	}
	m := featureRe.FindStringSubmatch(s)
	if m == nil {
		return "", 0, 0, false
	}
	major, minor, ok = ParseProtocolVersion(m[2])
	if !ok {
		return "", 0, 0, false
	}
	return m[1], major, minor, true
}
