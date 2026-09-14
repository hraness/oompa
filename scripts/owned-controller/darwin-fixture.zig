//! Credential-free finite native fixture; never accepts a provider command.
const std = @import("std");
const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("time.h");
});

fn ignoreSignal(_: c_int) callconv(.c) void {}

fn marker(path: [*:0]const u8, value: []const u8) bool {
    const fd = c.open(path, c.O_WRONLY | c.O_CREAT | c.O_EXCL, @as(c_uint, 0o600));
    if (fd < 0) return false;
    defer _ = c.close(fd);
    const count = c.write(fd, value.ptr, value.len);
    return count >= 0 and @as(usize, @intCast(count)) == value.len;
}

fn pause(ms: i64) void {
    var remaining = c.struct_timespec{ .tv_sec = @divTrunc(ms, 1000), .tv_nsec = @mod(ms, 1000) * 1_000_000 };
    while (c.nanosleep(&remaining, &remaining) != 0) {}
}

pub fn main(init: std.process.Init.Minimal) void {
    const args = init.args.vector;
    if (args.len < 3) c._exit(64);
    const mode = std.mem.span(args[1]);
    for (args[2..]) |arg| {
        const path = std.mem.span(arg);
        if (path.len == 0 or path[0] != '/' or path.len > 4096) c._exit(64);
    }
    if (std.mem.eql(u8, mode, "ignore-term")) _ = c.signal(c.SIGTERM, ignoreSignal);
    if (!marker(args[2], "started\n")) c._exit(65);
    if (std.mem.eql(u8, mode, "exit")) c._exit(7);
    if (std.mem.eql(u8, mode, "hold")) {
        pause(2000);
        c._exit(0);
    }
    if (std.mem.eql(u8, mode, "ignore-term")) {
        pause(2000);
        c._exit(0);
    }
    if (std.mem.eql(u8, mode, "self-expire")) {
        pause(500);
        c._exit(0);
    }
    if (!std.mem.eql(u8, mode, "escape") or args.len != 5) c._exit(64);
    var ready: [2]c_int = undefined;
    if (c.pipe(&ready) != 0) c._exit(66);
    const child = c.fork();
    if (child == 0) {
        _ = c.close(ready[0]);
        if (c.setsid() < 0) c._exit(67);
        var pid_buffer: [32]u8 = undefined;
        const pid = std.fmt.bufPrint(&pid_buffer, "{d}\n", .{c.getpid()}) catch unreachable;
        if (!marker(args[3], pid)) c._exit(68);
        if (c.write(ready[1], "R", 1) != 1) c._exit(69);
        _ = c.close(ready[1]);
        pause(500);
        if (!marker(args[4], "finished\n")) c._exit(70);
        c._exit(0);
    }
    _ = c.close(ready[1]);
    if (child < 1) c._exit(71);
    var byte: u8 = 0;
    if (c.read(ready[0], &byte, 1) != 1 or byte != 'R') c._exit(72);
    _ = c.close(ready[0]);
    // Deliberately leave the finite descendant to prove that direct-child
    // release is not a descendant-containment promise.
    c._exit(0);
}
