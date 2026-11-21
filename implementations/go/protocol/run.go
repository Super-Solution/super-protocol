// SPDX-License-Identifier: Apache-2.0

package protocol

import (
	"fmt"
	"strings"
)

// Run events: what an agent turn reports while it runs, wherever the loop lives. A server written
// in Go checks what it sends with ValidateRunEvent, and anything that follows a stream asks
// RunStreamOutcome what a closed connection means. docs/RUN-EVENTS.md has the event table.

var (
	// RunEventTypes is every run event type this version knows.
	RunEventTypes = []string{
		"run-start", "run-snapshot", "context-built", "step-start", "text-delta", "reasoning-delta",
		"tool-call-input-delta", "tool-call", "awaiting-user", "user-responded", "tool-result", "card",
		"card-updated", "step-finish", "job-started", "job-status", "message", "metering", "usage",
		"run-finish", "error",
	}
	RunModes = []string{"stream", "sync", "background"}
	// RunFinishReasons is why a step or a run stopped. "cancelled" is the person stopping it.
	RunFinishReasons = []string{"stop", "length", "tool-calls", "content-filter", "cancelled", "error", "unknown"}
	// RunCardActionTypes is what a person can do with a card that waits for them.
	RunCardActionTypes = []string{"submit", "select", "confirm", "cancel", "dismiss"}
	RunJobStatuses     = []string{"queued", "in_progress", "completed", "failed", "cancelled", "incomplete"}

	runUsageFields = []string{"inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"}
)

// RunEventIssue is one problem found in a run event.
type RunEventIssue = ManifestIssue

// RunStreamOutcome is what a stream that has stopped says about its run.
type RunStreamOutcome string

const (
	// RunStreamEmpty: no run event at all, so there was nothing to follow.
	RunStreamEmpty RunStreamOutcome = "empty"
	// RunStreamFinished: the run ended.
	RunStreamFinished RunStreamOutcome = "finished"
	// RunStreamAwaitingUser: the run is suspended on a card the person has not answered.
	RunStreamAwaitingUser RunStreamOutcome = "awaiting-user"
	// RunStreamInterrupted: the run was still working when the stream stopped, and may be running still.
	RunStreamInterrupted RunStreamOutcome = "interrupted"
)

type runChecker struct{ issues []RunEventIssue }

func (c *runChecker) add(path, message string) {
	c.issues = append(c.issues, RunEventIssue{Path: path, Message: message})
}

func isCount(v any) bool  { return isInteger(v) && v.(float64) >= 0 }
func isAmount(v any) bool { return finite(v) && v.(float64) >= 0 }

func (c *runChecker) text(path string, v any) {
	if s, ok := asString(v); !ok || s == "" {
		c.add(path, "must be a non-empty string")
	}
}

func (c *runChecker) oneOf(path string, v any, allowed []string) {
	if s, ok := asString(v); !ok || !contains(allowed, s) {
		c.add(path, "must be one of "+strings.Join(allowed, ", "))
	}
}

func (c *runChecker) count(path string, v any) {
	if !isCount(v) {
		c.add(path, "must be a non-negative integer")
	}
}

func (c *runChecker) object(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
	}
}

func (c *runChecker) str(path string, v any) {
	if !isString(v) {
		c.add(path, "must be a string")
	}
}

func (c *runChecker) boolean(path string, v any) {
	if _, ok := v.(bool); !ok {
		c.add(path, "must be a boolean")
	}
}

func (c *runChecker) usage(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	for _, field := range runUsageFields {
		if n, present := get(v, field); present && !isAmount(n) {
			c.add(path+"."+field, "must be a non-negative number")
		}
	}
}

func (c *runChecker) spec(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	kind, _ := get(v, "kind")
	c.text(path+".kind", kind)
}

func (c *runChecker) action(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	cardID, _ := get(v, "cardId")
	c.text(path+".cardId", cardID)
	if callID, present := get(v, "callId"); present {
		c.text(path+".callId", callID)
	}
	kind, _ := get(v, "kind")
	c.text(path+".kind", kind)
	actionType, _ := get(v, "type")
	c.oneOf(path+".type", actionType, RunCardActionTypes)
	if at, _ := get(v, "at"); !isAmount(at) {
		c.add(path+".at", "must be a non-negative number")
	}
}

func (c *runChecker) card(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	id, _ := get(v, "id")
	c.text(path+".id", id)
	spec, _ := get(v, "spec")
	c.spec(path+".spec", spec)
	if expired, present := get(v, "expired"); present {
		c.boolean(path+".expired", expired)
	}
	if callID, present := get(v, "callId"); present {
		c.text(path+".callId", callID)
	}
	if action, present := get(v, "action"); present {
		c.action(path+".action", action)
	}
}

func (c *runChecker) parts(path string, v any) {
	list, ok := v.([]any)
	if !ok {
		c.add(path, "must be an array")
		return
	}
	for i, part := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !isObject(part) {
			c.add(p, "must be an object")
			continue
		}
		partType, _ := get(part, "type")
		c.text(p+".type", partType)
	}
}

func (c *runChecker) handle(path string, v any) {
	if !isObject(v) {
		c.add(path, "must be an object")
		return
	}
	provider, _ := get(v, "provider")
	c.text(path+".provider", provider)
	id, _ := get(v, "id")
	c.text(path+".id", id)
}

