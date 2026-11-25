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
	toolChoices  = []string{"auto", "none", "required"}
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
	message := "must be 1 to 64 letters, digits, _ or -"
	if s, ok := asString(v); !ok {
		c.wrongType(path, v, message)
	} else if !toolNameRe.MatchString(s) {
		c.add(path, CodeFormat, message)
	}
}

func (c *checker) positive(path string, v any) {
	message := "must be a positive integer"
	if _, ok := v.(float64); !ok {
		c.wrongType(path, v, message)
	} else if !(isInteger(v) && v.(float64) >= 1) {
		c.add(path, CodeRange, message)
	}
}

func (c *checker) contentParts(path string, list []any) {
	if len(list) == 0 {
		c.add(path, CodeEmpty, "must not be empty")
		return
	}
	for i, part := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !isObject(part) {
			c.wrongType(p, part, "must be an object")
			continue
		}
		partType := field(part, "type")
		c.oneOf(p+".type", partType, []string{"text", "image"})
		switch partType {
		case "text":
			c.str(p+".text", field(part, "text"))
		case "image":
			message := "must be an https URL or a data:image URL (png, jpeg, gif or webp, base64)"
			url := field(part, "url")
			if s, ok := asString(url); !ok {
				c.wrongType(p+".url", url, message)
			} else if !(isHTTPSURL(s) || dataImageRe.MatchString(s)) {
				c.add(p+".url", CodeFormat, message)
			}
			if detail := field(part, "detail"); !isUndefined(detail) {
				c.oneOf(p+".detail", detail, imageDetails)
			}
		}
	}
}

func (c *checker) toolCalls(path string, v any, made map[string]bool) {
	list, ok := v.([]any)
	if !ok {
		c.wrongType(path, v, "must be an array")
		return
	}
	if len(list) == 0 {
		c.add(path, CodeEmpty, "must not be empty")
		return
	}
	own := map[string]bool{}
	for i, call := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !isObject(call) {
			c.wrongType(p, call, "must be an object")
			continue
		}
		id := field(call, "id")
		c.text(p+".id", id)
		c.toolName(p+".name", field(call, "name"))
		c.str(p+".arguments", field(call, "arguments"))
		if s, ok := asString(id); ok && s != "" {
			if own[s] {
				c.add(p+".id", CodeUnique, "duplicate tool call id")
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
		c.wrongType(path, v, "must be an object")
		return
	}
	at := func(key string) string {
		if path == "" {
			return key
		}
		return path + "." + key
	}
	role, _ := asString(field(v, "role"))
	if !contains(InferenceRoles, role) {
		c.oneOf(at("role"), field(v, "role"), InferenceRoles)
		return
	}
	switch role {
	case "system":
		c.str(at("content"), field(v, "content"))
	case "user":
		content := field(v, "content")
		if list, ok := content.([]any); ok {
			c.contentParts(at("content"), list)
		} else if !isString(content) {
			c.wrongType(at("content"), content, "must be a string or an array of content parts")
		}
	case "assistant":
		if calls := field(v, "tool_calls"); !isUndefined(calls) {
			own := made
			if own == nil {
				own = map[string]bool{}
			}
			c.toolCalls(at("tool_calls"), calls, own)
			if content := field(v, "content"); !isUndefined(content) {
				c.str(at("content"), content)
			}
		} else {
			c.str(at("content"), field(v, "content"))
		}
	default:
		c.text(at("tool_call_id"), field(v, "tool_call_id"))
		c.str(at("content"), field(v, "content"))
		if isError := field(v, "is_error"); !isUndefined(isError) {
			c.boolean(at("is_error"), isError)
		}
		if id, ok := asString(field(v, "tool_call_id")); made != nil && ok && id != "" && !made[id] {
			c.add(at("tool_call_id"), CodeReference, "no earlier assistant message made this tool call")
		}
	}
}

// ValidateInferenceMessage checks one message on its own: its role, its content and, for an assistant, its tool calls.
// Whether a tool result answers a call an earlier message made needs the whole conversation; ValidateInferenceRequest
// checks it.
func ValidateInferenceMessage(value any) []Issue {
	c := newChecker()
	c.message("", value, nil)
	return c.issues
}

// ValidateInferenceRequest checks a request before it is sent: whether it is well formed, not whether a given gateway
// can serve it.
func ValidateInferenceRequest(value any) []Issue {
	c := newChecker()
	if !isObject(value) {
		c.wrongType("", value, "request must be an object")
		return c.issues
	}
	c.text("service", field(value, "service"))
	if v := field(value, "service_version"); !isUndefined(v) {
		c.count("service_version", v)
	}
	c.text("customer_id", field(value, "customer_id"))
	messages := field(value, "messages")
	if list, ok := messages.([]any); !ok {
		c.wrongType("messages", messages, "must be a non-empty array")
	} else if len(list) == 0 {
		c.add("messages", CodeEmpty, "must be a non-empty array")
	} else {
		made := map[string]bool{}
		for i, m := range list {
			c.message(fmt.Sprintf("messages[%d]", i), m, made)
		}
	}
	if tools := field(value, "tools"); !isUndefined(tools) {
		list, ok := tools.([]any)
		if !ok {
			c.wrongType("tools", tools, "must be an array")
		} else {
			names := map[string]bool{}
			for i, tool := range list {
				p := fmt.Sprintf("tools[%d]", i)
				if !isObject(tool) {
					c.wrongType(p, tool, "must be an object")
					continue
				}
				name := field(tool, "name")
				c.toolName(p+".name", name)
				if d := field(tool, "description"); !isUndefined(d) {
					c.str(p+".description", d)
				}
				schema := field(tool, "input_schema")
				message := `must be a JSON Schema object with type "object"`
				if !isObject(schema) {
					c.wrongType(p+".input_schema", schema, message)
				} else if t := field(schema, "type"); t != "object" {
					c.add(p+".input_schema", CodeShape, message)
				}
				if s, ok := asString(name); ok && toolNameRe.MatchString(s) {
					if names[s] {
						c.add(p+".name", CodeUnique, "duplicate tool name")
					}
					names[s] = true
				}
			}
		}
	}
	if choice := field(value, "tool_choice"); !isUndefined(choice) {
		if isObject(choice) {
			c.toolName("tool_choice.name", field(choice, "name"))
		} else if choice != "auto" && choice != "none" && choice != "required" {
			message := `must be "auto", "none", "required" or { name }`
			if s, ok := choice.(string); ok {
				if hint := DidYouMean(s, toolChoices); hint != "" {
					c.addHint("tool_choice", CodeEnum, message, hint)
				} else {
					c.add("tool_choice", CodeEnum, message)
				}
			} else {
				c.addHint("tool_choice", CodeType, message, "got "+jsonType(choice))
			}
		}
	}
	if v := field(value, "max_output_tokens"); !isUndefined(v) {
		c.positive("max_output_tokens", v)
	}
	if v := field(value, "timeout_ms"); !isUndefined(v) {
		c.positive("timeout_ms", v)
	}
	return c.issues
}

func (c *checker) inferenceUsage(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "must be an object")
		return
	}
	c.text(path+".status", field(v, "status"))
	meters := field(v, "meters")
	if isUndefined(meters) {
		return
	}
	if !isObject(meters) {
		c.wrongType(path+".meters", meters, "must be an object")
		return
	}
	for _, k := range usageMeters {
		c.count(path+".meters."+k, field(meters, k))
	}
	for _, k := range usageExtras {
		if n := field(meters, k); !isUndefined(n) {
			c.count(path+".meters."+k, n)
		}
	}
}

