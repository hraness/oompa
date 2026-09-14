//! Fixed synthetic login. No provider, browser, credential or descendant operation.
const std = @import("std");
const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("sys/stat.h");
    @cInclude("time.h");
    @cInclude("errno.h");
    @cInclude("stdlib.h");
});
var signal_fd: c_int = -1;
fn observe(signal: c_int) callconv(.c) void {
    const value: [1]u8 = .{if (signal == c.SIGINT) 'I' else 'T'};
    _ = c.write(signal_fd, &value, 1);
    if (signal == c.SIGINT) c._exit(130);
}
fn pause(ms: i64) void {
    var value = c.struct_timespec{ .tv_sec = @divTrunc(ms, 1000), .tv_nsec = @mod(ms, 1000) * 1_000_000 };
    while (c.nanosleep(&value, &value) != 0) {}
}
fn write(fd: c_int, value: []const u8) bool {
    var offset: usize = 0;
    while (offset < value.len) {
        const count = c.write(fd, value.ptr + offset, value.len - offset);
        if (count < 0 and c.__error().* == c.EINTR) continue;
        if (count <= 0) return false;
        offset += @intCast(count);
    }
    return true;
}
pub fn main(init: std.process.Init.Minimal) void {
    const argv = init.args.vector;
    if (argv.len != 4 or !std.mem.eql(u8, std.mem.span(argv[1]), "auth") or !std.mem.eql(u8, std.mem.span(argv[2]), "login") or !std.mem.eql(u8, std.mem.span(argv[3]), "--claudeai")) c._exit(64);
    const config = c.getenv("CLAUDE_CONFIG_DIR") orelse c._exit(65);
    const mode = std.fs.path.basename(std.mem.span(config));
    const browser = c.getenv("BROWSER");
    if (std.mem.eql(u8, mode, "manual_browser")) {
        if (browser == null or !std.mem.eql(u8, std.mem.span(browser.?), "/usr/bin/true")) c._exit(66);
    } else if (browser != null) c._exit(66);
    if (c.getenv("ANTHROPIC_API_KEY") != null or c.getenv("NODE_OPTIONS") != null) c._exit(66);
    const parent = c.getppid();
    if (c.getsid(0) != c.getsid(parent) or c.getpgrp() != c.getpgid(parent) or c.tcgetpgrp(0) != c.getpgrp()) c._exit(67);
    var first: c.struct_stat = undefined;
    if (c.fstat(0, &first) != 0) c._exit(68);
    for (0..3) |descriptor| {
        const fd: c_int = @intCast(descriptor);
        var current: c.struct_stat = undefined;
        if (c.isatty(fd) != 1 or c.fstat(fd, &current) != 0 or current.st_rdev != first.st_rdev or c.tcgetpgrp(fd) != c.getpgrp()) c._exit(68);
    }
    signal_fd = c.open("signals", c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_APPEND, @as(c_uint, 0o600));
    if (signal_fd < 0) c._exit(69);
    _ = c.signal(c.SIGINT, observe);
    _ = c.signal(c.SIGTERM, observe);
    const marker = c.open("started", c.O_CREAT | c.O_EXCL | c.O_WRONLY, @as(c_uint, 0o600));
    var buffer: [160]u8 = undefined;
    const identity = std.fmt.bufPrint(&buffer, "{d} {d} {d} {d} inherited-owner-tty\n", .{c.getpid(), parent, c.getsid(0), c.getpgrp()}) catch c._exit(69);
    if (marker < 0 or !write(marker, identity)) c._exit(69);
    _ = c.close(marker);
    if (!write(1, "synthetic-login-ready\n")) c._exit(70);
    if (std.mem.eql(u8, mode, "abort") or std.mem.eql(u8, mode, "ctrl_c")) {
        pause(5000);
        c._exit(71);
    }
    pause(300); c._exit(0);
}
