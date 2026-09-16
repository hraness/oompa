import rawSnapshot from "../pr/data/snapshot.json" with { type: "json" };
import rawHistory from "../pr/data/history.json" with { type: "json" };

import {
  PR_CATEGORIES,
  prHistorySchema,
  prSnapshotSchema,
  type PrCategory,
  type PrSeverity,
  type PrSignal,
  type PrSnapshot,
} from "../pr/model.ts";
import { PR_REGION_LABELS, type PrRegion } from "../pr/municipalities.ts";
import { PR_RESOURCES } from "../pr/resources.ts";
import { prClasses, type PrSlot } from "./pr.stylex.ts";
import { sitePresentationClasses } from "./presentation.stylex.ts";
import { renderMarketingHeader } from "./marketing.tsx";
import {
  escapeHtml,
  paletteAttributes,
  renderHead,
  renderOompaAnalyticsScript,
  renderOompaSiteFooter,
} from "./template.ts";
import { publicContent, type PublicContent } from "./content.ts";

const CATEGORY_LABELS: Readonly<Record<PrCategory, string>> = {
  power: "Power",
  water: "Water",
  weather: "Weather",
  seismic: "Seismic",
  tsunami: "Tsunami",
  flood: "Flooding",
  health: "Health",
  transport: "Transport",
  comms: "Connectivity",
  fuel: "Fuel",
  supply: "Supply chain",
  regional: "Caribbean & geopolitics",
  climate: "Climate & ENSO",
  news: "News desk",
  official: "Official",
};

const SEVERITY_LABELS: Readonly<Record<PrSeverity, string>> = {
  emergency: "Emergency",
  warning: "Warning",
  watch: "Watch",
  advisory: "Advisory",
  info: "Informational",
};

const SEVERITY_BADGE: Readonly<Record<PrSeverity, PrSlot>> = {
  emergency: "badgeEmergency",
  warning: "badgeWarning",
  watch: "badgeWatch",
  advisory: "badgeAdvisory",
  info: "badgeInfo",
};

const SEVERITY_ORDER: readonly PrSeverity[] = ["emergency", "warning", "watch", "advisory", "info"];

const REGION_ORDER: readonly PrRegion[] = [
  "islandwide", "san-juan-metro", "north", "northeast", "east", "southeast", "south",
  "southwest", "west", "northwest", "central", "central-east", "vieques", "culebra",
  "mona-passage", "waters-north", "waters-south", "waters-east", "waters-northwest",
  "waters-southwest", "offshore", "usvi", "caribbean", "atlantic",
];

const number = new Intl.NumberFormat("en-US");

const relativeTime = (iso: string, now: Date): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown time";
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes.toString()}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours.toString()}h ago`;
  return `${Math.round(hours / 24).toString()}d ago`;
};

const metricLabels: Readonly<Record<string, string>> = {
  customersOut: "customers out",
  customersTotal: "customers tracked",
  percentOut: "% without service",
  magnitude: "magnitude",
  felt: "felt reports",
  windsKt: "winds (kt)",
  pressureMb: "pressure (mb)",
  gageFeet: "gage (ft)",
  waterLevelM: "water level (m)",
  residualM: "surge residual (m)",
  dropPct: "% vs baseline",
  gaugesReporting: "gauges",
  reservoirsTracked: "reservoirs",
  linkedReports: "reports",
  current: "current",
  baseline: "baseline",
};

const renderMetricsInline = (metrics: PrSignal["metrics"]): string => {
  if (metrics === undefined) return "";
  const parts = Object.entries(metrics)
    .filter(([key]) => metricLabels[key] !== undefined)
    .slice(0, 5)
    .map(([key, value]) => `${escapeHtml(metricLabels[key] ?? key)} ${escapeHtml(number.format(Math.round(value * 100) / 100))}`);
  return parts.length === 0 ? "" : `<span aria-hidden="true">·</span> ${parts.join(" · ")}`;
};

const renderSignal = (signal: PrSignal, now: Date): string => {
  const title = signal.titleEn ?? signal.title;
  const summary = signal.summaryEn ?? signal.summary;
  const search = `${signal.title} ${signal.titleEn ?? ""} ${signal.summary ?? ""} ${signal.summaryEn ?? ""} ${signal.sourceName}`.toLowerCase().slice(0, 1200);
  const time = signal.issuedAt === undefined
    ? ""
    : `<time datetime="${escapeHtml(signal.issuedAt)}" title="${escapeHtml(signal.issuedAt)}">${escapeHtml(relativeTime(signal.issuedAt, now))}</time>`;
  const regionChips = signal.regions
    .map((region) => PR_REGION_LABELS[region as PrRegion])
    .slice(0, 5)
    .map((label) => `<span class="${prClasses("regionChip")}">${escapeHtml(label)}</span>`)
    .join("");
  return `<article class="${prClasses("signal")}" data-pr-signal data-pr-category="${escapeHtml(signal.category)}" data-pr-regions="${escapeHtml(signal.regions.join(" "))}" data-pr-severity="${escapeHtml(signal.severity)}" data-pr-search="${escapeHtml(search)}">
  <div class="${prClasses("signalTop")}">
    <span class="${prClasses("badge", SEVERITY_BADGE[signal.severity])}">${escapeHtml(SEVERITY_LABELS[signal.severity])}</span>
    <span class="${prClasses("signalMeta")}">${escapeHtml(CATEGORY_LABELS[signal.category])}<span aria-hidden="true">·</span>${escapeHtml(signal.sourceName)}${signal.lang === "es" ? '<span aria-hidden="true">·</span><span lang="es">ES</span>' : ""}${time === "" ? "" : `<span aria-hidden="true">·</span>${time}`}</span>
  </div>
  <h3 class="${prClasses("signalTitle")}">${signal.url === undefined ? escapeHtml(title) : `<a class="${prClasses("sourceLink")}" href="${escapeHtml(signal.url)}">${escapeHtml(title)}</a>`}</h3>
  ${summary === undefined ? "" : `<p class="${prClasses("signalSummary")}">${escapeHtml(summary.slice(0, 700))}</p>`}
  <div class="${prClasses("signalMeta")}">${regionChips}${renderMetricsInline(signal.metrics)}</div>
