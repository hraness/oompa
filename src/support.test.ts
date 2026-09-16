import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProductSupportCommand } from "./support";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "product-support-"));
  const env = { HOME: root, XDG_DATA_HOME: root, HRANESS_SUPPORT_EMAIL: "off", HRANESS_SUPPORT_AUDIENCE: "agent" };
  return { root, env, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const record = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

function output() {
  let stdout = "", stderr = "";
  return { write: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } }, read: () => ({ stdout, stderr }) };
}

test("read-only protocol preserves account-free discovery and creates no local state", async () => {
  const f = await fixture();
  try {
    const sink = output();
    expect(await runProductSupportCommand(["protocol", "--json"], sink.write, { env: f.env, stateDirectory: f.root })).toBe(0);
    const text = sink.read();
    expect(text.stderr).toBe("");
    expect(record(text.stdout)).toBeObject();
    expect(text.stdout).toContain('oompa');
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("offer acknowledgement, suite opt-out and quiet results use the shared protocol", async () => {
  const f = await fixture();
  try {
    const options = { env: f.env, stateDirectory: f.root, now: 1000000000000 };
    const call = async (args: string[]) => {
      const sink = output();
      const code = await runProductSupportCommand(args, sink.write, options);
      expect(sink.read().stderr).toBe("");
      expect(code).toBe(0);
      return record(sink.read().stdout);
    };
    const offer = await call(["offer", "--json"]);
    expect(offer.kind).toBe("offer");
    const invitation = offer.invitation as Record<string, unknown>;
    expect(invitation.emailSuggestion).toBeUndefined();
    const id = invitation.id;
    if (typeof id !== "string") throw new Error("Expected an invitation ID");
    expect((await call(["offer", "--json"])).kind).toBe("quiet");
    expect((await call(["shown", id])).kind).toBe("shown");
    expect((await call(["shown", id])).kind).toBe("shown");
    expect((await call(["offer", "--json"])).kind).toBe("quiet");
    expect((await call(["dismiss"])).kind).toBe("dismissed");
    expect((await call(["status", "--json"])).optedOut).toBe(true);
    const off = output();
    expect(await runProductSupportCommand(["offer", "--json"], off.write, { env: { ...f.env, HRANESS_SUPPORT_AUDIENCE: "off" }, stateDirectory: f.root })).toBe(0);
    expect(record(off.read().stdout).kind).toBe("quiet");
  } finally { await f.cleanup(); }
});

test("real standalone support works with piped JSON before product setup", async () => {
  const f = await fixture();
  try {
    const entry = resolve(import.meta.dir, "../src/cli.ts");
    const child = Bun.spawn([process.execPath, entry, "support", "offer", "--json"], {
      cwd: f.root, env: { ...f.env, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(record(stdout).kind).toBe("offer");
    expect((record(stdout).invitation as Record<string, unknown>).emailSuggestion).toBeUndefined();
  } finally { await f.cleanup(); }
});


test("only completed useful typed output observes success, and observer failures are inert", async () => {
  const { main, isUsefulSupportResult } = await import("./cli");
  const { parseCli } = await import("./cli/parser");
  const { createAcceptanceInstallation } = await import("../scripts/live-acceptance-installation");
  const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4d";
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)));
  const installation = createAcceptanceInstallation({ device: "a", documentsDirectory: join(runRoot, "project-a-support"), rootDirectory: join(runRoot, "device-a-support"), expectedHomeDirectory: process.env.HOME ?? "/missing-home", runId, type: "hra-live-acceptance-device", version: 1 });
  try {
    for (const observer of [() => { throw new Error("synthetic output failure"); }, () => Promise.reject(new Error("synthetic rejected observer"))]) {
      const sink = output();
      const code = await main(["session", "list", "--json"], { writeStdout: sink.write.stdout, writeStderr: sink.write.stderr }, {
        installation, interactive: false, onUsefulResult: observer,
        callDaemon: async () => ({ ok: true, version: 1, requestId: crypto.randomUUID(), data: { accountId: null, sessions: [], nextCursor: null } }),
      });
      expect(code).toBe(0);
      expect(record(sink.read().stdout).ok).toBe(true);
      expect(sink.read().stderr).toBe("");
    }
    expect(isUsefulSupportResult(parseCli(["session", "list", "--json"]))).toBe(true);
    expect(isUsefulSupportResult(parseCli(["help", "session"]))).toBe(false);
    expect(isUsefulSupportResult(parseCli(["--version"]))).toBe(false);
    expect(isUsefulSupportResult(parseCli(["doctor", "--offline", "--json"]))).toBe(false);
    let observed = false;
    const sink = output();
    expect(await main(["session", "list", "--json"], { writeStdout: sink.write.stdout, writeStderr: sink.write.stderr }, {
      installation, interactive: false, onUsefulResult: () => { observed = true; },
      callDaemon: async () => ({ ok: false, version: 1, requestId: crypto.randomUUID(), error: { code: "UNAVAILABLE", message: "Synthetic unavailable fixture" } }),
    })).not.toBe(0);
    expect(observed).toBe(false);
  } finally { await rm(runRoot, { recursive: true, force: true }); }
});
