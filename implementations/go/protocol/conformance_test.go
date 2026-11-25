// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixtures struct {
	IssueCodes struct {
		Codes []string `json:"codes"`
	} `json:"issue_codes"`
	DidYouMean []struct {
		Value   any      `json:"value"`
		Allowed []string `json:"allowed"`
		Expect  *string  `json:"expect"`
	} `json:"did_you_mean"`
	PluginManifest []struct {
		Value  any             `json:"value"`
		Expect []ManifestIssue `json:"expect"`
	} `json:"plugin_manifest"`
	EditorCard []struct {
		Value  any        `json:"value"`
		Expect CardResult `json:"expect"`
	} `json:"editor_card"`
	ChartCard []struct {
		Value  any        `json:"value"`
		Expect CardResult `json:"expect"`
	} `json:"chart_card"`
	PlotCard []struct {
		Value  any        `json:"value"`
		Expect CardResult `json:"expect"`
	} `json:"plot_card"`
	PlotFallbackMessage string `json:"plot_fallback_message"`
	CardRefParse        []struct {
		Value  any          `json:"value"`
		Expect CardRefParse `json:"expect"`
	} `json:"card_ref_parse"`
	CardRefFormat []struct {
		Value  any     `json:"value"`
		Expect *string `json:"expect"`
	} `json:"card_ref_format"`
	ChartRef []struct {
		Value  *CardRef       `json:"value"`
		Href   string         `json:"href"`
		Expect *ChartRefParse `json:"expect"`
	} `json:"chart_ref"`
	TerminalEvent []struct {
		Type   string `json:"type"`
		Expect bool   `json:"expect"`
	} `json:"terminal_event"`
	RunEvent []struct {
		Value  any             `json:"value"`
		Expect []RunEventIssue `json:"expect"`
	} `json:"run_event"`
	RunEventType []struct {
		Type   string `json:"type"`
		Expect struct {
			Known    bool `json:"known"`
			Terminal bool `json:"terminal"`
		} `json:"expect"`
	} `json:"run_event_type"`
	RunStreamOutcome []struct {
		Events []any            `json:"events"`
		Expect RunStreamOutcome `json:"expect"`
	} `json:"run_stream_outcome"`
	CardPlacement []struct {
		Value       any   `json:"value"`
		Interactive *bool `json:"interactive"`
		Expect      struct {
			Valid   bool `json:"valid"`
			Allowed bool `json:"allowed"`
		} `json:"expect"`
	} `json:"card_placement"`
	HostTheme []struct {
		Value  any `json:"value"`
		Expect struct {
			Theme     *HostTheme        `json:"theme"`
			Variables map[string]string `json:"variables"`
		} `json:"expect"`
	} `json:"host_theme"`
	ToolAuthority []struct {
		Tool   any `json:"tool"`
		Expect struct {
			Authority *string  `json:"authority"`
			Presets   []string `json:"presets"`
		} `json:"expect"`
	} `json:"tool_authority"`
	ChatPlugin []struct {
		Plugin any `json:"plugin"`
		Expect struct {
			Issues     []ManifestIssue `json:"issues"`
			PanelKinds *[]string       `json:"panel_kinds"`
		} `json:"expect"`
	} `json:"chat_plugin"`
	InferenceMessage []struct {
		Value  any             `json:"value"`
		Expect []ManifestIssue `json:"expect"`
	} `json:"inference_message"`
	InferenceRequest []struct {
		Value  any             `json:"value"`
		Expect []ManifestIssue `json:"expect"`
	} `json:"inference_request"`
	StreamEvent []struct {
		Value  any             `json:"value"`
		Expect []ManifestIssue `json:"expect"`
	} `json:"stream_event"`
	InferenceStreamOutcome []struct {
		Events []any                  `json:"events"`
		Expect InferenceStreamOutcome `json:"expect"`
	} `json:"inference_stream_outcome"`
	SSE []struct {
		Chunks        []string `json:"chunks"`
		MaxFrameBytes *int     `json:"max_frame_bytes"`
		Expect        struct {
			Frames []struct {
				Event string `json:"event"`
				Data  string `json:"data"`
			} `json:"frames"`
			Error string `json:"error"`
		} `json:"expect"`
	} `json:"sse"`
}

