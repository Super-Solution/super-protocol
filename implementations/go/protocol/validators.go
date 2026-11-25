// SPDX-License-Identifier: Apache-2.0

// Package protocol ports the validators and the SSE parser of @supersolutions/super-protocol.
//
// Every message and the order of the checks match the TypeScript reference in implementations/typescript/;
// conformance/protocol.v1.json pins that. Inputs are decoded JSON (see jsutil.go).
package protocol

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

const (
	PluginManifestVersion = 0
	EditorCardKind        = "super-editor.document"
	ChartCardKind         = "super-chart.chart"
	PlotCardKind          = "super.plot"
)

// PlotFallbackMessage is what the user sees in place of a plot that cannot be drawn, followed by the
// card's alt. The technical reason goes to the developer log (and may go back to the model), never to the user.
const PlotFallbackMessage = "This chart can't be shown here."

var (
	// ChartTypes are the chart styles a chart card may ask for.
	ChartTypes      = []string{"candles", "hollow-candles", "ohlc", "line", "area", "baseline", "heikin-ashi"}
	surfaces        = []string{"card", "panel", "tool", "canvas"}
	tones           = []string{"bull", "bear", "neutral", "accent"}
	editorModes     = []string{"view", "edit"}
	annotationKinds = []string{"level", "zone", "marker", "trend", "ray", "fibonacci", "plan"}

	// annotationAnchors is how many anchors each annotation kind takes.
	annotationAnchors = map[string]int{"level": 1, "zone": 2, "marker": 1, "trend": 2, "ray": 2, "fibonacci": 2, "plan": 3}
	paramNameRe       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,31}$`)

	nameRe         = regexp.MustCompile(`^(@[a-z0-9\-~][a-z0-9\-._~]*/)?[a-z0-9\-~][a-z0-9\-._~]*$`)
	semverRe       = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.\-]+)?(\+[0-9A-Za-z.\-]+)?$`)
	capabilityIDRe = regexp.MustCompile(`^[a-z][a-z0-9\-]*(\.[a-z][a-z0-9\-]*)+$`)
)

const (
	maxBars        = 20000
	maxAnnotations = 256
	maxIndicators  = 12
	maxAnchors     = 3
	maxTextLength  = 2048
	maxKeyLength   = 128
	minHeight      = 160
	maxHeight      = 1200
	maxParams      = 16
	maxParamString = 128
	maxPlotAlt     = 2048
	maxPlotID      = 128
)

