import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const supervisorSource = async (): Promise<string> =>
  readFile(join(import.meta.dir, "authority-supervisor.rs"), "utf8");

const section = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

test("authority supervisor keeps control separate from target stdio", async () => {
  const source = await supervisorSource();

  expect(source).toContain("--control-socket");
  expect(source).toContain("--nonce");
  expect(source).toContain("HRA_AUTHORITY_SUPERVISOR/1 READY");
  expect(source).toContain("HRA_AUTHORITY_SUPERVISOR/1 CLEAN");
  expect(source).toContain("init_host_pid");
  expect(source).toContain("init_start_time");
  expect(source).toContain("init_pid_namespace_inode");
  expect(source).toContain("recovery_pid");
  expect(source).toContain("recovery_start_time");
  expect(source).toContain("#[repr(C)]\n    struct InitReadyRecord");
  expect(source).toContain("let target_argv = Box::leak(pointerTable(&argv_entries)");
  expect(source).toContain("standardDescriptorsOpen()");
  expect(source).toContain("closeRangeExcept(CONTROL_FD, SCRATCH_FD_MINIMUM - 1, input_control)");
  expect(source).toContain("failControlAndExit(fds.control, nonce, err)");
  expect(source).toContain("closeRange(3, i32::MAX)");
  expect(source).toContain("clearCloseOnExec(0)");
  expect(source).toContain("clearCloseOnExec(1)");
  expect(source).toContain("clearCloseOnExec(2)");
});

test("authority supervisor establishes a private, fail-closed Linux custody boundary", async () => {
  const source = await supervisorSource();

  expect(source).toContain("CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNS");
  expect(source).toContain("MS_REC | MS_PRIVATE");
  expect(source).not.toContain("k_umount");
  const freshProc = section(source, "fn mountFreshProc(", "struct DirectoryIdentity");
  expect(freshProc).toContain('b"proc\\0".as_ptr()');
  expect(freshProc).toContain('b"/proc\\0".as_ptr()');
  expect(freshProc).toContain("k_mount(");
  expect(source).toContain("PR_SET_PDEATHSIG");
  expect(source).toContain("assertParentStill(launch_parent_pid)?");
  expect(source).toContain("assertLifelineStillOpen(fds.lifeline_read)");
  expect(source).toContain("PR_SET_DUMPABLE");
  expect(source).toContain("PR_SET_NO_NEW_PRIVS");
  expect(source).toContain("PR_CAPBSET_DROP");
});

test("authority supervisor conceals durable custody before READY without a cwd escape", async () => {
  const source = await supervisorSource();
  const launch = section(source, "fn runLaunch(", "fn runPrepared(");
  const init = section(source, "fn initMain(", "fn targetMain(");
  const target = section(source, "fn targetMain(", "fn unshareAndMapCurrentIdentity(");

  expect(source).toContain('const AUTHORITY_SOCKET_PREFIX: &[u8] = b".authority-control-"');
  expect(source).toContain("recoveryDirectoryFromControlSocket(&control_socket_path)");
  expect(source).toContain("fn concealRecoveryDirectory(directory: &[u8])");
  expect(source).toContain("fn rejectRecoveryDirectoryMountAliases(directory: &[u8])");
  expect(source).toContain("MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC");
  expect(source).toContain('b"mode=000,size=4096,nr_inodes=1\\0"');
  expect(launch.indexOf("readCurrentWorkingDirectory(&mut cwd_buffer)")).toBeLessThan(
    launch.indexOf('k_chdir(b"/\\0".as_ptr())'),
  );
  expect(launch.indexOf('k_chdir(b"/\\0".as_ptr())')).toBeLessThan(
    launch.indexOf("unshareAndMapCurrentIdentity(host_uid, host_gid)"),
  );
  expect(init.indexOf("rejectRecoveryDirectoryMountAliases(&config.recovery_directory)")).toBeLessThan(
    init.indexOf("concealRecoveryDirectory(&config.recovery_directory)"),
  );
  expect(init.indexOf("concealRecoveryDirectory(&config.recovery_directory)")).toBeLessThan(
    init.indexOf("let init_identity = InitReadyRecord"),
  );
  expect(target.indexOf("hardenTargetCredentials()")).toBeLessThan(
    target.indexOf("k_chdir(config.target_cwd.as_ptr())"),
  );
  expect(target.indexOf("k_chdir(config.target_cwd.as_ptr())")).toBeLessThan(
    target.indexOf("let _ = k_execve("),
  );
  expect(target).toContain("config.target_path.as_ptr()");
  expect(target).toContain("config.target_argv");
  expect(target).toContain("config.target_env");
});

