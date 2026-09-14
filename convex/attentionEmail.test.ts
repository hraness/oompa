import { describe, expect, jest, test } from "bun:test";
import fc from "fast-check";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import type { InteractionKind } from "../src/domain/interactions";
import {
  attentionEmailFromV1,
  attentionEmailSubjectV1,
  buildOompaAttentionEmailBody,
  buildOompaAttentionEmailPayload,
  classifyOompaAttentionEmailResponse,
  createOompaAttentionEmailSender,
  oompaAttentionEmailBodyVersion,
  oompaAttentionEmailDeliveryTimeoutMs,
  oompaAttentionEmailEndpoint,
  oompaAttentionEmailFrom,
  oompaAttentionEmailMaximumBodyBytes,
  oompaAttentionEmailMaximumItems,
  oompaAttentionEmailSubject,
  oompaAttentionEmailUserAgent,
  parseOompaAttentionEmailBody,
  sendOompaAttentionEmail,
  type OompaAttentionEmailBody,
  type OompaAttentionEmailFetch,
  type OompaAttentionEmailItem,
} from "./attentionEmail";
import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
  isStrictResendApiKey,
  requireOompaAttentionResendApiKey,
} from "./resendApiKey";

const recipient = "reader@example.com" as CanonicalAuthEmail;
const apiKey = "re_fixture_key";
const authApiKey = "re_auth_test";
const emailEnvironment = {
  [oompaAttentionResendApiKeyEnvironmentName]: apiKey,
  [oompaResendApiKeyEnvironmentName]: authApiKey,
};
const idempotencyKey = "attention/018bcfe5-6800-7000-8000-000000000001";
const sessionPublicId = "session_0123456789abcdef";
const providerMessageId = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const jsonHeaders = { "Content-Type": "application/json" };

const interactionKinds: readonly InteractionKind[] = [
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
];

const items = interactionKinds.map((interactionKind, index): OompaAttentionEmailItem => ({
  interactionKind,
  sessionPublicId: `${sessionPublicId}_${String(index)}`,
}));

const errorBody = (statusCode: number, name: string): Readonly<{
  message: string;
  name: string;
  statusCode: number;
}> => ({ message: "The provider refused the request.", name, statusCode });