// CardResult is the outcome of validating a card spec. Issues is every problem found, in the order the validator
// checks; Error is the message of the first one and Expected its example when it has one.
type CardResult struct {
	OK       bool    `json:"ok"`
	Error    string  `json:"error,omitempty"`
	Expected string  `json:"expected,omitempty"`
	Issues   []Issue `json:"issues,omitempty"`
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ValidatePluginManifest returns every problem found; an empty slice means the manifest is valid.
func ValidatePluginManifest(value any) []Issue {
	c := newChecker()
	if !isObject(value) {
		c.wrongType("", value, "manifest must be an object")
		return c.issues
	}
	pattern := func(path string, v any, re *regexp.Regexp, message string) {
		if s, ok := asString(v); !ok {
			c.wrongType(path, v, message)
		} else if !re.MatchString(s) {
			c.add(path, CodeFormat, message)
		}
	}
	if v := field(value, "manifestVersion"); !equalsNumber(v, PluginManifestVersion) {
		message := fmt.Sprintf("must be %d", PluginManifestVersion)
		if isUndefined(v) {
			c.add("manifestVersion", CodeRequired, message)
		} else {
			c.add("manifestVersion", CodeEnum, message)
		}
	}
	pattern("name", field(value, "name"), nameRe, "must be a valid npm package name")
	pattern("version", field(value, "version"), semverRe, "must be a semver string")
	c.filled("license", field(value, "license"), "must be a non-empty SPDX expression")
	caps := field(value, "capabilities")
	if list, isList := caps.([]any); !isList {
		c.wrongType("capabilities", caps, "must be a non-empty array")
	} else if len(list) == 0 {
		c.add("capabilities", CodeEmpty, "must be a non-empty array")
	} else {
		seen := map[string]bool{}
		for i, cap := range list {
			path := fmt.Sprintf("capabilities[%d]", i)
			// `typeof c !== "object"`: arrays pass this test in the reference and fail the field checks.
			switch cap.(type) {
			case map[string]any, []any:
			default:
				c.wrongType(path, cap, "must be an object")
				continue
			}
			id := field(cap, "id")
			if !matches(capabilityIDRe, id) {
				pattern(path+".id", id, capabilityIDRe, "must be a dotted lowercase id such as editor.document")
			} else if seen[id.(string)] {
				c.add(path+".id", CodeUnique, "duplicate capability id")
			} else {
				seen[id.(string)] = true
			}
			surface := field(cap, "surface")
			c.oneOfMsg(path+".surface", surface, surfaces, "must be one of "+strings.Join(surfaces, ", "))
			surfaceName, _ := asString(surface)
			cardKind := field(cap, "cardKind")
			if surfaceName == "card" {
				c.textMsg(path+".cardKind", cardKind, "is required for card capabilities")
			}
			if surfaceName == "panel" && !isUndefined(cardKind) {
				c.textMsg(path+".cardKind", cardKind, "must be a non-empty card kind when given")
			}
			if surfaceName == "tool" {
				c.textMsg(path+".toolName", field(cap, "toolName"), "is required for tool capabilities")
			}
			if schema := field(cap, "inputSchema"); !isUndefined(schema) {
				c.object(path+".inputSchema", schema)
			}
		}
	}
	if service := field(value, "service"); !isUndefined(service) {
		message := "must be an http(s) URL"
		if !isObject(service) {
			c.addHint("service.baseUrl", CodeType, message, "got "+jsonType(service))
		} else if baseURL := field(service, "baseUrl"); !isString(baseURL) {
			c.wrongType("service.baseUrl", baseURL, message)
		} else if !isHTTPURL(baseURL.(string)) {
			c.add("service.baseUrl", CodeFormat, message)
		}
	}
	return c.issues
}

// ValidateEditorCardSpec checks the spec of a `super-editor.document` card.
func ValidateEditorCardSpec(spec any) CardResult {
	c := newChecker()
	if !isObject(spec) {
		c.wrongType("", spec, "Editor card spec must be an object.")
		return cardResult(c.issues)
	}
	c.oneOfMsg("kind", field(spec, "kind"), []string{EditorCardKind}, fmt.Sprintf("kind must be %q.", EditorCardKind))
	if title := field(spec, "title"); !isUndefined(title) {
		c.strMsg("title", title, "title must be a string.")
	}
	mode := field(spec, "mode")
	if !isUndefined(mode) {
		c.oneOfMsg("mode", mode, editorModes, `mode must be "view" or "edit".`)
	}
	document, service := field(spec, "document"), field(spec, "service")
	hasDocument, hasService := !isUndefined(document), !isUndefined(service)
	if hasDocument == hasService {
		c.addHint("", CodeExclusive, "Provide exactly one of `document` or `service`.", "document: {...} | service: { baseUrl, documentId }")
	}
	if hasService && mode == "edit" {
		c.add("mode", CodeExclusive, "A service-backed document is read-only for now: use an inline document to edit.")
	}
	if hasDocument {
		const message = "document must be a schemaVersion 1 report document with id, title and blocks."
		if !isObject(document) {
			c.wrongType("document", document, message)
		} else {
			if version := field(document, "schemaVersion"); !equalsNumber(version, 1) {
				if isUndefined(version) {
					c.add("document.schemaVersion", CodeRequired, message)
				} else {
					c.add("document.schemaVersion", CodeEnum, message)
				}
			}
			if id := field(document, "id"); !isString(id) {
				c.wrongType("document.id", id, message)
			}
			if title := field(document, "title"); !isString(title) {
				c.wrongType("document.title", title, message)
			}
			if blocks := field(document, "blocks"); !isList(blocks) {
				c.wrongType("document.blocks", blocks, message)
			}
		}
	}
	if hasService {
		const message = "service needs an http(s) baseUrl and a documentId."
		if !isObject(service) {
			c.wrongType("service", service, message)
		} else {
			if baseURL := field(service, "baseUrl"); !isString(baseURL) {
				c.wrongType("service.baseUrl", baseURL, message)
			} else if !isHTTPURL(baseURL.(string)) {
				c.add("service.baseUrl", CodeFormat, message)
			}
			c.textMsg("service.documentId", field(service, "documentId"), message)
		}
	}
	return cardResult(c.issues)
}

func firstMessage(fill func(c *checker)) string {
	c := newChecker()
	fill(c)
	if len(c.issues) == 0 {
		return ""
	}
	return c.issues[0].Message
}

func (c *checker) period(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "period must be an object.")
		return
	}
	multiplier := field(v, "multiplier")
	if _, ok := multiplier.(float64); !ok {
		c.wrongType(path+".multiplier", multiplier, "period.multiplier must be a positive integer.")
	} else if !isSafeInteger(multiplier) || multiplier.(float64) <= 0 {
		c.add(path+".multiplier", CodeRange, "period.multiplier must be a positive integer.")
	}
	c.filled(path+".timespan", field(v, "timespan"), "period.timespan must be a non-empty string.")
	c.filled(path+".text", field(v, "text"), "period.text must be a non-empty string.")
}

