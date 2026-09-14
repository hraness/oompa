//! Native birth and boot observations. Never reads command lines or environment.
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "platform", rename_all = "lowercase", deny_unknown_fields)]
pub enum Boot {
    Darwin {
        id: String,
    },
    Linux {
        id: String,
        #[serde(rename = "pidNamespace")]
        pid_namespace: Namespace,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Namespace {
    device: String,
    inode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Birth {
    #[serde(rename = "darwin-start-time")]
    Darwin { seconds: String, micros: u32 },
    #[serde(rename = "linux-start-ticks")]
    Linux { ticks: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub pid: i32,
    pub birth: Birth,
}

fn invalid() -> io::Error {
    io::Error::other("native identity unavailable")
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn decimal(value: &str) -> bool {
    value
        .parse::<u64>()
        .is_ok_and(|number| number.to_string() == value)
}

impl Boot {
    pub fn platform(&self) -> &'static str {
        match self {
            Self::Darwin { .. } => "darwin",
            Self::Linux { .. } => "linux",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Darwin { id } | Self::Linux { id, .. } => id,
        }
    }

    pub fn valid(&self) -> bool {
        uuid(self.id())
            && match self {
                Self::Darwin { .. } => true,
                Self::Linux { pid_namespace, .. } => {
                    decimal(&pid_namespace.device) && decimal(&pid_namespace.inode)
                }
            }
    }
}

impl Identity {
    pub fn valid_for(&self, boot: &Boot) -> bool {
        self.pid > 1
            && match (&self.birth, boot) {
                (Birth::Darwin { seconds, micros }, Boot::Darwin { .. }) => {
                    decimal(seconds) && *micros < 1_000_000
                }
                (Birth::Linux { ticks }, Boot::Linux { .. }) => decimal(ticks),
                _ => false,
            }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Host {
    platform: String,
    digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub host: Host,
    pub boot: Boot,
}

impl Context {
    pub fn valid(&self) -> bool {
        self.boot.valid()
            && self.host.platform == self.boot.platform()
            && self.host.digest.len() == 64
            && self
                .host
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    pub fn capture() -> io::Result<Self> {
        let boot = Boot::capture()?;
        let raw = host_identity()?;
        if raw == [0; 16] {
            return Err(invalid());
        }
        // The fixed application-specific key separates this local identity from
        // raw hardware/machine IDs and from other applications' identifiers.
        let mut hash = Hmac::<Sha256>::new_from_slice(b"hraness.native-process.host-context.v1")
            .map_err(|_| invalid())?;
        hash.update(boot.platform().as_bytes());
        hash.update(&[0]);
        hash.update(&raw);
        let digest = hash
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Self {
            host: Host {
                platform: boot.platform().to_owned(),
                digest,
            },
            boot,
        })
    }
}

#[cfg(target_os = "macos")]
fn host_identity() -> io::Result<[u8; 16]> {
    let mut bytes = [0; 16];
    // A zero timeout means an unlimited wait. This observation is bounded.
    let timeout = libc::timespec {
        tv_sec: 0,
        tv_nsec: 100_000_000,
    };
    // SAFETY: fixed 16-byte UUID output and initialized timeout, no retained pointers.
    if unsafe { libc::gethostuuid(bytes.as_mut_ptr(), &timeout) } != 0 {
        return Err(invalid());
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn host_identity() -> io::Result<[u8; 16]> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open("/etc/machine-id")?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.by_ref().take(34).read_to_end(&mut bytes)?;
    let value = bytes
        .strip_suffix(b"\n")
        .filter(|value| value.len() == 32)
        .ok_or_else(invalid)?;
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut result = [0; 16];
    for (index, pair) in value.chunks_exact(2).enumerate() {
        result[index] =
            digit(pair[0]).ok_or_else(invalid)? * 16 + digit(pair[1]).ok_or_else(invalid)?;
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessObservation {
    SameProcessPresent,
    OriginalAbsent,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupObservation {
    Present,
    Absent,
    Unknown,
}

fn existence(pid: i32) -> GroupObservation {
    // SAFETY: signal zero observes existence only. No nonzero signal is sent.
    if unsafe { libc::kill(pid, 0) } == 0 {
        GroupObservation::Present
    } else if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        GroupObservation::Absent
    } else {
        GroupObservation::Unknown
    }
}

pub fn observe_process(expected: &Identity) -> ProcessObservation {
    if expected.pid <= 1 {
        return ProcessObservation::Unknown;
    }
    match existence(expected.pid) {
        GroupObservation::Absent => ProcessObservation::OriginalAbsent,
        GroupObservation::Unknown => ProcessObservation::Unknown,
        GroupObservation::Present => match Identity::capture(expected.pid, None) {
            Ok(observed) if observed == *expected => ProcessObservation::SameProcessPresent,
            Ok(_) => ProcessObservation::OriginalAbsent,
            // Darwin can omit a held zombie from libproc while signal zero
            // still sees it. Only a fresh exact ESRCH may establish absence.
            Err(_) if existence(expected.pid) == GroupObservation::Absent => {
                ProcessObservation::OriginalAbsent
            }
            Err(_) => ProcessObservation::Unknown,
        },
    }
}

pub fn observe_group(group: i32) -> GroupObservation {
    // -1 and zero have broader process semantics, never admit those targets.
    if group <= 1 {
        GroupObservation::Unknown
    } else {
        existence(-group)
    }
}

#[cfg(target_os = "macos")]
impl Boot {
    pub fn capture() -> io::Result<Self> {
        let mut bytes = [0u8; 37];
        let mut length = bytes.len();
        // SAFETY: fixed NUL-terminated key and exact writable bounded output.
        let result = unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 || length != 37 || bytes[36] != 0 {
            return Err(invalid());
        }
        let id = std::str::from_utf8(&bytes[..36])
            .map_err(|_| invalid())?
            .to_ascii_lowercase();
        if !uuid(&id) {
            return Err(invalid());
        }
        Ok(Self::Darwin { id })
    }
}

#[cfg(target_os = "macos")]
impl Identity {
    pub fn capture(pid: i32, group: Option<i32>) -> io::Result<Self> {
        if pid <= 1 {
            return Err(invalid());
        }
        // SAFETY: fixed libproc record initialized and passed with its exact size.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let result = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if result != size
            || info.pbi_pid != pid as u32
            || group.is_some_and(|group| info.pbi_pgid != group as u32)
            || info.pbi_start_tvusec > 999_999
        {
            return Err(invalid());
        }
        Ok(Self {
            pid,
            birth: Birth::Darwin {
                seconds: info.pbi_start_tvsec.to_string(),
                micros: info.pbi_start_tvusec as u32,
            },
        })
    }
}

#[cfg(target_os = "linux")]
fn read_bounded(path: &str, maximum: u64) -> io::Result<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let mut bytes = Vec::new();
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(invalid());
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
impl Boot {
    pub fn capture() -> io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let bytes = read_bounded("/proc/sys/kernel/random/boot_id", 37)?;
        let id = std::str::from_utf8(&bytes)
            .map_err(|_| invalid())?
            .strip_suffix('\n')
            .ok_or_else(invalid)?;
        if !uuid(id) {
            return Err(invalid());
        }
        let ns = std::fs::metadata("/proc/self/ns/pid")?;
        Ok(Self::Linux {
            id: id.to_owned(),
            pid_namespace: Namespace {
                device: ns.dev().to_string(),
                inode: ns.ino().to_string(),
            },
        })
    }
}

#[cfg(target_os = "linux")]
impl Identity {
    pub fn capture(pid: i32, group: Option<i32>) -> io::Result<Self> {
        if pid <= 1 {
            return Err(invalid());
        }
        let bytes = read_bounded(&format!("/proc/{pid}/stat"), 8192)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
        let (prefix, rest) = text.split_once(" (").ok_or_else(invalid)?;
        if prefix != pid.to_string() {
            return Err(invalid());
        }
        let close = rest.rfind(')').ok_or_else(invalid)?;
        let suffix = rest.get(close + 1..).ok_or_else(invalid)?;
        if !suffix.starts_with(' ') {
            return Err(invalid());
        }
        let fields: Vec<_> = suffix.split_ascii_whitespace().collect();
        if fields.len() < 20 || fields.len() > 64 || fields[0].len() != 1 {
            return Err(invalid());
        }
        let pgid: i32 = fields[2].parse().map_err(|_| invalid())?;
        let ticks: u64 = fields[19].parse().map_err(|_| invalid())?;
        if group.is_some_and(|group| group != pgid) || fields[19] != ticks.to_string() {
            return Err(invalid());
        }
        Ok(Self {
            pid,
            birth: Birth::Linux {
                ticks: ticks.to_string(),
            },
        })
    }
}
