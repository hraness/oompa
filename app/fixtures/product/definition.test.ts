import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseDirectSessionManifest } from "@hraness/direct/testing";
import { interactionAffordance, orderSessionCards } from "../../src/model/session-view";
import {
  createProductPreviewSession, parseProductPreviewSelection, parseProductPreviewWorld, PRODUCT_PREVIEW_VIEWS,
} from "./definition";
import { createProductObservations, PRODUCT_PREVIEW_NOW, PRODUCT_SESSION_IDS } from "./fixtures";
import { installProductPreviewHarness, mountOompaAppearanceMenu, readProductPreviewHarness, useCustody, useSessionHead, useSessionModel, useSubmitCommand } from "./io";

describe("isolated real-screen product examples", () => {
  test("admits exactly four fixed, quiescent rendering-only scenarios", () => {
    for (const view of PRODUCT_PREVIEW_VIEWS) {
      const result = createProductPreviewSession(view);
      if (!result.ok) throw new Error(result.error.message);
      const session = result.value;
      try {
        expect(session.harness.view).toBe(view);
        expect(session.clock.now()).toBe(PRODUCT_PREVIEW_NOW);
        expect(session.manifest.scenarios.map(({ id }) => String(id))).toEqual(PRODUCT_PREVIEW_VIEWS.map((id) => `product.${id}`));
        expect(parseDirectSessionManifest(session.manifest).ok).toBe(true);
        expect(session.manifest.coverage.entries[0]?.claim).toContain("inert examples prove rendering only");
        expect(session.probe.isQuiescent()).toEqual({ ok: true, value: true });
      } finally { session.dispose(); }
      expect(session.disposalErrors()).toEqual([]);
      expect(() => session.harness.assertOpen()).toThrow("closed");
    }
  });

  test("strict view selection has no silent default or Direct override", () => {
    for (const view of PRODUCT_PREVIEW_VIEWS) expect(parseProductPreviewSelection(`?view=${view}`)).toBe(view);
    for (const query of ["", "?view=", "?view=missing", "?view=overview&view=settings", "?view=overview&__direct_world={}", "?__direct_scenario=product.overview", "?view=conversation&account=live", `?view=${"a".repeat(2_048)}`]) {
      expect(() => parseProductPreviewSelection(query)).toThrow();
    }
    for (const value of [null, [], Object.create(null), { version: 2, view: "overview" }, { version: 1, view: "missing" }, { version: 1, view: "overview", live: true }, { version: 1, view: "overview", [Symbol("extra")]: true }]) {
      expect(() => parseProductPreviewWorld(value)).toThrow();
    }
    let accessed = false;
    expect(() => parseProductPreviewWorld({ version: 1, get view() { accessed = true; return "overview"; } })).toThrow();
    expect(accessed).toBe(false);
    fc.assert(fc.property(fc.string(), (view) => {
      const allowed = (PRODUCT_PREVIEW_VIEWS as readonly string[]).includes(view);
      if (allowed) expect(parseProductPreviewSelection(`?view=${encodeURIComponent(view)}`) === view).toBe(true);
      else expect(() => parseProductPreviewSelection(`?view=${encodeURIComponent(view)}`)).toThrow();
    }), { numRuns: 100, seed: 20260908 });
  });

  test("real reducers differentiate attention, working and done without inventing remote approval", () => {
    const { heads, models, registries } = createProductObservations(PRODUCT_PREVIEW_NOW);
    const summaries = heads.map((head) => {
      const model = models[head.publicId]!.model;
      return { archived: false, attention: model.attention, lastActivityAt: model.lastActivityAt, metadataRevision: 1, publicId: head.publicId, state: model.state, title: model.title! };
    });
    expect(orderSessionCards(summaries, []).map(({ publicId }) => publicId)).toEqual([
      PRODUCT_SESSION_IDS.question, PRODUCT_SESSION_IDS.conversation, PRODUCT_SESSION_IDS.completed,
    ]);
    const question = models[PRODUCT_SESSION_IDS.question]!.model.pendingInteractions[0]!;
    const actions = interactionAffordance(question.remotePolicy, PRODUCT_PREVIEW_NOW);
    expect(question.interactionKind).toBe("user_input");
    expect(actions.actions).toEqual(["answer"]);
    expect(actions.questions[0]?.allowsOther).toBe(false);
    expect(actions.questions[0]?.options.map(({ label }) => label)).toEqual(["CSV", "JSON"]);
    expect(actions.reasonCodes).toEqual([]);
    expect(registries.machines.map(({ online }) => online)).toEqual([true, false]);
    expect(registries.machines.every(({ accountLinkingAllowed }) => !accountLinkingAllowed)).toBe(true);
    expect(models[PRODUCT_SESSION_IDS.conversation]!.model.subagents).toHaveLength(1);
    expect(() => createProductObservations(PRODUCT_PREVIEW_NOW + 1)).toThrow("fixed clock");
  });

  test("fixture IO requires an owner, never returns credentials, refuses effects, and closes", async () => {
    expect(() => readProductPreviewHarness()).toThrow("not installed");
    const result = createProductPreviewSession("conversation");
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value;
    const release = installProductPreviewHarness(session.harness);
    try {
      expect(() => installProductPreviewHarness(session.harness)).toThrow("already owns");
      const head = useSessionHead(PRODUCT_SESSION_IDS.conversation);
      expect(useSessionModel(head, { history: "full" }).model.title).toBe("Polish the checkout");
      expect(() => useSessionHead("unknown")).toThrow("Unknown");
      expect(useCustody().state).toBe("unenrolled");
      expect(Object.hasOwn(useCustody(), "key")).toBe(false);
      await expect(useSubmitCommand()({ executionDevicePublicId: head!.executionDevicePublicId, payload: { kind: "stop" }, sessionPublicId: head!.publicId })).rejects.toThrow("No command was sent");
      expect(session.harness.refusedEffects()).toBe(1);
      expect(session.probe.snapshot()).toMatchObject({ ok: true, value: { violations: { "example.refusedEffect": 1 } } });
      session.dispose();
      expect(() => readProductPreviewHarness()).toThrow("closed");
    } finally { release(); session.dispose(); }
    expect(() => readProductPreviewHarness()).toThrow("not installed");
  });

  test("the real appearance menu acquires no document, storage or event authority in a product example", () => {
    let accessed = false;
    const menu = new Proxy({} as HTMLDetailsElement, { get() { accessed = true; throw new Error("Appearance IO was accessed"); } });
    expect(() => mountOompaAppearanceMenu(menu)).toThrow("not installed");
    const result = createProductPreviewSession("settings");
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value;
    const release = installProductPreviewHarness(session.harness);
    try {
      const unmount = mountOompaAppearanceMenu(menu);
      expect(unmount()).toBeUndefined();
      expect(unmount()).toBeUndefined();
      expect(accessed).toBe(false);
      expect(session.harness.refusedEffects()).toBe(0);
      session.dispose();
      expect(() => mountOompaAppearanceMenu(menu)).toThrow("closed");
    } finally { release(); session.dispose(); }
    expect(accessed).toBe(false);
  });
});