describe("Oompa attention email body and payload", () => {
  test("freezes a versioned metadata-only body and pins its delivery payload", () => {
    const body = buildOompaAttentionEmailBody(items);
    const payload = buildOompaAttentionEmailPayload({ body, recipient });
    expect(Object.isFrozen(body)).toBe(true);
    expect(body).toEqual({
      text: [
        "Oompa needs your attention",
        "",
        "Open Oompa to review:",
        `- Command approval: https://app.oompa.app/#/session/${sessionPublicId}_0`,
        `- File change approval: https://app.oompa.app/#/session/${sessionPublicId}_1`,
        `- Permission approval: https://app.oompa.app/#/session/${sessionPublicId}_2`,
        `- User input: https://app.oompa.app/#/session/${sessionPublicId}_3`,
        `- MCP elicitation: https://app.oompa.app/#/session/${sessionPublicId}_4`,
      ].join("\n"),
      version: oompaAttentionEmailBodyVersion,
    });
    expect(oompaAttentionEmailBodyVersion).toBe(3);
    expect(payload).toEqual({
      from: oompaAttentionEmailFrom,
      subject: oompaAttentionEmailSubject,
      text: body.text,
      to: [recipient],
    });
    expect(Object.keys(payload).sort()).toEqual(["from", "subject", "text", "to"]);
    expect("reply_to" in payload).toBe(false);
    expect("html" in payload).toBe(false);
    expect(new TextEncoder().encode(payload.text).byteLength)
      .toBeLessThanOrEqual(oompaAttentionEmailMaximumBodyBytes);
  });

  test("rejects non-opaque destinations, extra content fields, and invalid recipients", () => {
    for (const invalid of [
      "short",
      "session/with/slash",
      "https://attacker.example/session",
      "session_0123456789abcdef?next=attacker",
      "session_0123456789abcdef%2fattacker",
    ]) {
      expect(() => buildOompaAttentionEmailBody([
        { interactionKind: "user_input", sessionPublicId: invalid },
      ])).toThrow("Attention email delivery is unavailable.");
    }

    expect(() => buildOompaAttentionEmailBody([{
        interactionKind: "user_input",
        prompt: "not allowed",
        sessionPublicId,
      } as OompaAttentionEmailItem]))
      .toThrow("Attention email delivery is unavailable.");
    expect(() => buildOompaAttentionEmailPayload({
      body: buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }]),
      recipient: "Reader@example.com" as CanonicalAuthEmail,
    })).toThrow("Attention email delivery is unavailable.");
  });

  test("requires one through eight items", () => {
    expect(() => buildOompaAttentionEmailBody([]))
      .toThrow("Attention email delivery is unavailable.");
    expect(() => buildOompaAttentionEmailBody(
      Array.from({ length: oompaAttentionEmailMaximumItems + 1 }, () => ({
        interactionKind: "user_input" as const,
        sessionPublicId,
      })),
    )).toThrow("Attention email delivery is unavailable.");
  });

  test("strictly restores a literal stored v1 body with its HRA-era sender", () => {
    const stored = {
      text: [
        "HRA needs your attention",
        "",
        "Open HRA to review:",
        `- User input: https://app.hra.sh/#/session/${sessionPublicId}`,
      ].join("\n"),
      version: 1 as const,
    };
    const restored = parseOompaAttentionEmailBody(JSON.parse(JSON.stringify(stored)));
    expect(restored).toEqual(stored);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }], 1))
      .toEqual(stored);
    expect(buildOompaAttentionEmailPayload({ body: stored, recipient })).toEqual({
      from: attentionEmailFromV1,
      subject: attentionEmailSubjectV1,
      text: stored.text,
      to: [recipient],
    });

    for (const invalid of [
      { ...stored, extra: true },
      { ...stored, version: 2 },
      { ...stored, version: 3 },
      { ...stored, text: `${stored.text}\n` },
      { ...stored, text: stored.text.replace("app.hra.sh", "app.oompa.dev") },
      { ...stored, text: stored.text.replace("app.hra.sh", "attacker.example") },
      { ...stored, text: stored.text.replace(sessionPublicId, "short") },
    ]) expect(parseOompaAttentionEmailBody(invalid)).toBeNull();
  });

  test("strictly restores a literal stored v2 body without rebuilding it", () => {
    const stored = {
      text: [
        "Oompa needs your attention",
        "",
        "Open Oompa to review:",
        `- User input: https://app.oompa.dev/#/session/${sessionPublicId}`,
      ].join("\n"),
      version: 2 as const,
    };
    const restored = parseOompaAttentionEmailBody(JSON.parse(JSON.stringify(stored)));
    expect(restored).toEqual(stored);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }], 2)).toEqual(stored);
    expect(buildOompaAttentionEmailPayload({ body: stored, recipient })).toEqual({
      from: "Oompa attention <notifications@news.hraness.com>",
      subject: "Oompa needs your attention",
      text: stored.text,
      to: [recipient],
    });

    for (const invalid of [
      { ...stored, extra: true },
      { ...stored, version: 1 },
      { ...stored, version: 3 },
      { ...stored, text: `${stored.text}\n` },
      { ...stored, text: stored.text.replace("app.oompa.dev", "app.hra.sh") },
      { ...stored, text: stored.text.replace("app.oompa.dev", "app.oompa.app") },
      { ...stored, text: stored.text.replace("app.oompa.dev", "attacker.example") },
      { ...stored, text: stored.text.replace(sessionPublicId, "short") },
    ]) expect(parseOompaAttentionEmailBody(invalid)).toBeNull();
  });

  test("strictly restores v3 and refuses another version's destination", () => {
    const stored = {
      text: ["Oompa needs your attention", "", "Open Oompa to review:",
        `- User input: https://app.oompa.app/#/session/${sessionPublicId}`].join("\n"),
      version: 3 as const,
    };
    const restored = parseOompaAttentionEmailBody(JSON.parse(JSON.stringify(stored)));
    expect(restored).toEqual(stored);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }])).toEqual(stored);
    for (const invalid of [
      { ...stored, extra: true }, { ...stored, version: 1 }, { ...stored, version: 2 }, { ...stored, version: 4 },
      { ...stored, text: stored.text.replace("app.oompa.app", "app.oompa.dev") },
      { ...stored, text: stored.text.replace("app.oompa.app", "app.hra.sh") },
      { ...stored, text: stored.text.replace("app.oompa.app", "attacker.example") },
    ]) expect(parseOompaAttentionEmailBody(invalid)).toBeNull();
  });
});

