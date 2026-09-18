import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { requireBoundedProcessCleanup, runBoundedProcess, type CompletedBoundedProcessResult } from "../scripts/bounded-process";
import { createSiteCompilerCase, siteCompilerOuterMs, siteCompilerWorkMs } from "./build-site-test-owner";

test("collects a deadline-stalled native compiler before a fresh isolated builder succeeds", async () => {
  const sourceRoot = await realpath(join(import.meta.dir, ".."));
  const root = await mkdtemp(join(tmpdir(), "oompa-site-native-owner-"));
  const readyPath = join(root, "native-compiler-ready.json");
  let expire: (() => void) | undefined;
  let collected: CompletedBoundedProcessResult | undefined;
  const stalled = createSiteCompilerCase(sourceRoot, {
    schedule: (callback, milliseconds) => {
      if (milliseconds === siteCompilerWorkMs) expire = callback;
      const timer = setTimeout(callback, milliseconds);
      return () => { clearTimeout(timer); };
    },
    runProcess: async (request) => {
      const result = await runBoundedProcess({ ...request, arguments: [join(sourceRoot, "site/build-site-test-stall-driver.ts"), readyPath] });
      collected = requireBoundedProcessCleanup(result);
      return result;
    },
  });
  stalled.registerRoot(root);
  const task = stalled.run(async () => { await stalled.buildSite({ check: false, repositoryRoot: root, sourceRoot }); });
  try {
    const readyDeadline = performance.now() + 10_000;
    let pid: number | undefined;
    while (pid === undefined) {
      try { pid = z.object({ pid: z.number().int().min(2) }).strict().parse(JSON.parse(await readFile(readyPath, "utf8")) as unknown).pid; }
      catch (error: unknown) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        if (performance.now() >= readyDeadline) throw new Error("SITE_COMPILER_NATIVE_READY_DEADLINE");
        await Bun.sleep(20);
      }
    }
    expect(expire).toBeDefined();
    if (expire === undefined) throw new Error("Missing case deadline");
    expire();
    await expect(task).rejects.toThrow("SITE_COMPILER_CASE_DEADLINE");
    expect(collected?.cleanup).toBe("proven");
    expect(collected?.exitCode).toBe(130);
    let absence: unknown;
    try { process.kill(pid, 0); } catch (error: unknown) { absence = error; }
    expect(absence).toMatchObject({ code: "ESRCH" });
  } finally { await stalled.close(); }

  const freshRoot = await mkdtemp(join(tmpdir(), "oompa-site-native-fresh-"));
  const fresh = createSiteCompilerCase(sourceRoot);
  fresh.registerRoot(freshRoot);
  try {
    await fresh.run(async () => {
      await mkdir(join(freshRoot, "site"));
      await writeFile(join(freshRoot, "site/favicon.svg"), "fixture:favicon\n");
      await writeFile(join(freshRoot, "site/og.png"), "fixture:og.png\n");
      await writeFile(join(freshRoot, "site/styles.css"), "fixture:styles\n");
      expect(await fresh.buildSite({ check: false, repositoryRoot: freshRoot, sourceRoot })).toEqual([]);
      expect((await readFile(join(freshRoot, "dist/site/index.html"), "utf8"))).toContain("<!doctype html>");
      expect(await fresh.buildSite({ check: true, repositoryRoot: freshRoot, sourceRoot })).toEqual([]);
    });
  } finally { await fresh.close(); }
}, 2 * siteCompilerOuterMs);
