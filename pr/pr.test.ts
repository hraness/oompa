import { describe, expect, test } from "bun:test";

import { classifyText, signalId } from "./classify.ts";
import { pulseFetchText } from "./http.ts";
import {
  PR_MUNICIPIOS,
  PR_REGIONS,
  regionsForText,
  regionsForUgc,
} from "./municipalities.ts";
import {
  prHistorySchema,
  prSignalSchema,
  prSnapshotSchema,
  type PrSignal,
} from "./model.ts";
import { parseFeed } from "./parse.ts";
import { collectSnapshot } from "./pipeline.ts";
import { resolvePulseAi } from "./ai.ts";
import { PR_RESOURCES } from "./resources.ts";
import { lumaOutagesSource } from "./sources/luma.ts";
import { nwsPrAlertsSource } from "./sources/nws.ts";
import { usgsQuakesSource } from "./sources/usgs.ts";
import { PULSE_SOURCES } from "./sources/index.ts";
import type { PulseSource, PulseSourceContext } from "./source.ts";

const now = new Date("2026-09-16T18:00:00.000Z");

const signal = (overrides: Partial<PrSignal>): PrSignal => prSignalSchema.parse({
  id: "testsignal-0001",
  source: "test",
  sourceName: "Test source",
  category: "news",
  severity: "info",
  title: "A deterministic test signal",
  regions: ["islandwide"],
  lang: "en",
  ...overrides,
});

describe("signal model", () => {
  test("rejects malformed signals", () => {
    const base = signal({});
    expect(prSignalSchema.safeParse({}).success).toBe(false);
    expect(prSignalSchema.safeParse({ ...base, id: "short" }).success).toBe(false);
    expect(prSignalSchema.safeParse({ ...base, severity: "critical" }).success).toBe(false);
    expect(prSignalSchema.safeParse({ ...base, regions: ["Islandwide!"] }).success).toBe(false);
  });

  test("signalId is stable, prefixed, and bounded", () => {
    const a = signalId("nws", ["alert-1"]);
    const b = signalId("nws", ["alert-1"]);
    const c = signalId("nws", ["alert-2"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("nws-")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(80);
    expect(signalId("x", [])).toMatch(/^x-[a-f0-9]{16}$/u);
  });
});

describe("geography", () => {
  test("covers all 78 municipios and maps each to a known region", () => {
    expect(PR_MUNICIPIOS).toHaveLength(78);
    const regionSet = new Set<string>(PR_REGIONS);
    for (const municipio of PR_MUNICIPIOS) {
      expect(regionSet.has(municipio.region)).toBe(true);
      expect(municipio.slug).toMatch(/^[a-z0-9-]+$/u);
    }
    const slugs = new Set(PR_MUNICIPIOS.map((municipio) => municipio.slug));
    expect(slugs.size).toBe(78);
  });

  test("gazetteer finds municipios and places with accents normalized", () => {
    expect(regionsForText("apagón en Mayagüez")).toEqual(["west"]);
    expect(regionsForText("flooding near El Yunque")).toContain("northeast");
    expect(regionsForText("migrants interdicted in the Mona Passage")).toContain("mona-passage");
    expect(regionsForText("terremoto en Ponce y Guayanilla")).toContain("south");
    expect(regionsForText("nothing relevant")).toEqual([]);
  });

  test("NWS UGC codes map to regions", () => {
    expect(regionsForUgc(["PRZ001", "PRZ013"])).toEqual(["san-juan-metro", "vieques"]);
    expect(regionsForUgc(["AMZ741"])).toEqual(["mona-passage"]);
    expect(regionsForUgc(["XXZ999"])).toEqual([]);
  });
});

describe("classifier", () => {
  test("bumps severity on strong phrases and tags categories", () => {
    const emergency = classifyText("Flash Flood Emergency for Arecibo");
    expect(emergency.severity).toBe("emergency");
    expect(emergency.regions).toContain("northwest");
    const hurricane = classifyText("Aviso de huracán para la costa norte");
    expect(hurricane.severity).toBe("warning");
    const water = classifyText("Racionamiento de agua en embalse Carraízo");
    expect(water.category).toBe("water");
    const outage = classifyText("LUMA reporta avería eléctrica en Bayamón");
    expect(outage.category).toBe("power");
    const quiet = classifyText("Festival de la pana en el casco urbano");
    expect(quiet.severity).toBe("info");
  });
});

describe("feed parser", () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Apagón mayor en la zona metro</title><link>https://example.com/1</link><pubDate>Wed, 16 Sep 2026 12:00:00 GMT</pubDate><description>&lt;b&gt;LUMA&lt;/b&gt; investiga.</description><guid>g-1</guid></item>
    <item><title></title><link></link></item>
  </channel></rss>`;
  const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Sismicidad en el suroeste</title><link href="https://example.com/2"/><updated>2026-09-16T10:00:00Z</updated><summary>Red Sísmica reporta.</summary></entry>
  </feed>`;

  test("parses RSS items and strips markup", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain("Apagón");
    expect(items[0]?.summary).toContain("LUMA");
    expect(items[0]?.summary).not.toContain("<b>");
    expect(items[0]?.publishedAt).toBe("2026-09-16T12:00:00.000Z");
  });

  test("parses Atom entries", () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0]?.link).toBe("https://example.com/2");
  });

  test("bounds the item count and tolerates malformed input", () => {
    const many = `<?xml version="1.0"?><rss><channel>${Array.from({ length: 90 }, (_, i) => `<item><title>t${i.toString()}</title><link>https://e.com/${i.toString()}</link></item>`).join("")}</channel></rss>`;
    expect(parseFeed(many, 40)).toHaveLength(40);
    expect(parseFeed("not xml at all")).toEqual([]);
    expect(parseFeed("<html><body>oops</body></html>")).toEqual([]);
  });
});

