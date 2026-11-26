// SPDX-License-Identifier: Apache-2.0

// Command conformance-shim answers scripts/conformance-run.mjs with this Go port, one JSON line per case (see
// docs/CONFORMANCE-RUNNER.md). It is the smallest program that can be tested that way: read a line, compute the
// result, write a line. Run it with
//
//	node scripts/conformance-run.mjs --command "go run ./implementations/go/conformance-shim"
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/Super-Solution/super-protocol/implementations/go/protocol"
)

type request struct {
	ID      int            `json:"id"`
	Section string         `json:"section"`
	Case    map[string]any `json:"case"`
}

// issues is never null on the wire: no problem is an empty list.
func issues(list []protocol.Issue) any {
	if list == nil {
		return []protocol.Issue{}
	}
	return list
}

func orNil[T comparable](value T, ok bool) any {
	if !ok {
		return nil
	}
	return value
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func strs(v any) []string {
	out := []string{}
	for _, s := range list(v) {
		out = append(out, s.(string))
	}
	return out
}

func decode(in any, out any) {
	raw, _ := json.Marshal(in)
	_ = json.Unmarshal(raw, out)
}

// handlers maps a section to what this port computes for one case. A section that is not here is answered
// "unsupported": the runner reports it and does not count it as a failure.
var handlers = map[string]func(c map[string]any) (any, error){
	"issue_codes": func(map[string]any) (any, error) { return map[string]any{"codes": protocol.IssueCodes}, nil },
	"protocol": func(map[string]any) (any, error) {
		return map[string]any{"version": protocol.ProtocolVersion, "features": protocol.ProtocolFeatures}, nil
	},
	"plot_fallback_message": func(map[string]any) (any, error) { return protocol.PlotFallbackMessage, nil },
	"did_you_mean": func(c map[string]any) (any, error) {
		hint := protocol.DidYouMean(c["value"], strs(c["allowed"]))
		return orNil(hint, hint != ""), nil
	},
	"protocol_version": func(c map[string]any) (any, error) {
		switch c["fn"] {
		case "parse":
			if major, minor, ok := protocol.ParseProtocolVersion(c["value"]); ok {
				return map[string]any{"major": major, "minor": minor}, nil
			}
		case "compare":
			if order, ok := protocol.CompareProtocolVersions(c["a"], c["b"]); ok {
				return order, nil
			}
		case "feature":
			if name, major, minor, ok := protocol.ParseProtocolFeature(c["value"]); ok {
				return map[string]any{"name": name, "major": major, "minor": minor}, nil
			}
		default:
			return nil, fmt.Errorf("unknown fn %v", c["fn"])
		}
		return nil, nil
	},
	"mapping": func(c map[string]any) (any, error) {
		var counting protocol.UsageCounting
		decode(c["counting"], &counting)
		var value any
		var err error
		switch c["fn"] {
		case "finish_from_gateway":
			value = protocol.FinishReasonFromGateway(c["value"])
		case "finish_to_gateway":
			word, ok := protocol.FinishReasonToGateway(c["value"])
			value = orNil(word, ok)
		case "usage_from_meters":
			value, err = protocol.RunUsageFromMeters(c["meters"], counting)
		case "meters_from_usage":
			value, err = protocol.MetersFromRunUsage(c["usage"], counting)
		default:
			return nil, fmt.Errorf("unknown fn %v", c["fn"])
		}
		if err != nil {
			return map[string]any{"error": err.Error()}, nil
		}
		return map[string]any{"value": value}, nil
	},
	"plugin_manifest": func(c map[string]any) (any, error) { return issues(protocol.ValidatePluginManifest(c["value"])), nil },
	"editor_card":     func(c map[string]any) (any, error) { return protocol.ValidateEditorCardSpec(c["value"]), nil },
	"chart_card":      func(c map[string]any) (any, error) { return protocol.ValidateChartCardSpec(c["value"]), nil },
	"plot_card":       func(c map[string]any) (any, error) { return protocol.ValidatePlotCardSpec(c["value"]), nil },
	"card_ref_parse":  func(c map[string]any) (any, error) { return protocol.ParseCardRef(c["value"]), nil },
	"card_ref_format": func(c map[string]any) (any, error) {
		link, ok := protocol.FormatCardRef(c["value"])
		return orNil(link, ok), nil
	},
	"chart_ref": func(c map[string]any) (any, error) {
		if c["value"] == nil {
			return nil, nil
		}
		var ref protocol.CardRef
		decode(c["value"], &ref)
		return protocol.ParseChartRef(ref), nil
	},
	"terminal_event": func(c map[string]any) (any, error) { return protocol.IsTerminalEvent(c["type"].(string)), nil },
	"run_event":      func(c map[string]any) (any, error) { return issues(protocol.ValidateRunEvent(c["value"])), nil },
	"run_event_type": func(c map[string]any) (any, error) {
		t := c["type"].(string)
		return map[string]any{"known": protocol.IsRunEventType(t), "terminal": protocol.IsRunTerminalEvent(t)}, nil
	},
	"run_stream_outcome": func(c map[string]any) (any, error) { return protocol.RunStreamOutcomeOf(list(c["events"])), nil },
	"card_placement": func(c map[string]any) (any, error) {
		var interactive *bool
		if b, ok := c["interactive"].(bool); ok {
			interactive = &b
		}
		return map[string]any{"valid": protocol.IsCardPlacement(c["value"]), "allowed": protocol.CanPlaceCard(interactive, c["value"])}, nil
	},
	"host_theme": func(c map[string]any) (any, error) {
		theme := protocol.ReadHostTheme(c["value"])
		if theme == nil {
			return map[string]any{"theme": nil, "variables": nil}, nil
		}
		return map[string]any{"theme": theme, "variables": protocol.ThemeVariables(*theme)}, nil
	},
	"tool_authority": func(c map[string]any) (any, error) {
		authority, ok := protocol.PluginToolAuthority(c["tool"])
		presets := []string{}
		if ok {
			presets = protocol.PluginToolPresets[authority]
		}
		return map[string]any{"authority": orNil(authority, ok), "presets": presets}, nil
	},
	"chat_plugin": func(c map[string]any) (any, error) {
		plugin, _ := c["plugin"].(map[string]any)
		manifest := plugin["manifest"]
		var panel any
		if len(protocol.ValidatePluginManifest(manifest)) == 0 {
			panel = protocol.PanelCardKinds(manifest)
		}
		return map[string]any{"issues": issues(protocol.ValidateChatPluginData(c["plugin"])), "panel_kinds": panel}, nil
	},
	"inference_message":        func(c map[string]any) (any, error) { return issues(protocol.ValidateInferenceMessage(c["value"])), nil },
	"inference_request":        func(c map[string]any) (any, error) { return issues(protocol.ValidateInferenceRequest(c["value"])), nil },
	"stream_event":             func(c map[string]any) (any, error) { return issues(protocol.ValidateStreamEvent(c["value"])), nil },
	"inference_stream_outcome": func(c map[string]any) (any, error) { return protocol.InferenceStreamOutcomeOf(list(c["events"])), nil },
	"sse": func(c map[string]any) (any, error) {
		limit := 0
		if n, ok := c["max_frame_bytes"].(float64); ok {
			limit = int(n)
		}
		p := protocol.NewParser(limit)
		frames := []map[string]string{}
		add := func(fs []protocol.Frame) {
			for _, f := range fs {
				frames = append(frames, map[string]string{"event": f.Event, "data": f.Data})
			}
		}
		var err error
		for _, h := range strs(c["chunks"]) {
			b, _ := hex.DecodeString(h)
			var fs []protocol.Frame
			if fs, err = p.Feed(b); err != nil {
				break
			}
			add(fs)
		}
		if err == nil {
			var fs []protocol.Frame
			fs, err = p.Finish()
			add(fs)
		}
		if err != nil {
			return map[string]any{"frames": frames, "error": err.Error()}, nil
		}
		return map[string]any{"frames": frames}, nil
	},
}

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 1<<20), 1<<28)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for in.Scan() {
		var r request
		if err := json.Unmarshal(in.Bytes(), &r); err != nil {
			fmt.Fprintln(os.Stderr, "not a request:", err)
			os.Exit(1)
		}
		answer := map[string]any{"id": r.ID}
		if handle, ok := handlers[r.Section]; !ok {
			answer["unsupported"] = true
		} else if result, err := handle(r.Case); err != nil {
			answer["error"] = err.Error()
		} else {
			answer["result"] = result
		}
		line, err := json.Marshal(answer)
		if err != nil {
			line, _ = json.Marshal(map[string]any{"id": r.ID, "error": err.Error()})
		}
		out.Write(line)
		out.WriteByte('\n')
	}
}
