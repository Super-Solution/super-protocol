// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"fmt"
	"regexp"
)

// What a gateway accepts and what it streams back, as pure functions: ValidateInferenceMessage,
// ValidateInferenceRequest and ValidateStreamEvent return every problem found, and InferenceStreamOutcomeOf says what a
// stopped stream means. Unknown extra keys are not refused. Ported from router.ts.

var (
	InferenceRoles         = []string{"system", "user", "assistant", "tool"}
	InferenceFinishReasons = []string{"stop", "length", "tool_calls"}
	ExecutionStatuses      = []string{"succeeded", "failed", "cancelled", "unknown"}
	StreamEventTypes       = []string{
		"request.started", "output.delta", "output.tool_call.delta", "output.tool_call.completed",
		"request.completed", "request.failed", "request.replayed",
	}

	imageDetails = []string{"auto", "low", "high"}
	toolNameRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	dataImageRe  = regexp.MustCompile(`^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$`)
	usageMeters  = []string{"input", "cached", "cache_write", "output"}
	usageExtras  = []string{"images", "video_ms", "audio_ms", "tasks"}
)

// InferenceStreamOutcome is what a stream that has stopped says about its request.
type InferenceStreamOutcome string

const (
	InferenceStreamEmpty       InferenceStreamOutcome = "empty"
	InferenceStreamCompleted   InferenceStreamOutcome = "completed"
	InferenceStreamFailed      InferenceStreamOutcome = "failed"
	InferenceStreamReplayed    InferenceStreamOutcome = "replayed"
	InferenceStreamInterrupted InferenceStreamOutcome = "interrupted"
)

func (c *checker) toolName(path string, v any) {
	if s, ok := asString(v); !ok || !toolNameRe.MatchString(s) {
		c.add(path, "must be 1 to 64 letters, digits, _ or -")
	}
}

func (c *checker) positive(path string, v any) {
	if !(isInteger(v) && v.(float64) >= 1) {
		c.add(path, "must be a positive integer")
	}
}

func (c *checker) contentParts(path string, list []any) {
	if len(list) == 0 {
		c.add(path, "must not be empty")
		return
	}
	for i, part := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !isObject(part) {
			c.add(p, "must be an object")
			continue
		}
		partType, _ := get(part, "type")
		c.oneOf(p+".type", partType, []string{"text", "image"})
		switch partType {
		case "text":
			text, _ := get(part, "text")
			c.str(p+".text", text)
		case "image":
			url, _ := get(part, "url")
			if s, ok := asString(url); !ok || !(isHTTPSURL(s) || dataImageRe.MatchString(s)) {
				c.add(p+".url", "must be an https URL or a data:image URL (png, jpeg, gif or webp, base64)")
			}
			if detail, present := get(part, "detail"); present {
				c.oneOf(p+".detail", detail, imageDetails)
			}
		}
	}
}

func (c *checker) toolCalls(path string, v any, made map[string]bool) {
	list, ok := v.([]any)
	if !ok {
		c.add(path, "must be an array")
		return
	}
	if len(list) == 0 {
		c.add(path, "must not be empty")
		return
	}
	own := map[string]bool{}
	for i, call := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !isObject(call) {
			c.add(p, "must be an object")
			continue
		}
		id, _ := get(call, "id")
		c.text(p+".id", id)
		name, _ := get(call, "name")
		c.toolName(p+".name", name)
		args, _ := get(call, "arguments")
		c.str(p+".arguments", args)
		if s, ok := asString(id); ok && s != "" {
			if own[s] {
				c.add(p+".id", "duplicate tool call id")
			}
			own[s] = true
		}
	}
	for id := range own {
		made[id] = true
	}
}

