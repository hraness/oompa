use std::path::PathBuf;

// This override belongs only to the separately built test harness. The release
// gate supplies the exact installed, admitted image; production has no override.
pub fn helper() -> PathBuf {
    let path = std::env::var_os("NATIVE_PROCESS_QUALIFICATION_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_oompa-process-kernel")));
    assert!(path.is_absolute());
    path
}

pub fn fixture() -> PathBuf {
    let path = std::env::var_os("NATIVE_PROCESS_QUALIFICATION_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_process-kernel-fixture")));
    assert!(path.is_absolute());
    path
}