test("authority supervisor emits CLEAN only after reaping namespace PID 1", async () => {
  const source = await supervisorSource();
  const prepared = section(source, "fn runPrepared(", "fn runRecovery(");
  const reap = prepared.indexOf("let init_status = match maybe_init_status");
  const clean = prepared.indexOf("emitClean(fds.control, nonce, exit_code)?");

  expect(reap).toBeGreaterThanOrEqual(0);
  expect(clean).toBeGreaterThan(reap);
  expect(prepared).toContain("k_exit(exit_code as i32)");
});

test("authority supervisor rejects inherited mount aliases before concealing custody", async () => {
  const source = await supervisorSource();
  const preflight = section(
    source,
    "fn rejectRecoveryDirectoryMountAliases(",
    "fn collectRecoveryAncestors(",
  );

  expect(source).toContain('b"/proc/self/mountinfo\\0"');
  expect(source).toContain("MOUNTINFO_MAX_BYTES: usize = 1_048_576");
  expect(source).toContain("MOUNTINFO_MAX_LINES: usize = 4_096");
  expect(source).toContain("MOUNTINFO_MAX_LINE_BYTES: usize = 8_192");
  expect(preflight).toContain("inspectMountInfoForRecoveryAliases(first, directory");
  expect(preflight).toContain("if first != second");
  expect(source).toContain("statMountpointDirectoryIdentity(mountpoint)");
  expect(source).toContain("mountpointAliasesRecoveryAncestor");
  expect(source).toContain("device_major");
  expect(source).toContain("device_minor");
  expect(source).toContain("inode");
  expect(source).toContain("SupervisorError::MountAliasUnsafe");
  expect(source).toContain('b"040"');
  expect(source).toContain('b"011"');
  expect(source).toContain('b"012"');
  expect(source).toContain('b"134"');
  expect(source).toContain("valid mountinfo fixture rejected");
  expect(source).toContain("unknown mountinfo escape accepted");
  expect(source).toContain("distinct-path same-inode mount alias accepted");
});

test("launch deadline is authenticated and independently enforced by outer supervisor and PID 1", async () => {
  const source = await supervisorSource();
  const prepared = section(source, "fn runPrepared(", "fn runRecovery(");
  const init = section(source, "fn initMain(", "fn targetMain(");

  expect(source).toContain("ns_init_pid=1 monotonic_ms={}");
  expect(source).toContain('let deadline_field = b" deadline_monotonic_ms="');
  expect(source).toContain("struct StartRecord");
  expect(source).toContain("deadline_monotonic_ms: u64");
  expect(prepared).toContain("readGo(fds.control, nonce)");
  expect(prepared).toContain("readTargetResultUntil(fds.result_read, deadline_monotonic_ms)");
  expect(prepared).toContain("waitForPidUntil(init_pid, deadline_monotonic_ms)");
  expect(prepared).toContain("completeLaunchDeadlineExpiry(init_pid, fds, nonce)");
  expect(init).toContain("waitForStartOrParentDeath(fds.start_read, fds.lifeline_read)");
  expect(init).toContain("waitForPidUntil(target_pid, deadline_monotonic_ms)");
  expect(init).toContain("killAndReap(target_pid)");
  expect(source).toContain("if record.deadline_monotonic_ms <= now");
  expect(source).toContain("if deadline <= now");
  expect(source).toContain("killAndReap(init_pid)?");
  expect(source).toContain("emitClean(fds.control, nonce, LAUNCH_TIMEOUT_EXIT_CODE)?");
  expect(source).toContain("LAUNCH_TIMEOUT_EXIT_CODE: u8 = 124");
  expect(source).toContain("(LAUNCH_TIMEOUT_EXIT_CODE as u32) << 8");
});

