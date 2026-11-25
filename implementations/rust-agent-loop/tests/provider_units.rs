//! Edges of the provider and the SSE decoder that the shadow replay does not reach because they need a cut at every
//! possible byte, or a terminator the scenarios do not use.

use serde_json::json;
use super_agent_loop::{error_from_response, locale_compare, to_chat_messages, SseDecoder};

fn all(chunks: &[&[u8]]) -> Vec<String> {
    let mut d = SseDecoder::new();
    let mut out: Vec<String> = chunks
        .iter()
        .flat_map(|c| d.push(c))
        .map(|m| m.data)
        .collect();
    out.extend(d.finish().into_iter().map(|m| m.data));
    out
}

#[test]
fn a_crlf_cut_between_its_two_bytes_is_one_terminator() {
    // read as \r then \n it would be two line ends: an empty line, and the event dispatched half way
    assert_eq!(all(&[b"data: a\r", b"\ndata: b\r\n\r\n"]), ["a\nb"]);
}

#[test]
fn a_bare_cr_ends_a_line_and_a_trailing_one_waits_for_the_next_read() {
    assert_eq!(all(&[b"data: a\r\rdata: b\r\r"]), ["a", "b"]);
    assert_eq!(all(&[b"data: a\r\r", b"data: b\r", b"\r"]), ["a", "b"]);
}

#[test]
fn a_last_event_without_its_blank_line_still_counts() {
    assert_eq!(all(&[b"data: tail"]), ["tail"]);
    assert_eq!(all(&[b"data: tail\n"]), ["tail"]);
}

#[test]
fn one_leading_space_only_is_stripped() {
    assert_eq!(
        all(&[b"data:  two\n\n", b"data:none\n\n"]),
        [" two", "none"]
    );
}

#[test]
fn comments_and_unknown_fields_dispatch_nothing() {
    assert_eq!(all(&[b": hb\n\nid: 7\nretry: 5\n\n"]), Vec::<String>::new());
}

#[test]
fn every_cut_of_a_multibyte_frame_decodes_the_same() {
    let frame = "data: {\"t\":\"你好🙂é\"}\n\n".as_bytes();
    let whole = all(&[frame]);
    assert_eq!(whole, ["{\"t\":\"你好🙂é\"}"]);
    for i in 0..=frame.len() {
        assert_eq!(all(&[&frame[..i], &frame[i..]]), whole, "cut at {i}");
        for j in i..=frame.len() {
            assert_eq!(
                all(&[&frame[..i], &frame[i..j], &frame[j..]]),
                whole,
                "cuts at {i}, {j}"
            );
        }
    }
}

#[test]
fn an_invalid_byte_is_a_replacement_character_not_a_failure() {
    assert_eq!(all(&[b"data: a\xFFb\n\n"]), ["a\u{FFFD}b"]);
}

#[test]
fn locale_order_of_names() {
    let mut names = vec![
        "b", "B", "a1", "a_b", "Ab", "a-b", "aB", "a", "A", "_x", "a.b",
    ];
    names.sort_by(|a, b| locale_compare(a, b));
    // what `["b","B",...].sort((a, b) => a.localeCompare(b))` gives in Node 22 (ICU 78)
    assert_eq!(
        names,
        ["_x", "a", "A", "a_b", "a-b", "a.b", "a1", "aB", "Ab", "b", "B"]
    );
}

#[test]
fn an_error_without_a_body_names_the_provider_and_the_status() {
    assert_eq!(
        error_from_response("openai", 500, "Internal Server Error", ""),
        (
            "overloaded".to_string(),
            "openai request failed with 500 Internal Server Error".to_string()
        )
    );
    assert_eq!(
        error_from_response("openai", 502, "", "").1,
        "openai request failed with 502"
    );
}

#[test]
fn a_json_body_without_an_error_message_keeps_the_default_message() {
    assert_eq!(
        error_from_response("openai", 429, "Too Many Requests", "{\"detail\":\"x\"}").1,
        "openai request failed with 429 Too Many Requests"
    );
}

#[test]
fn a_long_text_body_is_cut_at_500_utf16_units() {
    let body = "x".repeat(600);
    assert_eq!(error_from_response("openai", 500, "", &body).1.len(), 500);
    let wide = "😀".repeat(400); // 800 UTF-16 units
    assert_eq!(
        error_from_response("openai", 500, "", &wide)
            .1
            .chars()
            .count(),
        250
    );
}

#[test]
fn only_the_unanswered_call_is_dropped_from_a_history() {
    let history = vec![
        json!({"role": "assistant", "parts": [
            {"type": "tool-call", "callId": "a", "name": "t", "input": {}},
            {"type": "tool-call", "callId": "b", "name": "t", "input": {}},
        ]}),
        json!({"role": "tool", "parts": [{"type": "tool-result", "callId": "b", "name": "t", "output": "ok"}]}),
    ];
    let m = to_chat_messages(&history, None);
    assert_eq!(m[0]["tool_calls"].as_array().unwrap().len(), 1);
    assert_eq!(m[0]["tool_calls"][0]["id"], "b");
    assert_eq!(
        m[1],
        json!({"role": "tool", "tool_call_id": "b", "content": "ok"})
    );
}