var symbolStrings = []string{"name", "shortName", "exchange", "market", "priceCurrency", "type", "logo", "timezone"}

func (c *checker) symbol(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "symbol must be an object.")
		return
	}
	c.filled(path+".ticker", field(v, "ticker"), "symbol.ticker must be a non-empty string.")
	for _, k := range symbolStrings {
		if item := field(v, k); !isUndefined(item) {
			c.strMsg(path+"."+k, item, fmt.Sprintf("symbol.%s must be a string.", k))
		}
	}
	if p := field(v, "pricePrecision"); !isUndefined(p) && p != "auto" {
		message := `symbol.pricePrecision must be an integer from 0 to 12 or "auto".`
		if _, ok := p.(float64); !ok {
			c.addHint(path+".pricePrecision", CodeType, message, "got "+jsonType(p))
		} else if !(isInteger(p) && p.(float64) >= 0 && p.(float64) <= 12) {
			c.add(path+".pricePrecision", CodeRange, message)
		}
	}
}

func (c *checker) bar(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "a bar must be an object.")
		return
	}
	for _, k := range []string{"timestamp", "open", "high", "low", "close"} {
		c.finiteNumber(path+"."+k, field(v, k), fmt.Sprintf("bar.%s must be a finite number.", k))
	}
	if vol := field(v, "volume"); !isUndefined(vol) {
		c.finiteNumber(path+".volume", vol, "bar.volume must be a finite number.")
	}
	open, high, low, closing := field(v, "open"), field(v, "high"), field(v, "low"), field(v, "close")
	if finite(open) && finite(high) && finite(low) && finite(closing) {
		o, h, l, cl := open.(float64), high.(float64), low.(float64), closing.(float64)
		if h < max(o, cl, l) || l > min(o, cl) {
			c.add(path, CodeShape, "bar high/low must contain open and close.")
		}
	}
}

