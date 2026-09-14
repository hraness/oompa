//! Actual credential-free observation fixtures, run inside the native suite.
use super::{assert_joined, frame, Controller, NONCE};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const REQUEST_ID: &str = "abcdef0123456789abcdef0123456789";

fn invoke(arguments: &[&str], bytes: &[u8], close_input: bool) -> (bool, Vec<u8>) {
    let mut child = Command::new(super::qualification::helper())
        .args(arguments)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65_543).read_to_end(&mut bytes).unwrap();
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(4097).read_to_end(&mut bytes).unwrap();
        bytes
    });
    // Inputs are bounded by a frame; malformed modes may close before delivery.
    let _ = input.write_all(bytes);
    let input = if close_input {
        drop(input);
        None
    } else {
        Some(input)
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break (status, false);
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            break (child.wait().unwrap(), true);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    drop(input);
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    assert!(
        !timed_out,
        "native observation exceeded its independent deadline"
    );
    assert!(stderr.is_empty());
    assert!(stdout.len() <= 65_541);
    (status.success(), stdout)
}

fn decode(bytes: &[u8], kind: u8) -> Value {
    assert!(bytes.len() >= 5);
    assert_eq!(bytes[0], kind);
    let length = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
    assert_eq!(
        bytes.len(),
        length + 5,
        "one exact framed response and clean EOF"
    );
    serde_json::from_slice(&bytes[5..]).unwrap()
}

fn context() -> Value {
    let request = frame(
        7,
        &serde_json::to_vec(&json!({"version":1,"requestId":REQUEST_ID})).unwrap(),
    );
    let (success, bytes) = invoke(&["--host-context"], &request, true);
    assert!(success);
    let response = decode(&bytes, 139);
    assert_eq!(response["requestId"], REQUEST_ID);
    let context = response["context"].clone();
    assert_eq!(context["host"]["platform"], context["boot"]["platform"]);
    assert_eq!(context["host"]["digest"].as_str().unwrap().len(), 64);
    context
}

fn target(prepared: &Value, ready: Option<&Value>) -> Value {
    json!({"nonce":NONCE,"bindingDigest":"7".repeat(64),"expectedRevision":3,
        "prepared":prepared,"ready":ready})
}

fn observe(context: &Value, targets: Vec<Value>) -> Value {
    let request = json!({"version":1,"requestId":REQUEST_ID,"context":context,"targets":targets});
    let (success, bytes) = invoke(
        &["--observe-custody"],
        &frame(8, &serde_json::to_vec(&request).unwrap()),
        true,
    );
    assert!(success);
    let response = decode(&bytes, 140);
    assert_eq!(response["requestId"], REQUEST_ID);
    assert_eq!(response["targets"].as_array().unwrap().len(), targets.len());
    for (observed, expected) in response["targets"].as_array().unwrap().iter().zip(targets) {
        for key in ["nonce", "bindingDigest", "expectedRevision"] {
            assert_eq!(observed[key], expected[key]);
        }
    }
    response
}

fn prepared_of(ready: &Value) -> Value {
    let mut prepared = ready.clone();
    prepared.as_object_mut().unwrap().remove("root");
    prepared.as_object_mut().unwrap().remove("pid");
    prepared
}

