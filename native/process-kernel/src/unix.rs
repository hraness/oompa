//! One native owner. Every syscall and descriptor lifetime stays in this module.
//! The anchor remains unreaped until all process-group signals have completed.

use crate::identity::{Boot, Identity};
use crate::protocol::{self, Decoder, Failure, Frame, Launch};
use serde_json::json;
use std::collections::VecDeque;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static STOP_SIGNAL: AtomicBool = AtomicBool::new(false);

extern "C" fn stop_signal(_: libc::c_int) {
    STOP_SIGNAL.store(true, Ordering::Relaxed);
}

fn nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: no pointer crosses this call; this owner keeps the descriptor open.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn read_fd(fd: RawFd, bytes: &mut [u8]) -> io::Result<usize> {
    // SAFETY: the mutable slice is valid for its length and borrowed exclusively.
    let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
    if count < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(count as usize)
    }
}

fn write_fd(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    // SAFETY: the immutable slice is valid for its length; write retains no pointer.
    let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
    if count < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(count as usize)
    }
}

fn would_wait(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn anonymous_address_payload(payload: &[u8], darwin_padding: bool) -> bool {
    if darwin_padding {
        payload.iter().all(|byte| *byte == 0)
    } else {
        payload.is_empty()
    }
}

fn controller_read_endpoint(fd: RawFd) -> bool {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || flags & libc::O_ACCMODE == libc::O_WRONLY {
        return false;
    }
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return false;
    }
    if stat.st_mode & libc::S_IFMT == libc::S_IFIFO {
        return flags & libc::O_ACCMODE == libc::O_RDONLY;
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        return false;
    }
    // Bun's stdio pipe uses a local socketpair. Admit only connected anonymous
    // AF_UNIX stream endpoints, never a listener, named socket or network socket.
    let mut kind: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut kind as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of_val(&kind)
        || kind != libc::SOCK_STREAM
    {
        return false;
    }
    for peer in [false, true] {
        let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&address) as libc::socklen_t;
        let result = unsafe {
            if peer {
                libc::getpeername(
                    fd,
                    (&mut address as *mut libc::sockaddr_storage).cast(),
                    &mut length,
                )
            } else {
                libc::getsockname(
                    fd,
                    (&mut address as *mut libc::sockaddr_storage).cast(),
                    &mut length,
                )
            }
        };
        let path_offset = std::mem::offset_of!(libc::sockaddr_un, sun_path);
        if result != 0
            || i32::from(address.ss_family) != libc::AF_UNIX
            || !(path_offset..=std::mem::size_of::<libc::sockaddr_un>())
                .contains(&(length as usize))
        {
            return false;
        }
        // Darwin socketpair names use a padded16-byte sockaddr, Linux uses
        // only the family prefix. Both must have no path or abstract name.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                (&address as *const libc::sockaddr_storage).cast::<u8>(),
                length as usize,
            )
        };
        // On Linux even an all-NUL payload is an abstract socket name.
        if !anonymous_address_payload(&bytes[path_offset..], cfg!(target_os = "macos")) {
            return false;
        }
    }
    true
}

