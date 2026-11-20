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
	CardRefParse []struct {
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
		if got := ValidateEditorCardSpec(c.Value); got != c.Expect {
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
		if got := ValidateChartCardSpec(c.Value); got != c.Expect {
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
		if got := ValidatePlotCardSpec(c.Value); got != c.Expect {
			t.Errorf("plot[%d]: %v, want %v", i, got, c.Expect)
		}
	}
}

func TestTerminalEvent(t *testing.T) {
	for _, c := range load(t).TerminalEvent {
		if got := IsTerminalEvent(c.Type); got != c.Expect {
			t.Errorf("%q: %v, want %v", c.Type, got, c.Expect)
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
