//! Fixed credential-free target for the stdio-v1 transport experiment.
const std = @import("std");
const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("time.h");
    @cInclude("errno.h");
});

fn writeAll(fd: c_int, bytes: []const u8) bool {
    var position: usize = 0;
    while (position < bytes.len) {
        const written = c.write(fd, bytes.ptr + position, bytes.len - position);
        if (written < 0 and c.__error().* == c.EINTR) continue;
        if (written <= 0) return false;
        position += @intCast(written);
    }
    return true;
}

fn marker(path: [*:0]const u8, bytes: []const u8) bool {
    const fd = c.open(path, c.O_WRONLY | c.O_CREAT | c.O_EXCL, @as(c_uint, 0o600));
    if (fd < 0) return false;
    defer _ = c.close(fd);
    return writeAll(fd, bytes);
}

fn pause(ms: i64) void {
    var remaining = c.struct_timespec{ .tv_sec = @divTrunc(ms, 1000), .tv_nsec = @mod(ms, 1000) * 1_000_000 };
    while (c.nanosleep(&remaining, &remaining) != 0) {}
}

fn ignoreSignal(_: c_int) callconv(.c) void {}

pub fn main(init: std.process.Init.Minimal) void {
    const args = init.args.vector;
    if (args.len != 3 and args.len != 5) c._exit(64);
    const mode = std.mem.span(args[1]);
    for (args[2..]) |argument| {
        const path = std.mem.span(argument);
        if (path.len == 0 or path.len > 4096 or path[0] != '/') c._exit(64);
    }
    // In particular, the private GO gate and caller's extra descriptor must
    // not survive exec. Only this fixture's three target streams are inherited.
    for (3..32) |index| {
        if (c.fcntl(@as(c_int, @intCast(index)), c.F_GETFD) != -1 or c.__error().* != c.EBADF) c._exit(65);
    }
    if (std.mem.eql(u8, mode, "block-input")) _ = c.signal(c.SIGTERM, ignoreSignal);
    if (!marker(args[2], "started\n")) c._exit(66);
    if (std.mem.eql(u8, mode, "echo")) {
        if (!writeAll(1, "stdout:\x00\xff\n") or !writeAll(2, "stderr:\x00\x80\n")) c._exit(67);
        var buffer: [257]u8 = undefined;
        var total: usize = 0;
        while (true) {
            const count = c.read(0, &buffer, buffer.len);
            if (count < 0 and c.__error().* == c.EINTR) continue;
            if (count < 0) c._exit(68);
            if (count == 0) break;
            total += @intCast(count);
            if (total > 1024 * 1024 or !writeAll(1, buffer[0..@intCast(count)])) c._exit(69);
        }
        if (!writeAll(2, "input-eof\n")) c._exit(70);
        c._exit(7);
    }
    if (std.mem.eql(u8, mode, "flood-stdout")) {
        const buffer = [_]u8{'x'} ** 65536;
        for (0..16) |_| if (!writeAll(1, &buffer)) c._exit(71);
        c._exit(0);
    }
    if (std.mem.eql(u8, mode, "block-input") or std.mem.eql(u8, mode, "self-expire")) {
        pause(500);
        c._exit(0);
    }
    if (std.mem.eql(u8, mode, "close-output")) {
        _ = c.close(1);
        _ = c.close(2);
        pause(100);
        c._exit(7);
    }
    if ((!std.mem.eql(u8, mode, "linger-output") and !std.mem.eql(u8, mode, "late-output")) or args.len != 5) c._exit(64);
    var ready: [2]c_int = undefined;
    if (c.pipe(&ready) != 0) c._exit(72);
    const child = c.fork();
    if (child == 0) {
        _ = c.close(ready[0]);
        _ = c.close(0);
        if (c.setsid() < 0) c._exit(73);
        var buffer: [32]u8 = undefined;
        const pid = std.fmt.bufPrint(&buffer, "{d}\n", .{c.getpid()}) catch unreachable;
        if (!marker(args[3], pid) or !writeAll(ready[1], "R")) c._exit(74);
        _ = c.close(ready[1]);
        pause(if (std.mem.eql(u8, mode, "late-output")) 900 else 350);
        if (!writeAll(1, "tail-out\n") or !writeAll(2, "tail-err\n") or !marker(args[4], "finished\n")) c._exit(75);
        c._exit(0);
    }
    _ = c.close(ready[1]);
    if (child < 1) c._exit(76);
    var byte: u8 = 0;
    if (c.read(ready[0], &byte, 1) != 1 or byte != 'R') c._exit(77);
    _ = c.close(ready[0]);
    c._exit(0);
}
