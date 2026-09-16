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

use daemon::{CallError, Daemon};
use desktop_foundation::outputs::OutputsSection;
use desktop_foundation::{
    AccessibilityMetadata, DispatchOutcome, Host, MenuItem, MenuModel, MenuNode, Options,
    RenderError,
};

const SESSION_LIMIT: u32 = 8;

struct OompaHost {
    daemon: Daemon,
    outputs: OutputsSection,
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
                nodes.push(MenuNode::interactive(
                    MenuItem::action("daemon.start", "Start daemon")
                        .with_shortcut("CmdOrCtrl+S")
                        .with_accessibility(AccessibilityMetadata {
                            label: Some("Start Oompa daemon".to_owned()),
                            value: None,
                            hint: Some("Launches the local Oompa daemon".to_owned()),
                        }),
                ));
                tooltip = "Oompa — daemon not running".to_owned();
            }
            Err(error) => {
                nodes.push(MenuNode::disabled("Daemon state unknown"));
                tooltip = format!("Oompa — {error}");
            }
        }
        nodes.push(MenuNode::Separator);
        nodes.extend(self.outputs.nodes());
        nodes.push(MenuNode::Separator);
        nodes.push(MenuNode::interactive(
            MenuItem::action(desktop_foundation::QUIT_ACTION_ID, "Quit Oompa")
                .with_shortcut("CmdOrCtrl+Q")
                .with_accessibility(AccessibilityMetadata {
                    label: Some("Quit Oompa".to_owned()),
                    value: None,
                    hint: Some("Exit the Oompa menu bar companion".to_owned()),
                }),
        ));
        MenuModel {
            title: Some("Oompa".to_owned()),
            tooltip: Some(tooltip),
            icon: None,
            nodes,
        }
    }

    fn dispatch_result(&self, id: &str) -> DispatchOutcome {
        if self.outputs.dispatch(id) {
            return DispatchOutcome::Accepted;
        }
        if id == "daemon.start" {
            // The CLI owns daemon startup. Keep its exact argv and inherited
            // environment; a worker waits for it without blocking menu dispatch.
            let cli = std::env::var("OOMPA_MENUBAR_CLI").unwrap_or_else(|_| "oompa".to_owned());
            let mut command = std::process::Command::new(cli);
            command
                .args(["daemon", "start"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let _ = run_cli_in_background(command);
            return DispatchOutcome::Accepted;
        }
        DispatchOutcome::Rejected
    }

    fn render_failed(&self, error: RenderError) {
        eprintln!("oompa-menubar: render failed: {error:?}");
    }
}

fn run_cli_in_background(
    mut command: std::process::Command,
) -> std::io::Result<std::thread::JoinHandle<std::io::Result<std::process::ExitStatus>>> {
    // Create the worker before the child so a thread-creation failure cannot
    // orphan a spawned process. status() waits for and reaps the exact child.
    std::thread::Builder::new()
        .name("oompa-menubar-cli".to_owned())
        .spawn(move || command.status())
}

#[cfg(test)]
mod process_tests {
    use super::run_cli_in_background;
    use std::io::Read;
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    fn background_cli_reaps_its_exact_child() {
        let (mut output, child_output) = UnixStream::pair().unwrap();
        output
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .env_clear()
            .args(["-c", "printf '%s' \"$$\"; exit 23"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(OwnedFd::from(child_output)))
            .stderr(Stdio::null());

        let worker = run_cli_in_background(command).unwrap();
        assert_eq!(worker.thread().name(), Some("oompa-menubar-cli"));
        assert_eq!(worker.join().unwrap().unwrap().code(), Some(23));
        let mut pid = String::new();
        (&mut output).take(32).read_to_string(&mut pid).unwrap();
        let pid: libc::pid_t = pid.parse().unwrap();
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[test]
    fn background_cli_returns_spawn_failure() {
        let worker = run_cli_in_background(Command::new("")).unwrap();
        assert!(worker.join().unwrap().is_err());
    }
}

/// One status item per user. A second instance exits quietly rather than
/// double-registering an `NSStatusItem`.
fn acquire_instance_lock() -> Option<File> {
    let runtime = Daemon::for_current_user()?.socket.parent()?.to_path_buf();
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
    if result == 0 {
        Some(file)
    } else {
        None
    }
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
                println!(
                    "daemon running: {}",
                    status.get("pid").and_then(|v| v.as_u64()).unwrap_or(0)
                );
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
    let outputs = OutputsSection::new(
        daemon
            .socket
            .parent()
            .and_then(|r| r.parent())
            .unwrap()
            .join("outputs"),
    );
    let host = Arc::new(OompaHost { daemon, outputs });
    let options = Options {
        refresh: Duration::from_secs(5),
        companion_window: false,
    };
    if let Err(error) = desktop_foundation::run(tauri::generate_context!(), host, options, |b| b) {
        eprintln!("oompa-menubar: {error}");
        std::process::exit(1);
    }
}
