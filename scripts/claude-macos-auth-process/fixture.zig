//! Fixed native credential-free authentication-shaped fixture.
const std = @import("std");
const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("time.h");
    @cInclude("errno.h");
    @cInclude("stdlib.h");
});
fn pause(ms: i64) void {
    var value = c.struct_timespec{ .tv_sec = @divTrunc(ms, 1000), .tv_nsec = @mod(ms, 1000) * 1_000_000 };
    while (c.nanosleep(&value, &value) != 0) {}
}
fn write(fd: c_int, value: []const u8) bool {
    var position: usize = 0;
    while (position < value.len) {
        const count = c.write(fd, value.ptr + position, value.len - position);
        if (count < 0 and c.__error().* == c.EINTR) continue;
        if (count <= 0) return false;
        position += @intCast(count);
    }
    return true;
}
fn ignored(_: c_int) callconv(.c) void {}
pub fn main(init: std.process.Init.Minimal) void {
    const argv = init.args.vector;
    if (argv.len == 2 and std.mem.eql(u8, std.mem.span(argv[1]), "--inspect-hold")) {
        _ = c.signal(c.SIGTERM, ignored);
        const marker_path = c.getenv("OOMPA_INSPECTOR_FIXTURE_MARKER") orelse c._exit(73);
        const marker_fd = c.open(marker_path, c.O_CREAT | c.O_EXCL | c.O_WRONLY, @as(c_uint, 0o600));
        if (marker_fd < 0 or !write(marker_fd, "ready\n")) c._exit(73);
        _ = c.close(marker_fd);
        pause(2000); c._exit(0);
    }
    const config = c.getenv("CLAUDE_CONFIG_DIR") orelse c._exit(64);
    const configSlice = std.mem.span(config);
    const mode = std.fs.path.basename(configSlice);
    if (c.getsid(0) != c.getpid() or c.getpgrp() != c.getpid()) c._exit(65);
    const tty = c.open("/dev/tty", c.O_RDWR | c.O_NOCTTY);
    if (tty >= 0 or c.__error().* != c.ENXIO) c._exit(66);
    var byte: u8 = 0;
    if (c.read(0, &byte, 1) != 0) c._exit(67);
    if (c.getenv("ANTHROPIC_API_KEY") != null or c.getenv("NODE_OPTIONS") != null) c._exit(68);
    const marker = c.open("started", c.O_CREAT | c.O_EXCL | c.O_WRONLY, @as(c_uint, 0o600));
    var identity_buffer: [100]u8 = undefined;
    const identity = std.fmt.bufPrint(&identity_buffer, "{d} {d} {d} detached-no-tty-stdin-eof\n", .{c.getpid(), c.getsid(0), c.getpgrp()}) catch c._exit(69);
    if (marker < 0 or !write(marker, identity)) c._exit(69);
    _ = c.close(marker);
    if (std.mem.eql(u8, mode, "immediate")) c._exit(0);
    _ = c.signal(c.SIGTERM, ignored);
    if (std.mem.eql(u8, mode, "timeout") or std.mem.eql(u8, mode, "cancel")) {
        pause(1500); c._exit(0);
    }
    // Keep the actual native process available for the independent parent
    // identity/session/terminal inspection before emitting its bounded result.
    pause(300);
    if (std.mem.eql(u8, mode, "late")) {
        const child = c.fork();
        if (child == 0) {
            _ = c.setsid();
            const pid_fd = c.open("descendant", c.O_CREAT | c.O_EXCL | c.O_WRONLY, @as(c_uint, 0o600));
            const pid = std.fmt.bufPrint(&identity_buffer, "{d}\n", .{c.getpid()}) catch c._exit(72);
            if (pid_fd < 0 or !write(pid_fd, pid)) c._exit(72);
            _ = c.close(pid_fd);
            pause(900);
            _ = write(1, "late-output\n"); c._exit(0);
        }
        if (child < 1) c._exit(72);
        c._exit(0);
    }
    if (std.mem.eql(u8, mode, "overflow")) {
        const bytes = [_]u8{'x'} ** 32768;
        _ = write(1, &bytes); c._exit(0);
    }
    if (argv.len == 2 and std.mem.eql(u8, std.mem.span(argv[1]), "--version")) {
        _ = write(1, "2.1.260 (Claude Code)\n"); c._exit(0);
    }
    if (argv.len < 3 or !std.mem.eql(u8, std.mem.span(argv[1]), "auth")) c._exit(70);
    if (argv.len == 4 and std.mem.eql(u8, std.mem.span(argv[2]), "login") and std.mem.eql(u8, std.mem.span(argv[3]), "--help")) {
        _ = write(1, "Usage: claude auth login [options]\n\nOptions:\n  --claudeai  Log in with a Claude subscription\n  -h, --help  Display help\n"); c._exit(0);
    }
    if (std.mem.eql(u8, std.mem.span(argv[2]), "logout")) {
        if (argv.len == 4 and std.mem.eql(u8, std.mem.span(argv[3]), "--help")) {
            _ = write(1, "Usage: claude auth logout [options]\n\nOptions:\n  -h, --help  Display help\n");
        } else if (argv.len != 3) c._exit(70);
        c._exit(0);
    }
    if (argv.len != 4 or !std.mem.eql(u8, std.mem.span(argv[2]), "status") or !std.mem.eql(u8, std.mem.span(argv[3]), "--json")) c._exit(70);
    var buffer: [8192]u8 = undefined;
    const value = std.fmt.bufPrint(&buffer, "{{\"loggedIn\":false,\"authMethod\":\"none\",\"apiProvider\":\"firstParty\",\"analyticsDisabled\":false,\"projectsDirectory\":\"{s}/projects\"}}\n", .{configSlice}) catch c._exit(71);
    _ = write(1, value); c._exit(1);
}
