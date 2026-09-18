const stableSemver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const exactRegistryVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
export const OOMPA_RELEASE_OH_VERSION = "0.10.8";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const source = record(value, label);
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(source)) {
    if (typeof version !== "string") throw new Error(`${label} ${name} must be a string.`);
    result[name] = version;
  }
  return Object.freeze(result);
}

export type ReleasePackageInspection = Readonly<{
  blockers: readonly string[];
  name: "@hraness/oompa";
  version: string;
}>;

export function releaseArchiveName(version: string): string {
  if (!stableSemver.test(version)) throw new Error("The Oompa release version must be stable semantic versioning.");
  return `hraness-oompa-${version}.tgz`;
}

export function inspectReleasePackage(value: unknown): ReleasePackageInspection {
  const manifest = record(value, "Oompa package manifest");
  const publishConfig = record(manifest.publishConfig, "Oompa publishConfig");
  const bin = record(manifest.bin, "Oompa bin");
  const dependencies = stringRecord(manifest.dependencies, "Oompa runtime dependency");
  if (
    manifest.name !== "@hraness/oompa"
    || typeof manifest.version !== "string"
    || !stableSemver.test(manifest.version)
    || manifest.license !== "MIT"
    || publishConfig.access !== "public"
    || publishConfig.registry !== "https://registry.npmjs.org"
    || Object.keys(bin).length !== 1
    || bin.oompa !== "./src/cli.ts"
  ) throw new Error("The Oompa public package identity, license, registry, version, or binary is invalid.");

  const blockers = Object.entries(dependencies)
    .filter(([name, version]) => name === "@hraness/oh"
      ? version !== OOMPA_RELEASE_OH_VERSION
      : !exactRegistryVersion.test(version))
    .map(([name, version]) => `${name}=${version}`);
  if (!Object.hasOwn(dependencies, "@hraness/oh")) blockers.push("@hraness/oh=<missing>");
  blockers.sort();
  return Object.freeze({
    blockers: Object.freeze(blockers),
    name: "@hraness/oompa",
    version: manifest.version,
  });
}

export function assertReleasePackageReady(value: unknown): ReleasePackageInspection {
  const inspection = inspectReleasePackage(value);
  if (inspection.blockers.length > 0) {
    throw new Error(`Oompa release is blocked by runtime dependency policy: ${inspection.blockers.join(", ")}`);
  }
  return inspection;
}