// annotation checks one annotation; it returns its key when the key is a usable one, so the caller can look for
// duplicates.
func (c *checker) annotation(path string, v any) (key string, usable bool) {
	if !isObject(v) {
		c.wrongType(path, v, "an annotation must be an object.")
		return "", false
	}
	keyMessage := fmt.Sprintf("annotation.key must be a non-empty string of at most %d characters.", maxKeyLength)
	keyValue := field(v, "key")
	c.filled(path+".key", keyValue, keyMessage)
	if k, ok := asString(keyValue); ok && trim(k) != "" {
		if jsLength(k) > maxKeyLength {
			c.add(path+".key", CodeLength, keyMessage)
		} else {
			key, usable = k, true
		}
	}
	kindValue := field(v, "kind")
	c.oneOfMsg(path+".kind", kindValue, annotationKinds, `annotation.kind must be "level", "zone", "marker", "trend", "ray", "fibonacci" or "plan".`)
	kindName, _ := asString(kindValue)
	needed, known := annotationAnchors[kindName]
	anchorsMessage := "annotation.anchors must hold one to three anchors."
	anchorsValue := field(v, "anchors")
	anchors, isList := anchorsValue.([]any)
	switch {
	case !isList:
		c.wrongType(path+".anchors", anchorsValue, anchorsMessage)
	case len(anchors) == 0:
		c.add(path+".anchors", CodeEmpty, anchorsMessage)
	case len(anchors) > maxAnchors:
		c.add(path+".anchors", CodeLimit, anchorsMessage)
	}
	anchorsOK := isList && len(anchors) >= 1 && len(anchors) <= maxAnchors
	priced := make([]bool, len(anchors))
	if anchorsOK {
		for i, a := range anchors {
			ap := fmt.Sprintf("%s.anchors[%d]", path, i)
			if !isObject(a) {
				anchorsOK = false
				c.wrongType(ap, a, "annotation anchors need a finite time.")
				continue
			}
			c.finiteNumber(ap+".time", field(a, "time"), "annotation anchors need a finite time.")
			if price := field(a, "price"); !isUndefined(price) {
				c.finiteNumber(ap+".price", price, "annotation anchor price must be a finite number.")
			}
			priced[i] = !isUndefined(field(a, "price"))
		}
	}
	if known && anchorsOK {
		allPriced := true
		for _, p := range priced {
			allPriced = allPriced && p
		}
		problem := ""
		switch {
		case kindName == "level":
			if len(anchors) != 1 || !priced[0] {
				problem = "a level needs exactly one anchor with a price."
			}
		case kindName == "zone":
			if len(anchors) != 2 || !allPriced {
				problem = "a zone needs two anchors, both with a price."
			}
		case kindName == "marker":
			if len(anchors) != 1 {
				problem = "a marker needs exactly one anchor."
			}
		case len(anchors) != needed || !allPriced:
			problem = fmt.Sprintf("a %s needs %d anchors, all with a price.", kindName, needed)
		}
		if problem != "" {
			c.add(path+".anchors", CodeShape, problem)
		}
	}
	if params := field(v, "params"); !isUndefined(params) {
		pp := path + ".params"
		entries, isMap := params.(map[string]any)
		switch {
		case known && (kindName == "level" || kindName == "zone" || kindName == "marker"):
			c.add(pp, CodeShape, "annotation.params applies only to trend, ray, fibonacci and plan.")
		case !isMap:
			c.wrongType(pp, params, "annotation.params must be an object.")
		default:
			if len(entries) > maxParams {
				c.add(pp, CodeLimit, fmt.Sprintf("annotation.params may hold at most %d entries.", maxParams))
			}
			names := make([]string, 0, len(entries))
			for name := range entries {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				if !paramNameRe.MatchString(name) {
					c.add(pp+"."+name, CodeFormat, "annotation.params keys must be 1 to 32 letters, digits, dash or underscore, starting with a letter.")
				}
				message := fmt.Sprintf("annotation.params.%s must be a finite number, a boolean or a string of at most %d characters.", name, maxParamString)
				switch x := entries[name].(type) {
				case float64:
					if !finite(x) {
						c.add(pp+"."+name, CodeRange, message)
					}
				case string:
					if jsLength(x) > maxParamString {
						c.add(pp+"."+name, CodeLength, message)
					}
				case bool:
				default:
					c.addHint(pp+"."+name, CodeType, message, "got "+jsonType(x))
				}
			}
		}
	}
	if text := field(v, "text"); !isUndefined(text) {
		c.short(path+".text", text, maxTextLength, fmt.Sprintf("annotation.text must be a string of at most %d characters.", maxTextLength))
	}
	if tone := field(v, "tone"); !isUndefined(tone) {
		c.oneOfMsg(path+".tone", tone, tones, "annotation.tone must be bull, bear, neutral or accent.")
	}
	if color := field(v, "color"); !isUndefined(color) {
		c.short(path+".color", color, 128, "annotation.color must be a short CSS color string.")
	}
	return key, usable
}

