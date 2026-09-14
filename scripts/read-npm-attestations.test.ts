import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readNpmAttestations } from "./read-npm-attestations";
import { selectNpmProvenanceAttestations } from "./verify-npm-provenance";

const version = "0.6.3";
const url = "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2foompa@0.6.3";
const document = { attestations: [] };

function fixture(respond: (attempt: number, init: RequestInit) => Response | Promise<Response>) {
  let clock = 0;
  const requests: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  return {
    advance(milliseconds: number) { clock += milliseconds; },
    requests,
    sleeps,
    timeouts,
    runtime: {
      fetch: async (requestUrl: string, init: RequestInit) => {
        requests.push({ url: requestUrl, init });
        return respond(requests.length, init);
      },
      now: () => clock,
      sleep: async (milliseconds: number) => { sleeps.push(milliseconds); clock += milliseconds; },
      timeoutSignal: (milliseconds: number) => {
        timeouts.push(milliseconds);
        return new AbortController().signal;
      },
    },
  };
}

describe("bounded exact npm attestation visibility", () => {
  test("reads immediate JSON once without granting provenance admission", async () => {
    const f = fixture(() => Response.json(document));
    const value = await readNpmAttestations(version, f.runtime);
    expect(value).toEqual(document);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.url).toBe(url);
    expect(f.requests[0]?.init).toMatchObject({
      cache: "no-store", method: "GET", redirect: "error",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    expect(f.timeouts).toEqual([20_000]);
    expect(f.sleeps).toEqual([]);
    expect(() => selectNpmProvenanceAttestations(value)).toThrow("bounded expected attestation set");
  });

  test("waits through an 82-second visibility delay using only the exact GET", async () => {
    const f = fixture(() => f.runtime.now() < 82_000
      ? new Response(null, { status: 404 }) : Response.json(document));
    expect(await readNpmAttestations(version, f.runtime)).toEqual(document);
    expect(f.requests).toHaveLength(29);
    expect(f.sleeps).toEqual(Array.from({ length: 28 }, () => 3_000));
    expect(f.requests.every((request) => request.url === url)).toBe(true);
    expect(f.requests.every((request) => request.init.method === "GET")).toBe(true);
  });

  test("can accept visibility on the final permitted request", async () => {
    const f = fixture((attempt) => attempt === 60
      ? Response.json(document) : new Response(null, { status: 404 }));
    expect(await readNpmAttestations(version, f.runtime)).toEqual(document);
    expect(f.requests).toHaveLength(60);
    expect(f.sleeps).toHaveLength(59);
  });

  test("does not wait on an unbounded 404 error body or cancellation", async () => {
    let cancelled = false;
    const f = fixture((attempt) => attempt === 1 ? new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise<void>(() => undefined); },
    }), { status: 404 }) : Response.json(document));
    expect(await readNpmAttestations(version, f.runtime)).toEqual(document);
    expect(cancelled).toBe(true);
    expect(f.requests).toHaveLength(2);
  });

  test("exhausts persistent absence at 60 reads without a final sleep", async () => {
    let cancelled = 0;
    const f = fixture(() => new Response(new ReadableStream({
      cancel() { cancelled += 1; },
    }), { status: 404 }));
    await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow("visibility budget");
    expect(f.requests).toHaveLength(60);
    expect(f.sleeps).toHaveLength(59);
    expect(f.runtime.now()).toBe(177_000);
    expect(cancelled).toBe(60);
  });

  test("counts request duration toward the aggregate deadline", async () => {
    const f = fixture(() => {
      f.advance(19_000);
      return new Response(null, { status: 404 });
    });
    await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow("visibility budget");
    expect(f.requests).toHaveLength(9);
    expect(f.timeouts.at(-1)).toBe(4_000);
    expect(f.sleeps).toHaveLength(8);
  });

  test("does not sleep or issue another request when only the delay remains", async () => {
    const f = fixture(() => {
      f.advance(177_000);
      return new Response(null, { status: 404 });
    });
    await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow("visibility budget");
    expect(f.requests).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
  });

  test("bounds the last request and body by the remaining aggregate time", async () => {
    const f = fixture((attempt) => {
      if (attempt === 1) {
        f.advance(176_990);
        return new Response(null, { status: 404 });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          f.advance(10);
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }));
    });
    await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow("visibility budget");
    expect(f.timeouts).toEqual([20_000, 10]);
    expect(f.requests).toHaveLength(2);
  });

  test("does not accept a body that completes after the deadline", async () => {
    const f = fixture(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        f.advance(180_000);
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    })));
    await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow("visibility budget");
    expect(f.requests).toHaveLength(1);
  });

  test("floors fractional remaining time for the last request signal", async () => {
    const f = fixture((attempt) => {
      if (attempt === 1) { f.advance(176_989.5); return new Response(null, { status: 404 }); }
      return Response.json(document);
    });
    expect(await readNpmAttestations(version, f.runtime)).toEqual(document);
    expect(f.timeouts).toEqual([20_000, 10]);
  });

  test("does not fetch again when a delayed sleep crosses the deadline", async () => {
    const f = fixture(() => new Response(null, { status: 404 }));
    await expect(readNpmAttestations(version, {
      ...f.runtime,
      sleep: async () => { f.advance(180_000); },
    })).rejects.toThrow("visibility budget");
    expect(f.requests).toHaveLength(1);
  });

  test("fails closed if an injected clock is invalid or moves backward", async () => {
    for (const initial of [NaN, Infinity, -1]) {
      const f = fixture(() => Response.json(document));
      await expect(readNpmAttestations(version, { ...f.runtime, now: () => initial }))
        .rejects.toThrow("monotonic clock");
      expect(f.requests).toHaveLength(0);
    }
    const f = fixture(() => { f.advance(-1); return Response.json(document); });
    await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow("monotonic clock");
    expect(f.requests).toHaveLength(1);
  });

  for (const status of [201, 301, 401, 403, 408, 429, 500, 503]) {
    test(`does not retry HTTP ${status}`, async () => {
      const f = fixture(() => new Response(null, { status }));
      await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow(`HTTP ${status}`);
      expect(f.requests).toHaveLength(1);
      expect(f.sleeps).toEqual([]);
    });
  }

  test("does not retry transport failures or request/body aborts", async () => {
    for (const failure of [new TypeError("fetch failed"), new DOMException("timeout", "TimeoutError")]) {
      const f = fixture(() => { throw failure; });
      await expect(readNpmAttestations(version, f.runtime)).rejects.toBe(failure);
      expect(f.requests).toHaveLength(1);
      expect(f.sleeps).toEqual([]);
    }
    const failure = new DOMException("body timeout", "TimeoutError");
    const f = fixture(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure); },
    })));
    await expect(readNpmAttestations(version, f.runtime)).rejects.toBe(failure);
    expect(f.requests).toHaveLength(1);
  });

  test("bounds a nonsettling fetch and never dispatches with an already aborted signal", async () => {
    const entered = Promise.withResolvers<undefined>();
    const controller = new AbortController();
    const failure = new DOMException("request deadline", "TimeoutError");
    const f = fixture(() => {
      entered.resolve(undefined);
      return new Promise<Response>(() => undefined);
    });
    const reading = readNpmAttestations(version, {
      ...f.runtime, timeoutSignal: () => controller.signal,
    });
    await entered.promise;
    controller.abort(failure);
    await expect(reading).rejects.toBe(failure);
    expect(f.requests).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
    const undispatched = fixture(() => Response.json(document));
    await expect(readNpmAttestations(version, {
      ...undispatched.runtime, timeoutSignal: () => controller.signal,
    })).rejects.toBe(failure);
    expect(undispatched.requests).toHaveLength(0);
  });

  test("rejects malformed, invalid UTF-8, and oversized 200 responses without retry", async () => {
    for (const response of [
      new Response("not JSON"),
      new Response(Uint8Array.of(0xff)),
      new Response("{}", { headers: { "content-length": String(512 * 1024 + 1) } }),
      new Response(" ".repeat(512 * 1024 + 1)),
    ]) {
      const f = fixture(() => response);
      await expect(readNpmAttestations(version, f.runtime)).rejects.toThrow();
      expect(f.requests).toHaveLength(1);
      expect(f.sleeps).toEqual([]);
    }
  });

  test("bounds stalled cancellation after an oversized 200 response", async () => {
    const cancellation = Promise.withResolvers<undefined>();
    const controller = new AbortController();
    const failure = new DOMException("body deadline", "TimeoutError");
    const f = fixture(() => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array(512 * 1024 + 1)); },
      cancel() {
        cancellation.resolve(undefined);
        return new Promise<void>(() => undefined);
      },
    })));
    const reading = readNpmAttestations(version, {
      ...f.runtime, timeoutSignal: () => controller.signal,
    });
    await cancellation.promise;
    controller.abort(failure);
    await expect(reading).rejects.toBe(failure);
    expect(f.requests).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
  });

  test("never retries a verifier rejection after a 404 becomes readable", async () => {
    const f = fixture((attempt) => attempt === 1
      ? new Response(null, { status: 404 }) : Response.json(document));
    let verifications = 0;
    const admitted = readNpmAttestations(version, f.runtime).then((value) => {
      verifications += 1;
      return selectNpmProvenanceAttestations(value);
    });
    await expect(admitted).rejects.toThrow("bounded expected attestation set");
    expect(verifications).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(f.sleeps).toEqual([3_000]);
  });

  test("rejects noncanonical or unbounded version input without a request", async () => {
    for (const value of [null, undefined, 1, {}, "", "v0.6.3", "0.06.3", "0.6.3-beta", "0.6.3/latest", "1".repeat(65)]) {
      const f = fixture(() => Response.json(document));
      await expect(readNpmAttestations(value, f.runtime)).rejects.toThrow("exact stable release version");
      expect(f.requests).toHaveLength(0);
    }
  });

  test("maps canonical generated versions only to their fixed exact endpoint", async () => {
    await fc.assert(fc.asyncProperty(
      fc.tuple(fc.nat(), fc.nat(), fc.nat()),
      async (parts) => {
        const releaseVersion = parts.join(".");
        const f = fixture(() => Response.json(document));
        await readNpmAttestations(releaseVersion, f.runtime);
        expect(f.requests.map((request) => request.url)).toEqual([
          `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2foompa@${releaseVersion}`,
        ]);
      },
    ), { numRuns: 100, seed: 6304 });
  });

  test("wires only attestation reads into both admission boundaries", async () => {
    const [publisher, admission, owners] = await Promise.all([
      readFile(join(import.meta.dir, "publish-npm-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "check-public-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "..", ".github", "CODEOWNERS"), "utf8"),
    ]);
    for (const source of [publisher, admission]) {
      expect(source).toContain("attestations: await readNpmAttestations(inspection.version)");
      expect(source).toContain("await verifyNpmProvenance({");
      expect(source).not.toContain("attestationsUrl");
    }
    expect(publisher.match(/await runNpmPublisher\(\{/gu)).toHaveLength(1);
    expect(publisher).toContain("await admitProvenance(transition.attemptPolicy, transition.maximumProvenanceAttempt)");
    expect(publisher).toContain('await admitProvenance("exact", workflowRunAttempt)');
    expect(publisher).toContain('registryKeys: await registryJson(');
    expect(admission).toContain('registryKeys: await json("https://registry.npmjs.org/-/npm/v1/keys"');
    expect(admission).toContain('maximumAttempt: preflightState === "exact" ? preflightRunAttempt : runAttempt');
    expect(owners).toContain("/scripts/read-npm-attestations.ts @0thernet");
  });
});
