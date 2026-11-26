import { describe, expect, it } from "vitest";
import { inferenceStreamOutcome, validateInferenceMessage, validateInferenceRequest, validateStreamEvent } from "./index.js";

const call = { id: "call_1", name: "search", arguments: '{"q":"x"}' };
const base = { service: "chat", customer_id: "c1", messages: [{ role: "user", content: "hi" }] };

describe("inference request", () => {
  it("accepts the original text form and the tool forms", () => {
    expect(validateInferenceRequest(base)).toEqual([]);
    expect(
      validateInferenceRequest({
        ...base,
        messages: [
          { role: "user", content: [{ type: "text", text: "see" }, { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }] },
          { role: "assistant", tool_calls: [call] },
          { role: "tool", tool_call_id: "call_1", content: "found", is_error: false },
        ],
        tools: [{ name: "search", input_schema: { type: "object" } }],
        tool_choice: "required",
      }),
    ).toEqual([]);
  });
  it("says where each problem is, all of them at once", () => {
    expect(validateInferenceRequest({ service: "", messages: [{ role: "robot" }], tools: [{ name: "a b" }], max_output_tokens: 0 })).toEqual([
      { path: "service", code: "empty", message: "must be a non-empty string" },
      { path: "customer_id", code: "required", message: "must be a non-empty string" },
      { path: "messages[0].role", code: "enum", message: "must be one of system, user, assistant, tool" },
      { path: "tools[0].name", code: "format", message: "must be 1 to 64 letters, digits, _ or -" },
      { path: "tools[0].input_schema", code: "required", message: 'must be a JSON Schema object with type "object"' },
      { path: "max_output_tokens", code: "range", message: "must be a positive integer" },
    ]);
  });
  it("wants a tool result to answer a call an earlier assistant message made", () => {
    const result = { role: "tool", tool_call_id: "call_1", content: "r" };
    expect(validateInferenceRequest({ ...base, messages: [result] })).toEqual([{ path: "messages[0].tool_call_id", code: "reference", message: "no earlier assistant message made this tool call" }]);
    expect(validateInferenceMessage(result)).toEqual([]);
  });
});

describe("stream events", () => {
  it("checks each event type and skips unknown ones in an outcome", () => {
    expect(validateStreamEvent({ type: "output.delta", request_id: "r", sequence: 1, text: "hi" })).toEqual([]);
    expect(validateStreamEvent({ type: "output.tool_call.completed", request_id: "r", sequence: 1, index: 0, id: "c", name: "a b", arguments: "{}" })).toEqual([
      { path: "name", code: "format", message: "must be 1 to 64 letters, digits, _ or -" },
    ]);
    expect(validateStreamEvent({ type: "request.cancelled" })).toEqual([{ path: "type", code: "enum", message: "unknown stream event type" }]);
    expect(inferenceStreamOutcome([{ type: "ping" }])).toBe("empty");
    expect(inferenceStreamOutcome([{ type: "request.started", request_id: "r", sequence: 0, service_version: 1 }])).toBe("interrupted");
    expect(inferenceStreamOutcome([{ type: "request.failed" }, { type: "request.completed" }])).toBe("failed");
  });
});