// ValidateStreamEvent checks one stream event of the gateway. It is for whoever produces events; a consumer skips a
// type it does not know (see InferenceStreamOutcomeOf), since later versions add types.
func ValidateStreamEvent(value any) []Issue {
	c := newChecker()
	if !isObject(value) {
		c.wrongType("", value, "event must be an object")
		return c.issues
	}
	typeValue := field(value, "type")
	eventType, ok := asString(typeValue)
	if !ok {
		c.wrongType("type", typeValue, "must be a string")
		return c.issues
	}
	if !contains(StreamEventTypes, eventType) {
		if hint := DidYouMean(eventType, StreamEventTypes); hint != "" {
			c.addHint("type", CodeEnum, "unknown stream event type", hint)
		} else {
			c.add("type", CodeEnum, "unknown stream event type")
		}
		return c.issues
	}
	ev := func(key string) any { return field(value, key) }
	c.text("request_id", ev("request_id"))
	c.count("sequence", ev("sequence"))
	switch eventType {
	case "request.started":
		c.count("service_version", ev("service_version"))
	case "output.delta":
		c.str("text", ev("text"))
	case "output.tool_call.delta":
		c.count("index", ev("index"))
		if id := ev("id"); !isUndefined(id) {
			c.text("id", id)
		}
		if name := ev("name"); !isUndefined(name) {
			c.toolName("name", name)
		}
		c.str("arguments_delta", ev("arguments_delta"))
	case "output.tool_call.completed":
		c.count("index", ev("index"))
		c.text("id", ev("id"))
		c.toolName("name", ev("name"))
		c.str("arguments", ev("arguments"))
	case "request.completed":
		c.oneOf("execution_status", ev("execution_status"), ExecutionStatuses)
		c.text("billing_status", ev("billing_status"))
		if v := ev("finish_reason"); !isUndefined(v) {
			c.oneOf("finish_reason", v, InferenceFinishReasons)
		}
		if v := ev("usage"); !isUndefined(v) {
			c.inferenceUsage("usage", v)
		}
	case "request.failed":
		if v := ev("execution_status"); !isUndefined(v) {
			c.oneOf("execution_status", v, ExecutionStatuses)
		}
		if v := ev("billing_status"); !isUndefined(v) {
			c.text("billing_status", v)
		}
		if e := ev("error"); !isUndefined(e) {
			if !isObject(e) {
				c.object("error", e)
			} else {
				c.text("error.code", field(e, "code"))
			}
		}
		if v := ev("usage"); !isUndefined(v) {
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