describe("http boundary", () => {
  test("rejects non-https URLs without touching the network", async () => {
    await expect(pulseFetchText("http://example.com/feed")).rejects.toThrow("https");
    await expect(pulseFetchText("not a url")).rejects.toThrow("malformed");
  });
});

describe("source adapters", () => {
  const ctx = (text: string): PulseSourceContext => ({
    fetchText: async () => text,
    fetchJson: async () => JSON.parse(text) as unknown,
    now,
  });

  test("LUMA normalizes region rows and computes an island total", async () => {
    const payload = JSON.stringify({
      regions: [
        { name: "Arecibo", totalClients: 100000, totalClientsWithoutService: 8000, percentageClientsWithoutService: 8 },
        { name: "Ponce", totalClients: 90000, totalClientsWithoutService: 300, percentageClientsWithoutService: 0.3 },
        { name: "San Juan", totalClients: 200000, totalClientsWithoutService: 500, percentageClientsWithoutService: 0.25 },
      ],
    });
    const signals = await lumaOutagesSource.collect(ctx(payload));
    const arecibo = signals.find((s) => s.title.startsWith("Arecibo"));
    expect(arecibo?.severity).toBe("watch");
    expect(arecibo?.regions).toEqual(["northwest"]);
    expect(arecibo?.metrics?.["customersOut"]).toBe(8000);
    const total = signals.find((s) => s.title.startsWith("Island total"));
    expect(total?.metrics?.["customersOut"]).toBe(8800);
    expect(total?.regions).toEqual(["islandwide"]);
    for (const s of signals) expect(prSignalSchema.safeParse(s).success).toBe(true);
  });

  test("LUMA stays quiet when outages are trivial", async () => {
    const payload = JSON.stringify({
      regions: [{ name: "Ponce", totalClients: 90000, totalClientsWithoutService: 50, percentageClientsWithoutService: 0.05 }],
    });
    const signals = await lumaOutagesSource.collect(ctx(payload));
    expect(signals.filter((s) => s.title.startsWith("Ponce"))).toHaveLength(0);
    expect(signals.some((s) => s.title.startsWith("Island total"))).toBe(true);
  });

  test("NWS alerts map CAP severity and UGC zones", async () => {
    const payload = JSON.stringify({
      features: [{
        id: "urn:oid:example.1",
        properties: {
          event: "Flash Flood Warning",
          severity: "Severe",
          headline: "Flash Flood Warning for Caguas",
          description: "Heavy rain.",
          areaDesc: "Caguas",
          onset: "2026-09-16T15:00:00-04:00",
          expires: "2026-09-16T21:00:00-04:00",
          geocode: { UGC: ["PRZ004"] },
        },
      }],
    });
    const signals = await nwsPrAlertsSource.collect(ctx(payload));
    expect(signals).toHaveLength(1);
    const alert = signals[0];
    expect(alert?.severity).toBe("warning");
    expect(alert?.category).toBe("flood");
    expect(alert?.regions).toEqual(["central-east"]);
    expect(alert?.expiresAt).toBe("2026-09-16T21:00:00-04:00");
    expect(alert?.url).toContain("alerts.weather.gov");
  });

  test("USGS filters non-earthquakes and scores magnitude", async () => {
    const payload = JSON.stringify({
      features: [
        { id: "us7000abc", properties: { mag: 5.4, place: "10 km SSW of Guánica, Puerto Rico", time: 1789742400000, tsunami: 1, type: "earthquake", url: "https://earthquake.usgs.gov/x", felt: 250 } },
        { id: "quarry1", properties: { mag: 0.4, place: "quarry blast", time: 1789742400000, type: "quarry blast" } },
      ],
    });
    const signals = await usgsQuakesSource.collect(ctx(payload));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe("warning");
    expect(signals[0]?.category).toBe("seismic");
    expect(signals[0]?.regions).toContain("southwest");
    expect(signals[0]?.metrics?.["magnitude"]).toBe(5.4);
  });

  test("every registered source has unique id, https homepage and a known category", () => {
    const ids = new Set(PULSE_SOURCES.map((source) => source.id));
    expect(ids.size).toBe(PULSE_SOURCES.length);
    for (const source of PULSE_SOURCES) {
      expect(source.homepage.startsWith("https://")).toBe(true);
      expect(source.id).toMatch(/^[a-z0-9-]+$/u);
      expect(source.name.length).toBeGreaterThan(2);
    }
  });
});

