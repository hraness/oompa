import { regionsForText, type PrRegion } from "./municipalities.ts";
import type { PrCategory, PrSeverity } from "./model.ts";

interface Rule {
  readonly pattern: RegExp;
  readonly severity?: PrSeverity;
  readonly category?: PrCategory;
  readonly regions?: readonly PrRegion[];
}

/**
 * Deterministic baseline classification. Adapters that already know their
 * category keep it; these rules fill gaps and bump severity on strong phrases.
 * Spanish NWS terms map Aviso→warning, Vigilancia→watch, Advertencia→advisory.
 */
const RULES: readonly Rule[] = [
  { pattern: /\b(?:flash flood emergency|tsunami warning|extreme wind warning|storm surge warning|hurricane warning)\b/iu, severity: "emergency" },
  { pattern: /\b(?:aviso de (?:hurac[aá]n|tormenta|inundaci[oó]n repentina|tsunami|maremoto)|emergencia)\b/iu, severity: "warning" },
  { pattern: /\b(?:warning|aviso)\b/iu, severity: "warning" },
  { pattern: /\b(?:watch|vigilancia)\b/iu, severity: "watch" },
  { pattern: /\b(?:advisory|advertencia|alerta)\b/iu, severity: "advisory" },

  { pattern: /\btsunami|maremoto\b/iu, category: "tsunami", severity: "warning" },
  { pattern: /\b(?:terremoto|temblor|earthquake|sismo|r[eé]plica|aftershock|magnitud|sismi)\w*/iu, category: "seismic" },
  { pattern: /\b(?:flash flood|inundaci[oó]n(?: repentina)?|riada|crecida|flood|desbord\w*)\b/iu, category: "flood" },
  { pattern: /\b(?:apag[oó]n(?:es)?|luma|aver[ií]a el[eé]ctrica|genera pr|prepa\b|aee\b|load shed|blackout|power outage|subestaci[oó]n|transformador|megavati)/iu, category: "power" },
  { pattern: /\b(?:acueducto|prasa|agua potable|hervir el agua|boil water|embalse|reservoir|racionamiento|interrupci[oó]n de (?:servicio|agua))\b/iu, category: "water" },
  { pattern: /\b(?:hurricane|hurac[aá]n|tropical (?:storm|depression|wave)|tormenta tropical|depresi[oó]n tropical|onda tropical|calor|heat|thunderstorm|tronada|corriente de resaca|rip current|viento sostenido)\b/iu, category: "weather" },
  { pattern: /\b(?:dengue|salud|epidemia|outbreak|virus|covid|influenza|gripe|leptospiros|arbovir|chikungunya|oropouche)\w*/iu, category: "health" },
  { pattern: /\b(?:ferr(?:y|ies)|lancha|aeropuerto|airport|vuelo|flight|carretera|road closure|dtop|autopista|peaje|puerto\b|port condition|condici[oó]n de puerto)\b/iu, category: "transport" },
  { pattern: /\b(?:internet|cell(?:ular)?|antena|telecom|fibra|broadband|liberty|claro|t-mobile|at&t|red celular|servicio de datos)\b/iu, category: "comms" },
  { pattern: /\b(?:gasolin|combustible|diesel|petr[oó]leo|petroleum|refiner|tanker|buque tanque|glp|propano|propane|crude)\w*/iu, category: "fuel" },
  { pattern: /\b(?:supply chain|cadena de suministro|cadena de suministros|desabastecimiento|shortage|escasez|importaci[oó]n|import|export|freight|carga mar[ií]tima|container|contenedor|aduanas|customs|jones act)\b/iu, category: "supply" },
  { pattern: /\b(?:el ni[nñ]o|la ni[nñ]a|enso|sequ[ií]a|drought|sargass|sargazo|saharan dust|polvo del sahara|climate outlook|perspectiva clim[aá]tica|temporada de huracanes|hurricane season)\b/iu, category: "climate" },
  { pattern: /\b(?:cuba|venezuela|hait[ií]|rep[uú]blica dominicana|dominican|migrante|interdic|caribe|caribbean|lesser antilles|antillas)\b/iu, category: "regional" },
  { pattern: /\b(?:nmead|fema|declaraci[oó]n de (?:desastre|emergencia)|disaster declaration|emergency declaration|estado de emergencia|orden ejecutiva|executive order|gobierno de puerto rico)\b/iu, category: "official" },
];

export interface Classification {
  readonly category: PrCategory | undefined;
  readonly severity: PrSeverity;
  readonly regions: readonly PrRegion[];
}

export const classifyText = (
  title: string,
  summary = "",
): Classification => {
  const text = `${title} ${summary}`;
  let severity: PrSeverity = "info";
  let category: PrCategory | undefined;
  const rank = { info: 0, advisory: 1, watch: 2, warning: 3, emergency: 4 } as const;
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.severity !== undefined && rank[rule.severity] > rank[severity]) {
      severity = rule.severity;
    }
    category ??= rule.category;
  }
  return { category, severity, regions: regionsForText(text) };
};

/** Stable dedupe identity for signals that share an upstream event id. */
export const signalId = (
  source: string,
  parts: readonly (string | undefined)[],
): string => {
  const material = parts.filter((part) => part !== undefined && part.length > 0).join("|");
  let hash = 0xcbf29ce484222325n;
  for (const char of `${source}|${material}`) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${source.slice(0, 20)}-${hash.toString(16).padStart(16, "0")}`;
};