/// Rust's Command preserves ambient inheritable descriptors. Fence the exact
/// current descriptor table before constructing child stdio. This owner is
/// single-threaded; all subsequently opened stdio and exec-handshake descriptors
/// come from Command and are CLOEXEC. Enumerating the OS descriptor directory
/// also covers open descriptors above a subsequently lowered RLIMIT_NOFILE.
fn fence_descriptor_inheritance() -> io::Result<()> {
    #[cfg(target_os = "macos")]
    const DIRECTORY: &str = "/dev/fd";
    #[cfg(target_os = "linux")]
    const DIRECTORY: &str = "/proc/self/fd";
    for (count, entry) in std::fs::read_dir(DIRECTORY)?.enumerate() {
        if count >= 4096 {
            return Err(io::Error::other("native descriptor budget exceeded"));
        }
        let name = entry?.file_name();
        let fd = name
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or_else(|| io::Error::other("invalid native descriptor"))?;
        if fd < 3 {
            continue;
        }
        // SAFETY: numeric descriptor operations, no borrowed pointers. The
        // table belongs exclusively to this process, never the caller's table.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

struct OutputFrame {
    bytes: Vec<u8>,
    offset: usize,
    bucket: usize,
}

#[derive(Default)]
struct Output {
    frames: VecDeque<OutputFrame>,
    queued: [usize; 3],
    broken: bool,
}

impl Output {
    fn room(&self, stream: usize) -> usize {
        protocol::STREAM_QUEUE_LIMIT.saturating_sub(self.queued[stream])
    }

    fn frame(&mut self, kind: u8, body: &[u8]) -> bool {
        if self.broken {
            return false;
        }
        let bucket = match kind {
            130 => 1,
            131 => 2,
            _ => 0,
        };
        let limit = if bucket == 0 {
            protocol::CONTROL_QUEUE_LIMIT
        } else {
            protocol::STREAM_QUEUE_LIMIT
        };
        if self.queued[bucket] + body.len() + 5 > limit {
            return false;
        }
        let bytes = protocol::encode(kind, body);
        self.queued[bucket] += bytes.len();
        self.frames.push_back(OutputFrame {
            bytes,
            offset: 0,
            bucket,
        });
        true
    }

    fn control(&mut self, kind: u8, value: serde_json::Value) -> bool {
        let bytes = serde_json::to_vec(&value).expect("closed control value");
        bytes.len() <= 4096 && self.frame(kind, &bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        // Fairness: one frame per event-loop pass, never an unbounded drain.
        if let Some(frame) = self.frames.front_mut() {
            let count = write_fd(libc::STDOUT_FILENO, &frame.bytes[frame.offset..])?;
            if count == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            frame.offset += count;
            if frame.offset == frame.bytes.len() {
                let complete = self.frames.pop_front().unwrap();
                self.queued[complete.bucket] -= complete.bytes.len();
            }
        }
        Ok(())
    }

    fn abandon(&mut self) {
        self.broken = true;
        self.frames.clear();
        self.queued = [0; 3];
    }
}

struct PendingWrite {
    id: u32,
    bytes: Vec<u8>,
    accepted: usize,
    deadline: Instant,
}

struct Scope {
    child: Option<Child>,
    pid: Option<libc::pid_t>,
    anchor: Child,
    group_id: libc::pid_t,
    death: Option<ChildStdin>,
    input: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    root_observed: bool,
    root_collected: bool,
    anchor_observed: bool,
    anchor_collected: bool,
    activated: bool,
    prepared: bool,
    forced: bool,
    closure_uncertain: bool,
    signal_failed: bool,
    stop_at: Option<Instant>,
    deadline: Option<Instant>,
}

fn observe_unreaped(pid: libc::pid_t) -> io::Result<Option<(Option<i32>, Option<i32>)>> {
    // SAFETY: valid initialized output, exact owned child, and no reaping.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: waitid initialized these fields, with zero PID for no exit.
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED if (0..=255).contains(&status) => Ok(Some((Some(status), None))),
        libc::CLD_KILLED | libc::CLD_DUMPED if (1..=127).contains(&status) => {
            Ok(Some((None, Some(status))))
        }
        _ => Err(io::Error::other("invalid native wait state")),
    }
}

impl Scope {
    /// Prepare the private group anchor only. Provider execution requires Activate.
    fn prepare() -> io::Result<Self> {
        // Duplicate only the read endpoint, high enough to avoid stdio setup.
        // It exists without CLOEXEC only across this synchronous anchor spawn;
        // the owner is single-threaded and closes it before provider activation.
        let controller_fd = unsafe { libc::fcntl(0, libc::F_DUPFD, 64) };
        if controller_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let controller = unsafe { OwnedFd::from_raw_fd(controller_fd) };
        let mut anchor = Command::new(std::env::current_exe()?)
            .arg("--scope-anchor")
            .arg(controller_fd.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        drop(controller);
        let group_id = anchor.id() as libc::pid_t;
        let death = anchor.stdin.take();
        let ready = anchor.stdout.take();
        let mut scope = Self {
            child: None,
            pid: None,
            anchor,
            group_id,
            death,
            input: None,
            stdout: None,
            stderr: None,
            root_observed: false,
            root_collected: false,
            anchor_observed: false,
            anchor_collected: false,
            activated: false,
            prepared: false,
            forced: false,
            closure_uncertain: false,
            signal_failed: false,
            stop_at: None,
            deadline: None,
        };
        if let (Some(death), Some(ready)) = (scope.death.as_ref(), ready.as_ref()) {
            // Both parent endpoints must disappear across provider exec. The
            // actual helper-death fixture additionally detects a leaked writer.
            let cloexec = |fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC != 0;
            if cloexec(death.as_raw_fd())
                && cloexec(ready.as_raw_fd())
                && nonblocking(ready.as_raw_fd()).is_ok()
            {
                let deadline = Instant::now() + Duration::from_secs(1);
                let mut byte = [0; 1];
                while Instant::now() < deadline {
                    let mut polls = [
                        libc::pollfd {
                            fd: ready.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: 0,
                            events: 0,
                            revents: 0,
                        },
                    ];
                    // SAFETY: two initialized entries; no retained pointers.
                    unsafe {
                        libc::poll(polls.as_mut_ptr(), 2, 10);
                    }
                    if polls[1].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                        break;
                    }
                    if polls[0].revents != 0 {
                        if read_fd(ready.as_raw_fd(), &mut byte).ok() == Some(1) && byte == *b"R" {
                            // The live/unreaped anchor pins this exact group ID.
                            scope.prepared = unsafe { libc::getpgid(group_id) } == group_id;
                        }
                        break;
                    }
                }
            }
        }
        Ok(scope)
    }

    fn activate(&mut self, launch: &Launch) -> io::Result<libc::pid_t> {
        if !self.prepared || self.activated || self.stop_at.is_some() || self.anchor_observed {
            return Err(io::Error::other("scope not activatable"));
        }
        self.activated = true;
        fence_descriptor_inheritance()?;
        let mut child = Command::new(&launch.argv[0])
            .args(&launch.argv[1..])
            .current_dir(&launch.cwd)
            .env_clear()
            .envs(&launch.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(self.group_id)
            .spawn()?;
        let pid = child.id() as libc::pid_t;
        self.input = child.stdin.take();
        self.stdout = child.stdout.take();
        self.stderr = child.stderr.take();
        self.pid = Some(pid);
        self.child = Some(child);
        let configured = self
            .input
            .as_ref()
            .is_some_and(|p| nonblocking(p.as_raw_fd()).is_ok())
            && self
                .stdout
                .as_ref()
                .is_some_and(|p| nonblocking(p.as_raw_fd()).is_ok())
            && self
                .stderr
                .as_ref()
                .is_some_and(|p| nonblocking(p.as_raw_fd()).is_ok());
        if !configured {
            return Err(io::Error::other("pipe setup failed"));
        }
        Ok(pid)
    }

    fn signal(&mut self, signal: libc::c_int) {
        if self.anchor_collected {
            self.closure_uncertain = true;
            return;
        }
        // SAFETY: the live/unreaped anchor reserves the dedicated PGID. All
        // external signals finish before anchor collection, even after root exit.
        let result = unsafe { libc::kill(-self.group_id, signal) };
        if result != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            // Darwin may refuse a signal to a zombie-only group. Refusal is an
            // operation failure, never evidence of absence. Exact subsequent
            // collection/EOF/group ESRCH can still prove physical closure.
            self.signal_failed = true;
        }
    }

    fn observe_root(&mut self) -> io::Result<Option<(Option<i32>, Option<i32>)>> {
        if self.root_observed || self.root_collected {
            return Ok(None);
        }
        let Some(pid) = self.pid else {
            return Ok(None);
        };
        let result = observe_unreaped(pid)?;
        self.root_observed = result.is_some();
        Ok(result)
    }

    fn observe_anchor(&mut self) -> io::Result<bool> {
        if self.anchor_observed || self.anchor_collected {
            return Ok(false);
        }
        self.anchor_observed = observe_unreaped(self.group_id)?.is_some();
        Ok(self.anchor_observed)
    }

    fn start_stop(&mut self, launch: &Launch, now: Instant, force: bool) {
        if self.stop_at.is_none() {
            self.stop_at = Some(now);
            self.deadline =
                Some(now + Duration::from_millis(launch.term_grace_ms + launch.settlement_ms));
            if !force {
                self.signal(libc::SIGTERM);
            }
        }
        if force && !self.forced && !self.anchor_collected {
            self.signal(libc::SIGKILL);
            self.forced = true;
            let forced_deadline = now + Duration::from_millis(launch.settlement_ms);
            self.deadline = Some(self.deadline.unwrap().min(forced_deadline));
        }
    }

    fn collect(&mut self) -> io::Result<()> {
        if self.forced {
            if self.root_observed && !self.root_collected {
                self.child.as_mut().unwrap().wait()?;
                self.root_collected = true;
            }
            if self.anchor_observed && !self.anchor_collected {
                self.anchor.wait()?;
                self.anchor_collected = true;
                self.death.take();
            }
        }
        Ok(())
    }

    fn group_absent(&self) -> bool {
        if !self.anchor_collected {
            return false;
        }
        // Observation only, never reacquired signal authority.
        (unsafe { libc::kill(-self.group_id, 0) }) == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

struct Owner {
    output: Output,
    decoder: Decoder,
    launch: Option<Launch>,
    scope: Option<Scope>,
    pending: Option<PendingWrite>,
    next_write: Option<u32>,
    input_fenced: bool,
    controller_open: bool,
    failure: Option<Failure>,
    assembly_started: Option<Instant>,
    activation_started: Option<Instant>,
    terminal: bool,
    terminal_deadline: Option<Instant>,
    identities: Option<(Boot, Identity, Identity)>,
}

impl Owner {
    fn new() -> Self {
        Self {
            output: Output::default(),
            decoder: Decoder::default(),
            launch: None,
            scope: None,
            pending: None,
            next_write: Some(1),
            input_fenced: false,
            controller_open: true,
            failure: None,
            assembly_started: Some(Instant::now()),
            activation_started: None,
            terminal: false,
            terminal_deadline: None,
            identities: None,
        }
    }

    fn event(&mut self, kind: u8, value: serde_json::Value) {
        if !self.output.control(kind, value) {
            self.output.abandon();
        }
    }

    fn fail(&mut self, failure: Failure, now: Instant) {
        if self.failure.is_none() {
            self.failure = Some(failure);
            self.event(135, json!({"reason": failure.code()}));
        }
        self.stop(now, false);
    }

    fn settle_write(&mut self, cancelled: bool) {
        if let Some(pending) = self.pending.take() {
            let accepted = pending.accepted;
            let outcome = if !cancelled && accepted == pending.bytes.len() {
                "accepted-full"
            } else if accepted == 0 {
                "refused-before-write"
            } else {
                "partial-known"
            };
            self.event(
                132,
                json!({"id": pending.id, "outcome": outcome, "acceptedBytes": accepted}),
            );
        }
    }

    fn close_input(&mut self) {
        self.input_fenced = true;
        self.settle_write(true);
        if let Some(scope) = self.scope.as_mut() {
            if scope.input.take().is_some() && !self.output.frame(136, &[3]) {
                self.output.abandon();
            }
        }
    }

    fn stop(&mut self, now: Instant, force: bool) {
        self.close_input();
        if let (Some(scope), Some(launch)) = (self.scope.as_mut(), self.launch.as_ref()) {
            scope.start_stop(launch, now, force);
        } else if !self.terminal {
            self.terminal = true;
            self.terminal_deadline = Some(now + Duration::from_secs(1));
        }
    }

    fn frame(&mut self, frame: Frame, now: Instant) {
        if self.launch.is_none() {
            if frame.kind != 1 {
                self.fail(Failure::InvalidFrame, now);
                return;
            }
            let launch = match Launch::parse(&frame.body) {
                Ok(launch) => launch,
                Err(error) => {
                    self.fail(error, now);
                    return;
                }
            };
            if launch.scope != "posix-process-group" {
                self.fail(Failure::UnsupportedScope, now);
                self.event(
                    137,
                    json!({"version": 1, "nonce": launch.nonce, "scope": launch.scope}),
                );
                self.launch = Some(launch);
                return;
            }
            match Scope::prepare() {
                Ok(scope) => {
                    let group_id = scope.group_id;
                    let identities = Boot::capture().and_then(|boot| {
                        Ok((
                            boot,
                            Identity::capture(std::process::id() as i32, None)?,
                            Identity::capture(group_id, Some(group_id))?,
                        ))
                    });
                    let configured = scope.prepared && identities.is_ok();
                    self.identities = identities.ok();
                    self.scope = Some(scope);
                    self.launch = Some(launch);
                    if !configured {
                        self.fail(Failure::SpawnFailed, now);
                        return;
                    }
                    let launch = self.launch.as_ref().unwrap();
                    let (boot, supervisor, anchor) = self.identities.as_ref().unwrap();
                    self.activation_started = Some(now);
                    self.event(138, json!({"version": 1, "nonce": launch.nonce, "groupId": group_id, "scope": launch.scope,
                        "boot":boot,"supervisor":supervisor,"anchor":anchor}));
                }
                Err(_) => {
                    self.fail(Failure::SpawnFailed, now);
                    self.event(
                        137,
                        json!({"version": 1, "nonce": launch.nonce, "scope": launch.scope}),
                    );
                    self.launch = Some(launch);
                }
            }
            return;
        }
        match frame.kind {
            2 => {
                if !self
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope.child.is_some())
                {
                    self.fail(Failure::InvalidFrame, now);
                    return;
                }
                let id = u32::from_be_bytes(frame.body[..4].try_into().unwrap());
                if self.pending.is_some() || self.next_write != Some(id) {
                    self.fail(Failure::InvalidFrame, now);
                    return;
                }
                self.next_write = id.checked_add(1);
                let mut bytes = frame.body;
                bytes.drain(..4);
                let write_timeout = self.launch.as_ref().unwrap().write_timeout_ms;
                self.pending = Some(PendingWrite {
                    id,
                    bytes,
                    accepted: 0,
                    deadline: now + Duration::from_millis(write_timeout),
                });
                if self.input_fenced {
                    self.settle_write(true);
                } else if self.pending.as_ref().unwrap().bytes.is_empty() {
                    self.settle_write(false);
                }
            }
            3 => self.close_input(),
            4 => self.stop(now, false),
            5 => self.stop(now, true),
            6 => {
                if self.input_fenced || self.scope.as_ref().is_none_or(|scope| scope.activated) {
                    self.fail(Failure::InvalidFrame, now);
                    return;
                }
                self.activation_started = None;
                let launch = self.launch.as_ref().unwrap();
                match self.scope.as_mut().unwrap().activate(launch) {
                    Ok(pid) => {
                        let group_id = self.scope.as_ref().unwrap().group_id;
                        match Identity::capture(pid, Some(group_id)) {
                            Ok(root) => {
                                let (boot, supervisor, anchor) = self.identities.as_ref().unwrap();
                                self.event(129, json!({"version": 1, "nonce": launch.nonce, "pid": pid, "groupId": group_id, "scope": launch.scope,
                                    "boot":boot,"supervisor":supervisor,"anchor":anchor,"root":root}));
                            }
                            Err(_) => self.fail(Failure::SpawnFailed, now),
                        }
                    }
                    Err(_) => self.fail(Failure::SpawnFailed, now),
                }
            }
            _ => self.fail(Failure::InvalidFrame, now),
        }
    }

    fn control_ready(&mut self, flags: i16, now: Instant) {
        // A pipe HUP is observable with buffered bytes still present. Treat it as
        // an out-of-band fence, without waiting for a 64-MiB frame to assemble.
        if flags & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            self.controller_open = false;
            self.fail(Failure::ControllerLost, now);
            return;
        }
        if flags & libc::POLLIN == 0 || self.failure.is_some() || self.terminal {
            return;
        }
        if self.assembly_started.is_none() {
            self.assembly_started = Some(now);
        }
        let writable = self.decoder.writable();
        let maximum = writable.len().min(protocol::OUTPUT_CHUNK);
        match read_fd(libc::STDIN_FILENO, &mut writable[..maximum]) {
            Ok(0) => {
                self.controller_open = false;
                self.fail(Failure::ControllerLost, now);
            }
            Ok(count) => match self.decoder.advance(count, self.pending.is_none()) {
                Ok(Some(frame)) => {
                    self.assembly_started = None;
                    self.frame(frame, now);
                }
                Ok(None) => {}
                Err(error) => self.fail(error, now),
            },
            Err(error) if would_wait(&error) => {}
            Err(_) => {
                self.controller_open = false;
                self.fail(Failure::ControllerLost, now);
            }
        }
    }

    fn provider_write(&mut self, now: Instant) {
        let Some(pending) = self.pending.as_mut() else {
            return;
        };
        let Some(fd) = self
            .scope
            .as_ref()
            .and_then(|scope| scope.input.as_ref())
            .map(AsRawFd::as_raw_fd)
        else {
            self.settle_write(true);
            return;
        };
        let end = pending
            .bytes
            .len()
            .min(pending.accepted + protocol::OUTPUT_CHUNK);
        match write_fd(fd, &pending.bytes[pending.accepted..end]) {
            Ok(0) => self.fail(Failure::WriteFailed, now),
            Ok(count) => {
                pending.accepted += count;
                if pending.accepted == pending.bytes.len() {
                    self.settle_write(false);
                }
            }
            Err(error) if would_wait(&error) => {}
            Err(_) => self.fail(Failure::WriteFailed, now),
        }
    }

    fn provider_read(&mut self, stream: usize, now: Instant) {
        let Some(scope) = self.scope.as_ref() else {
            return;
        };
        let fd = match stream {
            1 => scope.stdout.as_ref().map(AsRawFd::as_raw_fd),
            _ => scope.stderr.as_ref().map(AsRawFd::as_raw_fd),
        };
        let Some(fd) = fd else {
            return;
        };
        let stopping = scope.stop_at.is_some();
        let room = self.output.room(stream).saturating_sub(5);
        if room == 0 && !stopping {
            return;
        }
        let discard = room == 0 || self.output.broken;
        let maximum = if discard {
            protocol::OUTPUT_CHUNK
        } else {
            room.min(protocol::OUTPUT_CHUNK)
        };
        let mut bytes = [0u8; protocol::OUTPUT_CHUNK];
        match read_fd(fd, &mut bytes[..maximum]) {
            Ok(0) => {
                let scope = self.scope.as_mut().unwrap();
                if stream == 1 {
                    scope.stdout.take();
                } else {
                    scope.stderr.take();
                }
                if !self.output.frame(136, &[stream as u8]) {
                    self.output.abandon();
                }
            }
            Ok(count) => {
                if discard
                    || !self
                        .output
                        .frame(if stream == 1 { 130 } else { 131 }, &bytes[..count])
                {
                    self.fail(Failure::OutputFailed, now);
                }
            }
            Err(error) if would_wait(&error) => {}
            Err(_) => {
                self.scope.as_mut().unwrap().closure_uncertain = true;
                self.fail(Failure::OutputFailed, now);
            }
        }
    }

    fn tick(&mut self, now: Instant) {
        if STOP_SIGNAL.swap(false, Ordering::Relaxed) {
            self.fail(Failure::ControllerLost, now);
        }
        if self.output.broken
            && self
                .scope
                .as_ref()
                .is_some_and(|scope| scope.stop_at.is_none())
        {
            self.fail(Failure::OutputFailed, now);
        }
        if self.failure.is_none()
            && [self.assembly_started, self.activation_started]
                .into_iter()
                .flatten()
                .any(|start| {
                    now.duration_since(start).as_millis() >= u128::from(protocol::FRAME_ASSEMBLY_MS)
                })
        {
            self.fail(Failure::Deadline, now);
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|write| now >= write.deadline)
        {
            self.fail(Failure::WriteFailed, now);
        }
        if self.scope.is_none() {
            return;
        }
        match self.scope.as_mut().unwrap().observe_root() {
            Ok(Some((code, signal))) => {
                self.event(133, json!({"code": code, "signal": signal}));
                self.stop(now, false);
            }
            Ok(None) => {}
            Err(_) => {
                self.scope.as_mut().unwrap().closure_uncertain = true;
                self.fail(Failure::CleanupUnproven, now);
            }
        }
        match self.scope.as_mut().unwrap().observe_anchor() {
            Ok(true) if !self.scope.as_ref().unwrap().forced => {
                self.fail(Failure::CleanupUnproven, now)
            }
            Ok(_) => {}
            Err(_) => {
                self.scope.as_mut().unwrap().closure_uncertain = true;
                self.fail(Failure::CleanupUnproven, now);
            }
        }
        let force_due = {
            let scope = self.scope.as_ref().unwrap();
            !scope.forced
                && scope.stop_at.is_some_and(|start| {
                    now.duration_since(start).as_millis()
                        >= u128::from(self.launch.as_ref().unwrap().term_grace_ms)
                })
        };
        if force_due {
            self.stop(now, true);
        }
        let scope = self.scope.as_mut().unwrap();
        if scope.collect().is_err() {
            scope.closure_uncertain = true;
        }
        if scope.signal_failed && self.failure.is_none() {
            self.fail(Failure::CleanupUnproven, now);
        }
        let scope = self.scope.as_ref().unwrap();
        let joined = (scope.child.is_none() || scope.root_collected)
            && scope.anchor_collected
            && scope.stdout.is_none()
            && scope.stderr.is_none()
            && scope.input.is_none()
            && self.pending.is_none()
            && !scope.closure_uncertain
            && scope.group_absent();
        if joined && !self.terminal {
            let launch = self.launch.as_ref().unwrap();
            let terminal_kind = if self.scope.as_ref().unwrap().child.is_some() {
                134
            } else {
                137
            };
            self.event(
                terminal_kind,
                json!({"version": 1, "nonce": launch.nonce, "scope": launch.scope}),
            );
            self.terminal = true;
            self.terminal_deadline = self.scope.as_ref().unwrap().deadline;
        }
    }

    fn run(mut self) -> bool {
        loop {
            let now = Instant::now();
            self.tick(now);
            if self.terminal && self.output.frames.is_empty() {
                return !self.output.broken && self.launch.is_some();
            }
            let deadline = self
                .terminal_deadline
                .or_else(|| self.scope.as_ref().and_then(|scope| scope.deadline));
            if deadline.is_some_and(|deadline| now >= deadline) {
                self.fail(Failure::CleanupUnproven, now);
                let _ = self.output.flush();
                return false;
            }
            let scope = self.scope.as_ref();
            let stopping = scope.is_some_and(|scope| scope.stop_at.is_some());
            let fd = |stream: usize| -> RawFd {
                if self.output.room(stream) < 6 && !stopping {
                    return -1;
                }
                if stream == 1 {
                    scope
                        .and_then(|s| s.stdout.as_ref())
                        .map_or(-1, AsRawFd::as_raw_fd)
                } else {
                    scope
                        .and_then(|s| s.stderr.as_ref())
                        .map_or(-1, AsRawFd::as_raw_fd)
                }
            };
            let mut polls = [
                libc::pollfd {
                    fd: if self.controller_open && !self.terminal {
                        0
                    } else {
                        -1
                    },
                    // A failed controller is fenced. Keep HUP observation, but
                    // do not spin on buffered commands we will never consume.
                    events: if self.failure.is_none() {
                        libc::POLLIN
                    } else {
                        0
                    },
                    revents: 0,
                },
                libc::pollfd {
                    fd: if !self.output.frames.is_empty() && !self.output.broken {
                        1
                    } else {
                        -1
                    },
                    events: libc::POLLOUT,
                    revents: 0,
                },
                libc::pollfd {
                    fd: fd(1),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: fd(2),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: if self.pending.is_some() {
                        scope
                            .and_then(|s| s.input.as_ref())
                            .map_or(-1, AsRawFd::as_raw_fd)
                    } else {
                        -1
                    },
                    events: libc::POLLOUT,
                    revents: 0,
                },
            ];
            // A bounded poll also observes exact root exit independently of EOF.
            // Pipe readiness wakes immediately; native cleanup never waits on JS.
            let timeout = if stopping { 10 } else { 50 };
            // SAFETY: polls owns exactly len initialized pollfd entries.
            let result =
                unsafe { libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, timeout) };
            let now = Instant::now();
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                self.fail(Failure::CleanupUnproven, now);
            }
            self.control_ready(polls[0].revents, now);
            if polls[1].revents != 0 {
                if let Err(error) = self.output.flush() {
                    if !would_wait(&error) {
                        self.output.abandon();
                        self.fail(Failure::OutputFailed, now);
                    }
                }
            }
            if polls[2].revents != 0 {
                self.provider_read(1, now);
            }
            if polls[3].revents != 0 {
                self.provider_read(2, now);
            }
            if polls[4].revents != 0 {
                self.provider_write(now);
            }
        }
    }
}

