//! Scripts-only direct-child ownership fixture. This is not a sandbox or a
//! descendant-container, and is not connected to the production daemon.
//! stdin is OOC1 control; stdout is OOC1 status. The target inherits neither.
//! Explicit stdio-v1 transport receives target stdin/out/err on separate FDs 3/4/5.
const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("poll.h");
    @cInclude("time.h");
    @cInclude("errno.h");
    @cInclude("dirent.h");
    @cInclude("sys/wait.h");
    @cInclude("sys/stat.h");
});

comptime {
    if (builtin.os.tag != .macos) @compileError("owned-controller Darwin helper requires macOS");
}

var interrupted: c.sig_atomic_t = 0;
var external_interrupt: c.sig_atomic_t = 0;
fn ignoreSignal(_: c_int) callconv(.c) void {}

fn setSignal(signal: c_int, handler: c.sig_t) bool {
    const previous = c.signal(signal, handler);
    return if (previous) |value| @intFromPtr(value) != std.math.maxInt(usize) else true;
}

fn onSignal(_: c_int) callconv(.c) void {
    @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
    @atomicStore(c.sig_atomic_t, &external_interrupt, 1, .seq_cst);
}

fn nowMs() ?i64 {
    var ts: c.struct_timespec = undefined;
    if (c.clock_gettime(c.CLOCK_MONOTONIC, &ts) != 0) return null;
    return ts.tv_sec * 1000 + @divTrunc(ts.tv_nsec, 1_000_000);
}

fn writeAll(fd: c_int, value: []const u8) bool {
    // Status is nonblocking and each frame fits within 160 bytes. A short,
    // interrupted, or full-pipe write fails closed instead of extending time.
    const count = c.write(fd, value.ptr, value.len);
    return count >= 0 and @as(usize, @intCast(count)) == value.len;
}

fn number(value: []const u8, maximum: u32) ?u32 {
    if (value.len == 0 or value[0] == '0') return null;
    for (value) |byte| if (byte < '0' or byte > '9') return null;
    const result = std.fmt.parseInt(u32, value, 10) catch return null;
    return if (result <= maximum) result else null;
}

fn nonceValid(value: []const u8) bool {
    if (value.len != 32) return false;
    for (value) |byte| if (!((byte >= '0' and byte <= '9') or (byte >= 'a' and byte <= 'f'))) return false;
    return true;
}

const Config = struct {
    nonce: []const u8,
    generation: u32,
    startup_ms: u32,
    run_ms: u32,
    shutdown_ms: u32,
    target: [*:0]const u8,
    target_argv: [*:null]const ?[*:0]const u8,
    transport: bool,
};

