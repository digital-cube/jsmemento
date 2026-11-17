//! main.rs — a complete JSMemento client in Rust (ureq, serde_json, tungstenite).
//!
//! It does three things, in this order:
//!   1. push    one USER_LOGIN event for you (the OS user) and print its id and rendered line;
//!   2. query   the last 10 events of user/<you>;
//!   3. tail    the live stream of user/<you> for 10 seconds.
//!
//! Environment:
//!   MEMENTO_API_KEY  your API key with the read and write scopes (required)
//!   MEMENTO_URL      the API base, default https://service.memento-service.org/memento
//!
//! Run:
//!   MEMENTO_API_KEY=mk_… cargo run

use std::env;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::process;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

const DEFAULT_URL: &str = "https://service.memento-service.org/memento";
const TAIL_SECONDS: u64 = 10;

struct Client {
    base_url: String,
    api_key: String,
    agent: ureq::Agent,
}

impl Client {
    /// POST a JSON body to the API and return the envelope's `data`.
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let mut response = self
            .agent
            .post(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send_json(body)
            .map_err(|error| format!("Cannot reach {}: {}", self.base_url, error))?;
        let status = response.status().as_u16();
        let envelope: Value = response.body_mut().read_json().unwrap_or(Value::Null);
        if status >= 300 {
            let message = envelope["error"]["message"]
                .as_str()
                .unwrap_or("request failed");
            return Err(format!("HTTP {status}: {message}"));
        }
        Ok(envelope["data"].clone())
    }

    /// 1. Push one event; returns the stored event.
    fn push(&self, user: &str) -> Result<Value, String> {
        let event = self.post(
            "/events",
            &json!({
                "event_type": "USER_LOGIN",
                "instance_type": "user",
                "instance_id": user,
                "actor_id": user,
                "payload": { "ip": "127.0.0.1", "client": "rust" },
            }),
        )?;
        println!("Pushed {}", event["id"].as_str().unwrap_or(""));
        println!("  {}", text(&event));
        Ok(event)
    }

    /// 2. The last 10 events of user/<user>, newest first.
    fn query(&self, user: &str) -> Result<(), String> {
        let events = self.post(
            "/events/query",
            &json!({
                "filter": { "and": [
                    { "field": "instance_type", "op": "eq", "value": "user" },
                    { "field": "instance_id", "op": "eq", "value": user },
                ]},
                "limit": 10,
            }),
        )?;
        println!("\nLatest events of user/{user}:");
        for event in events.as_array().into_iter().flatten() {
            let occurred_at = event["occurred_at"].as_str().unwrap_or("");
            let event_type = event["event_type"].as_str().unwrap_or("");
            println!("  {occurred_at}  {event_type}  {}", text(event));
        }
        Ok(())
    }

    /// 3. Print every new event of user/<user> for TAIL_SECONDS seconds.
    fn tail(&self, user: &str) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(TAIL_SECONDS);
        let base = self.base_url.replacen("http", "ws", 1);
        let url = format!(
            "{base}/ws?instance_type=user&instance_id={}&locale=en",
            encode(user)
        );
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("Tail: {e}"))?;
        // The key travels as a subprotocol; the server answers with `memento.v1`.
        let protocols = format!("memento.v1, bearer.{}", self.api_key);
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            protocols
                .parse()
                .map_err(|_| "Tail: the API key is not a valid header value".to_string())?,
        );
        let (mut socket, _) = tungstenite::connect(request).map_err(|error| match error {
            tungstenite::Error::Http(response) => {
                format!("Tail: HTTP {} from the stream", response.status().as_u16())
            }
            other => format!("Tail: cannot open the stream: {other}"),
        })?;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            set_read_timeout(socket.get_ref(), left);
            match socket.read() {
                Ok(Message::Text(data)) => {
                    let frame: Value = serde_json::from_str(data.as_str()).unwrap_or(Value::Null);
                    match frame["kind"].as_str() {
                        Some("memento.welcome") => {
                            println!("\nTailing user/{user} for {TAIL_SECONDS} s …")
                        }
                        Some("memento.event.new") => println!("  {}", text(&frame["payload"])),
                        _ => {} // anything else (memento.pong, …) is ignored
                    }
                }
                Ok(_) => {} // pings are answered by tungstenite
                Err(tungstenite::Error::Io(error))
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    break; // the 10 seconds are over
                }
                Err(error) => return Err(format!("Tail: the stream failed: {error}")),
            }
        }
        let _ = socket.close(None);
        println!("Done.");
        Ok(())
    }
}

/// So a blocking read wakes up when the tail time is over.
fn set_read_timeout(stream: &MaybeTlsStream<TcpStream>, timeout: Duration) {
    let _ = match stream {
        MaybeTlsStream::Plain(tcp) => tcp.set_read_timeout(Some(timeout)),
        MaybeTlsStream::NativeTls(tls) => tls.get_ref().set_read_timeout(Some(timeout)),
        _ => Ok(()),
    };
}

/// The rendered line, or the event type when the event has none.
fn text(event: &Value) -> String {
    event["rendered"]
        .as_str()
        .or(event["event_type"].as_str())
        .unwrap_or("")
        .to_string()
}

/// Percent-encode a query string value.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The OS user name: the instance and actor of the event.
fn os_user() -> String {
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "anonymous".to_string())
}

fn main() {
    let api_key = env::var("MEMENTO_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        eprintln!(
            "Set MEMENTO_API_KEY (create one at https://service.memento-service.org/keys)"
        );
        process::exit(2);
    }
    let base_url = env::var("MEMENTO_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_string())
        .trim_end_matches('/')
        .to_string();
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false) // read the error envelope ourselves
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let client = Client {
        base_url,
        api_key,
        agent,
    };
    let user = os_user();
    let result = client
        .push(&user)
        .and_then(|_| client.query(&user))
        .and_then(|_| client.tail(&user));
    if let Err(message) = result {
        eprintln!("{message}");
        process::exit(1);
    }
}
