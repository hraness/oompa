#[cfg(any(target_os = "macos", target_os = "linux"))]
mod identity;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod observation;
mod protocol;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix;

fn main() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let success = {
        let mut arguments = std::env::args_os().skip(1);
        match arguments.next() {
            None => unix::run(),
            Some(mode) if mode == "--scope-anchor" => {
                let fd = arguments.next();
                arguments.next().is_none()
                    && fd
                        .and_then(|value| value.to_str().and_then(|text| text.parse::<i32>().ok()))
                        .is_some_and(unix::run_anchor)
            }
            Some(mode) if mode == "--host-context" && arguments.next().is_none() => {
                observation::run(false)
            }
            Some(mode) if mode == "--observe-custody" && arguments.next().is_none() => {
                observation::run(true)
            }
            Some(_) => false,
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let success = {
        use std::io::Write;
        let frame = protocol::encode(135, br#"{"reason":"unsupported-scope"}"#);
        let _ = std::io::stdout().write_all(&frame);
        false
    };
    std::process::exit(if success { 0 } else { 1 });
}
