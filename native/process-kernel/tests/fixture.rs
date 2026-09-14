//! Explicit native-fixtures feature only. No provider, credentials or files.
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn main() {
    // Every fixture has a finite lifetime even if the helper is killed or a test
    // assertion fails. This watchdog is not counted as helper cleanup evidence.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(8));
        std::process::exit(99);
    });
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "echo" => {
            let mut input = std::io::stdin().lock();
            let mut output = std::io::stdout().lock();
            let mut bytes = [0; 4096];
            loop {
                let count = input.read(&mut bytes).unwrap();
                if count == 0 {
                    break;
                }
                output.write_all(&bytes[..count]).unwrap();
            }
        }
        "environment" => {
            println!(
                "{}:{}:{}",
                std::env::var("FIXTURE_VALUE").unwrap_or_default(),
                std::env::var_os("SHOULD_NOT_INHERIT").is_some(),
                std::env::var_os("HOME").is_some()
            );
        }
        "descriptors" => {
            // No inherited private controller or anchor endpoint may survive
            // provider exec. These fixtures open no non-stdio descriptors.
            let limit = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
            assert!((3..=1_048_576).contains(&limit));
            let open = (3..limit as i32)
                .filter(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } != -1)
                .count();
            println!("{open}");
        }
        "count" => {
            let mut count = 0usize;
            let mut bytes = [0; 65_536];
            loop {
                let read = std::io::stdin().read(&mut bytes).unwrap();
                if read == 0 {
                    break;
                }
                count += read;
                assert!(bytes[..read].iter().all(|byte| *byte == 0x73));
            }
            println!("{count}");
        }
        "pressure" => {
            let stderr = std::thread::spawn(|| {
                for _ in 0..64 {
                    std::io::stderr().write_all(&[0x91; 32 * 1024]).unwrap();
                }
            });
            for _ in 0..64 {
                std::io::stdout().write_all(&[0x83; 32 * 1024]).unwrap();
            }
            stderr.join().unwrap();
        }
        "block-input" | "worker" => {
            #[cfg(unix)]
            unsafe {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
            if mode == "worker" {
                std::io::stdout().write_all(b"native-child\n").unwrap();
                std::io::stderr().write_all(b"ready\n").unwrap();
            }
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        "launcher" | "launcher-exit" => launcher(mode == "launcher-exit"),
        "close-on-input-eof" => {
            let mut sink = [0; 1024];
            while std::io::stdin().read(&mut sink).unwrap() != 0 {}
        }
        "immediate" => {}
        _ => std::process::exit(2),
    }
}

#[allow(
    clippy::zombie_processes,
    reason = "Explicit native fault fixture: the scope owner must collect a worker whose launcher exits first; every fixture also has a finite watchdog"
)]
fn launcher(exit_first: bool) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("worker")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = [0; 6];
    child
        .stderr
        .as_mut()
        .unwrap()
        .read_exact(&mut ready)
        .unwrap();
    assert_eq!(&ready, b"ready\n");
    if exit_first {
        return;
    }
    let _ = child.wait();
}