</article>`;
};

const renderSparkline = (history: readonly { ts: string; signals: number; warning: number; emergency: number }[]): string => {
  const points = history.slice(-96);
  if (points.length < 2) return "";
  const width = 640;
  const height = 90;
  const pad = 6;
  const maxSignals = Math.max(1, ...points.map((point) => point.signals));
  const maxAlert = Math.max(1, ...points.map((point) => point.warning + point.emergency));
  const x = (index: number): number => pad + (index / (points.length - 1)) * (width - pad * 2);
  const line = (values: readonly number[], max: number): string =>
    values.map((value, index) => `${x(index).toFixed(1)},${(height - pad - (value / max) * (height - pad * 2)).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  return `<svg class="${prClasses("sparkline")}" viewBox="0 0 ${width.toString()} ${height.toString()}" role="img" aria-label="Signals and alert counts over the last ${points.length.toString()} refreshes">
  <polyline fill="none" stroke="var(--muted)" stroke-width="1.5" opacity="0.8" points="${line(points.map((p) => p.signals), maxSignals)}"/>
  <polyline fill="none" stroke="var(--link)" stroke-width="1.5" points="${line(points.map((p) => p.warning + p.emergency), maxAlert)}"/>
  ${first === undefined || last === undefined ? "" : `<text x="${pad.toString()}" y="${(height - 1).toString()}" font-size="9" fill="var(--muted)">${escapeHtml(first.ts.slice(0, 10))}</text><text x="${(width - pad).toString()}" y="${(height - 1).toString()}" font-size="9" fill="var(--muted)" text-anchor="end">${escapeHtml(last.ts.slice(0, 10))}</text>`}
</svg>`;
};

