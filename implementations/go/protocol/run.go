// SPDX-License-Identifier: Apache-2.0

package protocol

import "fmt"

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

func (c *checker) usage(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "must be an object")
		return
	}
	for _, name := range runUsageFields {
		if n := field(v, name); !isUndefined(n) {
			c.amount(path+"."+name, n)
		}
	}
}

func (c *checker) spec(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "must be an object")
		return
	}
	c.text(path+".kind", field(v, "kind"))
}

func (c *checker) action(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "must be an object")
		return
	}
	c.text(path+".cardId", field(v, "cardId"))
	if callID := field(v, "callId"); !isUndefined(callID) {
		c.text(path+".callId", callID)
	}
	c.text(path+".kind", field(v, "kind"))
	c.oneOf(path+".type", field(v, "type"), RunCardActionTypes)
	c.amount(path+".at", field(v, "at"))
}

func (c *checker) card(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "must be an object")
		return
	}
	c.text(path+".id", field(v, "id"))
	c.spec(path+".spec", field(v, "spec"))
	if expired := field(v, "expired"); !isUndefined(expired) {
		c.boolean(path+".expired", expired)
	}
	if callID := field(v, "callId"); !isUndefined(callID) {
		c.text(path+".callId", callID)
	}
	if action := field(v, "action"); !isUndefined(action) {
		c.action(path+".action", action)
	}
}

func (c *checker) parts(path string, v any) {
	list, ok := v.([]any)
	if !ok {
		c.wrongType(path, v, "must be an array")
		return
	}
	for i, part := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !isObject(part) {
			c.wrongType(p, part, "must be an object")
			continue
		}
		c.text(p+".type", field(part, "type"))
	}
}

func (c *checker) handle(path string, v any) {
	if !isObject(v) {
		c.wrongType(path, v, "must be an object")
		return
	}
	c.text(path+".provider", field(v, "provider"))
	c.text(path+".id", field(v, "id"))
}

// optional runs check on a field only when the event has it.
func (c *checker) optional(e any, key string, check func(path string, v any)) {
	if v := field(e, key); !isUndefined(v) {
		check(key, v)
	}
}

// ValidateRunEvent returns every problem found; an empty slice means the event is a valid run event.
//
// It is for whoever produces events. A follower should not refuse a stream over an event type it
// does not know (see IsRunEventType); later versions add types.
func ValidateRunEvent(e any) []RunEventIssue {
	c := newChecker()
	if !isObject(e) {
		c.wrongType("", e, "event must be an object")
		return c.issues
	}
	typeValue := field(e, "type")
	eventType, ok := asString(typeValue)
	if !ok {
		c.wrongType("type", typeValue, "must be a string")
		return c.issues
	}
	ev := func(key string) any { return field(e, key) }
	switch eventType {
	case "run-start":
		c.text("runId", ev("runId"))
		c.oneOf("mode", ev("mode"), RunModes)
		if threadID := ev("threadId"); !isUndefined(threadID) {
			c.text("threadId", threadID)
		}
	case "run-snapshot":
		c.parts("parts", ev("parts"))
		if cards, ok := ev("cards").([]any); !ok {
			c.wrongType("cards", ev("cards"), "must be an array")
		} else {
			for i, card := range cards {
				c.card(fmt.Sprintf("cards[%d]", i), card)
			}
		}
		c.optional(e, "usage", c.usage)
		c.optional(e, "steps", c.count)
	case "context-built":
		c.object("trace", ev("trace"))
		c.str("system", ev("system"))
		if names, ok := ev("toolNames").([]any); !ok {
			c.wrongType("toolNames", ev("toolNames"), "must be an array")
		} else {
			for i, name := range names {
				c.str(fmt.Sprintf("toolNames[%d]", i), name)
			}
		}
	case "step-start":
		c.count("step", ev("step"))
	case "text-delta", "reasoning-delta":
		c.str("delta", ev("delta"))
		if id := ev("id"); !isUndefined(id) {
			c.text("id", id)
		}
	case "tool-call-input-delta":
		c.text("callId", ev("callId"))
		c.text("name", ev("name"))
		c.optional(e, "partialCard", c.spec)
		c.optional(e, "loading", c.object)
	case "tool-call":
		c.text("callId", ev("callId"))
		c.text("name", ev("name"))
		c.optional(e, "repaired", c.boolean)
		c.optional(e, "loading", c.object)
	case "awaiting-user":
		c.text("callId", ev("callId"))
		c.card("card", ev("card"))
	case "user-responded":
		c.text("callId", ev("callId"))
		c.action("action", ev("action"))
	case "tool-result":
		c.text("callId", ev("callId"))
		c.text("name", ev("name"))
		c.optional(e, "failure", c.str)
		c.amount("ms", ev("ms"))
	case "card":
		c.card("card", ev("card"))
	case "card-updated":
		c.text("cardId", ev("cardId"))
		c.spec("spec", ev("spec"))
	case "step-finish":
		c.count("step", ev("step"))
		c.oneOf("finishReason", ev("finishReason"), RunFinishReasons)
		c.optional(e, "usage", c.usage)
	case "job-started":
		c.handle("handle", ev("handle"))
	case "job-status":
		c.handle("handle", ev("handle"))
		c.oneOf("status", ev("status"), RunJobStatuses)
	case "message":
		c.parts("parts", ev("parts"))
	case "metering":
		c.object("record", ev("record"))
	case "usage":
		c.usage("usage", ev("usage"))
	case "run-finish":
		c.text("runId", ev("runId"))
		c.oneOf("finishReason", ev("finishReason"), RunFinishReasons)
		c.usage("usage", ev("usage"))
		c.count("steps", ev("steps"))
	case "error":
		c.boolean("recoverable", ev("recoverable"))
	default:
		if hint := DidYouMean(eventType, RunEventTypes); hint != "" {
			c.addHint("type", CodeEnum, "unknown run event type", hint)
		} else {
			c.add("type", CodeEnum, "unknown run event type")
		}
		return c.issues
	}
	if seq := ev("seq"); !isUndefined(seq) {
		c.count("seq", seq)
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