func (c *checker) annotations(path string, v any) {
	list, ok := v.([]any)
	if !ok {
		c.wrongType(path, v, "annotations must be an array.")
		return
	}
	if len(list) > maxAnnotations {
		c.add(path, CodeLimit, fmt.Sprintf("at most %d annotations per chart.", maxAnnotations))
	}
	keys := make(map[string]bool, len(list))
	for i, item := range list {
		key, usable := c.annotation(fmt.Sprintf("%s[%d]", path, i), item)
		if !usable {
			continue
		}
		if keys[key] {
			c.add(fmt.Sprintf("%s[%d].key", path, i), CodeUnique, fmt.Sprintf("duplicate annotation key %q.", key))
		}
		keys[key] = true
	}
}

// ValidatePeriod returns "" when the period is valid, otherwise the first problem.
func ValidatePeriod(v any) string {
	return firstMessage(func(c *checker) { c.period("period", v) })
}

// ValidateSymbol returns "" when the symbol is valid, otherwise the first problem.
func ValidateSymbol(v any) string {
	return firstMessage(func(c *checker) { c.symbol("symbol", v) })
}

// ValidateMarketBar returns "" when the bar is valid, otherwise the first problem.
func ValidateMarketBar(v any) string {
	return firstMessage(func(c *checker) { c.bar("", v) })
}

// ValidateChartAnnotation returns "" when the annotation is valid, otherwise the first problem.
func ValidateChartAnnotation(v any) string {
	return firstMessage(func(c *checker) { c.annotation("", v) })
}

// ValidateChartAnnotations returns "" when every annotation is valid and keys are unique, otherwise the first problem.
func ValidateChartAnnotations(v any) string {
	return firstMessage(func(c *checker) { c.annotations("", v) })
}

// ValidateChartCardSpec checks the spec of a `super-chart.chart` card.
func ValidateChartCardSpec(spec any) CardResult {
	c := newChecker()
	if !isObject(spec) {
		c.wrongType("", spec, "Chart card spec must be an object.")
		return cardResult(c.issues)
	}
	c.oneOfMsg("kind", field(spec, "kind"), []string{ChartCardKind}, fmt.Sprintf("kind must be %q.", ChartCardKind))
	if id := field(spec, "id"); !isUndefined(id) {
		message := "id must be a non-empty string."
		c.filled("id", id, message)
		if s, ok := asString(id); ok && trim(s) != "" && jsLength(s) > 128 {
			c.add("id", CodeLength, message)
		}
	}
	if title := field(spec, "title"); !isUndefined(title) {
		c.strMsg("title", title, "title must be a string.")
	}
	c.symbol("symbol", field(spec, "symbol"))
	c.period("period", field(spec, "period"))
	if h := field(spec, "height"); !isUndefined(h) {
		c.finiteBetween("height", h, minHeight, maxHeight, fmt.Sprintf("height must be %d..%d pixels.", minHeight, maxHeight))
	}
	if t := field(spec, "chartType"); !isUndefined(t) {
		c.oneOfMsg("chartType", t, ChartTypes, "chartType must be one of "+strings.Join(ChartTypes, ", ")+".")
	}
	bars, feed := field(spec, "bars"), field(spec, "feed")
	hasBars, hasFeed := !isUndefined(bars), !isUndefined(feed)
	if hasBars == hasFeed {
		c.addHint("", CodeExclusive, "Provide exactly one of `bars` or `feed`.", "bars: [{timestamp, open, high, low, close, volume?}] | feed: { id }")
	}
	if hasBars {
		list, ok := bars.([]any)
		switch {
		case !ok:
			c.wrongType("bars", bars, "bars must be a non-empty array.")
		case len(list) == 0:
			c.add("bars", CodeEmpty, "bars must be a non-empty array.")
		default:
			if len(list) > maxBars {
				c.add("bars", CodeLimit, fmt.Sprintf("at most %d inline bars; reference a feed for more.", maxBars))
			}
			previous := math.Inf(-1)
			for i, bar := range list {
				c.bar(fmt.Sprintf("bars[%d]", i), bar)
				t, isNumber := field(bar, "timestamp").(float64)
				if !isNumber || !finite(t) {
					continue
				}
				if t <= previous {
					c.add(fmt.Sprintf("bars[%d].timestamp", i), CodeOrder, "bars must be sorted oldest first with unique timestamps.")
				}
				previous = t
			}
		}
	}
	if hasFeed {
		message := "feed needs a non-empty id."
		if !isObject(feed) {
			c.wrongType("feed", feed, message)
		} else {
			c.filled("feed.id", field(feed, "id"), message)
		}
	}
	if indicators := field(spec, "indicators"); !isUndefined(indicators) {
		message := fmt.Sprintf("indicators must be an array of at most %d.", maxIndicators)
		list, ok := indicators.([]any)
		if !ok {
			c.wrongType("indicators", indicators, message)
		} else {
			if len(list) > maxIndicators {
				c.add("indicators", CodeLimit, message)
			}
			for k, item := range list {
				p := fmt.Sprintf("indicators[%d]", k)
				if !isObject(item) {
					c.wrongType(p, item, "each indicator needs a name.")
					continue
				}
				c.filled(p+".name", field(item, "name"), "each indicator needs a name.")
				if params := field(item, "params"); !isUndefined(params) {
					message := "indicator params must be an array of finite numbers."
					values, ok := params.([]any)
					if !ok {
						c.wrongType(p+".params", params, message)
					} else {
						for j, n := range values {
							c.finiteNumber(fmt.Sprintf("%s.params[%d]", p, j), n, message)
						}
					}
				}
			}
		}
	}
	if annotations := field(spec, "annotations"); !isUndefined(annotations) {
		c.annotations("annotations", annotations)
	}
	return cardResult(c.issues)
}