// message checks one message; made is the set of tool call ids earlier assistant messages made, or nil to skip the
// check that a tool result answers one of them.
func (c *checker) message(path string, v any, made map[string]bool) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	at := func(key string) string {
		if path == "" {
			return key
		}
		return path + "." + key
	}
	field := func(key string) any { x, _ := get(v, key); return x }
	role, _ := asString(field("role"))
	if !contains(InferenceRoles, role) {
		c.oneOf(at("role"), field("role"), InferenceRoles)
		return
	}
	switch role {
	case "system":
		c.str(at("content"), field("content"))
	case "user":
		if list, ok := field("content").([]any); ok {
			c.contentParts(at("content"), list)
		} else if !isString(field("content")) {
			c.add(at("content"), "must be a string or an array of content parts")
		}
	case "assistant":
		if calls, present := get(v, "tool_calls"); present {
			own := made
			if own == nil {
				own = map[string]bool{}
			}
			c.toolCalls(at("tool_calls"), calls, own)
			if content, present := get(v, "content"); present {
				c.str(at("content"), content)
			}
		} else {
			c.str(at("content"), field("content"))
		}
	default:
		c.text(at("tool_call_id"), field("tool_call_id"))
		c.str(at("content"), field("content"))
		if isError, present := get(v, "is_error"); present {
			c.boolean(at("is_error"), isError)
		}
		if id, ok := asString(field("tool_call_id")); made != nil && ok && id != "" && !made[id] {
			c.add(at("tool_call_id"), "no earlier assistant message made this tool call")
		}
	}
}

// ValidateInferenceMessage checks one message on its own: its role, its content and, for an assistant, its tool calls.
// Whether a tool result answers a call an earlier message made needs the whole conversation; ValidateInferenceRequest
// checks it.
func ValidateInferenceMessage(value any) []ManifestIssue {
	c := &checker{issues: []ManifestIssue{}}
	c.message("", value, nil)
	return c.issues
}

// ValidateInferenceRequest checks a request before it is sent: whether it is well formed, not whether a given gateway
// can serve it.
func ValidateInferenceRequest(value any) []ManifestIssue {
	if !isObject(value) {
		return []ManifestIssue{{Path: "", Message: "request must be an object"}}
	}
	c := &checker{issues: []ManifestIssue{}}
	field := func(key string) any { x, _ := get(value, key); return x }
	c.text("service", field("service"))
	if v, present := get(value, "service_version"); present {
		c.count("service_version", v)
	}
	c.text("customer_id", field("customer_id"))
	if messages, ok := field("messages").([]any); !ok || len(messages) == 0 {
		c.add("messages", "must be a non-empty array")
	} else {
		made := map[string]bool{}
		for i, m := range messages {
			c.message(fmt.Sprintf("messages[%d]", i), m, made)
		}
	}
	if tools, present := get(value, "tools"); present {
		list, ok := tools.([]any)
		if !ok {
			c.add("tools", "must be an array")
		} else {
			names := map[string]bool{}
			for i, tool := range list {
				p := fmt.Sprintf("tools[%d]", i)
				if !isObject(tool) {
					c.add(p, "must be an object")
					continue
				}
				name, _ := get(tool, "name")
				c.toolName(p+".name", name)
				if d, present := get(tool, "description"); present {
					c.str(p+".description", d)
				}
				schema, _ := get(tool, "input_schema")
				if t, _ := get(schema, "type"); !isObject(schema) || t != "object" {
					c.add(p+".input_schema", `must be a JSON Schema object with type "object"`)
				}
				if s, ok := asString(name); ok && toolNameRe.MatchString(s) {
					if names[s] {
						c.add(p+".name", "duplicate tool name")
					}
					names[s] = true
				}
			}
		}
	}
	if choice, present := get(value, "tool_choice"); present {
		if isObject(choice) {
			name, _ := get(choice, "name")
			c.toolName("tool_choice.name", name)
		} else if choice != "auto" && choice != "none" && choice != "required" {
			c.add("tool_choice", `must be "auto", "none", "required" or { name }`)
		}
	}
	if v, present := get(value, "max_output_tokens"); present {
		c.positive("max_output_tokens", v)
	}
	if v, present := get(value, "timeout_ms"); present {
		c.positive("timeout_ms", v)
	}
	return c.issues
}

