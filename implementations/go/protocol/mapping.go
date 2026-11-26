// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"errors"
	"fmt"
)

// Conversions between the gateway's words and a run's words for the same things (see mapping.ts in the TypeScript
// reference). Counting input is the one place the words do not settle the meaning, so the two usage functions take
// the reading of each side as an argument and never guess. Usage is decoded JSON: map[string]any with float64 numbers.

// FinishReasonFromGateway is the run word for a gateway finish_reason. A value the gateway did not send, or one this
// version does not know, is "unknown": the run never claims a reason the gateway did not give.
func FinishReasonFromGateway(reason any) string {
	switch reason {
	case "stop":
		return "stop"
	case "length":
		return "length"
	case "tool_calls":
		return "tool-calls"
	}
	return "unknown"
}

// FinishReasonToGateway is the gateway word for a run's finish reason; ok is false when the gateway has none: it
// cannot say "content-filter", "cancelled", "error" or "unknown", and a value that is not a finish reason gets none too.
func FinishReasonToGateway(reason any) (word string, ok bool) {
	switch reason {
	case "stop":
		return "stop", true
	case "length":
		return "length", true
	case "tool-calls":
		return "tool_calls", true
	}
	return "", false
}

// How a system counts input: with the cached tokens in it, or without them.
const (
	IncludesCached = "includes-cached"
	ExcludesCached = "excludes-cached"
)

// UsageCounting is the reading of the gateway's Usage.input (Meters) and of the run's RunUsage.inputTokens (Run); each
// is IncludesCached or ExcludesCached.
type UsageCounting struct {
	Meters string `json:"meters"`
	Run    string `json:"run"`
}

func amountOf(name string, v any) (float64, error) {
	if !isAmount(v) {
		return 0, fmt.Errorf("%s must be a non-negative number", name)
	}
	return v.(float64), nil
}

// RunUsageFromMeters is a run's usage from a gateway's meters. cache_write has no field in RunUsage: when the run counts
// input with the cache in it, the written tokens are inside inputTokens; otherwise they are dropped. images, video_ms,
// audio_ms and tasks have no run counterpart and are dropped.
//
// It returns an error when Meters is IncludesCached and input is smaller than cached + cache_write: the input then
// cannot contain them, so it is the other reading, and guessing would misreport the tokens.
func RunUsageFromMeters(meters any, counting UsageCounting) (map[string]any, error) {
	var values [4]float64
	for i, name := range []string{"input", "cached", "cache_write", "output"} {
		v, err := amountOf("meters."+name, field(meters, name))
		if err != nil {
			return nil, err
		}
		values[i] = v
	}
	input, cached, written, output := values[0], values[1], values[2], values[3]
	base := input
	if counting.Meters == IncludesCached {
		base = input - cached - written
	}
	if base < 0 {
		return nil, errors.New("meters.input is smaller than cached + cache_write, so it does not include them: use excludes-cached")
	}
	inputTokens := base
	if counting.Run == IncludesCached {
		inputTokens = base + cached + written
	}
	return map[string]any{"inputTokens": inputTokens, "outputTokens": output, "cachedInputTokens": cached}, nil
}

// MetersFromRunUsage is a gateway's meters from a run's usage. RunUsage does not carry cache_write, so it comes back as
// 0 and, when the run counts input with the cache in it, the written tokens stay inside input; reasoningTokens and
// totalTokens have no meter and are dropped.
//
// It returns an error when inputTokens or outputTokens is absent (a meter is a number, and an unknown count is not 0),
// when a count is not a non-negative number, or when Run is IncludesCached and inputTokens is smaller than
// cachedInputTokens.
func MetersFromRunUsage(usage any, counting UsageCounting) (map[string]any, error) {
	inputTokens, err := amountOf("usage.inputTokens", field(usage, "inputTokens"))
	if err != nil {
		return nil, err
	}
	outputTokens, err := amountOf("usage.outputTokens", field(usage, "outputTokens"))
	if err != nil {
		return nil, err
	}
	var cachedValue any = float64(0)
	if v := field(usage, "cachedInputTokens"); !isUndefined(v) {
		cachedValue = v
	}
	cached, err := amountOf("usage.cachedInputTokens", cachedValue)
	if err != nil {
		return nil, err
	}
	base := inputTokens
	if counting.Run == IncludesCached {
		base = inputTokens - cached
	}
	if base < 0 {
		return nil, errors.New("usage.inputTokens is smaller than cachedInputTokens, so it does not include it: use excludes-cached")
	}
	input := base
	if counting.Meters == IncludesCached {
		input = base + cached
	}
	return map[string]any{"input": input, "cached": cached, "cache_write": float64(0), "output": outputTokens}, nil
}
