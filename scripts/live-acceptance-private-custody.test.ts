import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  AtomicPrivateJsonReceipt,
  observePrivateDirectory,
  privatePathsOverlap,
  type AtomicPrivateJsonPolicy,
} from "./live-acceptance-private-custody";
import { createAcceptanceInstallation } from "./live-acceptance-installation";

const receiptSchema = z.object({
  path: z.string(),
  runId: z.string().min(1),
  state: z.object({ step: z.number().int().nonnegative() }).strict(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

async function fixture(run: (input: Readonly<{
  directory: string;
  initial: Receipt;
  policy: AtomicPrivateJsonPolicy<Receipt>;
}>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "oompa-receipt-custody-"));
  await chmod(directory, 0o700);
  const initial: Receipt = {
    path: join(directory, "receipt.json"),
    runId: "synthetic-custody-run",
    state: { step: 0 },
  };
  const policy: AtomicPrivateJsonPolicy<Receipt> = {
    assertRuntime: async () => undefined,
    createdIdentityMatches: (current, next) => current.path === next.path
      && current.runId === next.runId,
    invalid: () => new Error("synthetic_receipt_refused"),
    maximumBytes: 1_024,
    parse: (value) => receiptSchema.parse(value),
    path: (value) => value.path,
  };
  try {
    await run({ directory, initial, policy });
  } finally {
    await rm(directory, { force: false, recursive: true });
  }
}

describe("private acceptance receipt custody", () => {
  test("dotted descendant names still overlap their parent in both directions", () => {
    const parent = join(tmpdir(), "oompa-custody-parent");
    for (const child of [join(parent, "child"), join(parent, "..child"), join(parent, "..child", "nested")]) {
      expect(privatePathsOverlap(parent, child)).toBe(true);
      expect(privatePathsOverlap(child, parent)).toBe(true);
    }
    expect(privatePathsOverlap(parent, parent)).toBe(true);
    expect(privatePathsOverlap(parent, `${parent}-sibling`)).toBe(false);
    expect(privatePathsOverlap(parent, join(parent, "..", "sibling"))).toBe(false);
  });

  test("installation admission refuses a run hidden below a dotted home descendant", () => {
    const expectedHomeDirectory = join(tmpdir(), "oompa-custody-home");
    const runId = "00000000-0000-4000-8000-000000000001";
    const root = join(expectedHomeDirectory, "..acceptance", `hra-live-acceptance-${runId}-test`);
    expect(() => createAcceptanceInstallation({
      version: 1, type: "hra-live-acceptance-device", device: "a", runId,
      rootDirectory: join(root, "device-a-test"),
      documentsDirectory: join(root, "project-a-test"), expectedHomeDirectory,
    })).toThrow("Acceptance state must not overlap");
  });

  test("round-trips exact state through atomic update, reopen, and removal", async () => {
    await fixture(async ({ initial, policy }) => {
      const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
      expect(receipt.assertVerifiedIdentity()).toBeUndefined();
      await receipt.update((current) => ({ ...current, state: { step: 1 } }));
      expect(receipt.assertVerifiedIdentity()).toBeUndefined();
      const reopened = await AtomicPrivateJsonReceipt.open(initial, policy);
      expect(reopened.assertVerifiedIdentity()).toBeUndefined();
      expect(reopened.value.state.step).toBe(1);
      await reopened.remove();
      expect(() => reopened.assertVerifiedIdentity()).toThrow("synthetic_receipt_refused");
      await expect(readFile(initial.path)).rejects.toThrow();
    });
  });

  test.each(["same_bytes_new_inode", "same_inode_changed_bytes", "same_value_changed_encoding"] as const)(
    "synchronous verification never adopts changed receipt identity or bytes: %s", async (substitution) => {
      await fixture(async ({ directory, initial, policy }) => {
        const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
        const original = await readFile(initial.path);
        if (substitution === "same_bytes_new_inode") await rename(initial.path, join(directory, "retained-original.json"));
        const replacement = substitution === "same_bytes_new_inode" ? original
          : substitution === "same_value_changed_encoding" ? Buffer.concat([original, Buffer.from("\n")])
          : Buffer.from(JSON.stringify({ ...initial, state: { step: 8 } }));
        await writeFile(initial.path, replacement, { mode: 0o600 });
        expect(() => receipt.assertVerifiedIdentity()).toThrow("synthetic_receipt_refused");
        expect(receipt.value).toEqual(initial);
        expect(await readFile(initial.path)).toEqual(replacement);
      });
    },
  );

  test("synchronous verification refuses private-file substitutions and excessive contents", async () => {
    for (const substitution of ["symlink", "hardlink", "mode", "oversize"] as const) {
      await fixture(async ({ directory, initial, policy }) => {
        const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
        if (substitution === "symlink") {
          const original = join(directory, "retained-original.json"); await rename(initial.path, original); await symlink(original, initial.path);
        } else if (substitution === "hardlink") await link(initial.path, join(directory, "other-link.json"));
        else if (substitution === "mode") await chmod(initial.path, 0o644);
        else await writeFile(initial.path, " ".repeat(policy.maximumBytes + 1), { mode: 0o600 });
        expect(() => receipt.assertVerifiedIdentity()).toThrow("synthetic_receipt_refused");
      });
    }
  });

  test("inspection cannot mutate the in-memory authority or next update", async () => {
    await fixture(async ({ initial, policy }) => {
      const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
      const observed = receipt.value;
      observed.state.step = 99;
      expect(receipt.value.state.step).toBe(0);
      const updated = await receipt.update((current) => ({
        ...current, state: { step: current.state.step + 1 },
      }));
      updated.state.step = 88;
      expect(receipt.value.state.step).toBe(1);
    });
  });

  test("a mutating transform cannot redirect the receipt or retain its mutation", async () => {
    await fixture(async ({ directory, initial, policy }) => {
      const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
      await expect(receipt.update((current) => {
        current.path = join(directory, "redirected.json");
        current.state.step = 99;
        return current;
      })).rejects.toThrow("synthetic_receipt_refused");
      expect(receipt.value).toEqual(initial);
      expect(JSON.parse(await readFile(initial.path, "utf8"))).toEqual(initial);
    });
  });

  test("in-place receipt replacement is not overwritten or deleted", async () => {
    await fixture(async ({ initial, policy }) => {
      const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
      const replacement = { ...initial, state: { step: 8 } };
      await writeFile(initial.path, JSON.stringify(replacement), { mode: 0o600 });
      await expect(receipt.update((current) => ({
        ...current, state: { step: 1 },
      }))).rejects.toThrow("synthetic_receipt_refused");
      await expect(receipt.remove()).rejects.toThrow("synthetic_receipt_refused");
      expect(JSON.parse(await readFile(initial.path, "utf8"))).toEqual(replacement);
    });
  });

  test("a replaced parent cannot retain authority by moving back the exact receipt inode", async () => {
    await fixture(async ({ directory, initial, policy }) => {
      const parent = join(directory, "parent");
      const moved = join(directory, "moved-parent");
      await mkdir(parent, { mode: 0o700 });
      const nested = { ...initial, path: join(parent, "receipt.json") };
      const receipt = await AtomicPrivateJsonReceipt.create(nested, policy);
      await rename(parent, moved);
      await mkdir(parent, { mode: 0o700 });
      await rename(join(moved, "receipt.json"), nested.path);
      expect(() => receipt.assertVerifiedIdentity()).toThrow("synthetic_receipt_refused");
      await expect(receipt.update((current) => ({
        ...current, state: { step: 1 },
      }))).rejects.toThrow("synthetic_receipt_refused");
      await expect(receipt.remove()).rejects.toThrow("synthetic_receipt_refused");
      expect(JSON.parse(await readFile(nested.path, "utf8"))).toEqual(nested);
    });
  });

  test("concurrent update and removal refuse without deleting an admitted update", async () => {
    await fixture(async ({ initial, policy }) => {
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let entered = (): void => undefined;
      const entry = new Promise<void>((resolve) => { entered = resolve; });
      let blocked = false;
      const receipt = await AtomicPrivateJsonReceipt.create(initial, {
        ...policy,
        assertRuntime: async () => {
          if (blocked) { entered(); await released; }
        },
      });
      blocked = true;
      const first = receipt.update((current) => ({ ...current, state: { step: 1 } }));
      void first.catch(() => undefined);
      await entry;
      try {
        expect(() => receipt.assertVerifiedIdentity()).toThrow("synthetic_receipt_refused");
        await expect(receipt.remove()).rejects.toThrow("synthetic_receipt_refused");
      } finally {
        release();
      }
      await first;
      expect(receipt.assertVerifiedIdentity()).toBeUndefined();
      expect(JSON.parse(await readFile(initial.path, "utf8"))).toEqual({
        ...initial, state: { step: 1 },
      });
    });
  });

  test.each(["same_bytes_new_inode", "same_inode_changed_bytes", "changed_during_parse"] as const)(
    "a substituted update temporary is neither adopted nor deleted: %s", async (substitution) => {
    await fixture(async ({ directory, initial, policy }) => {
      let substitute = false;
      let substitutedPath: string | undefined;
      const replacement = { ...initial, state: { step: substitution === "same_bytes_new_inode" ? 1 : 77 } };
      const receipt = await AtomicPrivateJsonReceipt.create(initial, {
        ...policy,
        parse: (value) => {
          const parsed = policy.parse(value);
          if (substitute && substitutedPath === undefined
            && (substitution !== "changed_during_parse" || parsed.state.step === 1)) {
            const name = readdirSync(directory).find((entry) => entry.endsWith(".tmp"));
            if (name !== undefined) {
              substitutedPath = join(directory, name);
              if (substitution === "same_bytes_new_inode") {
                renameSync(substitutedPath, join(directory, "owned-temporary.json"));
              }
              writeFileSync(substitutedPath, JSON.stringify(replacement), { mode: 0o600 });
            }
          }
          return parsed;
        },
      });
      substitute = true;
      await expect(receipt.update((current) => ({ ...current, state: { step: 1 } })))
        .rejects.toThrow("synthetic_receipt_refused");
      expect(substitutedPath).toBeDefined();
      expect(JSON.parse(await readFile(substitutedPath ?? "", "utf8"))).toEqual(replacement);
      expect(JSON.parse(await readFile(initial.path, "utf8"))).toEqual(initial);
      expect(receipt.value).toEqual(initial);
    });
    },
  );

  test("private directories and receipts reject special permission bits", async () => {
    await fixture(async ({ directory, initial, policy }) => {
      await writeFile(initial.path, JSON.stringify(initial), { mode: 0o600 });
      // Use the fixed native utility and verify the condition; the fs chmod
      // API does not retain these bits in every supported runtime.
      expect(spawnSync("/bin/chmod", ["1600", initial.path], { timeout: 1_000 }).status).toBe(0);
      expect((await lstat(initial.path)).mode & 0o7777).toBe(0o1600);
      await expect(AtomicPrivateJsonReceipt.open(initial, policy))
        .rejects.toThrow("synthetic_receipt_refused");
      expect(spawnSync("/bin/chmod", ["1700", directory], { timeout: 1_000 }).status).toBe(0);
      expect((await lstat(directory)).mode & 0o7777).toBe(0o1700);
      await expect(observePrivateDirectory(directory, policy.invalid))
        .rejects.toThrow("synthetic_receipt_refused");
    });
  });

  test("reopen rejects a receipt larger than the bounded private format", async () => {
    await fixture(async ({ initial, policy }) => {
      await writeFile(initial.path, " ".repeat(1_025), { mode: 0o600 });
      await expect(AtomicPrivateJsonReceipt.open(initial, policy))
        .rejects.toThrow("synthetic_receipt_refused");
    });
  });

  test("reopen refuses non-private, linked, non-file, and invalid UTF-8 inputs", async () => {
    await fixture(async ({ directory, initial, policy }) => {
      await writeFile(initial.path, JSON.stringify(initial), { mode: 0o600 });
      await chmod(initial.path, 0o644);
      await expect(AtomicPrivateJsonReceipt.open(initial, policy)).rejects.toThrow();
      await chmod(initial.path, 0o600);
      const hardlink = join(directory, "hardlink.json");
      await link(initial.path, hardlink);
      await expect(AtomicPrivateJsonReceipt.open(initial, policy)).rejects.toThrow();
      await rm(hardlink);
      const symbolic = join(directory, "symlink.json");
      await symlink(initial.path, symbolic);
      await expect(AtomicPrivateJsonReceipt.open({ ...initial, path: symbolic }, policy))
        .rejects.toThrow();
      await expect(AtomicPrivateJsonReceipt.open({ ...initial, path: directory }, policy))
        .rejects.toThrow();
      await writeFile(initial.path, Buffer.from([0xff]), { mode: 0o600 });
      await expect(AtomicPrivateJsonReceipt.open(initial, policy)).rejects.toThrow();
    });
  });

  test("reentrant transforms cannot start a second mutation", async () => {
    await fixture(async ({ initial, policy }) => {
      const receipt = await AtomicPrivateJsonReceipt.create(initial, policy);
      let nested: Promise<Receipt> | undefined;
      await receipt.update((current) => {
        nested = receipt.update((other) => ({ ...other, state: { step: 99 } }));
        void nested.catch(() => undefined);
        return { ...current, state: { step: 1 } };
      });
      await expect(nested).rejects.toThrow("synthetic_receipt_refused");
      expect(receipt.value.state.step).toBe(1);
    });
  });
});