func load(t testing.TB) fixtures {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "protocol.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestIssueCodes(t *testing.T) {
	if want := load(t).IssueCodes.Codes; !reflect.DeepEqual(IssueCodes, want) {
		t.Errorf("IssueCodes = %v, want %v", IssueCodes, want)
	}
}

func TestDidYouMean(t *testing.T) {
	f := load(t)
	if len(f.DidYouMean) < 25 {
		t.Fatalf("only %d cases", len(f.DidYouMean))
	}
	for i, c := range f.DidYouMean {
		got, want := DidYouMean(c.Value, c.Allowed), ""
		if c.Expect != nil {
			want = *c.Expect
		}
		if got != want {
			t.Errorf("did_you_mean[%d] %v in %v: %q, want %q", i, c.Value, c.Allowed, got, want)
		}
	}
}

func TestPluginManifest(t *testing.T) {
	f := load(t)
	if len(f.PluginManifest) < 100 {
		t.Fatalf("only %d cases", len(f.PluginManifest))
	}
	for i, c := range f.PluginManifest {
		if got := ValidatePluginManifest(c.Value); !reflect.DeepEqual(got, append([]ManifestIssue{}, c.Expect...)) {
			t.Errorf("manifest[%d]: %v, want %v", i, got, c.Expect)
		}
	}
}

func TestEditorCard(t *testing.T) {
	f := load(t)
	if len(f.EditorCard) < 30 {
		t.Fatalf("only %d cases", len(f.EditorCard))
	}
	for i, c := range f.EditorCard {
		if got := ValidateEditorCardSpec(c.Value); !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("editor[%d]: %v, want %v", i, got, c.Expect)
		}
	}
}

func TestChartCard(t *testing.T) {
	f := load(t)
	if len(f.ChartCard) < 200 {
		t.Fatalf("only %d cases", len(f.ChartCard))
	}
	for i, c := range f.ChartCard {
		if got := ValidateChartCardSpec(c.Value); !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("chart[%d]: %v, want %v", i, got, c.Expect)
		}
	}
}

func TestPlotCard(t *testing.T) {
	f := load(t)
	if len(f.PlotCard) < 60 {
		t.Fatalf("only %d cases", len(f.PlotCard))
	}
	for i, c := range f.PlotCard {
		if got := ValidatePlotCardSpec(c.Value); !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("plot[%d]: %v, want %v", i, got, c.Expect)
		}
	}
}

func TestPlotFallbackMessage(t *testing.T) {
	if want := load(t).PlotFallbackMessage; PlotFallbackMessage != want {
		t.Errorf("PlotFallbackMessage = %q, want %q", PlotFallbackMessage, want)
	}
}

func TestTerminalEvent(t *testing.T) {
	for _, c := range load(t).TerminalEvent {
		if got := IsTerminalEvent(c.Type); got != c.Expect {
			t.Errorf("%q: %v, want %v", c.Type, got, c.Expect)
		}
	}
}

func TestRunEvents(t *testing.T) {
	f := load(t)
	if len(f.RunEvent) < 1000 || len(f.RunEventType) < 25 || len(f.RunStreamOutcome) < 30 {
		t.Fatalf("only %d/%d/%d cases", len(f.RunEvent), len(f.RunEventType), len(f.RunStreamOutcome))
	}
	for i, c := range f.RunEvent {
		if got := ValidateRunEvent(c.Value); !reflect.DeepEqual(got, append([]RunEventIssue{}, c.Expect...)) {
			t.Errorf("run_event[%d] %v: %v, want %v", i, c.Value, got, c.Expect)
		}
	}
	for _, c := range f.RunEventType {
		if known, terminal := IsRunEventType(c.Type), IsRunTerminalEvent(c.Type); known != c.Expect.Known || terminal != c.Expect.Terminal {
			t.Errorf("run_event_type %q: known %v terminal %v, want %+v", c.Type, known, terminal, c.Expect)
		}
	}
	for i, c := range f.RunStreamOutcome {
		if got := RunStreamOutcomeOf(c.Events); got != c.Expect {
			t.Errorf("run_stream_outcome[%d]: %s, want %s", i, got, c.Expect)
		}
	}
}