fn closeInherited() bool {
    // Darwin has no closefrom in the pinned libc surface. Enumerate the
    // single-threaded child's own descriptors before closing any of them;
    // unlike an RLIMIT scan this also covers descriptors above a lowered limit.
    const directory = c.opendir("/dev/fd") orelse return false;
    const listing_fd = c.dirfd(directory);
    if (listing_fd < 0) {
        _ = c.closedir(directory);
        return false;
    }
    var descriptors: [4096]c_int = undefined;
    var length: usize = 0;
    var entries: usize = 0;
    while (true) {
        c.__error().* = 0;
        const entry = c.readdir(directory) orelse {
            if (c.__error().* != 0) {
                _ = c.closedir(directory);
                return false;
            }
            break;
        };
        entries += 1;
        if (entries > 4098) {
            _ = c.closedir(directory);
            return false;
        }
        const name_buffer: []const u8 = entry[0].d_name[0..];
        const name = name_buffer[0..std.mem.indexOfScalar(u8, name_buffer, 0).?];
        if (std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..") or std.mem.eql(u8, name, "0")) continue;
        const fd = number(name, 2147483647) orelse {
            _ = c.closedir(directory);
            return false;
        };
        if (fd < 4 or fd == listing_fd) continue;
        if (length == descriptors.len) {
            _ = c.closedir(directory);
            return false;
        }
        descriptors[length] = @intCast(fd);
        length += 1;
    }
    if (c.closedir(directory) != 0) return false;
    for (descriptors[0..length]) |fd| if (c.close(fd) != 0) return false;
    return true;
}

fn parseConfig(args: []const [*:0]const u8) ?Config {
    const transport = args.len > 1 and std.mem.eql(u8, std.mem.span(args[1]), "--transport=stdio-v1");
    const offset: usize = if (transport) 1 else 0;
    if (args.len < 13 + offset or args.len > 77 + offset) return null;
    const names = [_][]const u8{ "--nonce", "--generation", "--startup-ms", "--run-ms", "--shutdown-ms" };
    for (names, 0..) |name, index| {
        if (!std.mem.eql(u8, std.mem.span(args[index * 2 + 1 + offset]), name)) return null;
    }
    if (!std.mem.eql(u8, std.mem.span(args[11 + offset]), "--")) return null;
    const nonce = std.mem.span(args[2 + offset]);
    if (!nonceValid(nonce)) return null;
    const target = std.mem.span(args[12 + offset]);
    if (target.len == 0 or target.len > 4096 or target[0] != '/') return null;
    for (args[12 + offset ..]) |argument| if (std.mem.span(argument).len > 16384) return null;
    return .{
        .nonce = nonce,
        .generation = number(std.mem.span(args[4 + offset]), 2147483647) orelse return null,
        .startup_ms = number(std.mem.span(args[6 + offset]), 30000) orelse return null,
        .run_ms = number(std.mem.span(args[8 + offset]), 86400000) orelse return null,
        .shutdown_ms = number(std.mem.span(args[10 + offset]), 30000) orelse return null,
        .target = args[12 + offset],
        .target_argv = @ptrCast(args.ptr + 12 + offset),
        .transport = transport,
    };
}

fn validateTransport() bool {
    var identities: [6]c.struct_stat = undefined;
    for (0..6) |index| {
        const fd: c_int = @intCast(index);
        if (c.fstat(fd, &identities[index]) != 0) return false;
        if (index < 3) continue;
        const kind = identities[index].st_mode & c.S_IFMT;
        if (kind != c.S_IFIFO and kind != c.S_IFSOCK) return false;
        // Reused controller or target endpoints would merge channel authority.
        for (identities[0..index]) |previous| {
            if (previous.st_dev == identities[index].st_dev and previous.st_ino == identities[index].st_ino) return false;
        }
        const flags = c.fcntl(fd, c.F_GETFL);
        if (flags < 0 or (index == 3 and (flags & c.O_ACCMODE) == c.O_WRONLY) or
            (index != 3 and (flags & c.O_ACCMODE) == c.O_RDONLY)) return false;
        if (c.fcntl(fd, c.F_SETFL, @as(c_int, flags & ~@as(c_int, c.O_NONBLOCK))) < 0) return false;
    }
    return true;
}

fn childMain(config: Config, gate_read: c_int, gate_write: c_int) noreturn {
    _ = c.close(gate_write);
    // Copy transport endpoints before fd 3 becomes the private execution gate.
    if (config.transport) {
        for (0..3) |index| if (c.dup2(@intCast(index + 3), @intCast(index)) < 0) c._exit(125);
    }
    // Preserve only one gate descriptor. No inherited controller channel or
    // incidental parent descriptor can survive into the target.
    if (gate_read != 3) {
        if (c.dup2(gate_read, 3) != 3) c._exit(125);
        _ = c.close(gate_read);
    }
    if (!closeInherited()) c._exit(125);
    if (!config.transport) {
        const null_fd = c.open("/dev/null", c.O_RDWR);
        if (null_fd < 0) c._exit(125);
        for (0..3) |index| if (c.dup2(null_fd, @intCast(index)) < 0) c._exit(125);
        if (null_fd > 3) _ = c.close(null_fd);
    }
    if (!setSignal(c.SIGTERM, null) or !setSignal(c.SIGINT, null) or !setSignal(c.SIGPIPE, null)) c._exit(125);
    var byte: u8 = 0;
    const count = c.read(3, &byte, 1);
    _ = c.close(3);
    if (count != 1 or byte != 'G') c._exit(125);
    _ = c.execv(config.target, @ptrCast(config.target_argv));
    c._exit(126);
}

const Phase = enum { awaiting_go, running, stopping, killing };

fn supervise(config: Config) u8 {
    var gate: [2]c_int = undefined;
    if (c.pipe(&gate) != 0) return 70;
    if (c.fcntl(gate[0], c.F_SETFD, @as(c_int, c.FD_CLOEXEC)) < 0 or
        c.fcntl(gate[1], c.F_SETFD, @as(c_int, c.FD_CLOEXEC)) < 0)
    {
        _ = c.close(gate[0]);
        _ = c.close(gate[1]);
        return 70;
    }
    const child_pid = c.fork();
    if (child_pid == 0) childMain(config, gate[0], gate[1]);
    // Only the direct child owns target endpoints; the helper must not hold
    // provider EOF open after that child closes them or exits.
    if (config.transport) {
        for (3..6) |index| { _ = c.close(@intCast(index)); }
    }
    _ = c.close(gate[0]);
    if (child_pid < 1) {
        _ = c.close(gate[1]);
        return 70;
    }
    var gate_open = true;
    defer if (gate_open) {
        _ = c.close(gate[1]);
    };
    var phase: Phase = .awaiting_go;
    var released = false;
    var helper_exit_code: u8 = 0;
    var deadline = (nowMs() orelse 0) + config.startup_ms;
    var shutdown_deadline: i64 = 0;
    var output: [160]u8 = undefined;
    const ready = std.fmt.bufPrint(&output, "OOC1 READY {s} {d} {d}\n", .{ config.nonce, config.generation, child_pid }) catch unreachable;
    if (!writeAll(1, ready)) {
        @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
        helper_exit_code = 70;
    }
    var frame: [160]u8 = undefined;
    var frame_length: usize = 0;
    var input_open = true;
    var command_count: usize = 0;
    var joined_status: c_int = 0;
    while (true) {
        const joined = c.waitpid(child_pid, &joined_status, c.WNOHANG);
        if (joined == child_pid) break;
        if (joined < 0 and c.__error().* != c.EINTR) return 70;
        const now = nowMs() orelse {
            _ = c.kill(child_pid, c.SIGKILL);
            return 70;
        };
        if (@atomicLoad(c.sig_atomic_t, &external_interrupt, .seq_cst) != 0 and helper_exit_code == 0) helper_exit_code = 130;
        if (@atomicLoad(c.sig_atomic_t, &interrupted, .seq_cst) != 0 or now >= deadline) {
            switch (phase) {
                .awaiting_go, .running => {
                    if (now >= deadline and helper_exit_code == 0) helper_exit_code = 124;
                    _ = c.kill(child_pid, c.SIGTERM);
                    if (gate_open) {
                        _ = c.close(gate[1]);
                        gate_open = false;
                    }
                    phase = .stopping;
                    input_open = false;
                    shutdown_deadline = now + config.shutdown_ms;
                    deadline = now + @divTrunc(config.shutdown_ms, 2);
                    @atomicStore(c.sig_atomic_t, &interrupted, 0, .seq_cst);
                },
                .stopping => {
                    _ = c.kill(child_pid, c.SIGKILL);
                    phase = .killing;
                    deadline = shutdown_deadline;
                    @atomicStore(c.sig_atomic_t, &interrupted, 0, .seq_cst);
                },
                .killing => return 70, // No invented wait or terminal proof.
            }
        }
        var descriptor = c.struct_pollfd{ .fd = if (input_open) 0 else -1, .events = c.POLLIN, .revents = 0 };
        const polled = c.poll(&descriptor, 1, 10);
        if (polled < 0 and c.__error().* != c.EINTR) {
            @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
            helper_exit_code = 70;
        }
        if (!input_open or polled <= 0) continue;
        if ((descriptor.revents & (c.POLLIN | c.POLLHUP | c.POLLERR | c.POLLNVAL)) == 0) continue;
        var input: [256]u8 = undefined;
        const count = c.read(0, &input, input.len);
        if (count < 0 and (c.__error().* == c.EINTR or c.__error().* == c.EAGAIN)) continue;
        if (count <= 0) {
            @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
            helper_exit_code = 70;
            input_open = false;
            continue;
        }
        for (input[0..@intCast(count)], 0..) |byte, index| {
            if (frame_length >= frame.len or byte > 126 or (byte < 32 and byte != '\n')) {
                @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
                helper_exit_code = 64;
                input_open = false;
                break;
            }
            frame[frame_length] = byte;
            frame_length += 1;
            if (byte != '\n') continue;
            command_count += 1;
            var expected: [160]u8 = undefined;
            const go = std.fmt.bufPrint(&expected, "OOC1 GO {s} {d}\n", .{ config.nonce, config.generation }) catch unreachable;
            const is_go = std.mem.eql(u8, frame[0..frame_length], go);
            const term = std.fmt.bufPrint(&expected, "OOC1 TERM {s} {d}\n", .{ config.nonce, config.generation }) catch unreachable;
            const is_term = std.mem.eql(u8, frame[0..frame_length], term);
            frame_length = 0;
            if (command_count > 2 or (!is_go and !is_term) or (is_go and phase != .awaiting_go)) {
                @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
                helper_exit_code = 64;
                input_open = false;
                break;
            }
            if (is_term) {
                // Admission ends here. Any suffix already received in this
                // read is an invalid extra command or partial frame.
                if (index + 1 != @as(usize, @intCast(count))) helper_exit_code = 64;
                @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
                input_open = false;
                break;
            }
            if (!writeAll(gate[1], "G")) {
                @atomicStore(c.sig_atomic_t, &interrupted, 1, .seq_cst);
                helper_exit_code = 70;
                input_open = false;
                break;
            }
            _ = c.close(gate[1]);
            gate_open = false;
            released = true;
            phase = .running;
            deadline = now + config.run_ms;
        }
    }
    const signal = joined_status & 0x7f;
    const exit_status = (joined_status >> 8) & 0xff;
    if (signal == 0x7f) return 70;
    const terminal = std.fmt.bufPrint(&output, "OOC1 TERMINAL {s} {d} {d} {d} {s} {d}\n", .{
        config.nonce, config.generation, child_pid, @as(u8, if (released) 1 else 0),
        if (signal == 0) "exit" else "signal", if (signal == 0) exit_status else signal,
    }) catch unreachable;
    return if (writeAll(1, terminal)) helper_exit_code else 70;
}

pub fn main(init: std.process.Init.Minimal) void {
    const config = parseConfig(init.args.vector) orelse c._exit(64);
    if (config.transport and !validateTransport()) c._exit(70);
    if (!setSignal(c.SIGPIPE, ignoreSignal) or !setSignal(c.SIGTERM, onSignal) or !setSignal(c.SIGINT, onSignal)) c._exit(70);
    for (0..2) |index| {
        const fd: c_int = @intCast(index);
        const flags = c.fcntl(fd, c.F_GETFL);
        if (flags < 0 or c.fcntl(fd, c.F_SETFL, @as(c_int, flags | c.O_NONBLOCK)) < 0) c._exit(70);
    }
    c._exit(supervise(config));
}
