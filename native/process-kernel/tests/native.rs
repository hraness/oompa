#![cfg(any(target_os = "macos", target_os = "linux"))]

#[path = "observation.rs"]
mod observation;
mod qualification;

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
type Event = (u8, Vec<u8>);

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![kind];
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

struct Controller {
    child: Child,
    input: Option<Box<dyn Write>>,
    events: Receiver<Result<Event, ()>>,
    reader: Option<std::thread::JoinHandle<()>>,
    diagnostics: Option<std::thread::JoinHandle<Vec<u8>>>,
}

impl Controller {
    fn new() -> Self {
        Self::with_inherited_descriptor(false)
    }

    fn with_inherited_descriptor(inherit: bool) -> Self {
        Self::with_parent_options(inherit, false, false)
    }

    fn with_parent_options(inherit: bool, ignored_sigchld: bool, socket: bool) -> Self {
        // Intentionally leak a harmless high descriptor across only this helper
        // spawn. The provider's descriptor fixture must prove its removal.
        let inherited = if inherit {
            let source = std::fs::File::open("/dev/null").unwrap();
            let fd = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD, 128) };
            assert!(fd >= 128);
            Some(unsafe { OwnedFd::from_raw_fd(fd) })
        } else {
            None
        };
        let mut command = Command::new(qualification::helper());
        let (controller_socket, child_input) = if socket {
            let (controller, child) = UnixStream::pair().unwrap();
            (Some(controller), Stdio::from(OwnedFd::from(child)))
        } else {
            (None, Stdio::piped())
        };
        command
            .env("SHOULD_NOT_INHERIT", "private-fixture-marker")
            .stdin(child_input)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if ignored_sigchld {
            // Only the child-side pre-exec context changes. Other tests and the
            // controller retain their normal wait semantics.
            unsafe {
                command.pre_exec(|| {
                    if libc::signal(libc::SIGCHLD, libc::SIG_IGN) == libc::SIG_ERR {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().unwrap();
        drop(inherited);
        let input: Option<Box<dyn Write>> = if let Some(socket) = controller_socket {
            Some(Box::new(socket))
        } else {
            child
                .stdin
                .take()
                .map(|input| Box::new(input) as Box<dyn Write>)
        };
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (sender, events) = mpsc::sync_channel(256);
        let reader = std::thread::spawn(move || loop {
            let mut header = [0; 5];
            match stdout.read(&mut header[..1]) {
                Ok(0) => break,
                Ok(1) => {}
                _ => {
                    let _ = sender.send(Err(()));
                    break;
                }
            }
            if stdout.read_exact(&mut header[1..]).is_err() {
                let _ = sender.send(Err(()));
                break;
            }
            let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
            if length > 65_536 {
                let _ = sender.send(Err(()));
                break;
            }
            let mut bytes = vec![0; length];
            if stdout.read_exact(&mut bytes).is_err() {
                let _ = sender.send(Err(()));
                break;
            }
            if sender.send(Ok((header[0], bytes))).is_err() {
                break;
            }
        });
        let diagnostics = std::thread::spawn(move || {
            let mut result = Vec::new();
            stderr.by_ref().take(4097).read_to_end(&mut result).unwrap();
            result
        });
        Self {
            child,
            input,
            events,
            reader: Some(reader),
            diagnostics: Some(diagnostics),
        }
    }

    fn launch(&mut self, mode: &str) -> Value {
        let prepared = self.prepare(mode);
        self.send(6, &[]);
        let (kind, bytes) = self.next();
        assert_eq!(kind, 129, "expected Ready, got {kind}");
        let ready: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(ready["nonce"], NONCE);
        assert_eq!(ready["groupId"], prepared["groupId"]);
        assert_ne!(ready["pid"], ready["groupId"]);
        assert_eq!(ready["pid"], ready["root"]["pid"]);
        for name in ["boot", "supervisor", "anchor"] {
            assert_eq!(ready[name], prepared[name]);
        }
        ready
    }

    fn prepare(&mut self, mode: &str) -> Value {
        let request = json!({"version":1,"nonce":NONCE,"scope":"posix-process-group",
            "argv":[qualification::fixture(), mode],
            "cwd":"/", "environment":{"FIXTURE_VALUE":"present"},
            "termGraceMs":80,"settlementMs":1800,"writeTimeoutMs":if mode == "count" {3000} else {180}});
        self.send(1, &serde_json::to_vec(&request).unwrap());
        let (kind, bytes) = self.next();
        assert_eq!(kind, 138, "expected Prepared, got {kind}");
        let ready: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(ready["nonce"], NONCE);
        assert_eq!(ready["groupId"], ready["anchor"]["pid"]);
        assert_eq!(ready["supervisor"]["pid"], self.child.id());
        ready
    }

    fn send(&mut self, kind: u8, payload: &[u8]) {
        self.input
            .as_mut()
            .unwrap()
            .write_all(&frame(kind, payload))
            .unwrap();
    }

    fn write(&mut self, id: u32, bytes: &[u8]) {
        let mut payload = id.to_be_bytes().to_vec();
        payload.extend_from_slice(bytes);
        self.send(2, &payload);
    }

    fn next(&self) -> Event {
        self.events
            .recv_timeout(Duration::from_secs(4))
            .expect("bounded native event deadline")
            .expect("complete native frame")
    }

    fn finish(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let start = Instant::now();
        loop {
            match self.events.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(event)) => events.push(event),
                Ok(Err(())) => panic!("truncated native output"),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout)
                    if start.elapsed() < Duration::from_secs(4) => {}
                Err(_) => panic!("native controller did not complete"),
            }
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "helper exit not collected");
            std::thread::sleep(Duration::from_millis(5));
        };
        let diagnostics = self.diagnostics.take().unwrap().join().unwrap();
        assert!(
            status.success(),
            "native physical closure failed: {status:?}; event kinds={:?}; diagnostics={:?}",
            events.iter().map(|event| event.0).collect::<Vec<_>>(),
            String::from_utf8_lossy(&diagnostics)
        );
        self.reader.take().unwrap().join().unwrap();
        assert!(diagnostics.is_empty());
        events
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn control(events: &[Event], kind: u8) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event.0 == kind)
        .map(|event| serde_json::from_slice(&event.1).unwrap())
        .collect()
}