func TestCardPlacement(t *testing.T) {
	f := load(t)
	if len(f.CardPlacement) < 30 {
		t.Fatalf("only %d cases", len(f.CardPlacement))
	}
	for i, c := range f.CardPlacement {
		if valid, allowed := IsCardPlacement(c.Value), CanPlaceCard(c.Interactive, c.Value); valid != c.Expect.Valid || allowed != c.Expect.Allowed {
			t.Errorf("card_placement[%d] %v interactive %v: valid %v allowed %v, want %+v", i, c.Value, c.Interactive, valid, allowed, c.Expect)
		}
	}
}

func TestHostTheme(t *testing.T) {
	f := load(t)
	if len(f.HostTheme) < 100 {
		t.Fatalf("only %d cases", len(f.HostTheme))
	}
	for i, c := range f.HostTheme {
		theme := ReadHostTheme(c.Value)
		if !reflect.DeepEqual(theme, c.Expect.Theme) {
			t.Errorf("host_theme[%d] %v: %+v, want %+v", i, c.Value, theme, c.Expect.Theme)
			continue
		}
		if theme == nil {
			if c.Expect.Variables != nil {
				t.Errorf("host_theme[%d]: variables for no theme", i)
			}
		} else if got := ThemeVariables(*theme); !reflect.DeepEqual(got, c.Expect.Variables) {
			t.Errorf("host_theme[%d] %v: variables %v, want %v", i, c.Value, got, c.Expect.Variables)
		}
	}
}

func TestToolAuthority(t *testing.T) {
	f := load(t)
	if len(f.ToolAuthority) < 20 {
		t.Fatalf("only %d cases", len(f.ToolAuthority))
	}
	for i, c := range f.ToolAuthority {
		authority, ok := PluginToolAuthority(c.Tool)
		presets := []string{}
		if ok {
			presets = PluginToolPresets[authority]
		}
		if ok != (c.Expect.Authority != nil) || (ok && authority != *c.Expect.Authority) || !reflect.DeepEqual(presets, append([]string{}, c.Expect.Presets...)) {
			t.Errorf("tool_authority[%d] %v: %q %v %v, want %+v", i, c.Tool, authority, ok, presets, c.Expect)
		}
	}
}

func TestChatPlugin(t *testing.T) {
	f := load(t)
	if len(f.ChatPlugin) < 40 {
		t.Fatalf("only %d cases", len(f.ChatPlugin))
	}
	for i, c := range f.ChatPlugin {
		if got := ValidateChatPluginData(c.Plugin); !reflect.DeepEqual(got, append([]ManifestIssue{}, c.Expect.Issues...)) {
			t.Errorf("chat_plugin[%d]: %v, want %v", i, got, c.Expect.Issues)
		}
		manifest, _ := get(c.Plugin, "manifest")
		if len(ValidatePluginManifest(manifest)) == 0 {
			if got := PanelCardKinds(manifest); c.Expect.PanelKinds == nil || !reflect.DeepEqual(got, *c.Expect.PanelKinds) {
				t.Errorf("chat_plugin[%d]: panel kinds %v, want %v", i, got, c.Expect.PanelKinds)
			}
		} else if c.Expect.PanelKinds != nil {
			t.Errorf("chat_plugin[%d]: panel kinds for an invalid manifest", i)
		}
	}
}

func TestInference(t *testing.T) {
	f := load(t)
	if len(f.InferenceMessage) < 80 || len(f.InferenceRequest) < 200 || len(f.StreamEvent) < 400 || len(f.InferenceStreamOutcome) < 15 {
		t.Fatalf("only %d/%d/%d/%d cases", len(f.InferenceMessage), len(f.InferenceRequest), len(f.StreamEvent), len(f.InferenceStreamOutcome))
	}
	for i, c := range f.InferenceMessage {
		if got := ValidateInferenceMessage(c.Value); !reflect.DeepEqual(got, append([]ManifestIssue{}, c.Expect...)) {
			t.Errorf("inference_message[%d] %v: %v, want %v", i, c.Value, got, c.Expect)
		}
	}
	for i, c := range f.InferenceRequest {
		if got := ValidateInferenceRequest(c.Value); !reflect.DeepEqual(got, append([]ManifestIssue{}, c.Expect...)) {
			t.Errorf("inference_request[%d] %v: %v, want %v", i, c.Value, got, c.Expect)
		}
	}
	for i, c := range f.StreamEvent {
		if got := ValidateStreamEvent(c.Value); !reflect.DeepEqual(got, append([]ManifestIssue{}, c.Expect...)) {
			t.Errorf("stream_event[%d] %v: %v, want %v", i, c.Value, got, c.Expect)
		}
	}
	for i, c := range f.InferenceStreamOutcome {
		if got := InferenceStreamOutcomeOf(c.Events); got != c.Expect {
			t.Errorf("inference_stream_outcome[%d]: %s, want %s", i, got, c.Expect)
		}
	}
}

