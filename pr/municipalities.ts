/**
 * Puerto Rico geography for the pulse dashboard: the 78 municipios grouped into
 * the regions visitors and residents actually use, the NWS public and marine
 * zones that cover them, and a keyword gazetteer for tagging signal text.
 */

export const PR_REGIONS = [
  "san-juan-metro",
  "northeast",
  "vieques",
  "culebra",
  "east",
  "central-east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
  "north",
  "central",
  "islandwide",
  "mona-passage",
  "waters-north",
  "waters-south",
  "waters-east",
  "waters-northwest",
  "waters-southwest",
  "offshore",
  "usvi",
  "caribbean",
  "atlantic",
] as const;
export type PrRegion = (typeof PR_REGIONS)[number];

export const PR_REGION_LABELS: Readonly<Record<PrRegion, string>> = {
  "san-juan-metro": "San Juan metro",
  "northeast": "Northeast",
  "vieques": "Vieques",
  "culebra": "Culebra",
  "east": "East",
  "central-east": "Central-east",
  "southeast": "Southeast",
  "south": "South",
  "southwest": "Southwest",
  "west": "West",
  "northwest": "Northwest",
  "north": "North",
  "central": "Central mountains",
  "islandwide": "All of Puerto Rico",
  "mona-passage": "Mona Passage",
  "waters-north": "North coast waters",
  "waters-south": "South coast waters",
  "waters-east": "Vieques & eastern waters",
  "waters-northwest": "Northwest waters",
  "waters-southwest": "Southwest waters",
  "offshore": "Offshore waters",
  "usvi": "U.S. Virgin Islands",
  "caribbean": "Wider Caribbean",
  "atlantic": "Tropical Atlantic",
};

export interface Municipio {
  readonly slug: string;
  readonly name: string;
  readonly region: PrRegion;
}

const municipioRows: ReadonlyArray<readonly [string, PrRegion]> = [
  ["Adjuntas", "west"],
  ["Aguada", "west"],
  ["Aguadilla", "west"],
  ["Aguas Buenas", "central-east"],
  ["Aibonito", "central-east"],
  ["Añasco", "west"],
  ["Arecibo", "northwest"],
  ["Arroyo", "southeast"],
  ["Barceloneta", "north"],
  ["Barranquitas", "central"],
  ["Bayamón", "san-juan-metro"],
  ["Cabo Rojo", "southwest"],
  ["Caguas", "central-east"],
  ["Camuy", "northwest"],
  ["Canóvanas", "northeast"],
  ["Carolina", "san-juan-metro"],
  ["Cataño", "san-juan-metro"],
  ["Cayey", "central-east"],
  ["Ceiba", "northeast"],
  ["Ciales", "north"],
  ["Cidra", "central-east"],
  ["Coamo", "south"],
  ["Comerío", "central-east"],
  ["Corozal", "north"],
  ["Culebra", "culebra"],
  ["Dorado", "san-juan-metro"],
  ["Fajardo", "northeast"],
  ["Florida", "north"],
  ["Guánica", "southwest"],
  ["Guayama", "southeast"],
  ["Guayanilla", "south"],
  ["Guaynabo", "san-juan-metro"],
  ["Gurabo", "central-east"],
  ["Hatillo", "northwest"],
  ["Hormigueros", "southwest"],
  ["Humacao", "east"],
  ["Isabela", "northwest"],
  ["Jayuya", "central"],
  ["Juana Díaz", "south"],
  ["Juncos", "east"],
  ["Lajas", "southwest"],
  ["Lares", "central"],
  ["Las Marías", "west"],
  ["Las Piedras", "east"],
  ["Loíza", "northeast"],
  ["Luquillo", "northeast"],
  ["Manatí", "north"],
  ["Maricao", "west"],
  ["Maunabo", "east"],
  ["Mayagüez", "west"],
  ["Moca", "west"],
  ["Morovis", "north"],
  ["Naguabo", "east"],
  ["Naranjito", "north"],
  ["Orocovis", "central"],
  ["Patillas", "southeast"],
  ["Peñuelas", "south"],
  ["Ponce", "south"],
  ["Quebradillas", "northwest"],
  ["Rincón", "west"],
  ["Río Grande", "northeast"],
  ["Sabana Grande", "southwest"],
  ["Salinas", "southeast"],
  ["San Germán", "southwest"],
  ["San Juan", "san-juan-metro"],
  ["San Lorenzo", "central-east"],
  ["San Sebastián", "west"],
  ["Santa Isabel", "southeast"],
  ["Toa Alta", "san-juan-metro"],
  ["Toa Baja", "san-juan-metro"],
  ["Trujillo Alto", "san-juan-metro"],
  ["Utuado", "central"],
  ["Vega Alta", "north"],
  ["Vega Baja", "north"],
  ["Vieques", "vieques"],
  ["Villalba", "south"],
  ["Yabucoa", "east"],
  ["Yauco", "south"],
];

const toSlug = (name: string): string =>
  name
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/(^-|-$)/gu, "");

export const PR_MUNICIPIOS: readonly Municipio[] = municipioRows.map(([name, region]) => ({
  name,
  region,
  slug: toSlug(name),
}));

export const MUNICIPIO_BY_SLUG: ReadonlyMap<string, Municipio> = new Map(
  PR_MUNICIPIOS.map((municipio) => [municipio.slug, municipio]),
);

