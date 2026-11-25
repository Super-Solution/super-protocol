//! A [`Transport`] over HTTP(S), for a host that has no client of its own. It signs the request (a bearer key, extra
//! headers) and nothing else: the provider above it never sees a credential. Behind the `http` feature.

use crate::openai_chat::{HttpResponse, Transport, TransportError};
use serde_json::Value;
use std::time::Duration;

/// POSTs JSON to `base_url + path` and hands back the response with its body still unread, so a stream is read as it
/// arrives. A non-2xx answer is a response like any other (the provider reads the error out of its body); only a
/// failure to get an answer at all is a [`TransportError`].
pub struct HttpTransport {
    base_url: String,
    api_key: Option<String>,
    headers: Vec<(String, String)>,
    agent: ureq::Agent,
}

impl HttpTransport {
    /// `base_url` without a trailing slash, e.g. `https://api.openai.com/v1` or a Super Router's `/v1`.
    pub fn new(base_url: impl Into<String>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            // A stream may be quiet while the model thinks, but not for ever: this is the idle limit of one read.
            .timeout_read(Duration::from_secs(120))
            .build();
        HttpTransport {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: None,
            headers: vec![],
            agent,
        }
    }

    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

impl Transport for HttpTransport {
    fn post_json(&self, path: &str, body: &Value) -> Result<HttpResponse, TransportError> {
        let mut req = self
            .agent
            .post(&format!("{}{}", self.base_url, path))
            .set("Content-Type", "application/json")
            .set("Accept", "text/event-stream, application/json");
        if let Some(k) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {k}"));
        }
        for (n, v) in &self.headers {
            req = req.set(n, v);
        }
        match req.send_string(&body.to_string()) {
            Ok(resp) | Err(ureq::Error::Status(_, resp)) => Ok(HttpResponse {
                status: resp.status(),
                status_text: resp.status_text().to_string(),
                body: Box::new(resp.into_reader()),
            }),
            Err(ureq::Error::Transport(t)) => {
                let message = t.to_string();
                let lower = message.to_lowercase();
                let kind = if lower.contains("timed out") || lower.contains("timeout") {
                    "timeout"
                } else {
                    "network"
                };
                Err(TransportError {
                    kind: kind.into(),
                    message,
                })
            }
        }
    }
}