func TestSSE(t *testing.T) {
	f := load(t)
	if len(f.SSE) < 300 {
		t.Fatalf("only %d cases", len(f.SSE))
	}
	errorCases := 0
	for i, c := range f.SSE {
		limit := 0
		if c.MaxFrameBytes != nil {
			limit = *c.MaxFrameBytes
		}
		p := NewParser(limit)
		var got []Frame
		var err error
		for _, h := range c.Chunks {
			b, _ := hex.DecodeString(h)
			var frames []Frame
			if frames, err = p.Feed(b); err != nil {
				break
			}
			got = append(got, frames...)
		}
		if err == nil {
			var frames []Frame
			frames, err = p.Finish()
			got = append(got, frames...)
		}
		wantErr := c.Expect.Error
		switch {
		case wantErr != "":
			errorCases++
			if !errors.Is(err, ErrStreamFrameTooLarge) || err.Error() != wantErr {
				t.Errorf("sse[%d]: error %v, want %s", i, err, wantErr)
			}
		case err != nil:
			t.Errorf("sse[%d]: %v", i, err)
		}
		if len(got) != len(c.Expect.Frames) {
			t.Errorf("sse[%d]: %d frames, want %d", i, len(got), len(c.Expect.Frames))
			continue
		}
		for j, fr := range got {
			if w := c.Expect.Frames[j]; fr.Event != w.Event || fr.Data != w.Data {
				t.Errorf("sse[%d] frame %d: %q/%q, want %q/%q", i, j, fr.Event, fr.Data, w.Event, w.Data)
			}
		}
	}
	if errorCases < 10 {
		t.Fatalf("only %d error cases", errorCases)
	}
}

func BenchmarkSSE(b *testing.B) {
	f := load(b)
	var chunks [][]byte
	for _, c := range f.SSE {
		if c.MaxFrameBytes != nil {
			continue
		}
		for _, h := range c.Chunks {
			x, _ := hex.DecodeString(h)
			chunks = append(chunks, x)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p := NewParser(0)
		for _, x := range chunks {
			_, _ = p.Feed(x)
		}
	}
}

func BenchmarkChartCard(b *testing.B) {
	f := load(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ValidateChartCardSpec(f.ChartCard[i%len(f.ChartCard)].Value)
	}
}

func TestCardRefs(t *testing.T) {
	f := load(t)
	if len(f.CardRefParse) < 80 || len(f.CardRefFormat) < 60 || len(f.ChartRef) < 30 {
		t.Fatalf("only %d/%d/%d cases", len(f.CardRefParse), len(f.CardRefFormat), len(f.ChartRef))
	}
	for i, c := range f.CardRefParse {
		if got := ParseCardRef(c.Value); !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("card_ref_parse[%d] %v: %+v, want %+v", i, c.Value, got, c.Expect)
		}
	}
	for i, c := range f.CardRefFormat {
		got, ok := FormatCardRef(c.Value)
		switch {
		case c.Expect == nil && ok:
			t.Errorf("card_ref_format[%d] %v: %q, want refusal", i, c.Value, got)
		case c.Expect != nil && (!ok || got != *c.Expect):
			t.Errorf("card_ref_format[%d] %v: %q (ok %v), want %q", i, c.Value, got, ok, *c.Expect)
		}
	}
	for i, c := range f.ChartRef {
		if c.Value == nil {
			if c.Expect != nil {
				t.Errorf("chart_ref[%d]: no ref but an expectation", i)
			}
			continue
		}
		got := ParseChartRef(*c.Value)
		if c.Expect == nil || !reflect.DeepEqual(got, *c.Expect) {
			t.Errorf("chart_ref[%d] %s: %+v, want %+v", i, c.Href, got, c.Expect)
		}
	}
}
