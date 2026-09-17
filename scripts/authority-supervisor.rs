//! Linux-only descendant-lifetime custody for trusted provider commands.
//!
//! This repository-local helper is deliberately not a general sandbox. The
//! target retains its cwd, environment, ordinary filesystem access, and
//! ordinary stdio. The one filesystem exception is HRA's recovery directory,
//! which is concealed behind an empty read-only mount before READY so the
//! target cannot replace the journal lock or tamper with durable custody. A
//! strict, stable mountinfo preflight first rejects inherited bind aliases of
//! that directory or any ancestor, which would otherwise bypass one overmount.
//! Every descendant that the trusted target starts lives in one nested PID
//! namespace and is gone before the helper reports CLEAN.
//!
//! Invocation:
//!
//!   authority-supervisor \
//!     --control-socket /absolute/0700-recovery-dir/control.sock \
//!     --nonce 32-lowercase-hex-characters \
//!     -- /absolute/program arg...
//!
//! Recovery invocation uses the same authenticated socket protocol:
//!
//!   authority-supervisor --control-socket /absolute/0700-recovery-dir/control.sock \
//!     --nonce 32-lowercase-hex-characters --terminate \
//!     --outer-pid 2..2147483647 --outer-start-time /proc-stat-clock-ticks \
//!     --boot-id canonical-lowercase-uuid \
//!     --init-host-pid 2..2147483647 --init-start-time /proc-stat-clock-ticks \
//!     --init-pid-namespace-inode positive-decimal-inode
//!
//! HRA owns the Unix socket beneath a held 0700 recovery directory. It verifies
//! the nonce in READY, sends the matching GO frame, then requires both CLEAN
//! and the outer helper child exit before accepting cleanup proof. The target
//! never inherits the control socket or helper arguments; it inherits only
//! stdin, stdout, and stderr. HRA writes target stdin only after it sends GO.
//!
//! Control frames are line-oriented UTF-8 on the Unix socket:
//!
//!   HRA_AUTHORITY_SUPERVISOR/1 READY nonce=<hex> outer_pid=<pid> outer_pgid=<pid> outer_start_time=<ticks> boot_id=<uuid> init_host_pid=<pid> init_start_time=<ticks> init_pid_namespace_inode=<inode> ns_init_pid=1 monotonic_ms=<positive-u64>
//!   HRA_AUTHORITY_SUPERVISOR/1 GO nonce=<hex> deadline_monotonic_ms=<positive-u64>
//!   HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=<hex> exit=<0-255>
//!   HRA_AUTHORITY_SUPERVISOR/1 FAIL nonce=<hex> code=<stable-code>
//!   HRA_AUTHORITY_SUPERVISOR/1 RECOVERY_READY nonce=<hex> recovery_pid=<pid> recovery_start_time=<ticks> outer_pid=<pid> outer_start_time=<ticks> init_host_pid=<pid> init_start_time=<ticks> init_pid_namespace_inode=<inode>
//!   HRA_AUTHORITY_SUPERVISOR/1 RECOVERY_GO nonce=<hex>
//!   HRA_AUTHORITY_SUPERVISOR/1 RECOVERY_CLEAN nonce=<hex> recovery_pid=<pid> recovery_start_time=<ticks> outer_pid=<pid> outer_start_time=<ticks> boot_id=<uuid> init_host_pid=<pid> init_start_time=<ticks> init_pid_namespace_inode=<inode> method=<pidfd-sigkill|pidfd-already-exited>
//!
//! READY means a fresh user, mount, and PID namespace exists and its PID 1 is
//! waiting behind the GO gate. GO carries an absolute CLOCK_MONOTONIC deadline.
//! Both the outer supervisor and namespace PID 1 enforce it independently, so
//! a stopped or starved HRA process cannot extend target authority. CLEAN is
//! emitted only by the outer supervisor, after it has reaped that PID 1. Linux
//! kills all remaining tasks in a PID namespace when its init exits, including
//! double-forked or setsid() children. Any missing CLEAN or missing outer-helper
//! exit is indeterminate and must block later authority work.
//!
//! Recovery never claims remote provider-effect rollback. It validates the
//! recorded boot ID and both start times while holding both pidfds, signals
//! only the exact outer pidfd, and polls at most five seconds for both local
//! processes to exit. The sealed namespace init self-observes its immutable
//! PID-namespace inode before READY; recovery carries that durable binding but
//! deliberately does not attempt the cross-process proc readlink that Linux
//! denies for a nondumpable init. A failed validation sends no signal. A
//! post-signal timeout or wait failure remains indeterminate for the caller.
//! Before RECOVERY_GO, HRA must bind recovery_pid to the freshly spawned direct
//! child it owns. The sealed, nonce-authenticated, nondumpable helper reports
//! its own positive recovery_start_time; HRA binds RECOVERY_CLEAN to that exact
//! pair, the child's zero exit, and complete control-channel EOF.

// Camel-case function and type names are intentional: they keep this port a
// 1:1 line-mapped translation of the reviewed Zig supervisor for audit.
#![allow(non_snake_case)]

#[cfg(not(target_os = "linux"))]
compile_error!("authority-supervisor is supported only for Linux targets");

#[cfg(target_os = "linux")]
mod imp {
    use core::arch::asm;

    const PROTOCOL_PREFIX: &[u8] = b"HRA_AUTHORITY_SUPERVISOR/1 ";
    const NONCE_HEX_LENGTH: usize = 32;
    type Nonce = [u8; 16];
    const BOOT_ID_LENGTH: usize = 36;
    type BootId = [u8; BOOT_ID_LENGTH];
    const RECOVERY_EXIT_TIMEOUT_MS: u64 = 5_000;
    const LAUNCH_TIMEOUT_EXIT_CODE: u8 = 124;
    const MOUNTINFO_MAX_BYTES: usize = 1_048_576;
    const MOUNTINFO_MAX_LINES: usize = 4_096;
    const MOUNTINFO_MAX_LINE_BYTES: usize = 8_192;
    const AUTHORITY_SOCKET_PREFIX: &[u8] = b".authority-control-";
    const AUTHORITY_SOCKET_SUFFIX: &[u8] = b".sock";

    const CONTROL_FD: i32 = 3;
    const START_WRITE_FD: i32 = 4;
    const START_READ_FD: i32 = 5;
    const RESULT_READ_FD: i32 = 6;
    const RESULT_WRITE_FD: i32 = 7;
    const READY_READ_FD: i32 = 8;
    const READY_WRITE_FD: i32 = 9;
    const LIFELINE_WRITE_FD: i32 = 10;
    const LIFELINE_READ_FD: i32 = 11;
    const MAXIMUM_PRESERVED_FD: i32 = LIFELINE_READ_FD;
    const SCRATCH_FD_MINIMUM: i32 = 64;

    const PATH_MAX: usize = 4096;

    const AT_FDCWD: i32 = -100;
    const AT_NO_AUTOMOUNT: u32 = 0x800;
    const STATX_BASIC_STATS: u32 = 0x7ff;
    const STATX_TYPE: u32 = 0x001;
    const STATX_INO: u32 = 0x100;
    const S_IFMT: u16 = 0o170000;
    const S_IFDIR: u16 = 0o040000;
    const CLONE_NEWUSER: usize = 0x1000_0000;
    const CLONE_NEWPID: usize = 0x2000_0000;
    const CLONE_NEWNS: usize = 0x0002_0000;
    const MS_RDONLY: usize = 1;
    const MS_NOSUID: usize = 2;
    const MS_NODEV: usize = 4;
    const MS_NOEXEC: usize = 8;
    const MS_REC: usize = 16384;
    const MS_PRIVATE: usize = 1 << 18;
    const PR_SET_PDEATHSIG: usize = 1;
    const PR_SET_DUMPABLE: usize = 4;
    const PR_CAPBSET_DROP: usize = 24;
    const PR_SET_NO_NEW_PRIVS: usize = 38;
    const PR_CAP_AMBIENT: usize = 47;
    const PR_CAP_AMBIENT_CLEAR_ALL: usize = 4;
    const CAP_LAST_CAP: u8 = 40;
    const CAPSET_V3_VERSION: u32 = 0x2008_0522;
    const POLLIN: i16 = 0x001;
    const POLLERR: i16 = 0x008;
    const POLLHUP: i16 = 0x010;
    const POLLNVAL: i16 = 0x020;
    const WNOHANG: u32 = 1;
    const SIGKILL: usize = 9;
    #[cfg(target_arch = "aarch64")]
    const SIGCHLD: usize = 17;
    const CLOCK_MONOTONIC: i32 = 1;
    const O_RDONLY: usize = 0;
    const O_WRONLY: usize = 1;
    const O_CLOEXEC: usize = 0o2000000;
    const AF_UNIX: usize = 1;
    const SOCK_STREAM: usize = 1;
    const SOCK_CLOEXEC: usize = 0o2000000;
    const F_GETFD: usize = 1;
    const F_SETFD: usize = 2;
    const F_DUPFD_CLOEXEC: usize = 1030;
    const FD_CLOEXEC: usize = 1;
    const EINTR: i32 = 4;
    const ESRCH: i32 = 3;

    #[cfg(target_arch = "x86_64")]
    mod nr {
        pub const READ: usize = 0;
        pub const WRITE: usize = 1;
        pub const CLOSE: usize = 3;
        pub const POLL: usize = 7;
        pub const GETPID: usize = 39;
        pub const SOCKET: usize = 41;
        pub const CONNECT: usize = 42;
        pub const FORK: usize = 57;
        pub const EXECVE: usize = 59;
        pub const EXIT: usize = 60;
        pub const WAIT4: usize = 61;
        pub const KILL: usize = 62;
        pub const FCNTL: usize = 72;
        pub const CHDIR: usize = 80;
        pub const GETUID: usize = 102;
        pub const GETGID: usize = 104;
        pub const GETEUID: usize = 107;
        pub const GETEGID: usize = 108;
        pub const GETPPID: usize = 110;
        pub const GETPGID: usize = 121;
        pub const CAPSET: usize = 126;
        pub const PRCTL: usize = 157;
        pub const MOUNT: usize = 165;
        pub const CLOCK_GETTIME: usize = 228;
        pub const OPENAT: usize = 257;
        pub const READLINKAT: usize = 267;
        pub const UNSHARE: usize = 272;
        pub const DUP3: usize = 292;
        pub const PIPE2: usize = 293;
        pub const STATX: usize = 332;
        pub const PIDFD_SEND_SIGNAL: usize = 424;
        pub const PIDFD_OPEN: usize = 434;
        pub const CLOSE_RANGE: usize = 436;
    }