test("READY journals an exact namespace-init identity before GO", async () => {
  const source = await supervisorSource();
  const prepared = section(source, "fn runPrepared(", "fn runRecovery(");
  const init = section(source, "fn initMain(", "fn targetMain(");

  expect(prepared).toContain("let mut ready = InitReadyRecord");
  expect(prepared).toContain("let init_identity = InitIdentity");
  expect(prepared).toContain("host_pid: init_pid");
  expect(prepared).toContain("emitReady(");
  expect(prepared).toContain("&init_identity");
  expect(prepared).toContain("ready_monotonic_ms");
  expect(prepared.indexOf("readExactly(fds.ready_read, recordBytesMut(&mut ready))")).toBeLessThan(
    prepared.indexOf("emitReady("),
  );
  expect(init).toContain("mountFreshProc()");
  expect(init).toContain("readProcStartTime(k_getpid(), SupervisorError::InitNotReady)");
  expect(init).toContain("pid_namespace_inode: match readPidNamespaceInode(");
  expect(init).toContain("SupervisorError::InitNotReady");
  expect(init.indexOf("mountFreshProc()")).toBeLessThan(init.indexOf("let init_identity = InitReadyRecord"));
  expect(init.indexOf("let init_identity = InitReadyRecord")).toBeLessThan(init.indexOf("waitForStartOrParentDeath"));
});

test("launch maps its caller identity before becoming nondumpable", async () => {
  const source = await supervisorSource();
  const main = section(source, "fn realMain()", "fn argEquals(");
  const launch = section(source, "fn runLaunch(", "fn runPrepared(");
  const earlyRecoveryClassification = "let recovery_mode = std::env::args_os().nth(5)";

  expect(main).toContain("std::env::args_os()");
  expect(main).toContain(earlyRecoveryClassification);
  expect(main).toContain('argument.as_os_str().as_bytes() == b"--terminate"');
  expect(main.indexOf(earlyRecoveryClassification)).toBeLessThan(main.indexOf("setUndumpable().is_err()"));
  expect(main.indexOf("setUndumpable().is_err()")).toBeLessThan(main.indexOf("let args: Vec<Vec<u8>>"));
  expect(main.indexOf("let args: Vec<Vec<u8>>")).toBeLessThan(main.indexOf("parseConfig(&args)"));
  expect(main.match(/setUndumpable\(\)/g)).toHaveLength(1);
  expect(launch.indexOf("unshareAndMapCurrentIdentity(host_uid, host_gid)?")).toBeLessThan(
    launch.indexOf("setUndumpable()?"),
  );
  expect(launch.indexOf("setUndumpable()?")).toBeLessThan(
    launch.indexOf("let identity = LaunchIdentity"),
  );
});