pub fn run() -> bool {
    // Ignored SIGCHLD (including SA_NOCLDWAIT) can survive exec and auto-reap
    // children. Normalize it before creating the anchor: zombie retention is
    // what reserves the exact process-group identity through every signal.
    let mut child_action: libc::sigaction = unsafe { std::mem::zeroed() };
    child_action.sa_sigaction = libc::SIG_DFL;
    if unsafe { libc::sigemptyset(&mut child_action.sa_mask) } != 0
        || unsafe { libc::sigaction(libc::SIGCHLD, &child_action, std::ptr::null_mut()) } != 0
    {
        return false;
    }
    // Signal handlers only set a lock-free flag. All native cleanup stays with
    // the event-loop owner; SIGKILL cannot produce a terminal proof.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(
            libc::SIGTERM,
            stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGINT, stop_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGHUP, stop_signal as *const () as libc::sighandler_t);
    }
    if nonblocking(0).is_err() || nonblocking(1).is_err() {
        return false;
    }
    Owner::new().run()
}

/// Private group anchor. Its only retained endpoint is the supervisor-death
/// read pipe. EOF means that the only writer disappeared; signal this process's
/// own live group instead of reacquiring authority from a saved number.
pub fn run_anchor(controller_fd: RawFd) -> bool {
    if unsafe { libc::getpgrp() } != std::process::id() as i32 {
        return false;
    }
    if !(64..=1_048_575).contains(&controller_fd) || !controller_read_endpoint(controller_fd) {
        return false;
    }
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    // This is after exec, not pre_exec. Close unexpected inherited descriptors;
    // provider launch uses separate CLOEXEC parent endpoints and never sees this
    // read pipe. Bound the descriptor sweep before announcing readiness.
    let limit = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    if !(3..=1_048_576).contains(&limit) {
        return false;
    }
    for fd in 3..limit {
        if fd != i64::from(controller_fd) {
            unsafe {
                libc::close(fd as i32);
            }
        }
    }
    if write_fd(1, b"R").ok() != Some(1) {
        return false;
    }
    unsafe {
        libc::close(1);
        libc::close(2);
    }
    let mut byte = [0; 1];
    loop {
        let mut polls = [
            libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            },
            // Register readable interest to receive HUP on Darwin. Never read:
            // controller frames belong exclusively to the supervisor.
            libc::pollfd {
                fd: controller_fd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let polled = unsafe { libc::poll(polls.as_mut_ptr(), 2, 100) };
        if polled < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        let controller_lost =
            polls[1].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0;
        let death = polls[0].revents != 0;
        if death {
            let _ = read_fd(0, &mut byte);
        }
        if polled < 0 || controller_lost || death {
            // SAFETY: zero means our current group, with this live leader.
            unsafe {
                libc::kill(0, libc::SIGKILL);
            }
            return false;
        }
        if polls[1].revents & libc::POLLIN != 0 {
            // Buffered controller bytes belong to the supervisor. Rechecking
            // them immediately would spin, so wait at most20ms on the private
            // death pipe. HUP remains bounded even with a stopped supervisor
            // and an incomplete controller frame; no frame bytes are consumed.
            unsafe {
                libc::poll(polls.as_mut_ptr(), 1, 20);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_abstract_zero_names_are_not_anonymous_socketpairs() {
        assert!(anonymous_address_payload(&[], false));
        assert!(!anonymous_address_payload(&[0], false));
        assert!(!anonymous_address_payload(&[0; 14], false));
        assert!(anonymous_address_payload(&[0; 14], true));
        assert!(!anonymous_address_payload(&[0, b'x'], true));
    }

    #[test]
    fn startup_watchdogs_expire_without_bounding_ready_idle() {
        let start = Instant::now();
        let expired = start + Duration::from_millis(protocol::FRAME_ASSEMBLY_MS);
        let mut launch = Owner::new();
        launch.assembly_started = Some(start);
        launch.tick(expired);
        assert_eq!(launch.failure, Some(Failure::Deadline));

        let mut prepared = Owner::new();
        prepared.assembly_started = None;
        prepared.activation_started = Some(start);
        prepared.tick(expired - Duration::from_millis(1));
        assert_eq!(prepared.failure, None);
        prepared.tick(expired);
        assert_eq!(prepared.failure, Some(Failure::Deadline));
        assert!(prepared.input_fenced);

        let mut ready = Owner::new();
        ready.assembly_started = None;
        ready.activation_started = None;
        ready.tick(expired + Duration::from_secs(3600));
        assert_eq!(ready.failure, None);
        assert!(!ready.input_fenced);
    }
}