export const renderPrHtml = (content: PublicContent = publicContent): string => {
  const snapshot: PrSnapshot = prSnapshotSchema.parse(rawSnapshot);
  const history = prHistorySchema.parse(rawHistory);
  const now = new Date(snapshot.generatedAt);

  const presentRegions = new Set<string>();
  const presentCategories = new Set<PrCategory>();
  for (const signal of snapshot.signals) {
    presentCategories.add(signal.category);
    for (const region of signal.regions) presentRegions.add(region);
  }
  const regionChips = REGION_ORDER.filter((region) => presentRegions.has(region));
  const categoryChips = PR_CATEGORIES.filter((category) => presentCategories.has(category));

  const grouped = SEVERITY_ORDER
    .map((severity) => ({ severity, signals: snapshot.signals.filter((signal) => signal.severity === severity).slice(0, 120) }))
    .filter(({ signals }) => signals.length > 0);

  const metrics = snapshot.metrics;
  const sourcesOk = snapshot.health.filter((source) => source.ok).length;
  const metricCards: readonly { label: string; value: number | string | undefined }[] = [
    { label: "customers without power", value: metrics["customersOut"] },
    { label: "earthquakes · 24h", value: metrics["quakes24h"] },
    { label: "warnings & watches", value: (metrics["warningSignals"] ?? 0) + (metrics["watchSignals"] ?? 0) + (metrics["emergencySignals"] ?? 0) },
    { label: "sources reporting", value: `${sourcesOk.toString()}/${snapshot.health.length.toString()}` },
  ];

  const healthRows = snapshot.health.map((source) => `<tr>
  <td class="${prClasses("healthCell")}"><span class="${prClasses(source.ok ? "statusOk" : "statusFail")}" aria-label="${source.ok ? "ok" : "failing"}">${source.ok ? "●" : "●"}</span></td>
  <td class="${prClasses("healthCell")}"><a class="${prClasses("sourceLink")}" href="${escapeHtml(source.homepage)}" data-source-id="${escapeHtml(source.id)}">${escapeHtml(source.name)}</a></td>
  <td class="${prClasses("healthCell")}">${escapeHtml(CATEGORY_LABELS[source.category])}</td>
  <td class="${prClasses("healthCell")}">${source.signalCount.toString()}</td>
  <td class="${prClasses("healthCell")}">${(source.latencyMs / 1000).toFixed(1)}s</td>
  <td class="${prClasses("healthCell")}">${escapeHtml(source.error ?? "")}</td>
</tr>`).join("\n");

  const description = "A public situational-awareness board for Puerto Rico: power, water, weather, seismic, maritime, connectivity, health, and regional risk signals in one place.";

  return `<!doctype html>
<html ${paletteAttributes} data-hraness-material="lantern" lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/pr/",
  description,
  title: "Puerto Rico pulse | hraness",
  jsonLd: {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Puerto Rico pulse",
    description,
    url: `${content.siteUrl}/pr/`,
    about: { "@type": "Place", name: "Puerto Rico" },
    dateModified: snapshot.generatedAt,
    isPartOf: { "@type": "WebSite", name: content.productName, url: content.siteUrl },
  },
})}
</head>
<body>
<a class="${["skip-link", sitePresentationClasses("skipLink", "focusable")].join(" ")}" href="#content">Skip to content</a>
${renderMarketingHeader(content, "/pr/")}
<main id="content" class="${prClasses("page")}" data-pr-root>
  <header>
    <p class="${prClasses("eyebrow")}">hraness · situational awareness</p>
    <h1 class="${prClasses("title")}">Puerto Rico pulse</h1>
    <p class="${prClasses("lede")}">Power, water, weather, seismic, maritime, connectivity, health, and regional signals for the island, refreshed by an automated collector.</p>
    <p class="${prClasses("ledeEs")}" lang="es">Señales de energía, agua, clima, sismos, transporte marítimo, conectividad y salud para Puerto Rico, actualizadas automáticamente.</p>
    <p class="${prClasses("meta")}">Snapshot <time datetime="${escapeHtml(snapshot.generatedAt)}">${escapeHtml(snapshot.generatedAt.replace("T", " ").slice(0, 19))} UTC</time> · ${snapshot.signals.length.toString()} signals · data refreshed roughly every 15 minutes</p>
  </header>
  <aside class="${prClasses("disclaimer")}" aria-label="Important notice"><strong>This board is not an official emergency source.</strong> In a life-safety emergency call <strong>911</strong> and follow NMEAD, NWS San Juan, and your municipio's official instructions. Signals are automated summaries from public sources. Always open the linked source before acting.</aside>
  ${snapshot.brief === null ? "" : `<section class="${prClasses("brief")}" aria-label="Situation summary">
    <p class="${prClasses("briefLabel")}">Situation brief · AI-assisted (${escapeHtml(snapshot.brief.provider)} ${escapeHtml(snapshot.brief.model)})</p>
    <p class="${prClasses("briefText")}">${escapeHtml(snapshot.brief.text)}</p>
    ${snapshot.brief.textEs === undefined ? "" : `<p class="${prClasses("briefTextEs")}" lang="es">${escapeHtml(snapshot.brief.textEs)}</p>`}
  </section>`}
  <ul class="${prClasses("metrics")}" aria-label="Key metrics">
    ${metricCards.map(({ label, value }) => `<li class="${prClasses("metric")}"><span class="${prClasses("metricValue")}">${value === undefined ? "–" : escapeHtml(typeof value === "number" ? number.format(value) : value)}</span><span class="${prClasses("metricLabel")}">${escapeHtml(label)}</span></li>`).join("\n    ")}
  </ul>
  <form class="${prClasses("filters")}" data-pr-filters hidden aria-label="Filter signals">
    <fieldset class="${prClasses("filterGroup")}"><legend class="${prClasses("filterLegend")}">Category</legend><div class="${prClasses("chips")}">${categoryChips.map((category) => `<button class="${prClasses("chip")}" type="button" data-pr-filter="category" data-pr-value="${escapeHtml(category)}" aria-pressed="false">${escapeHtml(CATEGORY_LABELS[category])}</button>`).join("")}</div></fieldset>
    <fieldset class="${prClasses("filterGroup")}"><legend class="${prClasses("filterLegend")}">Region</legend><div class="${prClasses("chips")}">${regionChips.map((region) => `<button class="${prClasses("chip")}" type="button" data-pr-filter="region" data-pr-value="${escapeHtml(region)}" aria-pressed="false">${escapeHtml(PR_REGION_LABELS[region])}</button>`).join("")}</div></fieldset>
    <input class="${prClasses("searchInput")}" type="search" data-pr-search placeholder="Search signals… / Buscar señales…" autocomplete="off" maxlength="120" aria-label="Search signals">
    <p class="${prClasses("filterStatus")}" data-pr-status role="status">${snapshot.signals.length.toString()} signals</p>
  </form>
  <section class="${prClasses("section")}" id="signals" aria-labelledby="signals-heading">
    <h2 class="${prClasses("sectionHeading")}" id="signals-heading">Signals</h2>
    <p class="${prClasses("sectionNote")}">Sorted by severity, newest first. Spanish-language items carry an <span lang="es">ES</span> marker.</p>
    ${grouped.map(({ severity, signals }) => `<section aria-label="${escapeHtml(SEVERITY_LABELS[severity])} signals" data-pr-severity-group="${escapeHtml(severity)}">
      <h3>${escapeHtml(SEVERITY_LABELS[severity])} · ${signals.length.toString()}</h3>
      <div class="${prClasses("signalList")}">${signals.map((signal) => renderSignal(signal, now)).join("\n")}</div>
    </section>`).join("\n")}
    <p class="${prClasses("filterStatus")}" data-pr-empty hidden>No signals match the current filters.</p>
  </section>
  <section class="${prClasses("section")}" id="sources" aria-labelledby="sources-heading">
    <h2 class="${prClasses("sectionHeading")}" id="sources-heading">Sources</h2>
    <p class="${prClasses("sectionNote")}">${sourcesOk.toString()} of ${snapshot.health.length.toString()} collectors succeeded in this snapshot. Failures are shown, not hidden: a missing source can mean a rate limit, an outage, or a changed endpoint.</p>
    <table class="${prClasses("healthTable")}"><thead><tr><th class="${prClasses("healthCell", "healthHead")}" scope="col">Status</th><th class="${prClasses("healthCell", "healthHead")}" scope="col">Source</th><th class="${prClasses("healthCell", "healthHead")}" scope="col">Area</th><th class="${prClasses("healthCell", "healthHead")}" scope="col">Signals</th><th class="${prClasses("healthCell", "healthHead")}" scope="col">Latency</th><th class="${prClasses("healthCell", "healthHead")}" scope="col">Note</th></tr></thead><tbody>${healthRows}</tbody></table>
  </section>
  <section class="${prClasses("section")}" id="trend" aria-labelledby="trend-heading">
    <h2 class="${prClasses("sectionHeading")}" id="trend-heading">Recent trend</h2>
    <p class="${prClasses("sectionNote")}">Total signals (gray) and warning+emergency count (blue) per refresh.</p>
    ${renderSparkline(history.points)}
  </section>
  <section class="${prClasses("section")}" id="resources" aria-labelledby="resources-heading">
    <h2 class="${prClasses("sectionHeading")}" id="resources-heading">Resources</h2>
    <p class="${prClasses("sectionNote")}">Official, utility, and community links, curated rather than exhaustive.</p>
    <div class="${prClasses("resourceGroups")}">${PR_RESOURCES.map((group) => `<div class="${prClasses("resourceGroup")}"><h3 class="${prClasses("resourceHeading")}">${escapeHtml(group.heading)}</h3><ul class="${prClasses("resourceList")}">${group.links.map((link) => `<li class="${prClasses("resourceItem")}"><a class="${prClasses("sourceLink")}" href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>${link.note === undefined ? "" : `<span class="${prClasses("resourceNote")}">${escapeHtml(link.note)}</span>`}</li>`).join("\n")}</ul></div>`).join("\n")}</div>
  </section>
  <section class="${prClasses("section")}" id="methodology" aria-labelledby="methodology-heading">
    <h2 class="${prClasses("sectionHeading")}" id="methodology-heading">How this works</h2>
    <p class="${prClasses("methodology")}">A scheduled collector polls official feeds, public APIs, and open OSINT indexes (NWS, NHC, USGS, NOAA, FEMA, LUMA, AAA, USCG/DVIDS, IODA, GDACS, GDELT, FCC, CDC, PR Salud, and Puerto Rico newsrooms), normalizes each item into a typed signal with severity, regions, provenance, and a source link, then rebuilds this page. An optional AI pass translates Spanish items and writes the situation brief; it is labeled and never overrides an official severity. Source failures appear in the table above rather than being silently dropped. The raw snapshot is published at <a class="${prClasses("sourceLink")}" href="/pr/data/snapshot.json">/pr/data/snapshot.json</a>.</p>
  </section>
</main>
${renderOompaSiteFooter()}
${renderOompaAnalyticsScript()}
<script src="/site.js" type="module"></script>
</body>
</html>
`;
};
