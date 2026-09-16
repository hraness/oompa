#!/usr/bin/env node
// check-cost-surfaces — uniform cost-discipline gate for Hraness product repos.
// Dependency-free; runs under Bun or Node 18+.
//
// Verifies that every product data surface is registered in ./costs.json:
//   - convex/schema.ts defineTable names   -> "convex:<table>"
//   - PostHog capture("event") literals    -> "posthog:<event>"
//   - force-dynamic / edge routes          -> "route:<path>"
//   - turso/libsql schema modules          -> "turso:<table>" (from costs.json only)
//
// Entry rules: kind/retention/owner required everywhere; deletion required
// for authoritative; maxBytesPerEvent required for telemetry; owner and
// deletion paths must exist.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const failures = [];
const fail = (msg) => failures.push(msg);

const KINDS = new Set(["authoritative", "derived", "telemetry", "served"]);
const RETENTION = /^(ephemeral|ttl:P.+|account|tombstone|persistent)$/;

const registryPath = join(root, "costs.json");
if (!existsSync(registryPath)) {
  fail("costs.json is missing at the repository root");
  console.error(failures.join("\n"));
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch (e) {
  fail(`costs.json does not parse: ${e.message}`);
  console.error(failures.join("\n"));
  process.exit(1);
}

const surfaces = registry.surfaces ?? {};
const exempt = new Set(registry.exempt ?? []);

for (const [id, entry] of Object.entries(surfaces)) {
  if (typeof entry !== "object" || entry === null) {
    fail(`${id}: entry must be an object`);
    continue;
  }
  if (!KINDS.has(entry.kind)) {
    fail(`${id}: kind must be authoritative|derived|telemetry`);
  }
  if (typeof entry.retention !== "string" || !RETENTION.test(entry.retention)) {
    fail(`${id}: retention must be ephemeral|ttl:<ISO8601>|account|tombstone|persistent`);
  }
  if (typeof entry.owner !== "string" || !existsSync(join(root, entry.owner))) {
    fail(`${id}: owner path missing or not a file: ${entry.owner}`);
  }
  if (entry.kind === "authoritative") {
    if (typeof entry.deletion !== "string" || !existsSync(join(root, entry.deletion))) {
      fail(`${id}: authoritative surfaces need an existing deletion path`);
    }
    if (typeof entry.budget !== "object" || entry.budget === null) {
      fail(`${id}: authoritative surfaces need a budget object`);
    }
  }
  if (entry.kind === "telemetry" && typeof entry.maxBytesPerEvent !== "number") {
    fail(`${id}: telemetry surfaces need maxBytesPerEvent`);
  }
  if (entry.kind === "served" && id.startsWith("route:")) {
    // per-request compute; dynamic/rate behavior documented in entry.note
  }
  if (entry.kind === "derived" && typeof entry.source !== "string") {
    fail(`${id}: derived surfaces need a source naming their authoritative origin`);
  }
}

const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", ".git", ".vercel", "out", "coverage",
  ".turbo", "_generated", ".cache", "public", ".bun",
]);
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".rs"]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(p);
    } else if (SCAN_EXT.has(name.slice(name.lastIndexOf(".")))) {
      yield p;
    }
  }
}

// --- Convex tables ---------------------------------------------------------
function* convexSchemas() {
  const direct = join(root, "convex", "schema.ts");
  if (existsSync(direct)) yield direct;
  for (const group of ["projects", "packages", "apps"]) {
    const gdir = join(root, group);
    if (!existsSync(gdir)) continue;
    for (const child of readdirSync(gdir)) {
      if (child.startsWith(".") || SKIP_DIRS.has(child)) continue;
      const nested = join(gdir, child, "convex", "schema.ts");
      if (existsSync(nested)) yield nested;
    }
  }
}
for (const schemaPath of convexSchemas()) {
  const src = readFileSync(schemaPath, "utf8");
  const tableNames = new Set();
  for (const m of src.matchAll(/(\w+)\s*:\s*defineTable\s*\(/g)) tableNames.add(m[1]);
  for (const name of tableNames) {
    const id = `convex:${name}`;
    if (!surfaces[id] && !exempt.has(id)) {
      fail(`unregistered Convex table "${name}" (${relative(root, schemaPath)}) — add "${id}" to costs.json`);
    }
  }
}

// --- PostHog event literals -------------------------------------------------
const CAPTURE_RE = /capture\s*\(\s*["'`]([a-zA-Z0-9_:$-]+)["'`]/g;
const seenEvents = new Set();
for (const p of walk(root)) {
  const rel = relative(root, p);
  if (/\.test\.|\.spec\.|__tests__|scripts\/check-cost-surfaces/.test(rel)) continue;
  let src;
  try {
    src = readFileSync(p, "utf8");
  } catch {
    continue;
  }
  if (!/posthog/i.test(src)) continue;
  for (const m of src.matchAll(CAPTURE_RE)) {
    seenEvents.add(`${m[1]}\t${rel}`);
  }
}
for (const ev of seenEvents) {
  const [name, rel] = ev.split("\t");
  const id = `posthog:${name}`;
  if (!surfaces[id] && !exempt.has(id)) {
    fail(`unregistered analytics event "${name}" in ${rel} — add "${id}" to costs.json`);
  }
}

// --- Dynamic / edge routes --------------------------------------------------
function* routeDirs() {
  const singles = ["app", "src/app", "pages", "website", "site"];
  for (const d of singles) {
    const p = join(root, d);
    if (existsSync(p)) yield p;
  }
  for (const group of ["projects", "apps"]) {
    const gdir = join(root, group);
    if (!existsSync(gdir)) continue;
    for (const child of readdirSync(gdir)) {
      if (child.startsWith(".") || SKIP_DIRS.has(child)) continue;
      for (const d of ["app", "src/app"]) {
        const p = join(gdir, child, d);
        if (existsSync(p)) yield p;
      }
    }
  }
}
const FORCE_RE = /export\s+const\s+(?:dynamic|runtime)\s*=\s*["'](force-dynamic|edge|force-cache)["']/;
const seenRoutes = new Set();
for (const base of routeDirs()) {
  for (const p of walk(base)) {
    const rel = relative(root, p);
    if (!/(route|page)\.(ts|tsx|js|mjs)$/.test(p)) continue;
    let src;
    try {
      src = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const m = src.match(FORCE_RE);
    if (!m) continue;
    const seg = rel.replace(/\\/g, "/").replace(/(route|page)\.(ts|tsx|js|mjs)$/, "").replace(/^(?:src\/)?app\//, "/").replace(/^src\//, "").replace(/^pages\//, "/");
    const routePath = "/" + seg.replace(/^\/+/, "").replace(/\/$/, "");
    seenRoutes.add(`${routePath || "/"}\t${rel}`);
  }
}
for (const r of seenRoutes) {
  const [path, rel] = r.split("\t");
  const id = `route:${path || "/"}`;
  if (!surfaces[id] && !exempt.has(id)) {
    fail(`dynamic/edge route ${path || "/"} (${rel}) is unregistered — add "${id}" to costs.json`);
  }
}

if (failures.length > 0) {
  console.error(`check-cost-surfaces: ${failures.length} violation(s)`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `check-cost-surfaces: ${Object.keys(surfaces).length} surfaces registered, all checks passed`,
);