describe("Oompa attention email response classification", () => {
  test("accepts only an exact 2xx body with one bounded opaque provider id", () => {
    expect(classifyOompaAttentionEmailResponse({
      body: { id: providerMessageId },
      status: 201,
    })).toEqual({ kind: "accepted", providerMessageId });

    for (const body of [
      null,
      {},
      { id: "contains spaces" },
      { id: "x".repeat(257) },
      { id: providerMessageId, extra: true },
    ]) {
      expect(classifyOompaAttentionEmailResponse({ body, status: 200 }))
        .toEqual({ kind: "retryable", reason: "malformed_success" });
    }
  });

  test("keeps network-shaped HTTP outcomes retryable", () => {
    for (const status of [408, 429, 500, 503, 599]) {
      expect(classifyOompaAttentionEmailResponse({ body: null, status }))
        .toEqual({ kind: "retryable", reason: "transient_http" });
    }
    expect(classifyOompaAttentionEmailResponse({
      body: errorBody(409, "concurrent_idempotent_requests"),
      status: 409,
    })).toEqual({ kind: "retryable", reason: "concurrent_idempotency" });
  });

  test("marks an exact changed-body idempotency conflict ambiguous and safety-faulted", () => {
    expect(classifyOompaAttentionEmailResponse({
      body: errorBody(409, "invalid_idempotent_request"),
      status: 409,
    })).toEqual({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });
  });

  test("refuses only exact documented no-effect status and type pairs", () => {
    const pairs = [
      [400, "invalid_idempotency_key"],
      [400, "validation_error"],
      [401, "missing_api_key"],
      [401, "restricted_api_key"],
      [403, "invalid_api_key"],
      [403, "validation_error"],
      [404, "not_found"],
      [405, "method_not_allowed"],
      [422, "invalid_access"],
      [422, "invalid_attachment"],
      [422, "invalid_from_address"],
      [422, "invalid_parameter"],
      [422, "invalid_region"],
      [422, "missing_required_field"],
    ] as const;
    for (const [status, name] of pairs) {
      expect(classifyOompaAttentionEmailResponse({ body: errorBody(status, name), status }))
        .toEqual({ kind: "refused", providerErrorType: name, status });
    }
  });

  test("keeps unknown, malformed, and incoherent errors retryable", () => {
    for (const [body, status] of [
      [errorBody(422, "future_error"), 422],
      [errorBody(400, "invalid_parameter"), 400],
      [errorBody(400, "validation_error"), 422],
      [{ ...errorBody(400, "validation_error"), extra: true }, 400],
      [{ message: "missing status", name: "validation_error" }, 400],
      [errorBody(409, "resource_locked"), 409],
      [errorBody(403, "email_above_quota"), 403],
      [errorBody(403, "invalid_permission"), 403],
      [errorBody(403, "restricted_api_key"), 403],
      [errorBody(403, "suspended_api_key"), 403],
      [errorBody(422, "missing_required_parameter"), 422],
      [null, 302],
    ] as const) {
      expect(classifyOompaAttentionEmailResponse({ body, status }))
        .toEqual({ kind: "retryable", reason: "unknown_or_incoherent_response" });
    }

    let reads = 0;
    const accessor = Object.defineProperty({}, "id", {
      enumerable: true,
      get() {
        reads += 1;
        return providerMessageId;
      },
    });
    expect(classifyOompaAttentionEmailResponse({ body: accessor, status: 200 }))
      .toEqual({ kind: "retryable", reason: "malformed_success" });
    expect(reads).toBe(0);
  });

  test("is total over JSON values and arbitrary status integers", () => {
    fc.assert(fc.property(
      fc.jsonValue(),
      fc.integer({ max: 700, min: 0 }),
      (body, status) => {
        const result = classifyOompaAttentionEmailResponse({ body, status });
        expect(["accepted", "ambiguous", "refused", "retryable"])
          .toContain(result.kind);
      },
    ));
  });
});