test("recovery validates both pidfd-bound identities before signaling the outer helper", async () => {
  const source = await supervisorSource();
  const recovery = section(source, "fn runRecovery(", "enum RecoveryMethod");

  expect(source).toContain("--terminate");
  expect(source).toContain("--outer-pid");
  expect(source).toContain("--outer-start-time");
  expect(source).toContain("--boot-id");
  expect(source).toContain("--init-host-pid");
  expect(source).toContain("--init-start-time");
  expect(source).toContain("--init-pid-namespace-inode");
  expect(recovery).toContain("let recovery_identity = RecoveryHelperIdentity");
  expect(recovery).toContain("start_time: readProcStartTime(");
  expect(recovery).toContain("SupervisorError::RecoverySelfIdentityUnavailable");
  expect(recovery).toContain("emitRecoveryReady(socket, nonce, &recovery_identity, &recovery)?");
  expect(recovery).toContain("readRecoveryGo(socket, nonce)?");
  expect(recovery).toContain("k_pidfd_open(recovery.outer_pid, 0)");
  expect(recovery).toContain("k_pidfd_open(recovery.init_host_pid, 0)");
  expect(recovery).toContain("k_pidfd_send_signal(outer_pidfd, SIGKILL, 0, 0)");
  expect(recovery).toContain("waitForPidfdExit(outer_pidfd, deadline)?");
  expect(recovery).toContain("waitForPidfdExit(init_pidfd, deadline)?");
  expect(recovery).toContain("emitRecoveryClean(socket, nonce, &recovery_identity, &recovery, method)?");
  expect(recovery).not.toContain("k_kill(");
  expect(recovery.indexOf("k_pidfd_open(recovery.outer_pid, 0)")).toBeLessThan(
    recovery.indexOf("k_pidfd_open(recovery.init_host_pid, 0)"),
  );
  expect(recovery.indexOf("k_pidfd_open(recovery.init_host_pid, 0)")).toBeLessThan(
    recovery.indexOf("verifyRecoveryIdentity(&recovery)?"),
  );
  expect(recovery.indexOf("verifyRecoveryIdentity(&recovery)?")).toBeLessThan(
    recovery.indexOf("emitRecoveryReady(socket, nonce, &recovery_identity, &recovery)?"),
  );
  expect(recovery.indexOf("readRecoveryGo(socket, nonce)?")).toBeLessThan(
    recovery.lastIndexOf("verifyRecoveryIdentity(&recovery)?"),
  );
  expect(recovery.lastIndexOf("verifyRecoveryIdentity(&recovery)?")).toBeLessThan(
    recovery.indexOf("k_pidfd_send_signal(outer_pidfd, SIGKILL, 0, 0)"),
  );
  expect(recovery.indexOf("k_pidfd_send_signal(outer_pidfd, SIGKILL, 0, 0)")).toBeLessThan(
    recovery.indexOf("waitForPidfdExit(outer_pidfd, deadline)?"),
  );
  expect(recovery.indexOf("waitForPidfdExit(outer_pidfd, deadline)?")).toBeLessThan(
    recovery.indexOf("waitForPidfdExit(init_pidfd, deadline)?"),
  );
  expect(recovery.indexOf("waitForPidfdExit(init_pidfd, deadline)?")).toBeLessThan(
    recovery.indexOf("emitRecoveryClean(socket, nonce, &recovery_identity, &recovery, method)?"),
  );
  expect(recovery.indexOf("setUndumpable()?")).toBeLessThan(
    recovery.indexOf("let recovery_identity = RecoveryHelperIdentity"),
  );
});

test("recovery binds the sealed init namespace while revalidating both process identities", async () => {
  const source = await supervisorSource();
  const identity = section(source, "fn verifyRecoveryIdentity(", "fn verifyProcStartTime(");

  expect(source).toContain('b"/proc/sys/kernel/random/boot_id\\0"');
  expect(source).toContain('format!("/proc/{}/stat", pid)');
  expect(source).toContain('format!("/proc/{}/ns/pid", pid)');
  expect(source).toContain("BOOT_ID_LENGTH: usize = 36");
  expect(source).toContain("closing_parenthesis = Some(index)");
  expect(source).toContain("if token_index == 19");
  expect(source).toContain("fn parsePidNamespaceInode(target: &[u8]) -> Option<u64>");
  expect(source).toContain("RecoveryInitPidfdUnavailable");
  expect(source).toContain("RecoveryInitProcUnavailable");
  expect(source).toContain("RecoveryInitStartTimeMismatch");
  expect(source).toContain("RecoveryInitNotLive");
  expect(source).toContain("RecoverySelfIdentityUnavailable");
  expect(identity).toContain("let init_start_time = readProcStartTime(");
  expect(identity).toContain("recovery.init_host_pid");
  expect(identity).toContain("SupervisorError::RecoveryInitProcUnavailable");
  expect(identity).toContain("init_start_time != recovery.init_start_time");
  expect(identity).not.toContain("readPidNamespaceInode(");
  expect(source).not.toContain("RecoveryInitNamespaceMismatch");
  expect(source).toContain("PID-namespace membership cannot change during a task's lifetime");
  expect(source).toContain("pid_namespace_inode: match readPidNamespaceInode(");
  expect(source).toContain("RECOVERY_EXIT_TIMEOUT_MS: u64 = 5_000");
  expect(source).toContain("RECOVERY_CLEAN");
  expect(source).toContain("never claims remote provider-effect rollback");
  expect(source).toContain("Before RECOVERY_GO, HRA must bind recovery_pid");
  expect(source).toContain("nonce-authenticated, nondumpable helper reports");
  expect(source).toContain("HRA binds RECOVERY_CLEAN to that exact");
});