fn assert_joined(events: &[Event]) {
    let joined = control(events, 134);
    assert_eq!(
        joined,
        vec![json!({"version":1,"nonce":NONCE,"scope":"posix-process-group"})]
    );
    assert_eq!(control(events, 133).len(), 1);
    for stream in 1..=3 {
        assert_eq!(
            events
                .iter()
                .filter(|event| event.0 == 136 && event.1 == [stream])
                .count(),
            1
        );
    }
}

#[cfg(target_os = "macos")]
fn same_live_birth(identity: &Value, group: i32) -> bool {
    let pid = identity["pid"].as_i64().unwrap() as i32;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    (unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    }) == size
        && info.pbi_pid == pid as u32
        && info.pbi_pgid == group as u32
        && identity["birth"]["seconds"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            == Some(info.pbi_start_tvsec)
        && identity["birth"]["micros"] == info.pbi_start_tvusec
}

// Observation only. On Darwin libproc excludes zombies: first validate live
// birth, then a stopped exact parent plus matching child PID/PPID/Z proves that
// retained child exited. SIGCHLD normalization prevents automatic collection;
// the stopped parent cannot reap or create a replacement. ps itself supplies no
// birth identity. Linux exposes both the birth and zombie state in /proc.
fn same_zombie(identity: &Value, _group: i32, _parent: u32) -> bool {
    let pid = identity["pid"].as_i64().unwrap() as i32;
    #[cfg(target_os = "macos")]
    {
        let Ok(mut observer) = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "pid=,ppid=,stat="])
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_millis(250);
        let success = loop {
            match observer.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                _ => {
                    let _ = observer.kill();
                    let _ = observer.wait();
                    break false;
                }
            }
        };
        if !success {
            return false;
        }
        let mut bytes = Vec::new();
        if observer
            .stdout
            .take()
            .unwrap()
            .take(4097)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > 4096
        {
            return false;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return false;
        };
        let fields: Vec<_> = text.split_ascii_whitespace().collect();
        fields.len() == 3
            && fields[0] == pid.to_string()
            && fields[1] == _parent.to_string()
            && fields[2].starts_with('Z')
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(file) = std::fs::File::open(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let mut bytes = Vec::new();
        if file.take(8193).read_to_end(&mut bytes).is_err() || bytes.len() > 8192 {
            return false;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return false;
        };
        let Some((prefix, rest)) = text.split_once(" (") else {
            return false;
        };
        let Some(close) = rest.rfind(')') else {
            return false;
        };
        let fields: Vec<_> = rest[close + 1..].split_ascii_whitespace().collect();
        prefix == pid.to_string()
            && fields.len() >= 20
            && fields[0] == "Z"
            && fields[2] == _group.to_string()
            && identity["birth"]["ticks"] == fields[19]
    }
}