/** NWS public forecast zones covering Puerto Rico (San Juan office). */
export const NWS_ZONE_REGIONS: Readonly<Record<string, PrRegion>> = {
  PRZ001: "san-juan-metro",
  PRZ002: "northeast",
  PRZ003: "southeast",
  PRZ004: "central-east",
  PRZ005: "north",
  PRZ006: "central",
  PRZ007: "south",
  PRZ008: "northwest",
  PRZ009: "west",
  PRZ010: "west",
  PRZ011: "southwest",
  PRZ012: "culebra",
  PRZ013: "vieques",
};

/** NWS marine zones around Puerto Rico and the U.S. Virgin Islands. */
export const NWS_MARINE_ZONE_REGIONS: Readonly<Record<string, PrRegion>> = {
  AMZ711: "atlantic",
  AMZ712: "waters-north",
  AMZ716: "waters-east",
  AMZ723: "waters-east",
  AMZ726: "waters-east",
  AMZ733: "waters-south",
  AMZ735: "waters-south",
  AMZ741: "mona-passage",
  AMZ742: "waters-northwest",
  AMZ745: "waters-southwest",
};

export const USVI_ZONE_REGIONS: Readonly<Record<string, PrRegion>> = {
  VIZ001: "usvi",
  VIZ002: "usvi",
};

const normalizeForMatch = (value: string): string =>
  ` ${value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")} `;

interface GazetteerEntry {
  readonly pattern: string;
  readonly region: PrRegion;
  readonly municipio?: string;
}

const extraPlaceNames: ReadonlyArray<readonly [string, PrRegion]> = [
  ["el yunque", "northeast"],
  ["el yunque national forest", "northeast"],
  ["pasaje de la mona", "mona-passage"],
  ["mona passage", "mona-passage"],
  ["isla de mona", "mona-passage"],
  ["bahia de san juan", "san-juan-metro"],
  ["san juan bay", "san-juan-metro"],
  ["la parguera", "southwest"],
  ["el morro", "san-juan-metro"],
  ["isla verde", "san-juan-metro"],
  ["condado", "san-juan-metro"],
  ["santurce", "san-juan-metro"],
  ["hato rey", "san-juan-metro"],
  ["viejo san juan", "san-juan-metro"],
  ["old san juan", "san-juan-metro"],
  ["port of the americas", "south"],
  ["puerto de las americas", "south"],
  ["aeropuerto luis munoz marin", "san-juan-metro"],
  ["luis munoz marin", "san-juan-metro"],
  ["sju airport", "san-juan-metro"],
  ["rafael hernandez", "west"],
  ["mercedita", "south"],
  ["isla grande", "san-juan-metro"],
  ["jobos", "northwest"],
  ["crash boat", "west"],
  ["playa sucia", "southwest"],
  ["bahia de jobos", "southeast"],
  ["jobos bay", "southeast"],
  ["municipio autonomo de ponce", "south"],
  ["area metro", "san-juan-metro"],
  ["area metropolitana", "san-juan-metro"],
  ["metro area", "san-juan-metro"],
  ["san cristobal", "san-juan-metro"],
  ["fort buchanan", "san-juan-metro"],
  ["roosevelt roads", "northeast"],
  ["flamenco", "culebra"],
  ["mosquito bay", "vieques"],
  ["isabel segunda", "vieques"],
  ["virgin gorda", "usvi"],
  ["saint croix", "usvi"],
  ["st croix", "usvi"],
  ["saint thomas", "usvi"],
  ["st thomas", "usvi"],
  ["saint john", "usvi"],
  ["st john", "usvi"],
  ["charlotte amalie", "usvi"],
  ["christiansted", "usvi"],
  ["dominican republic", "caribbean"],
  ["republica dominicana", "caribbean"],
  ["haiti", "caribbean"],
  ["cuba", "caribbean"],
  ["venezuela", "caribbean"],
  ["lesser antilles", "caribbean"],
  ["antillas menores", "caribbean"],
  ["leeward islands", "caribbean"],
  ["islas de barlovento", "caribbean"],
];

const gazetteer: readonly GazetteerEntry[] = [
  ...PR_MUNICIPIOS.map((municipio): GazetteerEntry => ({
    pattern: normalizeForMatch(municipio.name).trim(),
    region: municipio.region,
    municipio: municipio.slug,
  })),
  ...extraPlaceNames.map(([pattern, region]): GazetteerEntry => ({
    pattern,
    region,
  })),
];

/** Match free text against municipio and place names, longest names first. */
export const regionsForText = (text: string): readonly PrRegion[] => {
  const normalized = normalizeForMatch(text);
  const found = new Set<PrRegion>();
  for (const entry of [...gazetteer].sort((a, b) => b.pattern.length - a.pattern.length)) {
    if (normalized.includes(` ${entry.pattern} `)) found.add(entry.region);
  }
  return [...found];
};

export const regionsForUgc = (codes: readonly string[]): readonly PrRegion[] => {
  const regions = new Set<PrRegion>();
  for (const code of codes) {
    const upper = code.toUpperCase();
    const direct = NWS_ZONE_REGIONS[upper] ?? NWS_MARINE_ZONE_REGIONS[upper] ?? USVI_ZONE_REGIONS[upper];
    if (direct !== undefined) regions.add(direct);
  }
  return [...regions];
};
