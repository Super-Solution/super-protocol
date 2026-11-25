//! Tool-argument repair, the same function as `repairToolArguments` / `normalizeToolName` of Super Chat's core
//! (`packages/core/src/tools/repair.ts`), pinned by `conformance/tool-repair.v0.json`.
//!
//! Models emit malformed tool arguments often enough that a turn must not die on a stray newline inside a JSON
//! string. Every fix is syntactic and lossless: no argument value is ever invented. The order of the fixes, and
//! the quirks of each (it is the TypeScript behaviour that is pinned, not an idealised one), are part of the
//! contract.
//!
//! Known limits of the match with JavaScript, all outside the conformance data: integers beyond 2^53 are kept
//! exactly here and rounded there, nesting deeper than 128 levels is refused by `serde_json`, and an error message
//! never splits a surrogate pair (JavaScript would cut inside one).

use serde_json::{json, Map, Value};

/// What `repair_tool_arguments` found. `repaired` is true when something had to change (or the input was not
/// usable); `error` is set when nothing could be salvaged and `value` is `{}`.
#[derive(Debug, Clone, PartialEq)]
pub struct RepairResult {
    pub value: Value,
    pub repaired: bool,
    pub error: Option<String>,
}

impl RepairResult {
    /// The shape of the conformance file's `expect`.
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("value".into(), self.value.clone());
        o.insert("repaired".into(), json!(self.repaired));
        if let Some(e) = &self.error {
            o.insert("error".into(), json!(e));
        }
        Value::Object(o)
    }
}

/// The characters JavaScript's `trim()`, `\s` and `\S` treat as white space (not Rust's `char::is_whitespace`:
/// U+FEFF counts here, U+0085 does not).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn is_json_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Escape control characters that appear inside JSON string literals.
fn escape_control_chars_in_strings(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let (mut in_string, mut escaped) = (false, false);
    for ch in input.chars() {
        if escaped {
            escaped = false;
            out.push(ch);
            continue;
        }
        if ch == '\\' {
            escaped = true;
            out.push(ch);
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            out.push(ch);
            continue;
        }
        if in_string && (ch as u32) < 0x20 {
            match ch {
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{8}' => out.push_str("\\b"),
                '\u{C}' => out.push_str("\\f"),
                _ => out.push_str(&format!("\\u{:04x}", ch as u32)),
            }
            continue;
        }
        out.push(ch);
    }
    out
}

/// Remove trailing commas before a closing brace or bracket, outside of strings.
fn drop_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let (mut in_string, mut escaped) = (false, false);
    for (i, &ch) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
            out.push(ch);
            continue;
        }
        if ch == '\\' {
            escaped = true;
            out.push(ch);
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
        }
        if !in_string && ch == ',' {
            let next = chars[i + 1..].iter().find(|c| !is_js_space(**c));
            if matches!(next, Some('}') | Some(']')) {
                continue; // drop it
            }
        }
        out.push(ch);
    }
    out
}

/// Extract the outermost balanced `{...}` from prose, respecting string literals.
fn extract_json_object(input: &str) -> Option<String> {
    let chars: Vec<char> = input.chars().collect();
    let start = chars.iter().position(|c| *c == '{')?;
    let (mut depth, mut in_string, mut escaped) = (0i64, false, false);
    for (i, &ch) in chars.iter().enumerate().skip(start) {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(chars[start..=i].iter().collect());
            }
        }
    }
    None
}