describe("Oompa attention email transport", () => {
  test("uses the pinned endpoint, immutable payload, and exact idempotency key", async () => {
    let observedResource: string | undefined;
    let observedInit: RequestInit | undefined;
    const fetch: OompaAttentionEmailFetch = async (resource, init) => {
      observedResource = resource;
      observedInit = init;
      return new Response(JSON.stringify({ id: providerMessageId }), {
        headers: jsonHeaders,
        status: 200,
      });
    };

    await expect(sendOompaAttentionEmail({
      body: buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }]),
      idempotencyKey,
      recipient,
    }, {
      environment: emailEnvironment,
      fetch,
    })).resolves.toEqual({ kind: "accepted", providerMessageId });

    expect(observedResource).toBe(oompaAttentionEmailEndpoint);
    expect(observedInit?.method).toBe("POST");
    expect(observedInit?.redirect).toBe("error");
    expect(observedInit?.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "User-Agent": oompaAttentionEmailUserAgent,
    });
    expect((observedInit?.signal as AbortSignal | undefined)?.aborted).toBe(false);
    const body = JSON.parse(observedInit?.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["from", "subject", "text", "to"]);
    expect(body.from).toBe(oompaAttentionEmailFrom);
    expect(body.subject).toBe(oompaAttentionEmailSubject);
    expect(body).not.toHaveProperty("reply_to");
  });

  test.each([1, 2, 3] as const)("sends a restored v%i body byte-identically across same-key retries", async (version) => {
    const grammar = {
      1: { from: "HRA attention <notifications@news.hraness.com>", subject: "HRA needs your attention",
        review: "Open HRA to review:", sessionUrl: "https://app.hra.sh/#/session/" },
      2: { from: "Oompa attention <notifications@news.hraness.com>", subject: "Oompa needs your attention",
        review: "Open Oompa to review:", sessionUrl: "https://app.oompa.dev/#/session/" },
      3: { from: "Oompa attention <notifications@news.hraness.com>", subject: "Oompa needs your attention",
        review: "Open Oompa to review:", sessionUrl: "https://app.oompa.app/#/session/" },
    }[version];
    const text = [grammar.subject, "", grammar.review, `- Permission approval: ${grammar.sessionUrl}${sessionPublicId}`].join("\n");
    const storedJson = JSON.stringify({ text, version });
    const body: OompaAttentionEmailBody | null = parseOompaAttentionEmailBody(
      JSON.parse(storedJson),
    );
    if (body === null) throw new Error("invalid stored-body fixture");

    const requestBodies: string[] = [];
    const requestKeys: string[] = [];
    let attempt = 0;
    const fetch: OompaAttentionEmailFetch = async (_resource, init) => {
      requestBodies.push(init.body as string);
      requestKeys.push((init.headers as Record<string, string>)["Idempotency-Key"] ?? "");
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify(errorBody(409, "concurrent_idempotent_requests")), {
            headers: jsonHeaders,
            status: 409,
          })
        : new Response(JSON.stringify({ id: providerMessageId }), {
            headers: jsonHeaders,
            status: 200,
          });
    };
    const input = { body, idempotencyKey, recipient };
    const options = {
      environment: emailEnvironment,
      fetch,
    };

    await expect(sendOompaAttentionEmail(input, options))
      .resolves.toEqual({ kind: "retryable", reason: "concurrent_idempotency" });
    await expect(sendOompaAttentionEmail(input, options))
      .resolves.toEqual({ kind: "accepted", providerMessageId });
    const expectedPayload = JSON.stringify({ from: grammar.from, subject: grammar.subject, text, to: [recipient] });
    expect(requestBodies).toEqual([expectedPayload, expectedPayload]);
    expect(requestKeys).toEqual([idempotencyKey, idempotencyKey]);
    expect((JSON.parse(requestBodies[0] ?? "") as { text: string }).text).toBe(body.text);
  });

  test("keeps network failure and malformed or oversized success retryable", async () => {
    const common = {
      body: buildOompaAttentionEmailBody([{
        interactionKind: "user_input" as const,
        sessionPublicId,
      }]),
      idempotencyKey,
      recipient,
    };
    const environment = emailEnvironment;
    await expect(sendOompaAttentionEmail(common, {
      environment,
      fetch: async () => { throw new Error("network detail must not escape"); },
    })).resolves.toEqual({ kind: "retryable", reason: "network" });
    await expect(sendOompaAttentionEmail(common, {
      environment,
      fetch: async () => new Response("not json", { headers: jsonHeaders, status: 200 }),
    })).resolves.toEqual({ kind: "retryable", reason: "malformed_success" });
    await expect(sendOompaAttentionEmail(common, {
      environment,
      fetch: async () => new Response(JSON.stringify({ id: "x".repeat(5_000) }), {
        headers: jsonHeaders,
        status: 200,
      }),
    })).resolves.toEqual({ kind: "retryable", reason: "malformed_success" });
  });

  test("enforces the fixed eight-second timeout and aborts the provider request", async () => {
    jest.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    try {
      const pending = sendOompaAttentionEmail({
        body: buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }]),
        idempotencyKey,
        recipient,
      }, {
        environment: emailEnvironment,
        fetch: async (_resource, init) => {
          observedSignal = init.signal ?? undefined;
          return await new Promise<Response>(() => undefined);
        },
      });
      await Promise.resolve();
      jest.advanceTimersByTime(oompaAttentionEmailDeliveryTimeoutMs);
      await expect(pending).resolves.toEqual({ kind: "retryable", reason: "timeout" });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("requires a strict dedicated key and refuses auth fallback or equality before fetch", async () => {
    expect(requireOompaAttentionResendApiKey(emailEnvironment)).toBe(apiKey);
    let calls = 0;
    for (const invalid of [
      undefined,
      "resend-key",
      "re_x",
      "re_has space",
      "re_has\nnewline",
      "re_has'quote",
      "re_has.dot",
      "re_has/non-url-char",
      "re_has_unicode_é",
      `re_${"a".repeat(510)}`,
      authApiKey,
    ]) {
      const environment = {
        [oompaAttentionResendApiKeyEnvironmentName]: invalid,
        [oompaResendApiKeyEnvironmentName]: authApiKey,
      };
      expect(() => requireOompaAttentionResendApiKey(environment))
        .toThrow("Attention email delivery is unavailable.");
      expect(() => createOompaAttentionEmailSender({ environment }))
        .toThrow("Attention email delivery is unavailable.");
      await expect(sendOompaAttentionEmail({
        body: buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }]),
        idempotencyKey,
        recipient,
      }, {
        environment,
        fetch: async () => {
          calls += 1;
          return new Response();
        },
      })).rejects.toThrow("Attention email delivery is unavailable.");
    }
    expect(calls).toBe(0);

    await expect(sendOompaAttentionEmail({
      body: buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }]),
      idempotencyKey: "bad key",
      recipient,
    }, {
      environment: emailEnvironment,
      fetch: async () => {
        calls += 1;
        return new Response();
      },
    })).rejects.toThrow("Attention email delivery is unavailable.");
    expect(calls).toBe(0);
  });

  test("keeps a prepared sender bound to its validated credential snapshot", async () => {
    const environment = { ...emailEnvironment };
    const authorizations: (string | null)[] = [];
    const sender = createOompaAttentionEmailSender({
      environment,
      fetch: async (_resource, init) => {
        authorizations.push(new Headers(init.headers).get("Authorization"));
        return new Response(JSON.stringify({ id: providerMessageId }), {
          headers: jsonHeaders,
          status: 200,
        });
      },
    });
    environment[oompaAttentionResendApiKeyEnvironmentName] = authApiKey;
    await expect(sender({
      body: buildOompaAttentionEmailBody([{ interactionKind: "user_input", sessionPublicId }]),
      idempotencyKey,
      recipient,
    })).resolves.toEqual({ kind: "accepted", providerMessageId });
    expect(authorizations).toEqual([`Bearer ${apiKey}`]);
  });

  test("accepts exactly the dedicated URL-safe key grammar and bounded lengths", () => {
    fc.assert(fc.property(fc.string({ maxLength: 520 }), (suffix) => {
      const value = `re_${suffix}`;
      const valid = value.length >= 8
        && value.length <= 512
        && /^[A-Za-z0-9_-]+$/u.test(suffix)
        && value !== authApiKey;
      expect(isStrictResendApiKey(value)).toBe(valid || value === authApiKey);
      const environment = {
        [oompaAttentionResendApiKeyEnvironmentName]: value,
        [oompaResendApiKeyEnvironmentName]: authApiKey,
      };
      if (valid) expect(requireOompaAttentionResendApiKey(environment)).toBe(value);
      else expect(() => requireOompaAttentionResendApiKey(environment))
        .toThrow("Attention email delivery is unavailable.");
    }));
    for (const length of [8, 512]) {
      const value = `re_${"a".repeat(length - 3)}`;
      expect(requireOompaAttentionResendApiKey({
        [oompaAttentionResendApiKeyEnvironmentName]: value,
        [oompaResendApiKeyEnvironmentName]: authApiKey,
      })).toBe(value);
    }
  });

  test("requires a valid authentication counterpart without falling back to it", () => {
    for (const invalid of [undefined, "re_x", "re_bad'quote", "re_has space", apiKey]) {
      expect(() => requireOompaAttentionResendApiKey({
        [oompaAttentionResendApiKeyEnvironmentName]: apiKey,
        [oompaResendApiKeyEnvironmentName]: invalid,
      })).toThrow("Attention email delivery is unavailable.");
    }
  });
});
