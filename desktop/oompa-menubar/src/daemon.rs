//! Minimal client for the Oompa local daemon transport.
//!
//! Wire contract (mirrors `src/daemon/local-transport.ts`): one unix-socket
//! connection carries exactly one newline-terminated request frame and one
//! newline-terminated response frame. Requests authenticate with the
//! ephemeral capability read from the mode-0600 `daemon.capability` file.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

const REQUEST_VERSION: u32 = 2;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub enum CallError {
    /// The endpoint, capability, or peer was absent before dispatch. The
    /// daemon is simply not running; no request was ever delivered.
    Unavailable(String),
    /// The request may have been dispatched. The outcome is unknown and must
    /// be reconciled, never replayed blindly.
    Indeterminate(String),
    /// The daemon answered with a closed error.
    Rejected { code: String, message: String },
    /// The peer or payload violated the transport contract.
    Invalid(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Unavailable(m) => write!(f, "daemon unavailable: {m}"),
            CallError::Indeterminate(m) => write!(f, "daemon indeterminate: {m}"),
            CallError::Rejected { code, message } => write!(f, "{code}: {message}"),
            CallError::Invalid(m) => write!(f, "invalid daemon exchange: {m}"),
        }
    }
}

impl std::error::Error for CallError {}

/// The daemon's state root, matching `resolveStatePaths()` in
/// `src/storage/paths.ts`. The CLI accepts no environment override, so the
/// menu bar accepts none either.
fn state_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Application Support/HRA Control Plane v1"))
    } else {
        Some(home.join(".local/state/hra-control-plane-v1"))
    }
}

pub struct Daemon {
    pub(crate) socket: PathBuf,
    pub(crate) capability: PathBuf,
}

impl Daemon {
    pub fn for_current_user() -> Option<Daemon> {
        let runtime = state_root()?.join("runtime");
        Some(Daemon {
            socket: runtime.join("daemon.sock"),
            capability: runtime.join("daemon.capability"),
        })
    }

    /// Sends one command and returns its `data`, or a closed `CallError`.
    pub fn call(&self, command: Value) -> Result<Value, CallError> {
        let capability = std::fs::read_to_string(&self.capability)
            .map_err(|e| CallError::Unavailable(format!("cannot read capability: {e}")))?;
        let capability = capability.trim();
        if capability.len() != 43
            || !capability.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(CallError::Invalid("capability file has an unexpected shape".into()));
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let frame = json!({
            "version": REQUEST_VERSION,
            "capability": capability,
            "requestId": request_id,
            "command": command,
        });
        let mut payload = serde_json::to_vec(&frame)
            .map_err(|e| CallError::Invalid(format!("cannot serialize request: {e}")))?;
        if payload.len() > MAX_FRAME_BYTES {
            return Err(CallError::Invalid("request exceeds the frame bound".into()));
        }
        payload.push(b'\n');

        let mut stream = UnixStream::connect(&self.socket)
            .map_err(|e| CallError::Unavailable(format!("cannot connect: {e}")))?;
        stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
        stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
        stream
            .write_all(&payload)
            .map_err(|e| CallError::Indeterminate(format!("request write failed: {e}")))?;

        let mut reader = BufReader::new(stream);
        let mut response = Vec::new();
        loop {
            let available = reader
                .fill_buf()
                .map_err(|e| CallError::Indeterminate(format!("response read failed: {e}")))?;
            if available.is_empty() {
                return Err(CallError::Indeterminate("daemon closed without a response".into()));
            }
            let take = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |i| i + 1);
            if response.len() + take > MAX_FRAME_BYTES {
                return Err(CallError::Invalid("response exceeds the frame bound".into()));
            }
            let done = available[take - 1] == b'\n';
            response.extend_from_slice(&available[..take]);
            reader.consume(take);
            if done {
                break;
            }
        }

        let value: Value = serde_json::from_slice(&response)
            .map_err(|e| CallError::Invalid(format!("response is not JSON: {e}")))?;
        let object = value.as_object().ok_or_else(|| CallError::Invalid("response is not an object".into()))?;
        if object.get("requestId").and_then(Value::as_str) != Some(request_id.as_str()) {
            return Err(CallError::Invalid("response request id mismatch".into()));
        }
        match object.get("ok").and_then(Value::as_bool) {
            Some(true) => Ok(object.get("data").cloned().unwrap_or(Value::Null)),
            Some(false) => {
                let error = object.get("error").and_then(Value::as_object);
                Err(CallError::Rejected {
                    code: error
                        .and_then(|e| e.get("code"))
                        .and_then(Value::as_str)
                        .unwrap_or("UNKNOWN")
                        .to_owned(),
                    message: error
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("The daemon rejected the request.")
                        .to_owned(),
                })
            }
            _ => Err(CallError::Invalid("response is missing ok".into())),
        }
    }

    /// Convenience for `daemon.status` — `None` when the daemon is down.
    pub fn status(&self) -> Result<Value, CallError> {
        self.call(json!({ "kind": "daemon.status" }))
    }

    pub fn session_list(&self, limit: u32) -> Result<Value, CallError> {
        self.call(json!({ "kind": "session.list", "archived": false, "limit": limit }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_shape_is_enforced() {
        // A malformed capability must fail before any socket work.
        let root = std::env::temp_dir().join(format!("oompa-menubar-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("daemon.capability"), "too-short").unwrap();
        let daemon = Daemon {
            socket: root.join("daemon.sock"),
            capability: root.join("daemon.capability"),
        };
        assert!(matches!(daemon.status(), Err(CallError::Invalid(_))));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_capability_is_unavailable_not_indeterminate() {
        let root = std::env::temp_dir().join(format!("oompa-menubar-none-{}", std::process::id()));
        let daemon = Daemon {
            socket: root.join("daemon.sock"),
            capability: root.join("daemon.capability"),
        };
        assert!(matches!(daemon.status(), Err(CallError::Unavailable(_))));
    }
}
