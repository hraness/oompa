//! One-shot native observations. No provider, database, arbitrary path or
//! nonzero-signal operation is reachable from either observation mode.

use crate::identity::{self, Boot, Context, GroupObservation, Identity, ProcessObservation};
use crate::protocol::{self, Failure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::time::{Duration, Instant};

const LIMIT: usize = 65_536;
const TARGET_LIMIT: usize = 16;
const DEADLINE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Prepared {
    version: u32,
    nonce: String,
    scope: String,
    group_id: i32,
    boot: Boot,
    supervisor: Identity,
    anchor: Identity,
}

impl Prepared {
    fn valid(&self) -> bool {
        self.version == 1
            && hex(&self.nonce, 32)
            && self.scope == "posix-process-group"
            && self.boot.valid()
            && self.group_id > 1
            && self.group_id == self.anchor.pid
            && self.supervisor.pid != self.anchor.pid
            && self.supervisor.valid_for(&self.boot)
            && self.anchor.valid_for(&self.boot)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Ready {
    version: u32,
    nonce: String,
    scope: String,
    group_id: i32,
    boot: Boot,
    supervisor: Identity,
    anchor: Identity,
    pid: i32,
    root: Identity,
}

impl Ready {
    fn agrees(&self, prepared: &Prepared) -> bool {
        self.version == prepared.version
            && self.nonce == prepared.nonce
            && self.scope == prepared.scope
            && self.group_id == prepared.group_id
            && self.boot == prepared.boot
            && self.supervisor == prepared.supervisor
            && self.anchor == prepared.anchor
            && self.pid == self.root.pid
            && self.root.pid != self.supervisor.pid
            && self.root.pid != self.anchor.pid
            && self.root.valid_for(&self.boot)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HostRequest {
    version: u32,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Target {
    nonce: String,
    binding_digest: String,
    expected_revision: u32,
    prepared: Prepared,
    #[serde(deserialize_with = "nullable_ready")]
    ready: Option<Ready>,
}

fn nullable_ready<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Option<Ready>, D::Error> {
    Option::<Ready>::deserialize(decoder)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScopeRequest {
    version: u32,
    request_id: String,
    context: Context,
    targets: Vec<Target>,
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl ScopeRequest {
    fn parse(bytes: &[u8]) -> Result<Self, Failure> {
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Failure::InvalidFrame)?;
        let mut nonces = HashSet::new();
        if value.version != 1
            || !hex(&value.request_id, 32)
            || !value.context.valid()
            || !(1..=TARGET_LIMIT).contains(&value.targets.len())
            || !value.targets.iter().all(|target| {
                hex(&target.nonce, 32)
                    && hex(&target.binding_digest, 64)
                    && (1..=5).contains(&target.expected_revision)
                    && target.prepared.valid()
                    && target.prepared.nonce == target.nonce
                    && target.prepared.boot == value.context.boot
                    && target
                        .ready
                        .as_ref()
                        .is_none_or(|ready| ready.agrees(&target.prepared))
                    && nonces.insert(&target.nonce)
            })
        {
            return Err(Failure::InvalidFrame);
        }
        Ok(value)
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Relation {
    SameBoot,
    BootEnded,
    ForeignHost,
    ForeignScope,
}

fn relation(expected: &Context, observed: &Context) -> Relation {
    if expected.host != observed.host {
        Relation::ForeignHost
    } else if expected.boot.id() != observed.boot.id() {
        Relation::BootEnded
    } else if expected.boot != observed.boot {
        Relation::ForeignScope
    } else {
        Relation::SameBoot
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    version: u32,
    request_id: String,
    context: Context,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetResponse {
    nonce: String,
    binding_digest: String,
    expected_revision: u32,
    supervisor: ProcessObservation,
    anchor: ProcessObservation,
    root: Option<ProcessObservation>,
    group: GroupObservation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeResponse {
    version: u32,
    request_id: String,
    context: Context,
    relation: Relation,
    targets: Vec<TargetResponse>,
}

fn observe(bytes: &[u8], scopes: bool, deadline: Instant) -> Result<(u8, Vec<u8>), Failure> {
    // Fully validate foreign input before any host or process observation.
    let request = if scopes {
        Some(ScopeRequest::parse(bytes)?)
    } else {
        None
    };
    let host = if scopes {
        None
    } else {
        let request: HostRequest =
            serde_json::from_slice(bytes).map_err(|_| Failure::InvalidFrame)?;
        if request.version != 1 || !hex(&request.request_id, 32) {
            return Err(Failure::InvalidFrame);
        }
        Some(request)
    };
    let before = Context::capture().map_err(|_| Failure::CleanupUnproven)?;
    let result = if let Some(request) = request {
        let relation = relation(&request.context, &before);
        let mut targets = Vec::with_capacity(request.targets.len());
        for target in request.targets {
            if Instant::now() >= deadline {
                return Err(Failure::Deadline);
            }
            let mut result = TargetResponse {
                nonce: target.nonce,
                binding_digest: target.binding_digest,
                expected_revision: target.expected_revision,
                supervisor: ProcessObservation::Unknown,
                anchor: ProcessObservation::Unknown,
                root: target.ready.as_ref().map(|_| ProcessObservation::Unknown),
                group: GroupObservation::Unknown,
            };
            if relation == Relation::SameBoot {
                // Supervisor observation precedes group absence. The product
                // requires original supervisor absence before releasing custody.
                result.supervisor = identity::observe_process(&target.prepared.supervisor);
                result.anchor = identity::observe_process(&target.prepared.anchor);
                result.root = target
                    .ready
                    .as_ref()
                    .map(|ready| identity::observe_process(&ready.root));
                result.group = identity::observe_group(target.prepared.group_id);
            }
            targets.push(result);
        }
        (
            140,
            serde_json::to_vec(&ScopeResponse {
                version: 1,
                request_id: request.request_id,
                context: before.clone(),
                relation,
                targets,
            }),
        )
    } else {
        (
            139,
            serde_json::to_vec(&HostResponse {
                version: 1,
                request_id: host.unwrap().request_id,
                context: before.clone(),
            }),
        )
    };
    // A changed or unavailable bracketing context invalidates the whole batch.
    if Context::capture().map_err(|_| Failure::CleanupUnproven)? != before {
        return Err(Failure::CleanupUnproven);
    }
    let bytes = result.1.map_err(|_| Failure::CleanupUnproven)?;
    if bytes.len() > LIMIT {
        return Err(Failure::CleanupUnproven);
    }
    if Instant::now() >= deadline {
        return Err(Failure::Deadline);
    }
    Ok((result.0, bytes))
}

fn nonblocking(fd: i32) -> io::Result<()> {
    // SAFETY: this process owns its stdio descriptors; no pointers are used.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wait(fd: i32, events: i16, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(io::ErrorKind::TimedOut)?;
        let timeout = remaining.as_millis().clamp(1, 50) as i32;
        let mut entry = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: one initialized poll entry valid for this call only.
        let result = unsafe { libc::poll(&mut entry, 1, timeout) };
        if result > 0 {
            if entry.revents & libc::POLLNVAL != 0 {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            return Ok(());
        }
        if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
    }
}

fn read(bytes: &mut [u8], deadline: Instant) -> io::Result<usize> {
    loop {
        wait(0, libc::POLLIN, deadline)?;
        // SAFETY: writable bounded slice and no retained pointer.
        let count = unsafe { libc::read(0, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count >= 0 {
            return Ok(count as usize);
        }
        let error = io::Error::last_os_error();
        if !matches!(
            error.kind(),
            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
        ) {
            return Err(error);
        }
    }
}

fn read_exact(mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        let count = read(bytes, deadline)?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        bytes = &mut bytes[count..];
    }
    Ok(())
}

fn request(scopes: bool, deadline: Instant) -> Result<Vec<u8>, Failure> {
    let mut header = [0; 5];
    read_exact(&mut header, deadline).map_err(|_| Failure::InvalidFrame)?;
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if header[0] != if scopes { 8 } else { 7 } || length > LIMIT {
        return Err(Failure::InvalidFrame);
    }
    let mut body = vec![0; length];
    read_exact(&mut body, deadline).map_err(|_| Failure::InvalidFrame)?;
    if read(&mut [0; 1], deadline).map_err(|_| Failure::InvalidFrame)? != 0 {
        return Err(Failure::InvalidFrame);
    }
    Ok(body)
}

fn write(mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        wait(1, libc::POLLOUT, deadline)?;
        // SAFETY: immutable bounded slice and no retained pointer.
        let count = unsafe { libc::write(1, bytes.as_ptr().cast(), bytes.len()) };
        if count > 0 {
            bytes = &bytes[count as usize..];
        } else if count == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        } else {
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                return Err(error);
            }
        }
    }
    Ok(())
}

pub fn run(scopes: bool) -> bool {
    let deadline = Instant::now() + DEADLINE;
    // Ignore only this process's SIGPIPE; observation never sends a nonzero signal.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    if nonblocking(0).is_err() || nonblocking(1).is_err() {
        return false;
    }
    let result = request(scopes, deadline).and_then(|bytes| observe(&bytes, scopes, deadline));
    match result {
        Ok((kind, bytes)) => write(&protocol::encode(kind, &bytes), deadline).is_ok(),
        Err(failure) => {
            let bytes = serde_json::to_vec(&serde_json::json!({"reason":failure.code()})).unwrap();
            let _ = write(&protocol::encode(135, &bytes), deadline);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn request_value() -> Value {
        let boot = json!({"platform":"darwin","id":"01234567-89ab-cdef-0123-456789abcdef"});
        let identity =
            |pid| json!({"pid":pid,"birth":{"kind":"darwin-start-time","seconds":"1","micros":0}});
        json!({"version":1,"requestId":"0".repeat(32),"context":{"host":{"platform":"darwin","digest":"1".repeat(64)},"boot":boot},
            "targets":[{"nonce":"2".repeat(32),"bindingDigest":"3".repeat(64),"expectedRevision":2,"ready":null,
                "prepared":{"version":1,"nonce":"2".repeat(32),"scope":"posix-process-group","groupId":3,
                    "boot":boot,"supervisor":identity(2),"anchor":identity(3)}}]})
    }

    #[test]
    fn strict_requests_reject_unsafe_or_inconsistent_identity() {
        let valid = request_value();
        assert!(ScopeRequest::parse(&serde_json::to_vec(&valid).unwrap()).is_ok());
        for change in [0, 1, 2, 3, 4, 5, 6, 7, 8] {
            let mut value = valid.clone();
            match change {
                0 => value["targets"][0]["prepared"]["groupId"] = json!(1),
                1 => value["targets"][0]["prepared"]["anchor"]["birth"]["seconds"] = json!("01"),
                2 => value["context"]["host"]["platform"] = json!("linux"),
                3 => {
                    value["targets"][0]["prepared"]["boot"]["id"] =
                        json!("11111111-1111-1111-1111-111111111111")
                }
                4 => value["targets"][0]["ready"] = json!({}),
                5 => value["targets"]
                    .as_array_mut()
                    .unwrap()
                    .push(valid["targets"][0].clone()),
                6 => value["path"] = json!("/not-admitted"),
                7 => value["targets"] = json!([]),
                8 => {
                    value["targets"][0].as_object_mut().unwrap().remove("ready");
                }
                _ => unreachable!(),
            }
            assert!(ScopeRequest::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn context_relation_never_equates_namespace_drift_with_reboot() {
        let value = request_value();
        let original: Context = serde_json::from_value(value["context"].clone()).unwrap();
        assert_eq!(relation(&original, &original), Relation::SameBoot);
        let mut changed = value["context"].clone();
        changed["boot"]["id"] = json!("11111111-1111-1111-1111-111111111111");
        assert_eq!(
            relation(&original, &serde_json::from_value(changed).unwrap()),
            Relation::BootEnded
        );
        let linux = |inode| {
            serde_json::from_value(json!({"host":{"platform":"linux","digest":"0".repeat(64)},
            "boot":{"platform":"linux","id":"01234567-89ab-cdef-0123-456789abcdef","pidNamespace":{"device":"1","inode":inode}}})).unwrap()
        };
        assert_eq!(relation(&linux("2"), &linux("3")), Relation::ForeignScope);
    }
}