const plotExpected = `spec: { type: "bar", data: [{ region: "EU", revenue: 12 }, { region: "US", revenue: 20 }], x: "region", y: "revenue" } (the plot itself, its data inside it), alt: "one sentence saying what the plot shows" (beside spec, not inside it)`

// ValidatePlotCardSpec checks the envelope of a `super.plot` card; the inner `spec` is opaque and checked by the
// plugin that draws it. The errors are for the model and the developer log, not for the user.
func ValidatePlotCardSpec(spec any) CardResult {
	c := newChecker()
	if !isObject(spec) {
		c.wrongType("", spec, "Plot card spec must be an object.")
		return cardResult(c.issues)
	}
	c.oneOfMsg("kind", field(spec, "kind"), []string{PlotCardKind}, fmt.Sprintf("kind must be %q.", PlotCardKind))
	if id := field(spec, "id"); !isUndefined(id) {
		message := "id must be a non-empty string."
		c.filled("id", id, message)
		if s, ok := asString(id); ok && trim(s) != "" && jsLength(s) > maxPlotID {
			c.add("id", CodeLength, message)
		}
	}
	if title := field(spec, "title"); !isUndefined(title) {
		c.strMsg("title", title, "title must be a string.")
	}
	if h := field(spec, "height"); !isUndefined(h) {
		c.finiteBetween("height", h, minHeight, maxHeight, fmt.Sprintf("height must be %d..%d pixels.", minHeight, maxHeight))
	}
	if inner := field(spec, "spec"); !isObject(inner) {
		message := "spec must be an object: the plot spec."
		if isUndefined(inner) {
			c.addHint("spec", CodeRequired, message, plotExpected)
		} else {
			c.wrongType("spec", inner, message)
		}
	}
	alt := field(spec, "alt")
	message := "alt must be a non-empty string saying what the plot shows."
	if isUndefined(alt) {
		c.addHint("alt", CodeRequired, message, plotExpected)
	} else {
		c.filled("alt", alt, message)
	}
	if s, ok := asString(alt); ok && trim(s) != "" && jsLength(s) > maxPlotAlt {
		c.add("alt", CodeLength, fmt.Sprintf("alt must be at most %d characters.", maxPlotAlt))
	}
	return cardResult(c.issues)
}

// IsTerminalEvent reports whether a stream event type ends a request.
func IsTerminalEvent(eventType string) bool {
	return eventType == "request.completed" || eventType == "request.failed" || eventType == "request.replayed"
}
