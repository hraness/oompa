//! `oompa-menubar` — the Oompa menu-bar companion.
//!
//! A disposable client of the local daemon. It renders daemon status and the
//! live session list into a status-item menu and can launch the daemon when
//! it is down. All authority stays in the daemon; this binary only speaks
//! the unix-socket command protocol.
//!
//! Runs unbundled: the `oompa` CLI builds and spawns this executable
//! directly. Packaging is an optional later gate.

mod daemon;

use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::sync::Arc;
use std::time::Duration;

use desktop_foundation::{Host, MenuModel, MenuNode, Options};
use daemon::{CallError, Daemon};

const SESSION_LIMIT: u32 = 8;

struct OompaHost {
    daemon: Daemon,
}

impl OompaHost {
    fn session_nodes(&self) -> Vec<MenuNode> {
        let mut nodes = Vec::new();
        match self.daemon.session_list(SESSION_LIMIT) {
            Ok(data) => {
                let sessions = data
                    .get("sessions")
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default();
                if sessions.is_empty() {
                    nodes.push(MenuNode::disabled("No sessions"));
                }
                for session in sessions {
                    let title = session
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or("untitled");
                    let state = session
                        .get("state")
                        .and_then(|s| s.as_str())
                        .unwrap_or("unknown");
                    nodes.push(MenuNode::disabled(format!("{title} — {state}")));
                }
            }
            Err(_) => nodes.push(MenuNode::disabled("Session list unavailable")),
        }
        nodes
    }
}

impl Host for OompaHost {
    fn snapshot(&self) -> MenuModel {
        let mut nodes = vec![MenuNode::disabled("Oompa"), MenuNode::Separator];
        let tooltip: String;
        match self.daemon.status() {
            Ok(status) => {
                let pid = status.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                nodes.push(MenuNode::disabled(format!("Daemon running · pid {pid}")));
                nodes.push(MenuNode::Separator);
                nodes.extend(self.session_nodes());
                tooltip = format!("Oompa — daemon running (pid {pid})");
            }
            Err(CallError::Unavailable(_)) => {
                nodes.push(MenuNode::disabled("Daemon not running"));
                nodes.push(MenuNode::item("daemon.start", "Start daemon"));
                tooltip = "Oompa — daemon not running".to_owned();
            }
            Err(error) => {
                nodes.push(MenuNode::disabled("Daemon state unknown"));
                tooltip = format!("Oompa — {error}");
            }
        }
        nodes.push(MenuNode::Separator);
        nodes.push(MenuNode::quit("Quit Oompa"));
        MenuModel {
            title: Some("Oompa".to_owned()),
            tooltip: Some(tooltip),
            icon: None,
            nodes,
        }
    }

    fn dispatch(&self, id: &str) {
        if id == "daemon.start" {
            // The CLI owns daemon startup. Spawn it detached and scrub nothing:
            // exact argv, inherited environment, no shell.
            let cli = std::env::var("OOMPA_MENUBAR_CLI").unwrap_or_else(|_| "oompa".to_owned());
            let _ = std::process::Command::new(cli)
                .args(["daemon", "start"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
}

/// One status item per user. A second instance exits quietly rather than
/// double-registering an `NSStatusItem`.
fn acquire_instance_lock() -> Option<File> {
    let runtime = Daemon::for_current_user()?
        .socket
        .parent()?
        .to_path_buf();
    std::fs::create_dir_all(&runtime).ok()?;
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(runtime.join("oompa-menubar.lock"))
        .ok()?;
    // flock on the runtime lock file — the file is advisory; the process
    // holding it is the only live status item.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 { Some(file) } else { None }
}

fn main() {
    let Some(daemon) = Daemon::for_current_user() else {
        eprintln!("oompa-menubar: cannot resolve the user state directory (HOME unset)");
        std::process::exit(2);
    };
    // `--probe` performs one daemon round-trip on stdout for CLI/dev checks
    // without starting the application loop.
    if std::env::args().nth(1).as_deref() == Some("--probe") {
        match daemon.status() {
            Ok(status) => {
                println!("daemon running: {}", status.get("pid").and_then(|v| v.as_u64()).unwrap_or(0));
                match daemon.session_list(SESSION_LIMIT) {
                    Ok(data) => {
                        let count = data
                            .get("sessions")
                            .and_then(|s| s.as_array())
                            .map_or(0, |s| s.len());
                        println!("sessions: {count}");
                    }
                    Err(error) => println!("session list: {error}"),
                }
            }
            Err(CallError::Unavailable(error)) => println!("daemon unavailable: {error}"),
            Err(error) => {
                eprintln!("probe failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let _instance = match acquire_instance_lock() {
        Some(lock) => lock,
        None => return,
    };
    let host = Arc::new(OompaHost { daemon });
    let options = Options { refresh: Duration::from_secs(5) };
    if let Err(error) = desktop_foundation::run(tauri::generate_context!(), host, options) {
        eprintln!("oompa-menubar: {error}");
        std::process::exit(1);
    }
}