// optional runs check on a field only when the event has it.
func (c *runChecker) optional(e any, key string, check func(path string, v any)) {
	if v, present := get(e, key); present {
		check(key, v)
	}
}

// ValidateRunEvent returns every problem found; an empty slice means the event is a valid run event.
//
// It is for whoever produces events. A follower should not refuse a stream over an event type it
// does not know (see IsRunEventType); later versions add types.
func ValidateRunEvent(e any) []RunEventIssue {
	if !isObject(e) {
		return []RunEventIssue{{Path: "", Message: "event must be an object"}}
	}
	typeValue, _ := get(e, "type")
	eventType, ok := asString(typeValue)
	if !ok {
		return []RunEventIssue{{Path: "type", Message: "must be a string"}}
	}
	c := &runChecker{issues: []RunEventIssue{}}
	field := func(key string) any { v, _ := get(e, key); return v }
	switch eventType {
	case "run-start":
		c.text("runId", field("runId"))
		c.oneOf("mode", field("mode"), RunModes)
	case "run-snapshot":
		c.parts("parts", field("parts"))
		if cards, ok := field("cards").([]any); !ok {
			c.add("cards", "must be an array")
		} else {
			for i, card := range cards {
				c.card(fmt.Sprintf("cards[%d]", i), card)
			}
		}
		c.optional(e, "usage", c.usage)
		c.optional(e, "steps", c.count)
	case "context-built":
		c.object("trace", field("trace"))
		c.str("system", field("system"))
		if names, ok := field("toolNames").([]any); !ok {
			c.add("toolNames", "must be an array")
		} else {
			for i, name := range names {
				c.str(fmt.Sprintf("toolNames[%d]", i), name)
			}
		}
	case "step-start":
		c.count("step", field("step"))
	case "text-delta", "reasoning-delta":
		c.str("delta", field("delta"))
	case "tool-call-input-delta":
		c.text("callId", field("callId"))
		c.text("name", field("name"))
		c.optional(e, "partialCard", c.spec)
		c.optional(e, "loading", c.object)
	case "tool-call":
		c.text("callId", field("callId"))
		c.text("name", field("name"))
		c.optional(e, "repaired", c.boolean)
		c.optional(e, "loading", c.object)
	case "awaiting-user":
		c.text("callId", field("callId"))
		c.card("card", field("card"))
	case "user-responded":
		c.text("callId", field("callId"))
		c.action("action", field("action"))
	case "tool-result":
		c.text("callId", field("callId"))
		c.text("name", field("name"))
		c.optional(e, "failure", c.str)
		if !isAmount(field("ms")) {
			c.add("ms", "must be a non-negative number")
		}
	case "card":
		c.card("card", field("card"))
	case "card-updated":
		c.text("cardId", field("cardId"))
		c.spec("spec", field("spec"))
	case "step-finish":
		c.count("step", field("step"))
		c.oneOf("finishReason", field("finishReason"), RunFinishReasons)
		c.optional(e, "usage", c.usage)
	case "job-started":
		c.handle("handle", field("handle"))
	case "job-status":
		c.handle("handle", field("handle"))
		c.oneOf("status", field("status"), RunJobStatuses)
	case "message":
		c.parts("parts", field("parts"))
	case "metering":
		c.object("record", field("record"))
	case "usage":
		c.usage("usage", field("usage"))
	case "run-finish":
		c.text("runId", field("runId"))
		c.oneOf("finishReason", field("finishReason"), RunFinishReasons)
		c.usage("usage", field("usage"))
		c.count("steps", field("steps"))
	case "error":
		c.boolean("recoverable", field("recoverable"))
	default:
		c.add("type", "unknown run event type")
	}
	return c.issues
}

// IsRunEventType reports whether eventType is a run event type this version knows. A follower skips
// the ones it does not.
func IsRunEventType(eventType string) bool { return contains(RunEventTypes, eventType) }

// IsRunTerminalEvent reports whether an event of this type ends its run. Only "run-finish" does: an
// "error" event is followed by one.
func IsRunTerminalEvent(eventType string) bool { return eventType == "run-finish" }

// RunStreamOutcomeOf says what a stream that has stopped means for its run. Call it when the
// connection closes, with every event the stream delivered (decoded JSON), in order.
//
// A closed connection is not the end of a run: a run that waits for approval closes its stream and
// stays suspended, and a dropped connection leaves the run working on the server. Only "run-finish"
// ends it. Values that are not run events of a known type are skipped. "run-start" and
// "run-snapshot" start the picture over.
func RunStreamOutcomeOf(events []any) RunStreamOutcome {
	seen, finished := false, false
	waiting := map[string]bool{}
	for _, event := range events {
		typeValue, _ := get(event, "type")
		eventType, ok := asString(typeValue)
		if !ok || !IsRunEventType(eventType) {
			continue
		}
		seen = true
		callValue, _ := get(event, "callId")
		callID, _ := asString(callValue)
		switch eventType {
		case "run-start", "run-snapshot":
			finished = false
			waiting = map[string]bool{}
		case "awaiting-user":
			finished = false
			waiting[callID] = true
		case "user-responded", "tool-result":
			delete(waiting, callID)
		case "run-finish":
			finished = true
			waiting = map[string]bool{}
		}
	}
	switch {
	case !seen:
		return RunStreamEmpty
	case finished:
		return RunStreamFinished
	case len(waiting) > 0:
		return RunStreamAwaitingUser
	default:
		return RunStreamInterrupted
	}
}
