import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import type { OompaAttentionEmailResult } from "./attentionEmail";
import {
  attentionNotificationActionGroupLimit,
  runAttentionNotificationAction,
  runAttentionNotificationDrain,
} from "./attentionNotificationDelivery";
import type { ActionCtx } from "./server";
import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
} from "./resendApiKey";

const apiKey = "re_notice_test";
const authApiKey = "re_auth_test";
let previousAttentionKey: string | undefined;
let previousAuthKey: string | undefined;

beforeEach(() => {
  previousAttentionKey = process.env[oompaAttentionResendApiKeyEnvironmentName];
  previousAuthKey = process.env[oompaResendApiKeyEnvironmentName];
  process.env[oompaAttentionResendApiKeyEnvironmentName] = apiKey;
  process.env[oompaResendApiKeyEnvironmentName] = authApiKey;
});

afterEach(() => {
  for (const [name, value] of [
    [oompaAttentionResendApiKeyEnvironmentName, previousAttentionKey],
    [oompaResendApiKeyEnvironmentName, previousAuthKey],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

const body = {
  text: [
    "Oompa needs your attention",
    "",
    "Open Oompa to review:",
    "- Command approval: https://app.oompa.app/#/session/session_action_test",
  ].join("\n"),
  version: 3 as const,
};

const untouchedInactive = {
  generation: 0,
  globalState: "absent" as const,
  outboxOccupancy: 0,
  safetyFaultOccupancy: 0,
};

describe("attention notification delivery action", () => {
  test("quietly skips only untouched empty preactivation before requiring a key", async () => {
    Reflect.deleteProperty(process.env, oompaAttentionResendApiKeyEnvironmentName);
    let mutations = 0;
    const queries: string[] = [];
    const context = {
      runMutation: async () => {
        mutations += 1;
        return null;
      },
      runQuery: async (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
        queries.push(getFunctionName(reference));
        expect(args).toEqual({});
        return untouchedInactive;
      },
    } as unknown as Pick<ActionCtx, "runMutation" | "runQuery">;
    const provider = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    try {
      expect(await runAttentionNotificationAction(context, 10)).toEqual({
        claimed: 0,
        closed: 0,
        processed: 0,
      });
      expect(queries).toEqual(["attentionNotificationControl:inactiveDeploymentStatus"]);
      expect(mutations).toBe(0);
      expect(provider).not.toHaveBeenCalled();
      await expect(runAttentionNotificationDrain(context, 10))
        .rejects.toThrow("Attention email delivery is unavailable.");
      await expect(runAttentionNotificationAction(context, 11))
        .rejects.toThrow("Invalid attention-notification drain limit.");
      expect(queries).toHaveLength(1);
    } finally {
      provider.mockRestore();
    }
  });

  test("requires readiness and preserves ordinary cleanup outside exact preactivation", async () => {
    let mutations = 0;
    for (const status of [
      { ...untouchedInactive, globalState: "enabled", generation: 1 },
      { ...untouchedInactive, globalState: "disabled", generation: 2 },
      { ...untouchedInactive, outboxOccupancy: 1 },
      { ...untouchedInactive, safetyFaultOccupancy: 1 },
    ]) {
      const claims = [{ kind: "closed" }, null];
      const context = {
        runMutation: async () => {
          mutations += 1;
          return claims.shift() ?? null;
        },
        runQuery: async () => status,
      } as unknown as Pick<ActionCtx, "runMutation" | "runQuery">;
      Reflect.deleteProperty(process.env, oompaAttentionResendApiKeyEnvironmentName);
      const before = mutations;
      await expect(runAttentionNotificationAction(context, 10))
        .rejects.toThrow("Attention email delivery is unavailable.");
      expect(mutations).toBe(before);
      process.env[oompaAttentionResendApiKeyEnvironmentName] = apiKey;
      expect(await runAttentionNotificationAction(context, 10)).toEqual({
        claimed: 0,
        closed: 1,
        processed: 1,
      });
      expect(mutations).toBe(before + 2);
    }
  });

  test("fails closed on malformed or unavailable inactivity reads before mutation", async () => {
    let mutations = 0;
    const provider = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    try {
      for (const status of [
        null,
        {},
        { ...untouchedInactive, extra: true },
        { ...untouchedInactive, generation: 1 },
        { ...untouchedInactive, generation: false },
        { ...untouchedInactive, globalState: "enabled" },
        { ...untouchedInactive, globalState: "unknown" },
        { ...untouchedInactive, globalState: false },
        { ...untouchedInactive, globalState: "" },
        { ...untouchedInactive, globalState: ["absent"] },
        { ...untouchedInactive, outboxOccupancy: -1 },
        { ...untouchedInactive, outboxOccupancy: false },
        { ...untouchedInactive, safetyFaultOccupancy: 2 },
        { ...untouchedInactive, safetyFaultOccupancy: undefined },
        { ...untouchedInactive, safetyFaultOccupancy: false },
        { ...untouchedInactive, generation: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        const context = {
          runMutation: async () => { mutations += 1; return null; },
          runQuery: async () => status,
        } as unknown as Pick<ActionCtx, "runMutation" | "runQuery">;
        await expect(runAttentionNotificationAction(context, 10))
          .rejects.toThrow("Attention notification status is unavailable.");
      }
      const context = {
        runMutation: async () => { mutations += 1; return null; },
        runQuery: async () => { throw new Error("private query detail"); },
      } as unknown as Pick<ActionCtx, "runMutation" | "runQuery">;
      await expect(runAttentionNotificationAction(context, 10))
        .rejects.toThrow("Attention notification status is unavailable.");
      expect(mutations).toBe(0);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  test("rejects unavailable dedicated credentials before any claim or provider request", async () => {
    let mutations = 0;
    const context = {
      runMutation: async () => {
        mutations += 1;
        return null;
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const provider = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    try {
      for (const invalid of [undefined, "re_bad key", "re_short'key", authApiKey]) {
        if (invalid === undefined) {
          Reflect.deleteProperty(process.env, oompaAttentionResendApiKeyEnvironmentName);
        } else process.env[oompaAttentionResendApiKeyEnvironmentName] = invalid;
        await expect(runAttentionNotificationDrain(context, 10))
          .rejects.toThrow("Attention email delivery is unavailable.");
      }
      expect(mutations).toBe(0);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  test("preserves retry settlement after a validated production sender encounters network failure", async () => {
    let claimCalls = 0;
    const settlements: unknown[] = [];
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        if (Object.hasOwn(args, "deliveryId")) {
          settlements.push(args);
          return { kind: "retryable" };
        }
        claimCalls += 1;
        return claimCalls === 1 ? {
          body,
          deliveryId: "01912345-6789-7abc-8def-0123456789f3",
          generation: 2,
          globalNotificationGeneration: 3,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        } : null;
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const provider = spyOn(globalThis, "fetch").mockRejectedValue(new Error("private provider detail"));
    try {
      expect(await runAttentionNotificationDrain(context, 10)).toEqual({
        claimed: 1,
        closed: 0,
        processed: 1,
      });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(settlements).toEqual([{
        deliveryId: "01912345-6789-7abc-8def-0123456789f3",
        generation: 2,
        globalNotificationGeneration: 3,
        result: { kind: "retryable", reason: "network" },
      }]);
    } finally {
      provider.mockRestore();
    }
  });

  test.each([1, 2] as const)("retries a stored v%i claim with its original payload and key", async (version) => {
    const label = version === 1 ? "HRA" : "Oompa";
    const origin = version === 1 ? "https://app.hra.sh" : "https://app.oompa.dev";
    const storedBody = { version, text: [`${label} needs your attention`, "", `Open ${label} to review:`,
      `- Command approval: ${origin}/#/session/session_action_test`].join("\n") };
    const idempotencyKey = "b".repeat(64);
    const settlements: unknown[] = [];
    let claims = 0;
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        if (Object.hasOwn(args, "result")) { settlements.push(args.result); return { kind: "settled" }; }
        return { body: storedBody, deliveryId: "01912345-6789-7abc-8def-0123456789f3",
          generation: ++claims, globalNotificationGeneration: 3, idempotencyKey, kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const requests: { body: RequestInit["body"]; key: string | null }[] = [];
    const provider = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (...[, init]: Parameters<typeof fetch>) => {
      requests.push({ body: init?.body, key: new Headers(init?.headers).get("Idempotency-Key") });
      return requests.length === 1
        ? new Response(JSON.stringify({ message: "Concurrent request", name: "concurrent_idempotent_requests", statusCode: 409 }),
          { status: 409, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ id: "message_action_retry" }),
          { status: 200, headers: { "Content-Type": "application/json" } });
    }, { preconnect: () => undefined }));
    try {
      expect(await runAttentionNotificationDrain(context, 1)).toEqual({ claimed: 1, closed: 0, processed: 1 });
      expect(await runAttentionNotificationDrain(context, 1)).toEqual({ claimed: 1, closed: 0, processed: 1 });
      const expected = { body: JSON.stringify({ from: `${label} attention <notifications@news.hraness.com>`,
        subject: `${label} needs your attention`, text: storedBody.text, to: ["attention@example.com"] }), key: idempotencyKey };
      expect(requests).toEqual([expected, expected]);
      expect(settlements).toEqual([{ kind: "retryable", reason: "concurrent_idempotency" },
        { kind: "accepted", providerMessageId: "message_action_retry" }]);
    } finally { provider.mockRestore(); }
  });

  test("processes at most ten claimed groups and settles every attempted effect", async () => {
    let claimCalls = 0;
    const settlements: unknown[] = [];
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        if (Object.hasOwn(args, "deliveryId")) {
          settlements.push(args);
          return { kind: "accepted" };
        }
        claimCalls += 1;
        return {
          body,
          deliveryId: `01912345-6789-7abc-8def-${String(claimCalls).padStart(12, "0")}`,
          generation: 1,
          globalNotificationGeneration: 1,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const sends: string[] = [];
    const send = async (input: Readonly<{ idempotencyKey: string }>): Promise<OompaAttentionEmailResult> => {
      sends.push(input.idempotencyKey);
      return { kind: "accepted", providerMessageId: "message_action" };
    };

    expect(await runAttentionNotificationDrain(
      context,
      attentionNotificationActionGroupLimit,
      send,
    )).toEqual({ claimed: 10, closed: 0, processed: 10 });
    expect(claimCalls).toBe(10);
    expect(sends).toHaveLength(10);
    expect(settlements).toHaveLength(10);
  });

  test("stops on idle, counts closed claims, and rejects an oversized action request", async () => {
    const claims = [{ kind: "closed" as const }, null];
    const context = {
      runMutation: async () => claims.shift() ?? null,
    } as unknown as Pick<ActionCtx, "runMutation">;
    expect(await runAttentionNotificationDrain(context, 10)).toEqual({
      claimed: 0,
      closed: 1,
      processed: 1,
    });
    await expect(runAttentionNotificationDrain(
      context,
      attentionNotificationActionGroupLimit + 1,
    )).rejects.toThrow("Invalid attention-notification drain limit");
  });

  test("stops after a committed safety latch and quarantines in a separate mutation", async () => {
    let claimCalls = 0;
    const mutations: Readonly<Record<string, unknown>>[] = [];
    const deliveryId = "01912345-6789-7abc-8def-0123456789f1";
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        mutations.push(args);
        if (Object.hasOwn(args, "result")) {
          return { kind: "safety_fault", quarantineFaultId: deliveryId };
        }
        if (Object.hasOwn(args, "faultId")) {
          return { deleted: 1, remaining: false };
        }
        claimCalls += 1;
        return {
          body,
          deliveryId,
          generation: 1,
          globalNotificationGeneration: 1,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const send = async (): Promise<OompaAttentionEmailResult> => ({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });

    expect(await runAttentionNotificationDrain(context, 10, send)).toEqual({
      claimed: 1,
      closed: 0,
      processed: 1,
    });
    expect(claimCalls).toBe(1);
    expect(mutations).toHaveLength(3);
    expect(mutations[1]).toMatchObject({ deliveryId, result: { kind: "ambiguous" } });
    expect(mutations[2]).toEqual({ faultId: deliveryId });
  });

  test("retains a valid idempotency ambiguity without dispatching quarantine", async () => {
    let claimCalls = 0;
    const mutations: Readonly<Record<string, unknown>>[] = [];
    const deliveryId = "01912345-6789-7abc-8def-0123456789f2";
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        mutations.push(args);
        if (Object.hasOwn(args, "result")) {
          return { kind: "ambiguous", reason: "idempotency_mismatch" };
        }
        claimCalls += 1;
        if (claimCalls > 1) return null;
        return {
          body,
          deliveryId,
          generation: 1,
          globalNotificationGeneration: 1,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const send = async (): Promise<OompaAttentionEmailResult> => ({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });

    expect(await runAttentionNotificationDrain(context, 10, send)).toEqual({
      claimed: 1,
      closed: 0,
      processed: 1,
    });
    expect(claimCalls).toBe(2);
    expect(mutations.filter((args) => Object.hasOwn(args, "deliveryId"))).toHaveLength(1);
    expect(mutations[1]).toMatchObject({ deliveryId, result: { kind: "ambiguous" } });
  });
});