#[test]
fn exact_writes_zero_write_and_natural_exit_have_distinct_native_proofs() {
    let mut owner = Controller::new();
    owner.launch("echo");
    owner.write(1, &[]);
    let zero = owner.next();
    assert_eq!(zero.0, 132);
    assert_eq!(
        serde_json::from_slice::<Value>(&zero.1).unwrap(),
        json!({"id":1,"outcome":"accepted-full","acceptedBytes":0})
    );
    let input: Vec<u8> = (0..65_536).map(|value| (value % 251) as u8).collect();
    owner.write(2, &input);
    let mut events = Vec::new();
    loop {
        let event = owner.next();
        let acknowledged = event.0 == 132;
        events.push(event);
        if acknowledged {
            break;
        }
    }
    owner.send(3, &[]);
    events.extend(owner.finish());
    let bytes: Vec<u8> = events
        .iter()
        .filter(|event| event.0 == 130)
        .flat_map(|event| event.1.clone())
        .collect();
    assert_eq!(bytes, input);
    assert_eq!(
        control(&events, 132),
        vec![json!({"id":2,"outcome":"accepted-full","acceptedBytes":65_536})]
    );
    assert!(control(&events, 135).is_empty());
    assert_joined(&events);
}

#[test]
fn launch_clears_ambient_environment_and_nonexistent_exec_never_starts() {
    let mut owner = Controller::new();
    owner.launch("environment");
    let events = owner.finish();
    let bytes: Vec<u8> = events
        .iter()
        .filter(|event| event.0 == 130)
        .flat_map(|event| event.1.clone())
        .collect();
    assert_eq!(bytes, b"present:false:false\n");
    assert_joined(&events);
    let mut owner = Controller::new();
    owner.send(
        1,
        &serde_json::to_vec(
            &json!({"version":1,"nonce":NONCE,"scope":"posix-process-group",
        "argv":["/oompa-fixture-no-such-executable"],"cwd":"/","environment":{},
        "termGraceMs":50,"settlementMs":100,"writeTimeoutMs":100}),
        )
        .unwrap(),
    );
    assert_eq!(owner.next().0, 138);
    owner.send(6, &[]);
    let events = owner.finish();
    assert_eq!(
        control(&events, 135),
        vec![json!({"reason":"spawn-failed"})]
    );
    assert_eq!(control(&events, 137).len(), 1);
    assert!(control(&events, 129).is_empty());
    assert!(control(&events, 133).is_empty());
}