/// Replace `word` where it stands alone (`\bWORD\b`, with `\b` as ASCII-only as in JavaScript).
fn replace_word(input: &str, word: &str, with: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let w: Vec<char> = word.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let end = i + w.len();
        if end <= chars.len()
            && chars[i..end] == w[..]
            && (i == 0 || !is_word(chars[i - 1]))
            && (end == chars.len() || !is_word(chars[end]))
        {
            out.push_str(with);
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// `/'([^'\\]*)'(\s*[:,}\]])/g` replaced with `"$1"$2`: a single-quoted string that is followed by `:`, `,`, `}` or `]`.
fn single_quotes_to_double(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\'' {
            // the next quote, with no backslash on the way
            let close = chars[i + 1..]
                .iter()
                .position(|c| *c == '\'' || *c == '\\')
                .filter(|k| chars[i + 1 + k] == '\'')
                .map(|k| i + 1 + k);
            if let Some(j) = close {
                let mut m = j + 1;
                while m < chars.len() && is_js_space(chars[m]) {
                    m += 1;
                }
                if m < chars.len() && matches!(chars[m], ':' | ',' | '}' | ']') {
                    out.push('"');
                    out.extend(&chars[i + 1..j]);
                    out.push('"');
                    out.extend(&chars[j + 1..=m]);
                    i = m + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Whether `text` opens and closes like a JSON object or array, ignoring the whitespace JSON allows around a value.
fn bracketed(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let Some(start) = chars.iter().position(|c| !is_json_space(*c)) else {
        return false;
    };
    let end = chars
        .iter()
        .rposition(|c| !is_json_space(*c))
        .unwrap_or(start);
    end > start
        && ((chars[start] == '{' && chars[end] == '}')
            || (chars[start] == '[' && chars[end] == ']'))
}

fn parse(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok()
}

/// The first `n` UTF-16 code units of `s`, never cutting a surrogate pair in two.
pub(crate) fn take_utf16(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in s.chars() {
        units += ch.len_utf16();
        if units > n {
            break;
        }
        out.push(ch);
    }
    out
}

/// Parse tool arguments, repairing what can be repaired losslessly. Returns `{}` rather than failing when nothing
/// is salvageable: an empty argument object lets the tool's own validation produce a message the model can act on.
pub fn repair_tool_arguments(raw: &Value) -> RepairResult {
    let ok = |value: Value, repaired: bool| RepairResult {
        value,
        repaired,
        error: None,
    };
    let text = match raw {
        Value::Null => return ok(json!({}), false),
        Value::Object(_) | Value::Array(_) => return ok(raw.clone(), false),
        Value::Number(_) => {
            return RepairResult {
                value: json!({}),
                repaired: true,
                error: Some("Unexpected argument type number".into()),
            }
        }
        Value::Bool(_) => {
            return RepairResult {
                value: json!({}),
                repaired: true,
                error: Some("Unexpected argument type boolean".into()),
            }
        }
        Value::String(s) => s,
    };

    let trimmed = js_trim(text);
    if trimmed.is_empty() || trimmed == "null" || trimmed == "{}" {
        return ok(json!({}), trimmed != "{}");
    }

    // Fast path: already valid.
    if let Some(parsed) = parse(trimmed) {
        // Double-encoded: valid JSON that yields a string which is itself JSON.
        if let Value::String(inner) = &parsed {
            return match parse(inner) {
                Some(v) => ok(v, true),
                None => ok(json!({ "value": inner }), true),
            };
        }
        return ok(parsed, false);
    }

    let after_fence = {
        let mut rest = trimmed;
        if let Some(r) = rest.strip_prefix("```") {
            rest = r;
            if r.len() >= 4 && r.is_char_boundary(4) && r[..4].eq_ignore_ascii_case("json") {
                rest = &r[4..];
            }
            rest = rest.trim_start_matches(is_js_space);
        }
        rest
    };
    let defenced = js_trim(after_fence.strip_suffix("```").unwrap_or(after_fence));

    let control_escaped = escape_control_chars_in_strings(defenced);
    let no_trailing_commas = drop_trailing_commas(&control_escaped);
    let mut candidates = vec![
        defenced.to_string(),
        control_escaped,
        no_trailing_commas.clone(),
        // Python literals, only as standalone tokens so "None of the above" survives.
        replace_word(
            &replace_word(
                &replace_word(&no_trailing_commas, "True", "true"),
                "False",
                "false",
            ),
            "None",
            "null",
        ),
        // Single quotes last: it is the most destructive fix (an apostrophe inside a value becomes a quote).
        single_quotes_to_double(&no_trailing_commas),
    ];
    if let Some(extracted) = extract_json_object(defenced) {
        let again = if extracted == defenced {
            no_trailing_commas.clone()
        } else {
            drop_trailing_commas(&escape_control_chars_in_strings(&extracted))
        };
        candidates.push(extracted);
        candidates.push(again);
    }

    // A candidate identical to one already tried is not parsed twice; nor is one that cannot be an object or array.
    let mut tried: Vec<&str> = vec![trimmed];
    for candidate in &candidates {
        if !bracketed(candidate) || tried.contains(&candidate.as_str()) {
            continue;
        }
        tried.push(candidate);
        if let Some(parsed) = parse(candidate) {
            if parsed.is_object() || parsed.is_array() {
                return ok(parsed, true);
            }
        }
    }

    RepairResult {
        value: json!({}),
        repaired: true,
        error: Some(format!(
            "Could not parse tool arguments: {}",
            take_utf16(trimmed, 200)
        )),
    }
}

/// Some OpenAI-compatible routers namespace tool names on the way out but not on the way in, so the model calls
/// `functions.getPrice` for a tool registered as `getPrice`. Strip the prefixes before dispatch.
pub fn normalize_tool_name(name: &str) -> String {
    fn strip_sep<'a>(s: &'a str, word: &str) -> &'a str {
        match s.strip_prefix(word) {
            Some(r) if r.starts_with(':') || r.starts_with('.') => &r[1..],
            _ => s,
        }
    }
    let mut out = js_trim(name);
    out = out.strip_prefix("functions.").unwrap_or(out);
    out = out.strip_prefix("mcp_").unwrap_or(out);
    out = strip_sep(out, "default_api");
    out = strip_sep(out, "tool");
    out.to_string()
}
