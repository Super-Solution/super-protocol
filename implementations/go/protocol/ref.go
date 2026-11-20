// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Card references: `ref:<target>?<name>=<value>&...`, the link a chat message uses to point into a card.
// Port of ref.ts; the limits and every message match the TypeScript reference.

const (
	CardRefScheme      = "ref"
	maxRefLength       = 512
	maxRefNames        = 16
	maxRefValues       = 32
	maxRefValueLength  = 256
	maxChartRefKeySize = 128
)

var (
	refTargetRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	refNameRe     = regexp.MustCompile(`^[a-z][A-Za-z0-9_-]{0,31}$`)
	refRawValueRe = regexp.MustCompile(`^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$`)
	decimalRe     = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?$`)
)

// CardRef is a parsed reference. A param repeated in the link is a list, in order.
type CardRef struct {
	Target string              `json:"target"`
	Params map[string][]string `json:"params"`
}

// CardRefParse is the outcome of ParseCardRef.
type CardRefParse struct {
	OK    bool     `json:"ok"`
	Ref   *CardRef `json:"ref,omitempty"`
	Error string   `json:"error,omitempty"`
}

func refFail(message string) CardRefParse { return CardRefParse{Error: message} }

func decodeRefValue(raw string) (string, bool) {
	bytes := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '%' {
			n, _ := strconv.ParseUint(raw[i+1:i+3], 16, 8)
			bytes = append(bytes, byte(n))
			i += 2
		} else {
			bytes = append(bytes, raw[i])
		}
	}
	if !utf8.Valid(bytes) {
		return "", false
	}
	return string(bytes), true
}

func encodeRefValue(value string) string {
	var b strings.Builder
	for _, c := range []byte(value) {
		if c < 128 && (c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '~' || c == '-') {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ParseCardRef reads a `ref:` link given as decoded JSON; anything but a string is refused.
func ParseCardRef(href any) CardRefParse {
	s, ok := href.(string)
	if !ok {
		return refFail("a ref must be a string.")
	}
	if jsLength(s) > maxRefLength {
		return refFail(fmt.Sprintf("a ref is at most %d characters.", maxRefLength))
	}
	if !strings.HasPrefix(s, CardRefScheme+":") {
		return refFail(fmt.Sprintf("a ref starts with %q.", CardRefScheme+":"))
	}
	rest := s[len(CardRefScheme)+1:]
	if strings.Contains(rest, "#") {
		return refFail("a ref has no fragment.")
	}
	target, query, hasQuery := strings.Cut(rest, "?")
	if !refTargetRe.MatchString(target) {
		return refFail("a ref target is 1 to 128 letters, digits, dot, underscore, colon or dash, starting with a letter or digit.")
	}
	params := map[string][]string{}
	if hasQuery {
		if query == "" {
			return refFail("a ref query is empty.")
		}
		for _, part := range strings.Split(query, "&") {
			name, raw, hasEq := strings.Cut(part, "=")
			if !hasEq {
				return refFail("each ref param is name=value.")
			}
			if !refNameRe.MatchString(name) {
				return refFail("a ref param name is 1 to 32 letters, digits, dash or underscore, starting with a lowercase letter.")
			}
			if !refRawValueRe.MatchString(raw) {
				return refFail("a ref param value is not empty and uses letters, digits, dot, dash, underscore, tilde or %XX only.")
			}
			value, valid := decodeRefValue(raw)
			if !valid {
				return refFail("a ref param value must be valid UTF-8.")
			}
			if jsLength(value) > maxRefValueLength {
				return refFail(fmt.Sprintf("a ref param value is at most %d characters.", maxRefValueLength))
			}
			if _, seen := params[name]; !seen {
				if len(params) >= maxRefNames {
					return refFail(fmt.Sprintf("a ref has at most %d param names.", maxRefNames))
				}
				params[name] = []string{}
			}
			if len(params[name]) >= maxRefValues {
				return refFail(fmt.Sprintf("a ref param has at most %d values.", maxRefValues))
			}
			params[name] = append(params[name], value)
		}
	}
	return CardRefParse{OK: true, Ref: &CardRef{Target: target, Params: params}}
}

// FormatCardRef writes a reference as a `ref:` link, names in alphabetical order. ok is false when the
// reference breaks a limit. The input is decoded JSON, like the validators take.
func FormatCardRef(ref any) (link string, ok bool) {
	target, _ := get(ref, "target")
	t, isString := target.(string)
	if !isObject(ref) || !isString || !refTargetRe.MatchString(t) {
		return "", false
	}
	paramsValue, _ := get(ref, "params")
	params, isMap := paramsValue.(map[string]any)
	if !isMap || len(params) > maxRefNames {
		return "", false
	}
	names := make([]string, 0, len(params))
	for name := range params {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := []string{}
	for _, name := range names {
		values, isList := params[name].([]any)
		if !refNameRe.MatchString(name) || !isList || len(values) == 0 || len(values) > maxRefValues {
			return "", false
		}
		for _, item := range values {
			value, isText := item.(string)
			if !isText || value == "" || jsLength(value) > maxRefValueLength {
				return "", false
			}
			parts = append(parts, name+"="+encodeRefValue(value))
		}
	}
	link = CardRefScheme + ":" + t
	if len(parts) > 0 {
		link += "?" + strings.Join(parts, "&")
	}
	if jsLength(link) > maxRefLength {
		return "", false
	}
	return link, true
}

// ChartRef is what a reference to a super-chart.chart card means: the whole chart, one annotation key,
// or a time range with an optional price band. Pointers are the optional fields.
type ChartRef struct {
	ChartID string   `json:"chartId"`
	Key     *string  `json:"key,omitempty"`
	From    *float64 `json:"from,omitempty"`
	To      *float64 `json:"to,omitempty"`
	Low     *float64 `json:"low,omitempty"`
	High    *float64 `json:"high,omitempty"`
}

// ChartRefParse is the outcome of ParseChartRef.
type ChartRefParse struct {
	OK    bool      `json:"ok"`
	Chart *ChartRef `json:"chart,omitempty"`
	Error string    `json:"error,omitempty"`
}

// ParseChartRef reads the chart vocabulary from a parsed reference. Params it does not use are ignored.
func ParseChartRef(ref CardRef) ChartRefParse {
	fail := func(message string) ChartRefParse { return ChartRefParse{Error: message} }
	numbers := map[string]*float64{}
	var key *string
	for _, name := range []string{"key", "from", "to", "low", "high"} {
		list, present := ref.Params[name]
		if !present {
			continue
		}
		if len(list) != 1 {
			return fail(fmt.Sprintf("a chart ref takes one %s.", name))
		}
		if name == "key" {
			k := list[0]
			key = &k
			continue
		}
		n := math.NaN()
		if decimalRe.MatchString(list[0]) {
			if f, err := strconv.ParseFloat(list[0], 64); err == nil || math.IsInf(f, 0) {
				n = f
			}
		}
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return fail(fmt.Sprintf("a chart ref %s must be a plain decimal number.", name))
		}
		if n == 0 {
			n = 0
		}
		numbers[name] = &n
	}
	chart := ChartRef{ChartID: ref.Target}
	from, to, low, high := numbers["from"], numbers["to"], numbers["low"], numbers["high"]
	if key != nil {
		if from != nil || to != nil || low != nil || high != nil {
			return fail("a chart ref uses key or a time range, not both.")
		}
		if jsLength(*key) > maxChartRefKeySize {
			return fail("a chart ref key is at most 128 characters.")
		}
		chart.Key = key
		return ChartRefParse{OK: true, Chart: &chart}
	}
	if (from == nil) != (to == nil) {
		return fail("a chart ref time range needs both from and to.")
	}
	if from != nil && to != nil {
		if *from > *to {
			return fail("a chart ref from must not be after to.")
		}
		chart.From, chart.To = from, to
	}
	if (low == nil) != (high == nil) {
		return fail("a chart ref price band needs both low and high.")
	}
	if low != nil && high != nil {
		if from == nil {
			return fail("a chart ref price band needs a time range.")
		}
		if *low > *high {
			return fail("a chart ref low must not be above high.")
		}
		chart.Low, chart.High = low, high
	}
	return ChartRefParse{OK: true, Chart: &chart}
}