#[test]
fn provider_inherits_no_private_controller_or_anchor_descriptors() {
    let mut owner = Controller::with_inherited_descriptor(true);
    owner.launch("descriptors");
    let events = owner.finish();
    let bytes: Vec<u8> = events
        .iter()
        .filter(|event| event.0 == 130)
        .flat_map(|event| event.1.clone())
        .collect();
    assert_eq!(bytes, b"0\n");
    assert!(control(&events, 135).is_empty());
    assert_joined(&events);
}

#[test]
fn exact_maximum_write_is_accepted_and_one_byte_over_is_refused_from_header() {
    let mut owner = Controller::new();
    owner.launch("count");
    owner.write(1, &vec![0x73; 64 * 1024 * 1024]);
    let acknowledged = owner.next();
    assert_eq!(acknowledged.0, 132);
    assert_eq!(
        serde_json::from_slice::<Value>(&acknowledged.1).unwrap(),
        json!({"id":1,"outcome":"accepted-full","acceptedBytes":64 * 1024 * 1024})
    );
    owner.send(3, &[]);
    let events = owner.finish();
    let bytes: Vec<u8> = events
        .iter()
        .filter(|event| event.0 == 130)
        .flat_map(|event| event.1.clone())
        .collect();
    assert_eq!(bytes, b"67108864\n");
    assert!(control(&events, 135).is_empty());
    assert_joined(&events);

    let mut owner = Controller::new();
    owner.launch("block-input");
    let mut header = vec![2];
    header.extend_from_slice(&(64 * 1024 * 1024u32 + 5).to_be_bytes());
    owner.input.as_mut().unwrap().write_all(&header).unwrap();
    let events = owner.finish();
    assert_eq!(
        control(&events, 135),
        vec![json!({"reason":"invalid-frame"})]
    );
    assert!(control(&events, 132).is_empty());
    assert_joined(&events);
}

#[test]
fn launcher_native_child_and_inherited_pipes_are_collected_after_root_exit() {
    for mode in ["launcher", "launcher-exit"] {
        let mut owner = Controller::new();
        let ready = owner.launch(mode);
        // Wait for the native child to prove the wrapper topology really exists.
        let mut early = Vec::new();
        loop {
            let child_output = owner.next();
            let printed = child_output.0 == 130 && child_output.1 == b"native-child\n";
            early.push(child_output);
            if printed {
                break;
            }
        }
        if mode == "launcher" {
            owner.send(4, &[]);
        }
        early.extend(owner.finish());
        let events = early;
        assert_joined(&events);
        let pid = ready["groupId"].as_i64().unwrap() as i32;
        assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}

#[test]
fn concurrent_streams_exceed_lifetime_queue_limit_without_truncation() {
    let mut owner = Controller::new();
    owner.launch("pressure");
    let events = owner.finish();
    for (kind, byte) in [(130, 0x83), (131, 0x91)] {
        let chunks: Vec<_> = events.iter().filter(|event| event.0 == kind).collect();
        assert_eq!(
            chunks.iter().map(|event| event.1.len()).sum::<usize>(),
            2 * 1024 * 1024
        );
        assert!(chunks
            .iter()
            .all(|event| event.1.len() <= 65_536 && event.1.iter().all(|value| *value == byte)));
    }
    assert!(control(&events, 135).is_empty());
    assert_joined(&events);
}

#[test]
fn blocked_write_times_out_with_known_prefix_and_still_proves_cleanup() {
    let mut owner = Controller::new();
    owner.launch("block-input");
    owner.write(1, &vec![0x75; 1024 * 1024]);
    let events = owner.finish();
    assert_eq!(
        control(&events, 135),
        vec![json!({"reason":"write-failed"})]
    );
    let writes = control(&events, 132);
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["outcome"], "partial-known");
    assert!(writes[0]["acceptedBytes"].as_u64().unwrap() < 1024 * 1024);
    assert_joined(&events);
}