func (c *checker) inferenceUsage(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	status, _ := get(v, "status")
	c.text(path+".status", status)
	meters, present := get(v, "meters")
	if !present {
		return
	}
	if !isObject(meters) {
		c.add(path+".meters", "must be an object")
		return
	}
	for _, k := range usageMeters {
		n, _ := get(meters, k)
		c.count(path+".meters."+k, n)
	}
	for _, k := range usageExtras {
		if n, present := get(meters, k); present {
			c.count(path+".meters."+k, n)
		}
	}
}

// ValidateStreamEvent checks one stream event of the gateway. It is for whoever produces events; a consumer skips a
// type it does not know (see InferenceStreamOutcomeOf), since later versions add types.
func ValidateStreamEvent(value any) []ManifestIssue {
	if !isObject(value) {
		return []ManifestIssue{{Path: "", Message: "event must be an object"}}
	}
	typeValue, _ := get(value, "type")
	eventType, ok := asString(typeValue)
	if !ok {
		return []ManifestIssue{{Path: "type", Message: "must be a string"}}
	}
	if !contains(StreamEventTypes, eventType) {
		return []ManifestIssue{{Path: "type", Message: "unknown stream event type"}}
	}
	c := &checker{issues: []ManifestIssue{}}
	field := func(key string) any { x, _ := get(value, key); return x }
	c.text("request_id", field("request_id"))
	c.count("sequence", field("sequence"))
	switch eventType {
	case "request.started":
		c.count("service_version", field("service_version"))
	case "output.delta":
		c.str("text", field("text"))
	case "output.tool_call.delta":
		c.count("index", field("index"))
		if id, present := get(value, "id"); present {
			c.text("id", id)
		}
		if name, present := get(value, "name"); present {
			c.toolName("name", name)
		}
		c.str("arguments_delta", field("arguments_delta"))
	case "output.tool_call.completed":
		c.count("index", field("index"))
		c.text("id", field("id"))
		c.toolName("name", field("name"))
		c.str("arguments", field("arguments"))
	case "request.completed":
		c.oneOf("execution_status", field("execution_status"), ExecutionStatuses)
		c.text("billing_status", field("billing_status"))
		if v, present := get(value, "finish_reason"); present {
			c.oneOf("finish_reason", v, InferenceFinishReasons)
		}
		if v, present := get(value, "usage"); present {
			c.inferenceUsage("usage", v)
		}
	case "request.failed":
		if v, present := get(value, "execution_status"); present {
			c.oneOf("execution_status", v, ExecutionStatuses)
		}
		if v, present := get(value, "billing_status"); present {
			c.text("billing_status", v)
		}
		if e, present := get(value, "error"); present {
			if !isObject(e) {
				c.object("error", e)
			} else {
				code, _ := get(e, "code")
				c.text("error.code", code)
			}
		}
		if v, present := get(value, "usage"); present {
			c.inferenceUsage("usage", v)
		}
	}
	return c.issues
}

// InferenceStreamOutcomeOf says what a stream that has stopped means for its request: the first terminal event it
// delivered, "interrupted" when it stopped before one (collectText throws stream_interrupted for it), or "empty" when
// it held no stream event of a known type. Values that are not stream events of a known type are skipped.
func InferenceStreamOutcomeOf(events []any) InferenceStreamOutcome {
	seen := false
	for _, event := range events {
		typeValue, _ := get(event, "type")
		eventType, ok := asString(typeValue)
		if !ok || !contains(StreamEventTypes, eventType) {
			continue
		}
		seen = true
		switch eventType {
		case "request.completed":
			return InferenceStreamCompleted
		case "request.failed":
			return InferenceStreamFailed
		case "request.replayed":
			return InferenceStreamReplayed
		}
	}
	if seen {
		return InferenceStreamInterrupted
	}
	return InferenceStreamEmpty
}