#[test]
fn observation_host_context_is_stable_and_malformed_modes_do_not_launch() {
    assert_eq!(context(), context());
    let good = frame(
        7,
        &serde_json::to_vec(&json!({"version":1,"requestId":REQUEST_ID})).unwrap(),
    );
    let extra = [good.clone(), vec![0]].concat();
    let oversized = frame(7, &vec![b' '; 65_537]);
    let duplicate = frame(
        7,
        format!(r#"{{"version":1,"version":1,"requestId":"{REQUEST_ID}"}}"#).as_bytes(),
    );
    let unknown = frame(
        7,
        &serde_json::to_vec(&json!({"version":1,"requestId":REQUEST_ID,"argv":["/bin/false"]}))
            .unwrap(),
    );
    for bytes in [
        vec![],
        vec![7, 0],
        frame(1, b"{}"),
        extra,
        oversized,
        duplicate,
        unknown,
    ] {
        let (success, bytes) = invoke(&["--host-context"], &bytes, true);
        assert!(!success);
        if !bytes.is_empty() {
            assert_eq!(bytes[0], 135);
        }
    }
    assert!(!invoke(&["--host-context", "extra"], &good, true).0);
    assert!(!invoke(&["--unknown"], &good, true).0);
    assert!(
        !invoke(&["--host-context"], &good, false).0,
        "request requires bounded EOF"
    );
}

#[test]
fn observation_distinguishes_live_stopped_replaced_and_reaped_identities() {
    let context = context();
    let mut owner = Controller::new();
    let ready = owner.launch("block-input");
    let prepared = prepared_of(&ready);
    let live = observe(&context, vec![target(&prepared, Some(&ready))]);
    assert_eq!(live["relation"], "same-boot");
    for name in ["supervisor", "anchor", "root"] {
        assert_eq!(live["targets"][0][name], "same-process-present");
    }
    assert_eq!(live["targets"][0]["group"], "present");

    assert_eq!(
        unsafe { libc::kill(owner.child.id() as i32, libc::SIGSTOP) },
        0
    );
    let deadline = Instant::now() + Duration::from_secs(1);
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
        if result != 0 || Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    // Resume even if an observation assertion/panic occurs while stopped.
    let result =
        std::panic::catch_unwind(|| observe(&context, vec![target(&prepared, Some(&ready))]));
    assert_eq!(
        unsafe { libc::kill(owner.child.id() as i32, libc::SIGCONT) },
        0
    );
    assert!(stopped);
    assert_eq!(
        result.unwrap()["targets"][0]["supervisor"],
        "same-process-present"
    );

    let mut replaced = ready.clone();
    let birth = replaced["root"]["birth"].as_object_mut().unwrap();
    if birth.contains_key("seconds") {
        birth.insert("seconds".to_owned(), json!("0"));
    } else {
        birth.insert("ticks".to_owned(), json!("0"));
    }
    let replacement = observe(&context, vec![target(&prepared, Some(&replaced))]);
    assert_eq!(replacement["targets"][0]["root"], "original-absent");
    assert_eq!(
        observe(&context, vec![target(&prepared, Some(&ready))])["targets"][0]["root"],
        "same-process-present"
    );

    owner.send(4, &[]);
    assert_joined(&owner.finish());
    let absent = observe(&context, vec![target(&prepared, Some(&ready))]);
    for name in ["supervisor", "anchor", "root"] {
        assert_eq!(absent["targets"][0][name], "original-absent");
    }
    assert_eq!(absent["targets"][0]["group"], "absent");
}

#[test]
fn observation_foreign_contexts_never_claim_pid_absence() {
    let context = context();
    let mut owner = Controller::new();
    let prepared = owner.prepare("block-input");
    let mut foreign = context.clone();
    foreign["host"]["digest"] = json!("0".repeat(64));
    let response = observe(&foreign, vec![target(&prepared, None)]);
    assert_eq!(response["relation"], "foreign-host");
    for key in ["supervisor", "anchor", "group"] {
        assert_eq!(response["targets"][0][key], "unknown");
    }
    assert!(response["targets"][0]["root"].is_null());
    let mut old_context = context.clone();
    old_context["boot"]["id"] = json!("00000000-0000-0000-0000-000000000000");
    let mut old_prepared = prepared.clone();
    old_prepared["boot"] = old_context["boot"].clone();
    let response = observe(&old_context, vec![target(&old_prepared, None)]);
    assert_eq!(response["relation"], "boot-ended");
    assert_eq!(response["targets"][0]["group"], "unknown");
    owner.send(4, &[]);
    owner.finish();
}

#[test]
fn observation_bounds_batches_and_requires_exact_nested_fields() {
    let context = context();
    let mut owner = Controller::new();
    let prepared = owner.prepare("block-input");
    let targets: Vec<_> = (0..16)
        .map(|index| {
            let mut value = target(&prepared, None);
            let nonce = format!("{index:032x}");
            value["nonce"] = json!(nonce);
            value["prepared"]["nonce"] = value["nonce"].clone();
            value
        })
        .collect();
    assert_eq!(
        observe(&context, targets.clone())["targets"]
            .as_array()
            .unwrap()
            .len(),
        16
    );
    for variant in 0..5 {
        let mut request =
            json!({"version":1,"requestId":REQUEST_ID,"context":context,"targets":targets});
        match variant {
            0 => {
                request["targets"]
                    .as_array_mut()
                    .unwrap()
                    .push(target(&prepared, None));
            }
            1 => {
                request["targets"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("ready");
            }
            2 => {
                request["targets"][0]["prepared"]["anchor"]["birth"]["extra"] = json!(false);
            }
            3 => {
                request["targets"][0]["prepared"]["groupId"] = json!(1);
            }
            4 => {
                request["targets"][0]["prepared"]["supervisor"]["pid"] = json!(1);
            }
            _ => unreachable!(),
        }
        let (success, bytes) = invoke(
            &["--observe-custody"],
            &frame(8, &serde_json::to_vec(&request).unwrap()),
            true,
        );
        assert!(!success);
        assert_eq!(decode(&bytes, 135)["reason"], "invalid-frame");
    }
    owner.send(4, &[]);
    owner.finish();
}

#[test]
fn observation_never_calls_held_zombie_identities_absent() {
    let context = context();
    let mut owner = Controller::new();
    let ready = owner.launch("block-input");
    let prepared = prepared_of(&ready);
    let group = ready["groupId"].as_i64().unwrap() as i32;
    #[cfg(target_os = "macos")]
    for identity in [&ready["anchor"], &ready["root"]] {
        assert!(super::same_live_birth(identity, group));
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
    owner.input.take();
    let deadline = Instant::now() + Duration::from_secs(1);
    let held_zombies = loop {
        if !stopped {
            break false;
        }
        if super::same_zombie(&ready["anchor"], group, owner.child.id())
            && super::same_zombie(&ready["root"], group, owner.child.id())
        {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let observation =
        std::panic::catch_unwind(|| observe(&context, vec![target(&prepared, Some(&ready))]));
    assert_eq!(
        unsafe { libc::kill(owner.child.id() as i32, libc::SIGCONT) },
        0
    );
    assert!(
        held_zombies,
        "owned root/anchor must be held zombies before observation"
    );
    let observed = observation.unwrap();
    assert_eq!(observed["targets"][0]["supervisor"], "same-process-present");
    for name in ["anchor", "root"] {
        assert_ne!(observed["targets"][0][name], "original-absent");
        #[cfg(target_os = "macos")]
        assert_eq!(observed["targets"][0][name], "unknown");
    }
    assert_joined(&owner.finish());
}