#[test]
fn controller_hup_interrupts_incomplete_large_frame_without_waiting_for_body() {
    let mut owner = Controller::new();
    owner.launch("block-input");
    let mut partial = vec![2];
    partial.extend_from_slice(&(64u32 * 1024 * 1024 + 4).to_be_bytes());
    partial.extend_from_slice(&1u32.to_be_bytes());
    partial.extend_from_slice(&[0x35; 4096]);
    owner.input.as_mut().unwrap().write_all(&partial).unwrap();
    let began = Instant::now();
    owner.input.take();
    let events = owner.finish();
    assert!(began.elapsed() < Duration::from_secs(2));
    assert_eq!(
        control(&events, 135),
        vec![json!({"reason":"controller-lost"})]
    );
    assert!(control(&events, 132).is_empty());
    assert_joined(&events);
}

#[test]
fn duplicate_write_is_never_replayed_and_forced_stop_collects_term_refusal() {
    let mut owner = Controller::new();
    owner.launch("echo");
    owner.write(1, &[]);
    assert_eq!(owner.next().0, 132);
    owner.write(1, b"must-not-write");
    let events = owner.finish();
    assert_eq!(
        control(&events, 135),
        vec![json!({"reason":"invalid-frame"})]
    );
    assert!(!events.iter().any(|event| event.0 == 130));
    assert_joined(&events);

    let mut owner = Controller::new();
    owner.launch("block-input");
    owner.send(5, &[]);
    let events = owner.finish();
    assert_eq!(control(&events, 133), vec![json!({"code":null,"signal":9})]);
    assert_joined(&events);
}