describe("pipeline", () => {
  const okSource = (id: string, signals: readonly PrSignal[]): PulseSource => ({
    id,
    name: `Fixture ${id}`,
    category: "news",
    homepage: "https://example.com/",
    collect: async () => signals,
  });
  const failingSource = (id: string): PulseSource => ({
    id,
    name: `Fixture ${id}`,
    category: "power",
    homepage: "https://example.com/",
    collect: async () => { throw new Error("simulated outage"); },
  });

  test("collects, dedupes, classifies, and isolates source failures", async () => {
    const shared = signal({ id: "dup-shared-000001", title: "Shared event" });
    const snapshot = await collectSnapshot({
      now,
      ai: null,
      sources: [
        okSource("a-ok", [
          shared,
          signal({ id: "second-signal-0002", title: "Terremoto en Ponce", regions: [] }),
        ]),
        okSource("b-ok", [shared]),
        failingSource("c-down"),
      ],
    });
    expect(snapshot.schema).toBe(1);
    expect(snapshot.aiStatus).toBe("disabled");
    expect(snapshot.signals.map((s) => s.id)).toEqual(["dup-shared-000001", "second-signal-0002"]);
    const ponce = snapshot.signals.find((s) => s.id === "second-signal-0002");
    expect(ponce?.regions).toEqual(["south"]);
    expect(ponce?.category).toBe("news");
    const health = Object.fromEntries(snapshot.health.map((h) => [h.id, h]));
    expect(health["a-ok"]?.ok).toBe(true);
    expect(health["a-ok"]?.signalCount).toBe(2);
    expect(health["c-down"]?.ok).toBe(false);
    expect(health["c-down"]?.error).toContain("simulated outage");
    expect(health["c-down"]?.homepage).toBe("https://example.com/");
    expect(prSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test("a hanging source is fenced by the time budget", async () => {
    const hanging: PulseSource = {
      id: "hanging",
      name: "Fixture hanging",
      category: "news",
      homepage: "https://example.com/",
      collect: () => new Promise<readonly PrSignal[]>(() => {}),
    };
    const started = Date.now();
    const snapshot = await collectSnapshot({ now, ai: null, sourceBudgetMs: 60, sources: [hanging] });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(snapshot.health[0]?.ok).toBe(false);
    expect(snapshot.health[0]?.error).toContain("budget");
  });

  test("drops signals that fail schema validation", async () => {
    const snapshot = await collectSnapshot({
      now,
      ai: null,
      sources: [okSource("a-ok", [{ ...signal({ id: "ok-signal-00001" }), id: "x" }])],
    });
    expect(snapshot.signals).toHaveLength(0);
    expect(snapshot.health[0]?.ok).toBe(true);
  });
});

describe("ai gating", () => {
  test("is disabled without keys or with an explicit none", () => {
    expect(resolvePulseAi({})).toBeNull();
    expect(resolvePulseAi({ PR_PULSE_AI_PROVIDER: "none", ANTHROPIC_API_KEY: "sk-ant-x" })).toBeNull();
    expect(resolvePulseAi({ PR_PULSE_AI_PROVIDER: "auto" })).toBeNull();
  });
  test("selects a provider only with its key present", () => {
    expect(resolvePulseAi({ ANTHROPIC_API_KEY: "sk-ant-x" })?.provider).toBe("anthropic");
    expect(resolvePulseAi({ OPENAI_API_KEY: "sk-x" })?.provider).toBe("openai");
    expect(resolvePulseAi({ PR_PULSE_AI_PROVIDER: "openai" })).toBeNull();
    expect(resolvePulseAi({ PR_PULSE_AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-x", PR_PULSE_AI_MODEL: "gpt-5-nano" })?.model).toBe("gpt-5-nano");
  });
});

describe("history schema", () => {
  test("accepts bounded points", () => {
    expect(prHistorySchema.safeParse({ schema: 1, points: [] }).success).toBe(true);
    expect(prHistorySchema.safeParse({
      schema: 1,
      points: [{ ts: "2026-09-16T18:00:00Z", signals: 10, emergency: 0, warning: 1, watch: 2, unhealthySources: 0 }],
    }).success).toBe(true);
  });
});

describe("resource directory", () => {
  test("all links are https with labels", () => {
    for (const group of PR_RESOURCES) {
      expect(group.heading.length).toBeGreaterThan(4);
      for (const link of group.links) {
        expect(link.url.startsWith("https://")).toBe(true);
        expect(link.label.length).toBeGreaterThan(1);
      }
    }
  });
});