    #[cfg(target_arch = "aarch64")]
    mod nr {
        pub const DUP3: usize = 24;
        pub const FCNTL: usize = 25;
        pub const MOUNT: usize = 40;
        pub const CHDIR: usize = 49;
        pub const OPENAT: usize = 56;
        pub const CLOSE: usize = 57;
        pub const PIPE2: usize = 59;
        pub const READ: usize = 63;
        pub const WRITE: usize = 64;
        pub const PPOLL: usize = 73;
        pub const READLINKAT: usize = 78;
        pub const CAPSET: usize = 91;
        pub const EXIT: usize = 93;
        pub const UNSHARE: usize = 97;
        pub const CLOCK_GETTIME: usize = 113;
        pub const KILL: usize = 129;
        pub const GETPGID: usize = 155;
        pub const PRCTL: usize = 167;
        pub const GETPID: usize = 172;
        pub const GETPPID: usize = 173;
        pub const GETUID: usize = 174;
        pub const GETEUID: usize = 175;
        pub const GETGID: usize = 176;
        pub const GETEGID: usize = 177;
        pub const SOCKET: usize = 198;
        pub const CONNECT: usize = 203;
        pub const CLONE: usize = 220;
        pub const EXECVE: usize = 221;
        pub const WAIT4: usize = 260;
        pub const STATX: usize = 291;
        pub const PIDFD_SEND_SIGNAL: usize = 424;
        pub const PIDFD_OPEN: usize = 434;
        pub const CLOSE_RANGE: usize = 436;
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn sys0(n: usize) -> isize {
        let ret: isize;
        asm!("syscall", inlateout("rax") n => ret, lateout("rcx") _, lateout("r11") _, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn sys1(n: usize, a1: usize) -> isize {
        let ret: isize;
        asm!("syscall", inlateout("rax") n => ret, in("rdi") a1, lateout("rcx") _, lateout("r11") _, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn sys2(n: usize, a1: usize, a2: usize) -> isize {
        let ret: isize;
        asm!("syscall", inlateout("rax") n => ret, in("rdi") a1, in("rsi") a2, lateout("rcx") _, lateout("r11") _, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn sys3(n: usize, a1: usize, a2: usize, a3: usize) -> isize {
        let ret: isize;
        asm!("syscall", inlateout("rax") n => ret, in("rdi") a1, in("rsi") a2, in("rdx") a3, lateout("rcx") _, lateout("r11") _, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn sys4(n: usize, a1: usize, a2: usize, a3: usize, a4: usize) -> isize {
        let ret: isize;
        asm!("syscall", inlateout("rax") n => ret, in("rdi") a1, in("rsi") a2, in("rdx") a3, in("r10") a4, lateout("rcx") _, lateout("r11") _, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "x86_64")]
    unsafe fn sys5(n: usize, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> isize {
        let ret: isize;
        asm!("syscall", inlateout("rax") n => ret, in("rdi") a1, in("rsi") a2, in("rdx") a3, in("r10") a4, in("r8") a5, lateout("rcx") _, lateout("r11") _, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn sys0(n: usize) -> isize {
        let ret: isize;
        asm!("svc #0", inlateout("x8") n => _, lateout("x0") ret, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn sys1(n: usize, a1: usize) -> isize {
        let ret: isize;
        asm!("svc #0", inlateout("x8") n => _, inlateout("x0") a1 => ret, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn sys2(n: usize, a1: usize, a2: usize) -> isize {
        let ret: isize;
        asm!("svc #0", inlateout("x8") n => _, inlateout("x0") a1 => ret, in("x1") a2, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn sys3(n: usize, a1: usize, a2: usize, a3: usize) -> isize {
        let ret: isize;
        asm!("svc #0", inlateout("x8") n => _, inlateout("x0") a1 => ret, in("x1") a2, in("x2") a3, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn sys4(n: usize, a1: usize, a2: usize, a3: usize, a4: usize) -> isize {
        let ret: isize;
        asm!("svc #0", inlateout("x8") n => _, inlateout("x0") a1 => ret, in("x1") a2, in("x2") a3, in("x3") a4, options(nostack, preserves_flags));
        ret
    }

    #[cfg(target_arch = "aarch64")]
    unsafe fn sys5(n: usize, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> isize {
        let ret: isize;
        asm!("svc #0", inlateout("x8") n => _, inlateout("x0") a1 => ret, in("x1") a2, in("x2") a3, in("x3") a4, in("x4") a5, options(nostack, preserves_flags));
        ret
    }

    #[inline(always)]
    fn errno(ret: isize) -> i32 {
        if ret < 0 && ret > -4096 {
            (-ret) as i32
        } else {
            0
        }
    }

    fn k_exit(code: i32) -> ! {
        unsafe { sys1(nr::EXIT, code as usize) };
        std::process::abort();
    }

    fn k_getpid() -> i32 {
        unsafe { sys0(nr::GETPID) as i32 }
    }

    fn k_getppid() -> i32 {
        unsafe { sys0(nr::GETPPID) as i32 }
    }

    fn k_getuid() -> u32 {
        unsafe { sys0(nr::GETUID) as u32 }
    }

    fn k_geteuid() -> u32 {
        unsafe { sys0(nr::GETEUID) as u32 }
    }

    fn k_getgid() -> u32 {
        unsafe { sys0(nr::GETGID) as u32 }
    }

    fn k_getegid() -> u32 {
        unsafe { sys0(nr::GETEGID) as u32 }
    }

    fn k_getpgid(pid: i32) -> isize {
        unsafe { sys1(nr::GETPGID, pid as usize) }
    }

    // fork() on x86_64; clone(SIGCHLD, 0) on archs without a fork syscall.
    fn k_fork() -> isize {
        #[cfg(target_arch = "x86_64")]
        unsafe {
            return sys0(nr::FORK);
        }
        #[cfg(target_arch = "aarch64")]
        unsafe {
            return sys5(nr::CLONE, SIGCHLD, 0, 0, 0, 0);
        }
    }

    fn k_execve(path: *const u8, argv: *const *const u8, envp: *const *const u8) -> isize {
        unsafe { sys3(nr::EXECVE, path as usize, argv as usize, envp as usize) }
    }

    fn k_chdir(path: *const u8) -> isize {
        unsafe { sys1(nr::CHDIR, path as usize) }
    }

    fn k_unshare(flags: usize) -> isize {
        unsafe { sys1(nr::UNSHARE, flags) }
    }

    fn k_mount(
        source: *const u8,
        target: *const u8,
        fstype: *const u8,
        flags: usize,
        data: usize,
    ) -> isize {
        unsafe {
            sys5(
                nr::MOUNT,
                source as usize,
                target as usize,
                fstype as usize,
                flags,
                data,
            )
        }
    }

    fn k_prctl(op: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> isize {
        unsafe { sys5(nr::PRCTL, op, a2, a3, a4, a5) }
    }

    fn k_capset(header: *const CapabilityHeader, data: *const CapabilityData) -> isize {
        unsafe { sys2(nr::CAPSET, header as usize, data as usize) }
    }

    fn k_pipe2(fds: *mut [i32; 2], flags: usize) -> isize {
        unsafe { sys2(nr::PIPE2, fds as usize, flags) }
    }

    fn k_dup3(old: i32, new: i32, flags: usize) -> isize {
        unsafe { sys3(nr::DUP3, old as usize, new as usize, flags) }
    }

    fn k_fcntl(fd: i32, cmd: usize, arg: usize) -> isize {
        unsafe { sys3(nr::FCNTL, fd as usize, cmd, arg) }
    }

    fn k_close(fd: i32) -> isize {
        unsafe { sys1(nr::CLOSE, fd as usize) }
    }

    fn k_close_range(first: u32, last: u32, flags: u32) -> isize {
        unsafe {
            sys3(
                nr::CLOSE_RANGE,
                first as usize,
                last as usize,
                flags as usize,
            )
        }
    }

    fn k_socket(domain: usize, kind: usize, protocol: usize) -> isize {
        unsafe { sys3(nr::SOCKET, domain, kind, protocol) }
    }

    fn k_connect(fd: i32, address: *const SockAddrUn, length: u32) -> isize {
        unsafe { sys3(nr::CONNECT, fd as usize, address as usize, length as usize) }
    }

    fn k_read(fd: i32, buffer: *mut u8, count: usize) -> isize {
        unsafe { sys3(nr::READ, fd as usize, buffer as usize, count) }
    }

    fn k_write(fd: i32, buffer: *const u8, count: usize) -> isize {
        unsafe { sys3(nr::WRITE, fd as usize, buffer as usize, count) }
    }

    fn k_open(path: *const u8, flags: usize, mode: usize) -> isize {
        unsafe {
            sys4(
                nr::OPENAT,
                AT_FDCWD as i64 as usize,
                path as usize,
                flags,
                mode,
            )
        }
    }

    fn k_readlink(path: *const u8, buffer: *mut u8, count: usize) -> isize {
        unsafe {
            sys4(
                nr::READLINKAT,
                AT_FDCWD as i64 as usize,
                path as usize,
                buffer as usize,
                count,
            )
        }
    }

    fn k_statx(dirfd: i32, path: *const u8, flags: u32, mask: u32, out: *mut Statx) -> isize {
        unsafe {
            sys5(
                nr::STATX,
                dirfd as i64 as usize,
                path as usize,
                flags as usize,
                mask as usize,
                out as usize,
            )
        }
    }

    fn k_waitpid(pid: i32, status: *mut u32, flags: u32) -> isize {
        unsafe {
            sys4(
                nr::WAIT4,
                pid as i64 as usize,
                status as usize,
                flags as usize,
                0,
            )
        }
    }

    fn k_kill(pid: i32, signal: usize) -> isize {
        unsafe { sys2(nr::KILL, pid as i64 as usize, signal) }
    }

    fn k_pidfd_open(pid: i32, flags: u32) -> isize {
        unsafe { sys2(nr::PIDFD_OPEN, pid as i64 as usize, flags as usize) }
    }

    fn k_pidfd_send_signal(pidfd: i32, signal: usize, info: usize, flags: u32) -> isize {
        unsafe {
            sys4(
                nr::PIDFD_SEND_SIGNAL,
                pidfd as i64 as usize,
                signal,
                info,
                flags as usize,
            )
        }
    }

    fn k_clock_gettime(clock: i32, timestamp: *mut Timespec) -> isize {
        unsafe { sys2(nr::CLOCK_GETTIME, clock as usize, timestamp as usize) }
    }

    #[cfg(target_arch = "x86_64")]
    fn k_poll(fds: *mut PollFd, count: usize, timeout_ms: i32) -> isize {
        unsafe { sys3(nr::POLL, fds as usize, count, timeout_ms as u32 as usize) }
    }

    // aarch64 has no poll(2); ppoll takes a timespec and a fixed-size sigmask.
    #[cfg(target_arch = "aarch64")]
    fn k_poll(fds: *mut PollFd, count: usize, timeout_ms: i32) -> isize {
        if timeout_ms >= 0 {
            let timeout = Timespec {
                sec: (timeout_ms / 1000) as i64,
                nsec: ((timeout_ms % 1000) as i64) * 1_000_000,
            };
            unsafe {
                sys5(
                    nr::PPOLL,
                    fds as usize,
                    count,
                    &timeout as *const Timespec as usize,
                    0,
                    8,
                )
            }
        } else {
            unsafe { sys5(nr::PPOLL, fds as usize, count, 0, 0, 8) }
        }
    }

    #[repr(C)]
    struct Timespec {
        sec: i64,
        nsec: i64,
    }

    #[repr(C)]
    struct PollFd {
        fd: i32,
        events: i16,
        revents: i16,
    }

    #[repr(C)]
    struct StatxTimestamp {
        sec: i64,
        nsec: u32,
        reserved: i32,
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct Statx {
        mask: u32,
        blksize: u32,
        attributes: u64,
        nlink: u32,
        uid: u32,
        gid: u32,
        mode: u16,
        spare0: u16,
        ino: u64,
        size: u64,
        blocks: u64,
        attributes_mask: u64,
        atime: StatxTimestamp,
        btime: StatxTimestamp,
        ctime: StatxTimestamp,
        mtime: StatxTimestamp,
        rdev_major: u32,
        rdev_minor: u32,
        dev_major: u32,
        dev_minor: u32,
        mnt_id: u64,
        dio_mem_align: u32,
        dio_offset_align: u32,
        subvol: u64,
        atomic_write_unit_min: u32,
        atomic_write_unit_max: u32,
        atomic_write_segments_max: u32,
        dio_read_offset_align: u32,
        atomic_write_unit_max_opt: u32,
        spare2: u32,
        spare3: [u64; 8],
    }

    #[repr(C)]
    struct SockAddrUn {
        family: u16,
        path: [u8; 108],
    }

    #[repr(C)]
    struct CapabilityHeader {
        version: u32,
        pid: i32,
    }

    #[repr(C)]
    struct CapabilityData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }

    const _: () = {
        assert!(core::mem::size_of::<PollFd>() == 8);
        assert!(core::mem::size_of::<Statx>() == 256);
        assert!(core::mem::size_of::<SockAddrUn>() == 110);
        assert!(core::mem::size_of::<CapabilityHeader>() == 8);
        assert!(core::mem::size_of::<CapabilityData>() == 12);
    };

    #[derive(Debug)]
    enum SupervisorError {
        InvalidArguments,
        InvalidTarget,
        InvalidControlSocket,
        ControlConnectFailed,
        NamespaceUnavailable,
        NamespaceMappingFailed,
        MountIsolationFailed,
        MountTableInvalid,
        MountAliasUnsafe,
        SupervisorHardeningFailed,
        TargetHardeningFailed,
        FileDescriptorIsolationUnavailable,
        PipeFailed,
        ForkFailed,
        InitNotReady,
        ParentExited,
        ControlProtocolRejected,
        TargetStartFailed,
        ResultMissing,
        InitExitedAbruptly,
        WaitFailed,
        CleanupUnproven,
        LaunchIdentityUnavailable,
        RecoveryUnsafeTarget,
        RecoveryBootIdUnavailable,
        RecoveryBootIdMismatch,
        RecoverySelfIdentityUnavailable,
        RecoveryProcUnavailable,
        RecoveryStartTimeMismatch,
        RecoveryPidfdUnavailable,
        RecoveryOuterNotLive,
        RecoveryInitPidfdUnavailable,
        RecoveryInitProcUnavailable,
        RecoveryInitStartTimeMismatch,
        RecoveryInitNotLive,
        RecoverySignalFailed,
        RecoveryExitTimeout,
        RecoveryWaitFailed,
    }

    impl Clone for SupervisorError {
        fn clone(&self) -> Self {
            match self {
                SupervisorError::InvalidArguments => SupervisorError::InvalidArguments,
                SupervisorError::InvalidTarget => SupervisorError::InvalidTarget,
                SupervisorError::InvalidControlSocket => SupervisorError::InvalidControlSocket,
                SupervisorError::ControlConnectFailed => SupervisorError::ControlConnectFailed,
                SupervisorError::NamespaceUnavailable => SupervisorError::NamespaceUnavailable,
                SupervisorError::NamespaceMappingFailed => SupervisorError::NamespaceMappingFailed,
                SupervisorError::MountIsolationFailed => SupervisorError::MountIsolationFailed,
                SupervisorError::MountTableInvalid => SupervisorError::MountTableInvalid,
                SupervisorError::MountAliasUnsafe => SupervisorError::MountAliasUnsafe,
                SupervisorError::SupervisorHardeningFailed => {
                    SupervisorError::SupervisorHardeningFailed
                }
                SupervisorError::TargetHardeningFailed => SupervisorError::TargetHardeningFailed,
                SupervisorError::FileDescriptorIsolationUnavailable => {
                    SupervisorError::FileDescriptorIsolationUnavailable
                }
                SupervisorError::PipeFailed => SupervisorError::PipeFailed,
                SupervisorError::ForkFailed => SupervisorError::ForkFailed,
                SupervisorError::InitNotReady => SupervisorError::InitNotReady,
                SupervisorError::ParentExited => SupervisorError::ParentExited,
                SupervisorError::ControlProtocolRejected => {
                    SupervisorError::ControlProtocolRejected
                }
                SupervisorError::TargetStartFailed => SupervisorError::TargetStartFailed,
                SupervisorError::ResultMissing => SupervisorError::ResultMissing,
                SupervisorError::InitExitedAbruptly => SupervisorError::InitExitedAbruptly,
                SupervisorError::WaitFailed => SupervisorError::WaitFailed,
                SupervisorError::CleanupUnproven => SupervisorError::CleanupUnproven,
                SupervisorError::LaunchIdentityUnavailable => {
                    SupervisorError::LaunchIdentityUnavailable
                }
                SupervisorError::RecoveryUnsafeTarget => SupervisorError::RecoveryUnsafeTarget,
                SupervisorError::RecoveryBootIdUnavailable => {
                    SupervisorError::RecoveryBootIdUnavailable
                }
                SupervisorError::RecoveryBootIdMismatch => SupervisorError::RecoveryBootIdMismatch,
                SupervisorError::RecoverySelfIdentityUnavailable => {
                    SupervisorError::RecoverySelfIdentityUnavailable
                }
                SupervisorError::RecoveryProcUnavailable => {
                    SupervisorError::RecoveryProcUnavailable
                }
                SupervisorError::RecoveryStartTimeMismatch => {
                    SupervisorError::RecoveryStartTimeMismatch
                }
                SupervisorError::RecoveryPidfdUnavailable => {
                    SupervisorError::RecoveryPidfdUnavailable
                }
                SupervisorError::RecoveryOuterNotLive => SupervisorError::RecoveryOuterNotLive,
                SupervisorError::RecoveryInitPidfdUnavailable => {
                    SupervisorError::RecoveryInitPidfdUnavailable
                }
                SupervisorError::RecoveryInitProcUnavailable => {
                    SupervisorError::RecoveryInitProcUnavailable
                }
                SupervisorError::RecoveryInitStartTimeMismatch => {
                    SupervisorError::RecoveryInitStartTimeMismatch
                }
                SupervisorError::RecoveryInitNotLive => SupervisorError::RecoveryInitNotLive,
                SupervisorError::RecoverySignalFailed => SupervisorError::RecoverySignalFailed,
                SupervisorError::RecoveryExitTimeout => SupervisorError::RecoveryExitTimeout,
                SupervisorError::RecoveryWaitFailed => SupervisorError::RecoveryWaitFailed,
            }
        }
    }

    impl Copy for SupervisorError {}

    type Result<T> = core::result::Result<T, SupervisorError>;

    struct LaunchConfig {
        recovery_directory: Vec<u8>,
        target_path: Vec<u8>,
        // Null-terminated pointer tables into storage leaked for the process
        // lifetime in parseConfig, so fork children pass stable pointers to
        // execve.
        target_argv: *const *const u8,
        target_env: *const *const u8,
        target_cwd: Vec<u8>,
    }

    struct RecoveryConfig {
        outer_pid: i32,
        outer_start_time: u64,
        boot_id: BootId,
        init_host_pid: i32,
        init_start_time: u64,
        init_pid_namespace_inode: u64,
    }

    struct RecoveryHelperIdentity {
        pid: i32,
        start_time: u64,
    }

    enum Action {
        Launch(LaunchConfig),
        Terminate(RecoveryConfig),
    }

    struct Config {
        control_socket_path: Vec<u8>,
        nonce: Nonce,
        action: Action,
    }

    struct LaunchIdentity {
        outer_pid: i32,
        outer_start_time: u64,
        boot_id: BootId,
    }

    struct InitIdentity {
        host_pid: i32,
        start_time: u64,
        pid_namespace_inode: u64,
    }

    #[repr(C)]
    struct InitReadyRecord {
        tag: u8,
        reserved: [u8; 7],
        start_time: u64,
        pid_namespace_inode: u64,
    }

    #[repr(C)]
    struct StartRecord {
        tag: u8,
        reserved: [u8; 7],
        deadline_monotonic_ms: u64,
    }

    #[repr(C)]
    struct TargetResult {
        kind: u8,
        reserved: [u8; 3],
        wait_status: u32,
    }

    mod result_kind {
        pub const TARGET: u8 = 1;
        pub const INTERNAL: u8 = 2;
    }

    fn recordBytes<T>(record: &T) -> &[u8] {
        unsafe {
            core::slice::from_raw_parts(record as *const T as *const u8, core::mem::size_of::<T>())
        }
    }

    fn recordBytesMut<T>(record: &mut T) -> &mut [u8] {
        unsafe {
            core::slice::from_raw_parts_mut(record as *mut T as *mut u8, core::mem::size_of::<T>())
        }
    }

    fn realMain() -> ! {
        assertMountInfoParserFixtures();
        let launch_parent_pid = k_getppid();
        // In recovery mode the old target can still be alive while this
        // helper is starting. Classify only the fixed action position and
        // hide the nonce before collecting or fully parsing argv or opening a
        // pidfd. Launch must remain dumpable until it writes its unprivileged
        // uid/gid maps; runLaunch hardens it immediately after that credential
        // transition and before READY or target creation.
        let recovery_mode = std::env::args_os().nth(5).is_some_and(|argument| {
            use std::os::unix::ffi::OsStrExt;
            argument.as_os_str().as_bytes() == b"--terminate"
        });
        if recovery_mode && setUndumpable().is_err() {
            k_exit(1);
        }
        let args: Vec<Vec<u8>> = std::env::args_os()
            .map(|argument| {
                use std::os::unix::ffi::OsStrExt;
                argument.as_os_str().as_bytes().to_vec()
            })
            .collect();
        let config = match parseConfig(&args) {
            Ok(config) => config,
            Err(_) => k_exit(64),
        };
        let Config {
            control_socket_path,
            nonce,
            action,
        } = config;

        // HRA deliberately gives a launch target raw standard streams. Refuse
        // to start rather than let a control socket occupy one of them. This
        // is checked before socket() because socket() may otherwise reuse a
        // missing standard descriptor.
        if let Action::Launch(_) = action {
            if !standardDescriptorsOpen() {
                k_exit(64);
            }
        }

        let connected_socket = match connectControl(&control_socket_path) {
            Ok(socket) => socket,
            Err(_) => k_exit(1),
        };
        // Keep the original connection alive until the duplicate is
        // established, then make the descriptor-preparation input
        // unambiguously non-stdio.
        let socket = match duplicateAtLeast(connected_socket, CONTROL_FD) {
            Ok(socket) => socket,
            Err(_) => {
                emitFail(connected_socket, &nonce, b"fd_isolation_unavailable");
                closeIgnore(connected_socket);
                k_exit(1);
            }
        };
        closeIgnore(connected_socket);

        let outcome = match action {
            Action::Launch(launch) => runLaunch(&nonce, launch, socket, launch_parent_pid),
            Action::Terminate(recovery) => runRecovery(&nonce, recovery, socket, launch_parent_pid),
        };
        if let Err(err) = outcome {
            emitFail(socket, &nonce, errorCode(&err));
            closeIgnore(socket);
            k_exit(1);
        }
        closeIgnore(socket);
        k_exit(0);
    }

    fn argEquals(args: &[Vec<u8>], index: usize, expected: &[u8]) -> bool {
        args.get(index)
            .map(|arg| arg.as_slice() == expected)
            .unwrap_or(false)
    }

    // The kernel guarantees argv strings carry no interior NUL, so each
    // entry becomes an exact NUL-terminated byte string for execve.
    fn cStrings(input: &[Vec<u8>]) -> Vec<Vec<u8>> {
        input
            .iter()
            .map(|arg| {
                let mut copy = arg.clone();
                copy.push(0);
                copy
            })
            .collect()
    }

    fn pointerTable(entries: &[Vec<u8>]) -> Vec<*const u8> {
        let mut table: Vec<*const u8> = entries.iter().map(|entry| entry.as_ptr()).collect();
        table.push(core::ptr::null());
        table
    }

    // The raw envp block is rebuilt byte-for-byte from /proc/self/environ,
    // which carries the exact exec-time environment including any bare
    // entries without '='.
    fn readEnvironBlock() -> Result<Vec<Vec<u8>>> {
        let fd = {
            let raw = k_open(b"/proc/self/environ\0".as_ptr(), O_RDONLY | O_CLOEXEC, 0);
            if errno(raw) != 0 {
                return Err(SupervisorError::InvalidArguments);
            }
            raw as i32
        };
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8_192];
        loop {
            let result = k_read(fd, chunk.as_mut_ptr(), chunk.len());
            match errno(result) {
                0 => {
                    if result <= 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..result as usize]);
                    if buffer.len() > 1_048_576 {
                        closeIgnore(fd);
                        return Err(SupervisorError::InvalidArguments);
                    }
                }
                EINTR => continue,
                _ => {
                    closeIgnore(fd);
                    return Err(SupervisorError::InvalidArguments);
                }
            }
        }
        closeIgnore(fd);
        let mut entries: Vec<Vec<u8>> = Vec::new();
        let mut cursor = 0;
        while cursor < buffer.len() {
            let relative_end = match buffer[cursor..].iter().position(|b| *b == 0) {
                Some(position) => cursor + position,
                None => return Err(SupervisorError::InvalidArguments),
            };
            entries.push(buffer[cursor..=relative_end].to_vec());
            cursor = relative_end + 1;
        }
        Ok(entries)
    }

    fn parseConfig(args: &[Vec<u8>]) -> Result<Config> {
        if args.len() < 6 {
            return Err(SupervisorError::InvalidArguments);
        }
        if !argEquals(args, 1, b"--control-socket") {
            return Err(SupervisorError::InvalidArguments);
        }
        if !argEquals(args, 3, b"--nonce") {
            return Err(SupervisorError::InvalidArguments);
        }
        let control_socket_path = args[2].clone();
        if control_socket_path.is_empty()
            || control_socket_path[0] != b'/'
            || control_socket_path.len() >= 108
        {
            return Err(SupervisorError::InvalidControlSocket);
        }
        let recovery_directory = match recoveryDirectoryFromControlSocket(&control_socket_path) {
            Some(directory) => directory.to_vec(),
            None => return Err(SupervisorError::InvalidControlSocket),
        };

        let nonce = match parseNonce(&args[4]) {
            Some(nonce) => nonce,
            None => return Err(SupervisorError::InvalidArguments),
        };
        if argEquals(args, 5, b"--") {
            if args.len() < 7 {
                return Err(SupervisorError::InvalidArguments);
            }
            let target_path = args[6].clone();
            if target_path.is_empty() || target_path[0] != b'/' {
                return Err(SupervisorError::InvalidTarget);
            }
            let argv_entries = cStrings(&args[6..]);
            let environ_entries = readEnvironBlock()?;
            let target_argv = Box::leak(pointerTable(&argv_entries).into_boxed_slice()).as_ptr();
            let target_env = Box::leak(pointerTable(&environ_entries).into_boxed_slice()).as_ptr();
            // Leak the backing strings too: the tables above point into them
            // and must outlive every fork that hands them to execve.
            std::mem::forget(argv_entries);
            std::mem::forget(environ_entries);
            return Ok(Config {
                control_socket_path,
                nonce,
                action: Action::Launch(LaunchConfig {
                    recovery_directory,
                    target_path: nulTerminated(target_path),
                    target_argv,
                    target_env,
                    target_cwd: b"/\0".to_vec(),
                }),
            });
        }

        if !argEquals(args, 5, b"--terminate") || args.len() != 18 {
            return Err(SupervisorError::InvalidArguments);
        }
        if !argEquals(args, 6, b"--outer-pid")
            || !argEquals(args, 8, b"--outer-start-time")
            || !argEquals(args, 10, b"--boot-id")
        {
            return Err(SupervisorError::InvalidArguments);
        }
        let outer_pid = match parseRecoveryPid(&args[7]) {
            Some(pid) => pid,
            None => return Err(SupervisorError::InvalidArguments),
        };
        let outer_start_time = match parsePositiveU64(&args[9]) {
            Some(value) => value,
            None => return Err(SupervisorError::InvalidArguments),
        };
        let boot_id = match parseBootId(&args[11]) {
            Some(boot_id) => boot_id,
            None => return Err(SupervisorError::InvalidArguments),
        };
        if !argEquals(args, 12, b"--init-host-pid")
            || !argEquals(args, 14, b"--init-start-time")
            || !argEquals(args, 16, b"--init-pid-namespace-inode")
        {
            return Err(SupervisorError::InvalidArguments);
        }
        let init_host_pid = match parseRecoveryPid(&args[13]) {
            Some(pid) => pid,
            None => return Err(SupervisorError::InvalidArguments),
        };
        let init_start_time = match parsePositiveU64(&args[15]) {
            Some(value) => value,
            None => return Err(SupervisorError::InvalidArguments),
        };
        let init_pid_namespace_inode = match parsePositiveU64(&args[17]) {
            Some(value) => value,
            None => return Err(SupervisorError::InvalidArguments),
        };
        Ok(Config {
            control_socket_path,
            nonce,
            action: Action::Terminate(RecoveryConfig {
                outer_pid,
                outer_start_time,
                boot_id,
                init_host_pid,
                init_start_time,
                init_pid_namespace_inode,
            }),
        })
    }

    fn nulTerminated(input: Vec<u8>) -> Vec<u8> {
        let mut output = input;
        output.push(0);
        output
    }

    fn recoveryDirectoryFromControlSocket(path: &[u8]) -> Option<&[u8]> {
        let separator = path.iter().rposition(|b| *b == b'/')?;
        if separator <= 1 || separator + 1 >= path.len() {
            return None;
        }
        let directory = &path[0..separator];
        if !isCanonicalAbsolutePath(directory) {
            return None;
        }
        let name = &path[separator + 1..];
        let expected_length =
            AUTHORITY_SOCKET_PREFIX.len() + NONCE_HEX_LENGTH + AUTHORITY_SOCKET_SUFFIX.len();
        if name.len() != expected_length
            || !name.starts_with(AUTHORITY_SOCKET_PREFIX)
            || !name.ends_with(AUTHORITY_SOCKET_SUFFIX)
        {
            return None;
        }
        let token =
            &name[AUTHORITY_SOCKET_PREFIX.len()..AUTHORITY_SOCKET_PREFIX.len() + NONCE_HEX_LENGTH];
        for character in token {
            if decodeHex(*character).is_none() {
                return None;
            }
        }
        Some(directory)
    }

    fn isCanonicalAbsolutePath(path: &[u8]) -> bool {
        if path.len() < 2 || path[0] != b'/' || path[path.len() - 1] == b'/' {
            return false;
        }
        let mut start = 1;
        while start < path.len() {
            let relative_end = path[start..].iter().position(|b| *b == b'/');
            let end = match relative_end {
                Some(offset) => start + offset,
                None => path.len(),
            };
            let segment = &path[start..end];
            if segment.is_empty() || segment == b"." || segment == b".." {
                return false;
            }
            if relative_end.is_none() {
                break;
            }
            start = end + 1;
        }
        true
    }

    fn parseNonce(input: &[u8]) -> Option<Nonce> {
        if input.len() != NONCE_HEX_LENGTH {
            return None;
        }
        let mut nonce: Nonce = [0; 16];
        for index in 0..nonce.len() {
            let high = decodeHex(input[index * 2])?;
            let low = decodeHex(input[index * 2 + 1])?;
            nonce[index] = (high << 4) | low;
        }
        Some(nonce)
    }

    fn decodeHex(character: u8) -> Option<u8> {
        match character {
            b'0'..=b'9' => Some(character - b'0'),
            b'a'..=b'f' => Some(character - b'a' + 10),
            _ => None,
        }
    }

    fn parseBootId(input: &[u8]) -> Option<BootId> {
        if input.len() != BOOT_ID_LENGTH {
            return None;
        }
        let mut boot_id: BootId = [0; BOOT_ID_LENGTH];
        for (index, character) in input.iter().enumerate() {
            if index == 8 || index == 13 || index == 18 || index == 23 {
                if *character != b'-' {
                    return None;
                }
            } else if decodeHex(*character).is_none() {
                return None;
            }
            boot_id[index] = *character;
        }
        Some(boot_id)
    }

    fn parsePositiveU64(input: &[u8]) -> Option<u64> {
        if input.is_empty() || input[0] < b'1' || input[0] > b'9' {
            return None;
        }
        parseDecimalU64(input)
    }

    fn parseDecimalU64(input: &[u8]) -> Option<u64> {
        if input.is_empty() {
            return None;
        }
        let mut value: u64 = 0;
        for character in input {
            if !character.is_ascii_digit() {
                return None;
            }
            let digit = (*character - b'0') as u64;
            if value > (u64::MAX - digit) / 10 {
                return None;
            }
            value = value * 10 + digit;
        }
        Some(value)
    }

    fn parseRecoveryPid(input: &[u8]) -> Option<i32> {
        let raw = parsePositiveU64(input)?;
        // PID 1 and the all-processes/negative PID forms are never recovery
        // targets. The remaining value is range-checked before pidfd_open().
        if raw <= 1 || raw > i32::MAX as u64 {
            return None;
        }
        Some(raw as i32)
    }

    fn runLaunch(
        nonce: &Nonce,
        mut config: LaunchConfig,
        socket: i32,
        launch_parent_pid: i32,
    ) -> Result<()> {
        let host_uid = k_getuid();
        let host_gid = k_getgid();
        if host_uid != k_geteuid() || host_gid != k_getegid() {
            return Err(SupervisorError::NamespaceUnavailable);
        }

        // Do not carry an open cwd reference around the recovery-directory
        // overmount. Capture its canonical kernel path, detach to /, and
        // restore the requested cwd only in the capability-free target. A
        // caller that tries to launch from inside the concealed directory
        // therefore fails closed instead of retaining an inode-level route
        // around the mount.
        let mut cwd_buffer = [0u8; PATH_MAX + 1];
        config.target_cwd = readCurrentWorkingDirectory(&mut cwd_buffer)?;
        if errno(k_chdir(b"/\0".as_ptr())) != 0 {
            return Err(SupervisorError::InvalidTarget);
        }

        unshareAndMapCurrentIdentity(host_uid, host_gid)?;
        // The outer supervisor is itself a child of HRA. It arms PDEATHSIG
        // after uid/gid mapping, then checks the pre-arm race before it can
        // announce READY or fork namespace PID 1.
        armParentDeath()?;
        assertParentStill(launch_parent_pid)?;
        setUndumpable()?;
        let outer_pid = k_getpid();
        let identity = LaunchIdentity {
            outer_pid,
            outer_start_time: readProcStartTime(
                outer_pid,
                SupervisorError::LaunchIdentityUnavailable,
            )?,
            boot_id: readBootId(SupervisorError::LaunchIdentityUnavailable)?,
        };
        let fds = prepareFileDescriptors(socket, nonce)?;

        match runPrepared(nonce, &config, &identity, &fds) {
            Err(err) => {
                // Descriptor preparation has replaced the caller's socket
                // with the fixed helper-only control descriptor. Never fall
                // back to a stale numeric descriptor when reporting a
                // post-remap failure.
                failControlAndExit(fds.control, nonce, err);
            }
            Ok(()) => Ok(()),
        }
    }

    fn runPrepared(
        nonce: &Nonce,
        config: &LaunchConfig,
        identity: &LaunchIdentity,
        fds: &PreparedFileDescriptors,
    ) -> Result<()> {
        let outer_pgid_result = k_getpgid(0);
        if errno(outer_pgid_result) != 0 {
            return Err(SupervisorError::SupervisorHardeningFailed);
        }
        let outer_pgid = outer_pgid_result as i32;

        let fork_result = k_fork();
        if errno(fork_result) != 0 {
            return Err(SupervisorError::ForkFailed);
        }
        if fork_result == 0 {
            initMain(config, fds);
        }

        let init_pid = fork_result as i32;
        closeIgnore(fds.start_read);
        closeIgnore(fds.result_write);
        closeIgnore(fds.ready_write);
        closeIgnore(fds.lifeline_read);

        let mut ready = InitReadyRecord {
            tag: 0,
            reserved: [0; 7],
            start_time: 0,
            pid_namespace_inode: 0,
        };
        if readExactly(fds.ready_read, recordBytesMut(&mut ready)).is_err() {
            return Err(stopInitAndFail(init_pid, SupervisorError::InitNotReady));
        }
        closeIgnore(fds.ready_read);
        if ready.tag != b'R' {
            return Err(stopInitAndFail(init_pid, SupervisorError::InitNotReady));
        }
        let init_identity = InitIdentity {
            host_pid: init_pid,
            start_time: ready.start_time,
            pid_namespace_inode: ready.pid_namespace_inode,
        };

        let ready_monotonic_ms =
            match monotonicMilliseconds(SupervisorError::ControlProtocolRejected) {
                Ok(value) => value,
                Err(_) => {
                    return Err(stopInitAndFail(
                        init_pid,
                        SupervisorError::ControlProtocolRejected,
                    ))
                }
            };
        emitReady(
            fds.control,
            nonce,
            identity,
            outer_pgid,
            &init_identity,
            ready_monotonic_ms,
        )?;
        let deadline_monotonic_ms = match readGo(fds.control, nonce) {
            Ok(deadline) => deadline,
            Err(_) => {
                return Err(stopInitAndFail(
                    init_pid,
                    SupervisorError::ControlProtocolRejected,
                ))
            }
        };
        let start_record = StartRecord {
            tag: b'G',
            reserved: [0; 7],
            deadline_monotonic_ms,
        };
        if writeAll(fds.start_write, recordBytes(&start_record)).is_err() {
            return Err(stopInitAndFail(
                init_pid,
                SupervisorError::TargetStartFailed,
            ));
        }
        closeIgnore(fds.start_write);
        // Target stdin begins immediately after GO. The outer helper must
        // never consume it, and now releases its own descriptor 0 copy.
        closeIgnore(0);

        let maybe_result = match readTargetResultUntil(fds.result_read, deadline_monotonic_ms) {
            Ok(result) => result,
            Err(_) => return Err(stopInitAndFail(init_pid, SupervisorError::ResultMissing)),
        };
        let result = match maybe_result {
            None => return completeLaunchDeadlineExpiry(init_pid, fds, nonce),
            Some(result) => result,
        };
        closeIgnore(fds.result_read);

        let maybe_init_status = match waitForPidUntil(init_pid, deadline_monotonic_ms) {
            Ok(status) => status,
            Err(_) => return Err(stopInitAndFail(init_pid, SupervisorError::CleanupUnproven)),
        };
        let init_status = match maybe_init_status {
            None => return completeLaunchDeadlineExpiry(init_pid, fds, nonce),
            Some(status) => status,
        };
        closeIgnore(fds.lifeline_write);
        if !wIfExited(init_status) || wExitStatus(init_status) != 0 {
            return Err(SupervisorError::InitExitedAbruptly);
        }
        if result.kind != result_kind::TARGET {
            return Err(SupervisorError::TargetStartFailed);
        }

        let exit_code = exitCodeFromWaitStatus(result.wait_status);
        // This is the only CLEAN emission site. PID 1 was already reaped
        // above; this outer process immediately exits after writing CLEAN,
        // and HRA must observe that exit as the second half of the custody
        // proof.
        emitClean(fds.control, nonce, exit_code)?;
        closeIgnore(fds.control);
        k_exit(exit_code as i32);
    }

    fn runRecovery(
        nonce: &Nonce,
        recovery: RecoveryConfig,
        socket: i32,
        launch_parent_pid: i32,
    ) -> Result<()> {
        // Recovery is a child of HRA, never the recorded outer helper or HRA
        // itself. Refuse pathological journal input before opening a pidfd.
        if recovery.outer_pid == k_getpid()
            || recovery.outer_pid == launch_parent_pid
            || recovery.init_host_pid == k_getpid()
            || recovery.init_host_pid == launch_parent_pid
            || recovery.init_host_pid == recovery.outer_pid
        {
            return Err(SupervisorError::RecoveryUnsafeTarget);
        }
        armParentDeath()?;
        assertParentStill(launch_parent_pid)?;
        setUndumpable()?;
        let recovery_identity = RecoveryHelperIdentity {
            pid: k_getpid(),
            start_time: readProcStartTime(
                k_getpid(),
                SupervisorError::RecoverySelfIdentityUnavailable,
            )?,
        };
        verifyBootId(&recovery.boot_id)?;

        // Open both pidfds before looking at either /proc/<pid>/stat. If a
        // task exits and its numeric PID is reused after this point, these
        // descriptors still refer only to the old tasks and can never signal
        // the replacement.
        let raw_outer_pidfd = k_pidfd_open(recovery.outer_pid, 0);
        if errno(raw_outer_pidfd) != 0 {
            return Err(SupervisorError::RecoveryPidfdUnavailable);
        }
        let outer_pidfd = raw_outer_pidfd as i32;
        let raw_init_pidfd = k_pidfd_open(recovery.init_host_pid, 0);
        if errno(raw_init_pidfd) != 0 {
            closeIgnore(outer_pidfd);
            return Err(SupervisorError::RecoveryInitPidfdUnavailable);
        }
        let init_pidfd = raw_init_pidfd as i32;

        let outcome = (|| -> Result<()> {
            verifyRecoveryIdentity(&recovery)?;
            assertPidfdLive(outer_pidfd, SupervisorError::RecoveryOuterNotLive)?;
            assertPidfdLive(init_pidfd, SupervisorError::RecoveryInitNotLive)?;
            emitRecoveryReady(socket, nonce, &recovery_identity, &recovery)?;
            readRecoveryGo(socket, nonce)?;
            assertParentStill(launch_parent_pid)?;
            // Revalidate both exact identities immediately before the only
            // signal. A dead pidfd can only report ESRCH below; it cannot
            // retarget a reused numeric PID. A missing or mismatched
            // namespace init blocks recovery.
            verifyRecoveryIdentity(&recovery)?;
            assertPidfdLive(outer_pidfd, SupervisorError::RecoveryOuterNotLive)?;
            assertPidfdLive(init_pidfd, SupervisorError::RecoveryInitNotLive)?;

            let deadline = recoveryExitDeadline()?;
            let signal_result = errno(k_pidfd_send_signal(outer_pidfd, SIGKILL, 0, 0));
            let method = match signal_result {
                0 => RecoveryMethod::PidfdSigkill,
                ESRCH => RecoveryMethod::PidfdAlreadyExited,
                _ => return Err(SupervisorError::RecoverySignalFailed),
            };
            waitForPidfdExit(outer_pidfd, deadline)?;
            // The init pidfd is the durable proof that the exact namespace
            // PID 1, rather than only its outer supervisor, has exited
            // before success.
            waitForPidfdExit(init_pidfd, deadline)?;
            emitRecoveryClean(socket, nonce, &recovery_identity, &recovery, method)?;
            Ok(())
        })();
        closeIgnore(outer_pidfd);
        closeIgnore(init_pidfd);
        outcome
    }

    enum RecoveryMethod {
        PidfdSigkill,
        PidfdAlreadyExited,
    }

    fn verifyBootId(expected: &BootId) -> Result<()> {
        let actual = readBootId(SupervisorError::RecoveryBootIdUnavailable)?;
        if actual[..] != expected[..] {
            return Err(SupervisorError::RecoveryBootIdMismatch);
        }
        Ok(())
    }

    fn verifyRecoveryIdentity(recovery: &RecoveryConfig) -> Result<()> {
        verifyProcStartTime(recovery.outer_pid, recovery.outer_start_time)?;
        let init_start_time = readProcStartTime(
            recovery.init_host_pid,
            SupervisorError::RecoveryInitProcUnavailable,
        )?;
        if init_start_time != recovery.init_start_time {
            return Err(SupervisorError::RecoveryInitStartTimeMismatch);
        }
        // PID-namespace membership cannot change during a task's lifetime.
        // The exact sealed init self-reported this inode before READY, and
        // both pidfd + start-time checks above bind recovery to that same
        // task. Do not weaken the init's nondumpable boundary just to repeat
        // its proc readlink here.
        Ok(())
    }

    fn verifyProcStartTime(expected_pid: i32, expected_start_time: u64) -> Result<()> {
        let actual_start_time =
            readProcStartTime(expected_pid, SupervisorError::RecoveryProcUnavailable)?;
        if actual_start_time != expected_start_time {
            return Err(SupervisorError::RecoveryStartTimeMismatch);
        }
        Ok(())
    }

    struct PreparedFileDescriptors {
        control: i32,
        start_write: i32,
        start_read: i32,
        result_read: i32,
        result_write: i32,
        ready_read: i32,
        ready_write: i32,
        lifeline_write: i32,
        lifeline_read: i32,
    }

    fn prepareFileDescriptors(
        input_control: i32,
        nonce: &Nonce,
    ) -> Result<PreparedFileDescriptors> {
        if input_control < CONTROL_FD {
            return Err(SupervisorError::FileDescriptorIsolationUnavailable);
        }
        // Preserve every source above the fixed descriptor range before
        // remapping. This prevents a pipe allocation from becoming another
        // protocol channel while its endpoints are being assigned fixed
        // names.
        let control_copy = duplicateAtLeast(input_control, SCRATCH_FD_MINIMUM)?;

        let mut start = [0i32; 2];
        let mut result = [0i32; 2];
        let mut ready = [0i32; 2];
        let mut lifeline = [0i32; 2];
        makePipe(&mut start)?;
        makePipe(&mut result)?;
        makePipe(&mut ready)?;
        makePipe(&mut lifeline)?;

        let start_read_copy = duplicateAtLeast(start[0], SCRATCH_FD_MINIMUM)?;
        let start_write_copy = duplicateAtLeast(start[1], SCRATCH_FD_MINIMUM)?;
        let result_read_copy = duplicateAtLeast(result[0], SCRATCH_FD_MINIMUM)?;
        let result_write_copy = duplicateAtLeast(result[1], SCRATCH_FD_MINIMUM)?;
        let ready_read_copy = duplicateAtLeast(ready[0], SCRATCH_FD_MINIMUM)?;
        let ready_write_copy = duplicateAtLeast(ready[1], SCRATCH_FD_MINIMUM)?;
        let lifeline_read_copy = duplicateAtLeast(lifeline[0], SCRATCH_FD_MINIMUM)?;
        let lifeline_write_copy = duplicateAtLeast(lifeline[1], SCRATCH_FD_MINIMUM)?;

        // Stdio is the target's explicitly allowed surface. Everything else
        // is copied into a fixed helper descriptor below or closed forever.
        // Keep the caller's connected socket alive until descriptor 3 has
        // been installed. That leaves main() a live channel for any failure
        // before the fixed control descriptor exists.
        closeRangeExcept(CONTROL_FD, SCRATCH_FD_MINIMUM - 1, input_control)?;
        duplicateInto(control_copy, CONTROL_FD)?;
        // From here fd 3 is known-good, so every failure can still emit an
        // authenticated FAIL frame even though the original numeric
        // descriptor may be replaced or closed below.
        macro_rules! duplicate_or_fail {
            ($copy:expr, $fixed:expr) => {
                if let Err(err) = duplicateInto($copy, $fixed) {
                    failControlAndExit(CONTROL_FD, nonce, err);
                }
            };
        }
        duplicate_or_fail!(start_write_copy, START_WRITE_FD);
        duplicate_or_fail!(start_read_copy, START_READ_FD);
        duplicate_or_fail!(result_read_copy, RESULT_READ_FD);
        duplicate_or_fail!(result_write_copy, RESULT_WRITE_FD);
        duplicate_or_fail!(ready_read_copy, READY_READ_FD);
        duplicate_or_fail!(ready_write_copy, READY_WRITE_FD);
        duplicate_or_fail!(lifeline_write_copy, LIFELINE_WRITE_FD);
        duplicate_or_fail!(lifeline_read_copy, LIFELINE_READ_FD);
        if let Err(err) = closeRange(MAXIMUM_PRESERVED_FD + 1, i32::MAX) {
            failControlAndExit(CONTROL_FD, nonce, err);
        }

        Ok(PreparedFileDescriptors {
            control: CONTROL_FD,
            start_write: START_WRITE_FD,
            start_read: START_READ_FD,
            result_read: RESULT_READ_FD,
            result_write: RESULT_WRITE_FD,
            ready_read: READY_READ_FD,
            ready_write: READY_WRITE_FD,
            lifeline_write: LIFELINE_WRITE_FD,
            lifeline_read: LIFELINE_READ_FD,
        })
    }

    fn initMain(config: &LaunchConfig, fds: &PreparedFileDescriptors) -> ! {
        closeIgnore(fds.control);
        closeIgnore(fds.start_write);
        closeIgnore(fds.result_read);
        closeIgnore(fds.ready_read);
        closeIgnore(fds.lifeline_write);

        // PID 1 never writes raw bytes to HRA's target stdout/stderr streams,
        // but retains them so the target can inherit its ordinary raw stdio
        // surface.

        if armParentDeath().is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 1);
        }
        if setUndumpable().is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 2);
        }
        // PR_SET_PDEATHSIG covers parent death after this point. The lifeline
        // pipe closes the small fork-to-prctl race before READY can be
        // emitted.
        if assertLifelineStillOpen(fds.lifeline_read).is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 3);
        }
        // This runs while this process is PID 1 in the child PID namespace
        // and only after root propagation was made private in the outer
        // supervisor.
        if rejectRecoveryDirectoryMountAliases(&config.recovery_directory).is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 4);
        }
        if concealRecoveryDirectory(&config.recovery_directory).is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 4);
        }
        if mountFreshProc().is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 4);
        }
        let init_identity = InitReadyRecord {
            tag: b'R',
            reserved: [0; 7],
            start_time: match readProcStartTime(k_getpid(), SupervisorError::InitNotReady) {
                Ok(value) => value,
                Err(_) => initExit(fds.result_write, result_kind::INTERNAL, 5),
            },
            pid_namespace_inode: match readPidNamespaceInode(
                k_getpid(),
                SupervisorError::InitNotReady,
            ) {
                Ok(value) => value,
                Err(_) => initExit(fds.result_write, result_kind::INTERNAL, 6),
            },
        };
        if writeAll(fds.ready_write, recordBytes(&init_identity)).is_err() {
            initExit(fds.result_write, result_kind::INTERNAL, 7);
        }
        closeIgnore(fds.ready_write);

        let deadline_monotonic_ms =
            match waitForStartOrParentDeath(fds.start_read, fds.lifeline_read) {
                Ok(deadline) => deadline,
                Err(SupervisorError::ParentExited) => k_exit(0),
                Err(_) => initExit(fds.result_write, result_kind::INTERNAL, 8),
            };
        closeIgnore(fds.start_read);
        closeIgnore(fds.lifeline_read);

        let target_fork = k_fork();
        if errno(target_fork) != 0 {
            initExit(fds.result_write, result_kind::INTERNAL, 9);
        }
        if target_fork == 0 {
            targetMain(config);
        }

        let target_pid = target_fork as i32;
        let maybe_target_status = match waitForPidUntil(target_pid, deadline_monotonic_ms) {
            Ok(status) => status,
            Err(_) => initExit(fds.result_write, result_kind::INTERNAL, 10),
        };
        let target_status = match maybe_target_status {
            Some(status) => status,
            None => {
                if killAndReap(target_pid).is_err() {
                    initExit(fds.result_write, result_kind::INTERNAL, 10);
                }
                // The outer supervisor owns the externally visible timeout
                // status. PID 1 exits promptly after proving that its direct
                // target is reaped.
                timeoutWaitStatus()
            }
        };
        let result = TargetResult {
            kind: result_kind::TARGET,
            reserved: [0; 3],
            wait_status: target_status,
        };
        if writeAll(fds.result_write, recordBytes(&result)).is_err() {
            k_exit(1);
        }
        closeIgnore(fds.result_write);
        // Exiting namespace PID 1 is intentional: Linux SIGKILLs every
        // remaining task in this namespace before the outer supervisor can
        // emit CLEAN.
        k_exit(0);
    }

    fn targetMain(config: &LaunchConfig) -> ! {
        if closeRange(3, i32::MAX).is_err() {
            k_exit(127);
        }
        if clearCloseOnExec(0).is_err() {
            k_exit(127);
        }
        if clearCloseOnExec(1).is_err() {
            k_exit(127);
        }
        if clearCloseOnExec(2).is_err() {
            k_exit(127);
        }
        if hardenTargetCredentials().is_err() {
            k_exit(127);
        }
        if errno(k_chdir(config.target_cwd.as_ptr())) != 0 {
            k_exit(127);
        }
        let _ = k_execve(
            config.target_path.as_ptr(),
            config.target_argv,
            config.target_env,
        );
        k_exit(127);
    }

    fn unshareAndMapCurrentIdentity(host_uid: u32, host_gid: u32) -> Result<()> {
        let flags = CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNS;
        if errno(k_unshare(flags)) != 0 {
            return Err(SupervisorError::NamespaceUnavailable);
        }

        writePath(b"/proc/self/setgroups\0".as_ptr(), b"deny\n")
            .map_err(|_| SupervisorError::NamespaceMappingFailed)?;

        let uid_text = format!("0 {} 1\n", host_uid);
        writePath(b"/proc/self/uid_map\0".as_ptr(), uid_text.as_bytes())
            .map_err(|_| SupervisorError::NamespaceMappingFailed)?;

        let gid_text = format!("0 {} 1\n", host_gid);
        writePath(b"/proc/self/gid_map\0".as_ptr(), gid_text.as_bytes())
            .map_err(|_| SupervisorError::NamespaceMappingFailed)?;

        // The mount namespace is private before namespace PID 1 remounts
        // /proc. A target mount operation can therefore never propagate to
        // the host.
        if errno(k_mount(
            core::ptr::null(),
            b"/\0".as_ptr(),
            core::ptr::null(),
            MS_REC | MS_PRIVATE,
            0,
        )) != 0
        {
            return Err(SupervisorError::MountIsolationFailed);
        }
        Ok(())
    }

    fn mountFreshProc() -> Result<()> {
        // Mounts inherited from a more privileged namespace are locked
        // together and cannot be individually detached here. Linux permits
        // stacking a new procfs over that locked mount inside this private
        // namespace.
        let flags = MS_NOSUID | MS_NODEV | MS_NOEXEC;
        if errno(k_mount(
            b"proc\0".as_ptr(),
            b"/proc\0".as_ptr(),
            b"proc\0".as_ptr(),
            flags,
            0,
        )) != 0
        {
            return Err(SupervisorError::MountIsolationFailed);
        }
        Ok(())
    }

    #[derive(Clone, Copy)]
    struct DirectoryIdentity {
        device_major: u32,
        device_minor: u32,
        inode: u64,
    }

    #[derive(Clone, Copy)]
    struct RecoveryAncestor {
        path_length: usize,
        identity: DirectoryIdentity,
    }

    fn rejectRecoveryDirectoryMountAliases(directory: &[u8]) -> Result<()> {
        // Directory is derived from a sub-108-byte canonical control-socket
        // path, so there can be at most one ancestor per byte. Keep the
        // entire proof on the stack: no allocator or inherited descriptor
        // survives into PID 1.
        let mut ancestors = [RecoveryAncestor {
            path_length: 0,
            identity: DirectoryIdentity {
                device_major: 0,
                device_minor: 0,
                inode: 0,
            },
        }; 108];
        let ancestor_count = collectRecoveryAncestors(directory, &mut ancestors)?;

        // A bounded full read rejects truncation. The byte-for-byte second
        // read is a seqlock-style stability proof: although no untrusted
        // task shares this new private mount namespace yet, an unexpected
        // concurrent mutation must still stop launch rather than invalidate
        // the inode comparison below.
        let mut first_buffer = [0u8; MOUNTINFO_MAX_BYTES];
        let first_len = readSmallFile(
            b"/proc/self/mountinfo\0".as_ptr(),
            &mut first_buffer,
            SupervisorError::MountTableInvalid,
        )?;
        let first = &first_buffer[..first_len];
        inspectMountInfoForRecoveryAliases(first, directory, &ancestors[0..ancestor_count])?;

        let mut second_buffer = [0u8; MOUNTINFO_MAX_BYTES];
        let second_len = readSmallFile(
            b"/proc/self/mountinfo\0".as_ptr(),
            &mut second_buffer,
            SupervisorError::MountTableInvalid,
        )?;
        let second = &second_buffer[..second_len];
        if first != second {
            return Err(SupervisorError::MountTableInvalid);
        }
        Ok(())
    }

    fn collectRecoveryAncestors(
        directory: &[u8],
        output: &mut [RecoveryAncestor; 108],
    ) -> Result<usize> {
        let mut count: usize = 0;
        output[count] = RecoveryAncestor {
            path_length: 1,
            identity: statDirectoryIdentity(&directory[0..1])?,
        };
        count += 1;

        for (index, character) in directory.iter().enumerate().skip(1) {
            if *character != b'/' {
                continue;
            }
            if count == output.len() {
                return Err(SupervisorError::MountTableInvalid);
            }
            output[count] = RecoveryAncestor {
                path_length: index,
                identity: statDirectoryIdentity(&directory[0..index])?,
            };
            count += 1;
        }
        if count == output.len() {
            return Err(SupervisorError::MountTableInvalid);
        }
        output[count] = RecoveryAncestor {
            path_length: directory.len(),
            identity: statDirectoryIdentity(directory)?,
        };
        Ok(count + 1)
    }

    fn inspectMountInfoForRecoveryAliases(
        contents: &[u8],
        directory: &[u8],
        ancestors: &[RecoveryAncestor],
    ) -> Result<()> {
        if contents.is_empty() || contents[contents.len() - 1] != b'\n' {
            return Err(SupervisorError::MountTableInvalid);
        }
        let mut cursor: usize = 0;
        let mut line_count: usize = 0;
        while cursor < contents.len() {
            let relative_end = match contents[cursor..].iter().position(|b| *b == b'\n') {
                Some(position) => position,
                None => return Err(SupervisorError::MountTableInvalid),
            };
            let line_end = cursor + relative_end;
            let line = &contents[cursor..line_end];
            if line.is_empty() || line.len() > MOUNTINFO_MAX_LINE_BYTES {
                return Err(SupervisorError::MountTableInvalid);
            }
            line_count += 1;
            if line_count > MOUNTINFO_MAX_LINES {
                return Err(SupervisorError::MountTableInvalid);
            }

            let mut mountpoint_buffer = [0u8; PATH_MAX + 1];
            let mountpoint = parseMountInfoLine(line, &mut mountpoint_buffer)?;
            if let Some(identity) = statMountpointDirectoryIdentity(mountpoint)? {
                if mountpointAliasesRecoveryAncestor(mountpoint, &identity, directory, ancestors) {
                    return Err(SupervisorError::MountAliasUnsafe);
                }
            }
            cursor = line_end + 1;
        }
        Ok(())
    }

    fn mountpointAliasesRecoveryAncestor(
        mountpoint: &[u8],
        identity: &DirectoryIdentity,
        directory: &[u8],
        ancestors: &[RecoveryAncestor],
    ) -> bool {
        for ancestor in ancestors {
            if !sameDirectoryIdentity(identity, &ancestor.identity) {
                continue;
            }
            let canonical_ancestor = &directory[0..ancestor.path_length];
            if mountpoint != canonical_ancestor {
                return true;
            }
        }
        false
    }

    fn parseMountInfoLine<'a>(
        line: &[u8],
        mountpoint_buffer: &'a mut [u8; PATH_MAX + 1],
    ) -> Result<&'a [u8]> {
        let separator = match findSubslice(line, b" - ") {
            Some(position) => position,
            None => return Err(SupervisorError::MountTableInvalid),
        };
        if findSubslice(&line[separator + 3..], b" - ").is_some() {
            return Err(SupervisorError::MountTableInvalid);
        }

        let mut root_buffer = [0u8; PATH_MAX + 1];
        let mut field_index: usize = 0;
        let mut mountpoint_length: Option<usize> = None;
        for field in line[0..separator].split(|b| *b == b' ') {
            if !validMountInfoToken(field) {
                return Err(SupervisorError::MountTableInvalid);
            }
            match field_index {
                0 | 1 => {
                    if parsePositiveU64(field).is_none() {
                        return Err(SupervisorError::MountTableInvalid);
                    }
                }
                2 => {
                    if !validMountDevice(field) {
                        return Err(SupervisorError::MountTableInvalid);
                    }
                }
                3 => {
                    if decodeMountInfoPath(field, &mut root_buffer).is_none() {
                        return Err(SupervisorError::MountTableInvalid);
                    }
                }
                4 => {
                    mountpoint_length = decodeMountInfoPath(field, mountpoint_buffer);
                    if mountpoint_length.is_none() {
                        return Err(SupervisorError::MountTableInvalid);
                    }
                }
                _ => {}
            }
            field_index += 1;
        }
        if field_index < 6 || mountpoint_length.is_none() {
            return Err(SupervisorError::MountTableInvalid);
        }

        let mut after_count: usize = 0;
        for field in line[separator + 3..].split(|b| *b == b' ') {
            if !validMountInfoToken(field) {
                return Err(SupervisorError::MountTableInvalid);
            }
            after_count += 1;
        }
        if after_count != 3 {
            return Err(SupervisorError::MountTableInvalid);
        }
        match mountpoint_length {
            Some(length) => Ok(&mountpoint_buffer[0..length]),
            None => Err(SupervisorError::MountTableInvalid),
        }
    }

    fn findSubslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn validMountDevice(field: &[u8]) -> bool {
        let separator = match field.iter().position(|b| *b == b':') {
            Some(position) => position,
            None => return false,
        };
        if field[separator + 1..]
            .iter()
            .position(|b| *b == b':')
            .is_some()
        {
            return false;
        }
        parseDecimalU64(&field[0..separator]).is_some()
            && parseDecimalU64(&field[separator + 1..]).is_some()
    }

    fn validMountInfoToken(field: &[u8]) -> bool {
        if field.is_empty() {
            return false;
        }
        let mut cursor: usize = 0;
        while cursor < field.len() {
            let character = field[cursor];
            if character == b'\\' {
                if cursor + 4 > field.len()
                    || decodeMountInfoEscape(&field[cursor + 1..cursor + 4]).is_none()
                {
                    return false;
                }
                cursor += 4;
                continue;
            }
            if character <= b' ' || character == 0x7f {
                return false;
            }
            cursor += 1;
        }
        true
    }

    // Decodes into output, NUL-terminates it, and returns the decoded length.
    // Callers slice output[0..length] for the decoded path.
    fn decodeMountInfoPath(input: &[u8], output: &mut [u8]) -> Option<usize> {
        if !validMountInfoToken(input) {
            return None;
        }
        let mut input_cursor: usize = 0;
        let mut output_cursor: usize = 0;
        while input_cursor < input.len() {
            let decoded = if input[input_cursor] == b'\\' {
                let character = decodeMountInfoEscape(&input[input_cursor + 1..input_cursor + 4])?;
                input_cursor += 4;
                character
            } else {
                let character = input[input_cursor];
                input_cursor += 1;
                character
            };
            if output_cursor >= output.len() - 1 {
                return None;
            }
            output[output_cursor] = decoded;
            output_cursor += 1;
        }
        if !(output[0..output_cursor] == *b"/"
            || isCanonicalAbsolutePath(&output[0..output_cursor]))
        {
            return None;
        }
        output[output_cursor] = 0;
        Some(output_cursor)
    }

    fn decodeMountInfoEscape(input: &[u8]) -> Option<u8> {
        if input == b"040" {
            return Some(b' ');
        }
        if input == b"011" {
            return Some(b'\t');
        }
        if input == b"012" {
            return Some(b'\n');
        }
        if input == b"134" {
            return Some(b'\\');
        }
        None
    }

    fn statDirectoryIdentity(path: &[u8]) -> Result<DirectoryIdentity> {
        match statMountpointDirectoryIdentity(path)? {
            Some(identity) => Ok(identity),
            None => Err(SupervisorError::MountTableInvalid),
        }
    }

    fn statMountpointDirectoryIdentity(path: &[u8]) -> Result<Option<DirectoryIdentity>> {
        if path.is_empty() || path.len() > PATH_MAX {
            return Err(SupervisorError::MountTableInvalid);
        }
        let mut path_buffer = [0u8; PATH_MAX + 1];
        path_buffer[0..path.len()].copy_from_slice(path);
        let mut information: Statx = unsafe { core::mem::zeroed() };
        if errno(k_statx(
            AT_FDCWD,
            path_buffer.as_ptr(),
            AT_NO_AUTOMOUNT,
            STATX_BASIC_STATS,
            &mut information,
        )) != 0
        {
            return Err(SupervisorError::MountTableInvalid);
        }
        if information.mask & STATX_TYPE == 0 || information.mask & STATX_INO == 0 {
            return Err(SupervisorError::MountTableInvalid);
        }
        if (information.mode & S_IFMT) != S_IFDIR {
            return Ok(None);
        }
        Ok(Some(DirectoryIdentity {
            device_major: information.dev_major,
            device_minor: information.dev_minor,
            inode: information.ino,
        }))
    }

    fn sameDirectoryIdentity(left: &DirectoryIdentity, right: &DirectoryIdentity) -> bool {
        left.device_major == right.device_major
            && left.device_minor == right.device_minor
            && left.inode == right.inode
    }

    // Compile-time-equivalent parser fixtures, executed once at start. The
    // fixed inputs make every outcome deterministic; a regression here means
    // the binary is corrupt and must not run.
    fn assertMountInfoParserFixtures() {
        let mut mountpoint_buffer = [0u8; PATH_MAX + 1];
        let decoded = parseMountInfoLine(
            b"36 25 0:32 / /tmp/recovery\\040alias rw,nosuid shared:1 - tmpfs tmpfs rw",
            &mut mountpoint_buffer,
        )
        .expect("valid mountinfo fixture rejected");
        assert!(
            decoded == b"/tmp/recovery alias",
            "mountinfo escape fixture decoded incorrectly"
        );

        let mut malformed_buffer = [0u8; PATH_MAX + 1];
        if parseMountInfoLine(
            b"36 25 0:32 / /tmp/recovery\\777 rw - tmpfs tmpfs rw",
            &mut malformed_buffer,
        )
        .is_ok()
        {
            panic!("unknown mountinfo escape accepted");
        }

        let identity = DirectoryIdentity {
            device_major: 1,
            device_minor: 2,
            inode: 3,
        };
        let ancestors = [RecoveryAncestor {
            path_length: 13,
            identity,
        }];
        if mountpointAliasesRecoveryAncestor(
            b"/tmp/recovery",
            &identity,
            b"/tmp/recovery",
            &ancestors,
        ) {
            panic!("canonical recovery mountpoint classified as alias");
        }
        if !mountpointAliasesRecoveryAncestor(
            b"/tmp/recovery-alias",
            &identity,
            b"/tmp/recovery",
            &ancestors,
        ) {
            panic!("distinct-path same-inode mount alias accepted");
        }
    }

    fn concealRecoveryDirectory(directory: &[u8]) -> Result<()> {
        let mut path_buffer = [0u8; 108];
        if directory.len() >= path_buffer.len() {
            return Err(SupervisorError::MountIsolationFailed);
        }
        path_buffer[0..directory.len()].copy_from_slice(directory);
        let flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC;
        if errno(k_mount(
            b"tmpfs\0".as_ptr(),
            path_buffer.as_ptr(),
            b"tmpfs\0".as_ptr(),
            flags,
            b"mode=000,size=4096,nr_inodes=1\0".as_ptr() as usize,
        )) != 0
        {
            return Err(SupervisorError::MountIsolationFailed);
        }
        Ok(())
    }

    fn setUndumpable() -> Result<()> {
        if errno(k_prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)) != 0 {
            return Err(SupervisorError::SupervisorHardeningFailed);
        }
        Ok(())
    }

    fn hardenTargetCredentials() -> Result<()> {
        if errno(k_prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) != 0 {
            return Err(SupervisorError::TargetHardeningFailed);
        }
        if errno(k_prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) != 0 {
            return Err(SupervisorError::TargetHardeningFailed);
        }

        let mut capability: u8 = 0;
        while capability <= CAP_LAST_CAP {
            if errno(k_prctl(PR_CAPBSET_DROP, capability as usize, 0, 0, 0)) != 0 {
                return Err(SupervisorError::TargetHardeningFailed);
            }
            capability += 1;
        }

        let header = CapabilityHeader {
            version: CAPSET_V3_VERSION,
            pid: 0,
        };
        let data = [
            CapabilityData {
                effective: 0,
                permitted: 0,
                inheritable: 0,
            },
            CapabilityData {
                effective: 0,
                permitted: 0,
                inheritable: 0,
            },
        ];
        if errno(k_capset(&header, data.as_ptr())) != 0 {
            return Err(SupervisorError::TargetHardeningFailed);
        }
        Ok(())
    }

    fn armParentDeath() -> Result<()> {
        if errno(k_prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0)) != 0 {
            return Err(SupervisorError::SupervisorHardeningFailed);
        }
        Ok(())
    }

    fn assertParentStill(expected_parent: i32) -> Result<()> {
        if k_getppid() != expected_parent {
            return Err(SupervisorError::ParentExited);
        }
        Ok(())
    }

    fn assertLifelineStillOpen(lifeline: i32) -> Result<()> {
        let mut descriptors = [PollFd {
            fd: lifeline,
            events: POLLIN,
            revents: 0,
        }];
        loop {
            let result = k_poll(descriptors.as_mut_ptr(), descriptors.len(), 0);
            match errno(result) {
                0 => {}
                EINTR => continue,
                _ => return Err(SupervisorError::ParentExited),
            }
            if result == 0 {
                return Ok(());
            }
            if (descriptors[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0 {
                return Err(SupervisorError::ParentExited);
            }
        }
    }

    fn waitForStartOrParentDeath(start: i32, lifeline: i32) -> Result<u64> {
        let mut descriptors = [
            PollFd {
                fd: start,
                events: POLLIN,
                revents: 0,
            },
            PollFd {
                fd: lifeline,
                events: POLLIN,
                revents: 0,
            },
        ];
        loop {
            let result = k_poll(descriptors.as_mut_ptr(), descriptors.len(), -1);
            match errno(result) {
                0 => {}
                EINTR => continue,
                _ => return Err(SupervisorError::WaitFailed),
            }
            if (descriptors[1].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0 {
                return Err(SupervisorError::ParentExited);
            }
            if (descriptors[0].revents & POLLIN) != 0 {
                let mut record = StartRecord {
                    tag: 0,
                    reserved: [0; 7],
                    deadline_monotonic_ms: 0,
                };
                readExactly(start, recordBytesMut(&mut record))?;
                if record.tag != b'G' || record.reserved.iter().any(|b| *b != 0) {
                    return Err(SupervisorError::ControlProtocolRejected);
                }
                let now = monotonicMilliseconds(SupervisorError::ControlProtocolRejected)?;
                if record.deadline_monotonic_ms <= now {
                    return Err(SupervisorError::ControlProtocolRejected);
                }
                return Ok(record.deadline_monotonic_ms);
            }
            if (descriptors[0].revents & (POLLHUP | POLLERR | POLLNVAL)) != 0 {
                return Err(SupervisorError::ParentExited);
            }
        }
    }

    fn assertPidfdLive(pidfd: i32, not_live: SupervisorError) -> Result<()> {
        let mut descriptors = [PollFd {
            fd: pidfd,
            events: POLLIN,
            revents: 0,
        }];
        loop {
            let result = k_poll(descriptors.as_mut_ptr(), descriptors.len(), 0);
            match errno(result) {
                0 => {}
                EINTR => continue,
                _ => return Err(SupervisorError::RecoveryWaitFailed),
            }
            if result == 0 {
                return Ok(());
            }
            if (descriptors[0].revents & POLLIN) != 0 {
                return Err(not_live);
            }
            return Err(SupervisorError::RecoveryWaitFailed);
        }
    }

    fn recoveryExitDeadline() -> Result<u64> {
        let started = monotonicMilliseconds(SupervisorError::RecoveryWaitFailed)?;
        if started > u64::MAX - RECOVERY_EXIT_TIMEOUT_MS {
            return Err(SupervisorError::RecoveryWaitFailed);
        }
        Ok(started + RECOVERY_EXIT_TIMEOUT_MS)
    }

    fn waitForPidfdExit(pidfd: i32, deadline: u64) -> Result<()> {
        let mut descriptors = [PollFd {
            fd: pidfd,
            events: POLLIN,
            revents: 0,
        }];

        loop {
            let now = monotonicMilliseconds(SupervisorError::RecoveryWaitFailed)?;
            if now >= deadline {
                return Err(SupervisorError::RecoveryExitTimeout);
            }
            let remaining = deadline - now;
            let timeout = remaining.min(i32::MAX as u64) as i32;
            descriptors[0].revents = 0;
            let result = k_poll(descriptors.as_mut_ptr(), descriptors.len(), timeout);
            match errno(result) {
                0 => {
                    if result == 0 {
                        return Err(SupervisorError::RecoveryExitTimeout);
                    }
                    if (descriptors[0].revents & POLLIN) != 0 {
                        return Ok(());
                    }
                    return Err(SupervisorError::RecoveryWaitFailed);
                }
                EINTR => continue,
                _ => return Err(SupervisorError::RecoveryWaitFailed),
            }
        }
    }

    fn monotonicMilliseconds(failure: SupervisorError) -> Result<u64> {
        let mut timestamp = Timespec { sec: 0, nsec: 0 };
        if errno(k_clock_gettime(CLOCK_MONOTONIC, &mut timestamp)) != 0 {
            return Err(failure);
        }
        if timestamp.sec < 0 || timestamp.nsec < 0 {
            return Err(failure);
        }
        let seconds = timestamp.sec as u64;
        let nanoseconds = timestamp.nsec as u64;
        if seconds > u64::MAX / 1_000 {
            return Err(failure);
        }
        Ok(seconds * 1_000 + nanoseconds / 1_000_000)
    }

    fn readGo(fd: i32, nonce: &Nonce) -> Result<u64> {
        let deadline_field = b" deadline_monotonic_ms=";
        let mut expected_prefix =
            Vec::with_capacity(PROTOCOL_PREFIX.len() + 9 + NONCE_HEX_LENGTH + deadline_field.len());
        expected_prefix.extend_from_slice(PROTOCOL_PREFIX);
        expected_prefix.extend_from_slice(b"GO nonce=");
        expected_prefix.extend_from_slice(&nonceHex(nonce));
        expected_prefix.extend_from_slice(deadline_field);

        let mut line_buffer = [0u8; 192];
        let line = readBoundedLine(fd, &mut line_buffer)?;
        if !line.starts_with(&expected_prefix) {
            return Err(SupervisorError::ControlProtocolRejected);
        }
        let deadline_text = &line[expected_prefix.len()..];
        let deadline = match parsePositiveU64(deadline_text) {
            Some(deadline) => deadline,
            None => return Err(SupervisorError::ControlProtocolRejected),
        };
        let now = monotonicMilliseconds(SupervisorError::ControlProtocolRejected)?;
        if deadline <= now {
            return Err(SupervisorError::ControlProtocolRejected);
        }
        Ok(deadline)
    }

    fn readRecoveryGo(fd: i32, nonce: &Nonce) -> Result<()> {
        let mut expected = Vec::with_capacity(PROTOCOL_PREFIX.len() + 18 + NONCE_HEX_LENGTH + 1);
        expected.extend_from_slice(PROTOCOL_PREFIX);
        expected.extend_from_slice(b"RECOVERY_GO nonce=");
        expected.extend_from_slice(&nonceHex(nonce));
        expected.push(b'\n');

        let mut actual = vec![0u8; expected.len()];
        readExactly(fd, &mut actual)?;
        if actual != expected {
            return Err(SupervisorError::ControlProtocolRejected);
        }
        Ok(())
    }

    fn readTargetResultUntil(fd: i32, deadline: u64) -> Result<Option<TargetResult>> {
        let mut descriptors = [PollFd {
            fd,
            events: POLLIN,
            revents: 0,
        }];
        loop {
            let now = monotonicMilliseconds(SupervisorError::WaitFailed)?;
            if now >= deadline {
                return Ok(None);
            }
            let remaining = deadline - now;
            let timeout = remaining.min(i32::MAX as u64) as i32;
            descriptors[0].revents = 0;
            let poll_result = k_poll(descriptors.as_mut_ptr(), descriptors.len(), timeout);
            match errno(poll_result) {
                0 => {}
                EINTR => continue,
                _ => return Err(SupervisorError::WaitFailed),
            }
            if poll_result == 0 {
                return Ok(None);
            }
            if (descriptors[0].revents & POLLIN) != 0 {
                if monotonicMilliseconds(SupervisorError::WaitFailed)? >= deadline {
                    return Ok(None);
                }
                let mut result = TargetResult {
                    kind: 0,
                    reserved: [0; 3],
                    wait_status: 0,
                };
                readExactly(fd, recordBytesMut(&mut result))?;
                return Ok(Some(result));
            }
            return Err(SupervisorError::ResultMissing);
        }
    }

    fn waitForPidUntil(pid: i32, deadline: u64) -> Result<Option<u32>> {
        let mut status: u32 = 0;
        loop {
            let now = monotonicMilliseconds(SupervisorError::WaitFailed)?;
            if now >= deadline {
                return Ok(None);
            }
            let result = k_waitpid(pid, &mut status, WNOHANG);
            match errno(result) {
                0 => {
                    if result != 0 {
                        if result != pid as isize {
                            return Err(SupervisorError::WaitFailed);
                        }
                        return Ok(Some(status));
                    }
                }
                EINTR => continue,
                _ => return Err(SupervisorError::WaitFailed),
            }

            let remaining = deadline - now;
            let timeout = remaining.min(25) as i32;
            let poll_result = k_poll(core::ptr::null_mut(), 0, timeout);
            match errno(poll_result) {
                0 | EINTR => {}
                _ => return Err(SupervisorError::WaitFailed),
            }
        }
    }

    fn killAndReap(pid: i32) -> Result<()> {
        let kill_result = errno(k_kill(pid, SIGKILL));
        if kill_result != 0 && kill_result != ESRCH {
            return Err(SupervisorError::CleanupUnproven);
        }
        waitForPid(pid).map_err(|_| SupervisorError::CleanupUnproven)?;
        Ok(())
    }

    fn completeLaunchDeadlineExpiry(
        init_pid: i32,
        fds: &PreparedFileDescriptors,
        nonce: &Nonce,
    ) -> Result<()> {
        killAndReap(init_pid)?;
        closeIgnore(fds.result_read);
        closeIgnore(fds.lifeline_write);
        emitClean(fds.control, nonce, LAUNCH_TIMEOUT_EXIT_CODE)?;
        closeIgnore(fds.control);
        k_exit(LAUNCH_TIMEOUT_EXIT_CODE as i32);
    }

    fn timeoutWaitStatus() -> u32 {
        // waitpid encodes a normal exit code in bits 8..15. Preserve the
        // public timeout contract even when PID 1 reaches the deadline and
        // reports first.
        (LAUNCH_TIMEOUT_EXIT_CODE as u32) << 8
    }

    fn stopInitAndFail(init_pid: i32, failure: SupervisorError) -> SupervisorError {
        if killAndReap(init_pid).is_err() {
            return SupervisorError::CleanupUnproven;
        }
        failure
    }

    fn waitForPid(pid: i32) -> Result<u32> {
        let mut status: u32 = 0;
        loop {
            let result = k_waitpid(pid, &mut status, 0);
            match errno(result) {
                0 => return Ok(status),
                EINTR => continue,
                _ => return Err(SupervisorError::WaitFailed),
            }
        }
    }

    fn wIfExited(status: u32) -> bool {
        (status & 0x7f) == 0
    }

    fn wExitStatus(status: u32) -> u8 {
        ((status & 0xff00) >> 8) as u8
    }

    fn wIfSignaled(status: u32) -> bool {
        (status & 0xffff).wrapping_sub(1) < 0xff
    }

    fn wTermSig(status: u32) -> u32 {
        status & 0x7f
    }

    fn exitCodeFromWaitStatus(status: u32) -> u8 {
        if wIfExited(status) {
            return wExitStatus(status);
        }
        if wIfSignaled(status) {
            let signal_code = wTermSig(status) as u16;
            return (128 + signal_code) as u8;
        }
        1
    }

    fn connectControl(path: &[u8]) -> Result<i32> {
        let socket_result = k_socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if errno(socket_result) != 0 {
            return Err(SupervisorError::ControlConnectFailed);
        }
        let socket = socket_result as i32;

        let mut address = SockAddrUn {
            family: AF_UNIX as u16,
            path: [0; 108],
        };
        address.path[0..path.len()].copy_from_slice(path);
        let address_length = (core::mem::offset_of!(SockAddrUn, path) + path.len() + 1) as u32;
        loop {
            let result = k_connect(socket, &address, address_length);
            match errno(result) {
                0 => return Ok(socket),
                EINTR => continue,
                _ => {
                    closeIgnore(socket);
                    return Err(SupervisorError::ControlConnectFailed);
                }
            }
        }
    }

    fn readBoundedLine<'a>(fd: i32, buffer: &'a mut [u8]) -> Result<&'a [u8]> {
        let mut cursor: usize = 0;
        while cursor < buffer.len() {
            let mut byte = [0u8; 1];
            readExactly(fd, &mut byte)?;
            if byte[0] == b'\n' {
                return Ok(&buffer[0..cursor]);
            }
            buffer[cursor] = byte[0];
            cursor += 1;
        }
        Err(SupervisorError::ControlProtocolRejected)
    }

    fn readExactly(fd: i32, output: &mut [u8]) -> Result<()> {
        let mut cursor: usize = 0;
        while cursor < output.len() {
            let result = k_read(fd, output[cursor..].as_mut_ptr(), output.len() - cursor);
            match errno(result) {
                0 => {
                    let count = result as usize;
                    if count == 0 {
                        return Err(SupervisorError::ResultMissing);
                    }
                    cursor += count;
                }
                EINTR => continue,
                _ => return Err(SupervisorError::ResultMissing),
            }
        }
        Ok(())
    }

    fn writeAll(fd: i32, input: &[u8]) -> Result<()> {
        let mut cursor: usize = 0;
        while cursor < input.len() {
            let result = k_write(fd, input[cursor..].as_ptr(), input.len() - cursor);
            match errno(result) {
                0 => {
                    let count = result as usize;
                    if count == 0 {
                        return Err(SupervisorError::ResultMissing);
                    }
                    cursor += count;
                }
                EINTR => continue,
                _ => return Err(SupervisorError::ResultMissing),
            }
        }
        Ok(())
    }

    fn writePath(path: *const u8, contents: &[u8]) -> Result<()> {
        let raw_fd = k_open(path, O_WRONLY | O_CLOEXEC, 0);
        if errno(raw_fd) != 0 {
            return Err(SupervisorError::NamespaceMappingFailed);
        }
        let fd = raw_fd as i32;
        let outcome = writeAll(fd, contents);
        closeIgnore(fd);
        outcome
    }

    fn readBootId(failure: SupervisorError) -> Result<BootId> {
        let mut contents = [0u8; 64];
        let read_len = readSmallFile(
            b"/proc/sys/kernel/random/boot_id\0".as_ptr(),
            &mut contents,
            failure,
        )?;
        if read_len != BOOT_ID_LENGTH + 1 || contents[BOOT_ID_LENGTH] != b'\n' {
            return Err(failure);
        }
        match parseBootId(&contents[0..BOOT_ID_LENGTH]) {
            Some(boot_id) => Ok(boot_id),
            None => Err(failure),
        }
    }

    fn readProcStartTime(pid: i32, failure: SupervisorError) -> Result<u64> {
        let path_text = format!("/proc/{}/stat", pid);
        let mut path_buffer = [0u8; 64];
        if path_text.len() >= path_buffer.len() {
            return Err(failure);
        }
        path_buffer[0..path_text.len()].copy_from_slice(path_text.as_bytes());
        let mut contents = [0u8; 4_096];
        let read_len = readSmallFile(path_buffer.as_ptr(), &mut contents, failure)?;
        match parseProcStartTime(pid, &contents[..read_len]) {
            Some(start_time) => Ok(start_time),
            None => Err(failure),
        }
    }

    fn readPidNamespaceInode(pid: i32, failure: SupervisorError) -> Result<u64> {
        let path_text = format!("/proc/{}/ns/pid", pid);
        let mut path_buffer = [0u8; 64];
        if path_text.len() >= path_buffer.len() {
            return Err(failure);
        }
        path_buffer[0..path_text.len()].copy_from_slice(path_text.as_bytes());
        let mut target = [0u8; 64];
        let result = k_readlink(path_buffer.as_ptr(), target.as_mut_ptr(), target.len());
        if errno(result) != 0 {
            return Err(failure);
        }
        let length = result as usize;
        if length == target.len() {
            return Err(failure);
        }
        match parsePidNamespaceInode(&target[0..length]) {
            Some(inode) => Ok(inode),
            None => Err(failure),
        }
    }

    fn readCurrentWorkingDirectory(buffer: &mut [u8; PATH_MAX + 1]) -> Result<Vec<u8>> {
        let result = k_readlink(
            b"/proc/self/cwd\0".as_ptr(),
            buffer[0..PATH_MAX].as_mut_ptr(),
            PATH_MAX,
        );
        if errno(result) != 0 {
            return Err(SupervisorError::InvalidTarget);
        }
        let length = result as usize;
        if length == 0 || length >= PATH_MAX {
            return Err(SupervisorError::InvalidTarget);
        }
        let path = &buffer[0..length];
        if path[0] != b'/' || path.ends_with(b" (deleted)") {
            return Err(SupervisorError::InvalidTarget);
        }
        Ok(nulTerminated(path.to_vec()))
    }

    fn readSmallFile(
        path: *const u8,
        buffer: &mut [u8],
        failure: SupervisorError,
    ) -> Result<usize> {
        let raw_fd = k_open(path, O_RDONLY | O_CLOEXEC, 0);
        if errno(raw_fd) != 0 {
            return Err(failure);
        }
        let fd = raw_fd as i32;

        let mut cursor: usize = 0;
        loop {
            if cursor >= buffer.len() {
                closeIgnore(fd);
                // A full buffer has no proof that its last byte was EOF.
                // Reject rather than parse a potentially truncated proc
                // record.
                return Err(failure);
            }
            let result = k_read(fd, buffer[cursor..].as_mut_ptr(), buffer.len() - cursor);
            match errno(result) {
                0 => {
                    let count = result as usize;
                    if count == 0 {
                        closeIgnore(fd);
                        return Ok(cursor);
                    }
                    cursor += count;
                }
                EINTR => continue,
                _ => {
                    closeIgnore(fd);
                    return Err(failure);
                }
            }
        }
    }

    fn parseProcStartTime(expected_pid: i32, contents: &[u8]) -> Option<u64> {
        let first_space = contents.iter().position(|b| *b == b' ')?;
        let stat_pid = parseDecimalU64(&contents[0..first_space])?;
        if stat_pid != expected_pid as u64 {
            return None;
        }

        // Linux wraps comm in parentheses, and a process may put spaces or
        // ')' into comm. Its closing delimiter is therefore the final ')'
        // in stat.
        let mut closing_parenthesis: Option<usize> = None;
        for (index, character) in contents.iter().enumerate() {
            if *character == b')' {
                closing_parenthesis = Some(index);
            }
        }
        let mut cursor = closing_parenthesis? + 1;
        let mut token_index: usize = 0;
        while cursor < contents.len() {
            while cursor < contents.len() && isAsciiWhitespace(contents[cursor]) {
                cursor += 1;
            }
            if cursor == contents.len() {
                break;
            }
            let token_start = cursor;
            while cursor < contents.len() && !isAsciiWhitespace(contents[cursor]) {
                cursor += 1;
            }
            // Field 3 is the first token after comm, so field 22 is
            // index 19.
            if token_index == 19 {
                return parseDecimalU64(&contents[token_start..cursor]);
            }
            token_index += 1;
        }
        None
    }

    fn parsePidNamespaceInode(target: &[u8]) -> Option<u64> {
        let prefix = b"pid:[";
        if !target.starts_with(prefix)
            || target.len() <= prefix.len() + 1
            || target[target.len() - 1] != b']'
        {
            return None;
        }
        parsePositiveU64(&target[prefix.len()..target.len() - 1])
    }

    fn isAsciiWhitespace(character: u8) -> bool {
        matches!(character, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
    }

    fn makePipe(output: &mut [i32; 2]) -> Result<()> {
        if errno(k_pipe2(output, O_CLOEXEC)) != 0 {
            return Err(SupervisorError::PipeFailed);
        }
        Ok(())
    }

    fn duplicateAtLeast(source: i32, minimum: i32) -> Result<i32> {
        let result = k_fcntl(source, F_DUPFD_CLOEXEC, minimum as usize);
        if errno(result) != 0 {
            return Err(SupervisorError::FileDescriptorIsolationUnavailable);
        }
        Ok(result as i32)
    }

    fn duplicateInto(source: i32, destination: i32) -> Result<()> {
        if errno(k_dup3(source, destination, 0)) != 0 {
            return Err(SupervisorError::FileDescriptorIsolationUnavailable);
        }
        Ok(())
    }

    fn clearCloseOnExec(fd: i32) -> Result<()> {
        let current = k_fcntl(fd, F_GETFD, 0);
        if errno(current) != 0 {
            return Err(SupervisorError::FileDescriptorIsolationUnavailable);
        }
        let flags = current as usize;
        if errno(k_fcntl(fd, F_SETFD, flags & !FD_CLOEXEC)) != 0 {
            return Err(SupervisorError::FileDescriptorIsolationUnavailable);
        }
        Ok(())
    }

    fn standardDescriptorsOpen() -> bool {
        for fd in [0i32, 1, 2] {
            if errno(k_fcntl(fd, F_GETFD, 0)) != 0 {
                return false;
            }
        }
        true
    }

    fn closeRangeExcept(first: i32, last: i32, preserved: i32) -> Result<()> {
        if first > last {
            return Ok(());
        }
        if preserved < first || preserved > last {
            return closeRange(first, last);
        }
        if preserved > first {
            closeRange(first, preserved - 1)?;
        }
        if preserved < last {
            closeRange(preserved + 1, last)?;
        }
        Ok(())
    }

    fn closeRange(first: i32, last: i32) -> Result<()> {
        if errno(k_close_range(first as u32, last as u32, 0)) != 0 {
            return Err(SupervisorError::FileDescriptorIsolationUnavailable);
        }
        Ok(())
    }

    fn closeIgnore(fd: i32) {
        let _ = k_close(fd);
    }

    fn failControlAndExit(fd: i32, nonce: &Nonce, err: SupervisorError) -> ! {
        emitFail(fd, nonce, errorCode(&err));
        closeIgnore(fd);
        k_exit(1);
    }

    fn initExit(result_fd: i32, kind: u8, status: u32) -> ! {
        let result = TargetResult {
            kind,
            reserved: [0; 3],
            wait_status: status,
        };
        let _ = writeAll(result_fd, recordBytes(&result));
        k_exit(1);
    }

    fn nonceHex(nonce: &Nonce) -> [u8; NONCE_HEX_LENGTH] {
        const DIGITS: &[u8] = b"0123456789abcdef";
        let mut rendered = [0u8; NONCE_HEX_LENGTH];
        for (index, byte) in nonce.iter().enumerate() {
            rendered[index * 2] = DIGITS[(byte >> 4) as usize];
            rendered[index * 2 + 1] = DIGITS[(byte & 0x0f) as usize];
        }
        rendered
    }

    fn emitReady(
        fd: i32,
        nonce: &Nonce,
        identity: &LaunchIdentity,
        outer_pgid: i32,
        init_identity: &InitIdentity,
        ready_monotonic_ms: u64,
    ) -> Result<()> {
        let nonce_text = nonceHex(nonce);
        let line = format!(
            "{}READY nonce={} outer_pid={} outer_pgid={} outer_start_time={} boot_id={} init_host_pid={} init_start_time={} init_pid_namespace_inode={} ns_init_pid=1 monotonic_ms={}\n",
            core::str::from_utf8(PROTOCOL_PREFIX).unwrap_or(""),
            core::str::from_utf8(&nonce_text).unwrap_or(""),
            identity.outer_pid,
            outer_pgid,
            identity.outer_start_time,
            core::str::from_utf8(&identity.boot_id).unwrap_or(""),
            init_identity.host_pid,
            init_identity.start_time,
            init_identity.pid_namespace_inode,
            ready_monotonic_ms,
        );
        writeAll(fd, line.as_bytes())
    }

    fn emitRecoveryReady(
        fd: i32,
        nonce: &Nonce,
        recovery_identity: &RecoveryHelperIdentity,
        recovery: &RecoveryConfig,
    ) -> Result<()> {
        let nonce_text = nonceHex(nonce);
        let line = format!(
            "{}RECOVERY_READY nonce={} recovery_pid={} recovery_start_time={} outer_pid={} outer_start_time={} init_host_pid={} init_start_time={} init_pid_namespace_inode={}\n",
            core::str::from_utf8(PROTOCOL_PREFIX).unwrap_or(""),
            core::str::from_utf8(&nonce_text).unwrap_or(""),
            recovery_identity.pid,
            recovery_identity.start_time,
            recovery.outer_pid,
            recovery.outer_start_time,
            recovery.init_host_pid,
            recovery.init_start_time,
            recovery.init_pid_namespace_inode,
        );
        writeAll(fd, line.as_bytes())
    }

    fn emitRecoveryClean(
        fd: i32,
        nonce: &Nonce,
        recovery_identity: &RecoveryHelperIdentity,
        recovery: &RecoveryConfig,
        method: RecoveryMethod,
    ) -> Result<()> {
        let nonce_text = nonceHex(nonce);
        let method_text = match method {
            RecoveryMethod::PidfdSigkill => "pidfd-sigkill",
            RecoveryMethod::PidfdAlreadyExited => "pidfd-already-exited",
        };
        let line = format!(
            "{}RECOVERY_CLEAN nonce={} recovery_pid={} recovery_start_time={} outer_pid={} outer_start_time={} boot_id={} init_host_pid={} init_start_time={} init_pid_namespace_inode={} method={}\n",
            core::str::from_utf8(PROTOCOL_PREFIX).unwrap_or(""),
            core::str::from_utf8(&nonce_text).unwrap_or(""),
            recovery_identity.pid,
            recovery_identity.start_time,
            recovery.outer_pid,
            recovery.outer_start_time,
            core::str::from_utf8(&recovery.boot_id).unwrap_or(""),
            recovery.init_host_pid,
            recovery.init_start_time,
            recovery.init_pid_namespace_inode,
            method_text,
        );
        writeAll(fd, line.as_bytes())
    }

    fn emitClean(fd: i32, nonce: &Nonce, exit_code: u8) -> Result<()> {
        let nonce_text = nonceHex(nonce);
        let line = format!(
            "{}CLEAN nonce={} exit={}\n",
            core::str::from_utf8(PROTOCOL_PREFIX).unwrap_or(""),
            core::str::from_utf8(&nonce_text).unwrap_or(""),
            exit_code,
        );
        writeAll(fd, line.as_bytes())
    }

    fn emitFail(fd: i32, nonce: &Nonce, code: &[u8]) {
        let nonce_text = nonceHex(nonce);
        let line = format!(
            "{}FAIL nonce={} code={}\n",
            core::str::from_utf8(PROTOCOL_PREFIX).unwrap_or(""),
            core::str::from_utf8(&nonce_text).unwrap_or(""),
            core::str::from_utf8(code).unwrap_or(""),
        );
        let _ = writeAll(fd, line.as_bytes());
    }

    fn errorCode(err: &SupervisorError) -> &'static [u8] {
        match err {
            SupervisorError::InvalidArguments => b"invalid_arguments",
            SupervisorError::InvalidTarget => b"invalid_target",
            SupervisorError::InvalidControlSocket => b"invalid_control_socket",
            SupervisorError::ControlConnectFailed => b"control_connect_failed",
            SupervisorError::NamespaceUnavailable => b"namespace_unavailable",
            SupervisorError::NamespaceMappingFailed => b"namespace_mapping_failed",
            SupervisorError::MountIsolationFailed => b"mount_isolation_failed",
            SupervisorError::MountTableInvalid => b"mount_table_invalid",
            SupervisorError::MountAliasUnsafe => b"mount_alias_unsafe",
            SupervisorError::SupervisorHardeningFailed => b"supervisor_hardening_failed",
            SupervisorError::TargetHardeningFailed => b"target_hardening_failed",
            SupervisorError::FileDescriptorIsolationUnavailable => b"fd_isolation_unavailable",
            SupervisorError::PipeFailed => b"pipe_failed",
            SupervisorError::ForkFailed => b"fork_failed",
            SupervisorError::InitNotReady => b"init_not_ready",
            SupervisorError::ParentExited => b"parent_exited",
            SupervisorError::ControlProtocolRejected => b"control_rejected",
            SupervisorError::TargetStartFailed => b"target_start_failed",
            SupervisorError::ResultMissing => b"result_missing",
            SupervisorError::InitExitedAbruptly => b"init_exited_abruptly",
            SupervisorError::WaitFailed => b"wait_failed",
            SupervisorError::CleanupUnproven => b"cleanup_unproven",
            SupervisorError::LaunchIdentityUnavailable => b"launch_identity_unavailable",
            SupervisorError::RecoveryUnsafeTarget => b"recovery_unsafe_target",
            SupervisorError::RecoveryBootIdUnavailable => b"recovery_boot_id_unavailable",
            SupervisorError::RecoveryBootIdMismatch => b"recovery_boot_id_mismatch",
            SupervisorError::RecoverySelfIdentityUnavailable => {
                b"recovery_self_identity_unavailable"
            }
            SupervisorError::RecoveryProcUnavailable => b"recovery_proc_unavailable",
            SupervisorError::RecoveryStartTimeMismatch => b"recovery_start_time_mismatch",
            SupervisorError::RecoveryPidfdUnavailable => b"recovery_pidfd_unavailable",
            SupervisorError::RecoveryOuterNotLive => b"recovery_outer_not_live",
            SupervisorError::RecoveryInitPidfdUnavailable => b"recovery_init_pidfd_unavailable",
            SupervisorError::RecoveryInitProcUnavailable => b"recovery_init_proc_unavailable",
            SupervisorError::RecoveryInitStartTimeMismatch => b"recovery_init_start_time_mismatch",
            SupervisorError::RecoveryInitNotLive => b"recovery_init_not_live",
            SupervisorError::RecoverySignalFailed => b"recovery_signal_failed",
            SupervisorError::RecoveryExitTimeout => b"recovery_exit_timeout",
            SupervisorError::RecoveryWaitFailed => b"recovery_wait_failed",
        }
    }

    pub fn run() -> ! {
        realMain()
    }
}

#[cfg(target_os = "linux")]
fn main() -> ! {
    imp::run()
}