#[test]
fn abrupt_helper_death_never_manufactures_join_or_recovery_authority() {
    let mut owner = Controller::new();
    let ready = owner.launch("block-input");
    owner.child.kill().unwrap();
    let status = owner.child.wait().unwrap();
    assert!(!status.success());
    let mut events = Vec::new();
    while let Ok(event) = owner.events.recv_timeout(Duration::from_secs(1)) {
        if let Ok(event) = event {
            events.push(event);
        }
    }
    assert!(control(&events, 134).is_empty());
    assert!(control(&events, 137).is_empty());
    // The private anchor kills its own live group, even though this provider
    // refuses TERM and never reads stdin. This also detects a leaked death-pipe
    // writer in the provider. Saved identities are observed, never signaled.
    let group = ready["groupId"].as_i64().unwrap() as i32;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if unsafe { libc::kill(-group, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "anchor did not retire group after owner death"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    owner.reader.take().unwrap().join().unwrap();
    owner.diagnostics.take().unwrap().join().unwrap();
}

#[test]
fn prepared_scope_is_inert_and_cancel_before_activate_never_starts_provider() {
    for disconnect in [false, true] {
        let mut owner = Controller::new();
        owner.prepare("environment");
        assert!(matches!(
            owner.events.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        if disconnect {
            owner.input.take();
        } else {
            owner.send(4, &[]);
        }
        let events = owner.finish();
        assert!(!events.iter().any(|event| matches!(event.0, 129..=134)));
        assert_eq!(control(&events, 137).len(), 1);
    }
}

#[test]
fn anchor_observes_controller_loss_while_supervisor_is_stopped() {
    // Exercise both an idle controller and a buffered incomplete Write. The
    // independent anchor must never consume the supervisor's frame bytes.
    for (socket, buffered) in [(false, false), (false, true), (true, false), (true, true)] {
        let mut owner = Controller::with_parent_options(false, false, socket);
        let ready = owner.launch("block-input");
        let group = ready["groupId"].as_i64().unwrap() as i32;
        #[cfg(target_os = "macos")]
        for identity in [&ready["anchor"], &ready["root"]] {
            assert!(same_live_birth(identity, group));
        }
        assert_eq!(
            unsafe { libc::kill(owner.child.id() as i32, libc::SIGSTOP) },
            0
        );
        let stop_deadline = Instant::now() + Duration::from_secs(1);
        let stopped = loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    owner.child.id(),
                    &mut info,
                    libc::WSTOPPED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0
                && unsafe { info.si_pid() } == owner.child.id() as i32
                && info.si_code == libc::CLD_STOPPED
            {
                break true;
            }
            if result != 0 || Instant::now() >= stop_deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let mut input_written = true;
        if stopped && buffered {
            let mut bytes = vec![2];
            bytes.extend_from_slice(&(64 * 1024 * 1024u32 + 4).to_be_bytes());
            bytes.extend_from_slice(&1u32.to_be_bytes());
            input_written = owner.input.as_mut().unwrap().write_all(&bytes).is_ok();
        }
        owner.input.take();
        let deadline = Instant::now() + Duration::from_secs(1);
        let independently_dead = loop {
            if !stopped || !input_written {
                break false;
            }
            if same_zombie(&ready["anchor"], group, owner.child.id())
                && same_zombie(&ready["root"], group, owner.child.id())
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        // Always resume before an assertion can fail in the stopped interval.
        assert_eq!(
            unsafe { libc::kill(owner.child.id() as i32, libc::SIGCONT) },
            0
        );
        assert!(
            independently_dead,
            "anchor and provider must die before supervisor resumption"
        );
        let events = owner.finish();
        assert_joined(&events);
        assert!(!control(&events, 135).is_empty());
        assert_eq!(control(&events, 133), vec![json!({"code":null,"signal":9})]);
        assert_eq!(unsafe { libc::kill(-group, 0) }, -1);
    }
}

#[test]
fn anchor_only_failure_cannot_abandon_the_provider_group() {
    let mut owner = Controller::new();
    let ready = owner.launch("block-input");
    let anchor = ready["groupId"].as_i64().unwrap() as i32;
    // This fixture owns the still-live supervisor and deliberately nonterminal
    // provider; the anchor remains its unreaped child across this fault signal.
    assert_eq!(unsafe { libc::kill(anchor, libc::SIGKILL) }, 0);
    let events = owner.finish();
    assert_eq!(control(&events, 135).len(), 1);
    assert_eq!(control(&events, 133), vec![json!({"code":null,"signal":9})]);
    assert_joined(&events);
}

#[test]
fn inherited_ignored_sigchld_cannot_remove_native_identity_reservation() {
    let mut owner = Controller::with_parent_options(false, true, false);
    owner.launch("block-input");
    owner.send(5, &[]);
    let events = owner.finish();
    assert!(control(&events, 135).is_empty());
    assert_joined(&events);
}

#[test]
fn blocked_controller_output_cannot_extend_the_native_cleanup_budget() {
    let mut child = Command::new(qualification::helper())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let read_control = |output: &mut std::process::ChildStdout, expected: u8| -> Value {
        let mut header = [0; 5];
        output.read_exact(&mut header).unwrap();
        assert_eq!(header[0], expected);
        let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
        assert!(length <= 4096);
        let mut bytes = vec![0; length];
        output.read_exact(&mut bytes).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    };
    let launch = json!({"version":1,"nonce":NONCE,"scope":"posix-process-group",
        "argv":[qualification::fixture(), "pressure"], "cwd":"/","environment":{},
        "termGraceMs":50,"settlementMs":250,"writeTimeoutMs":100});
    input
        .write_all(&frame(1, &serde_json::to_vec(&launch).unwrap()))
        .unwrap();
    read_control(&mut output, 138);
    input.write_all(&frame(6, &[])).unwrap();
    let ready = read_control(&mut output, 129);
    // Stop reading while both provider streams exceed kernel and helper buffers.
    std::thread::sleep(Duration::from_millis(80));
    input.write_all(&frame(4, &[])).unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(2) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("blocked output extended the cleanup deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        !status.success(),
        "lost framed output must not claim successful terminal delivery"
    );
    let group = ready["groupId"].as_i64().unwrap() as i32;
    assert_eq!(unsafe { libc::kill(-group, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    let mut residual = Vec::new();
    output
        .take(3 * 1024 * 1024)
        .read_to_end(&mut residual)
        .unwrap();
    assert!(residual.len() < 3 * 1024 * 1024);
}
