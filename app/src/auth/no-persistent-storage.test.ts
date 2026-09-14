import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const appSource = join(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Comments name these APIs on purpose (to say the app does not use them), so
 * the scan reads code only.
 */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/(^|[^:])\/\/.*$/gmu, "$1");
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
        found.push(child);
      }
    }
  };
  await visit(root);
  return found.sort();
}

/**
 * The modules allowed to name `localStorage`, and what they may keep
 * there: a bounded list of opaque session public ids that is the reader's own
 * grid arrangement, a bounded finite palette/mode appearance preference, and
 * the automatic-effort on/off flag for new browser starts.
 * No projection text, no session name, no authentication
 * token, and no key material — those stay in memory and in the non-extractable
 * IndexedDB key store. Any added entry here needs the same argument.
 */
const localStorageUsers = ["appearance.ts", "data/automatic-effort.ts", "data/card-order.ts"];

describe("browser storage discipline", () => {
  test("only finite preferences and grid arrangement reach localStorage, and nothing reaches sessionStorage or document.cookie", async () => {
    const offenders: string[] = [];
    const users: string[] = [];
    for (const path of await sourceFiles(appSource)) {
      const text = stripComments(await readFile(path, "utf8"));
      if (/\bsessionStorage\b|document\.cookie/u.test(text)) {
        offenders.push(relative(appSource, path));
      } else if (/\blocalStorage\b/u.test(text)) users.push(relative(appSource, path));
    }
    expect(offenders).toEqual([]);
    expect(users).toEqual(localStorageUsers);
  });

  test("the stored arrangement is bounded and holds ids only", async () => {
    const text = await readFile(join(appSource, "model", "card-order.ts"), "utf8");
    expect(text).toContain("export const maximumOrderedCards = 200");
    expect(text).toContain("normaliseCardOrder");
  });

  test("appearance stores only its bounded shared preference and never reads legacy keys", async () => {
    const text = await readFile(join(appSource, "appearance.ts"), "utf8");
    expect(text).toContain('oompaAppearanceStorageKey = "hraness-design-palette-v1"');
    expect(text).toContain("maximumPreferenceLength = 256");
    expect(text).toContain("parseDesignPalettePreference");
    expect(text).toContain("legacyStorageKey: null");
  });

  test("the only persistent store is IndexedDB, and only for device key pairs", async () => {
    const users: string[] = [];
    for (const path of await sourceFiles(appSource)) {
      const text = stripComments(await readFile(path, "utf8"));
      if (/\bindexedDB\b/u.test(text)) users.push(relative(appSource, path));
    }
    expect(users).toEqual(["custody/keystore.ts"]);
  });

  test("the auth provider is constructed with the in-memory storage", async () => {
    const text = await readFile(join(appSource, "app.tsx"), "utf8");
    expect(text).toContain("<ConvexAuthProvider client={convexClient} storage={memoryTokenStorage}>");
  });

  test("no module registers a service worker or loads an analytics script", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles(appSource)) {
      const text = stripComments(await readFile(path, "utf8"));
      if (/serviceWorker|analytics|posthog|gtag/iu.test(text)) {
        offenders.push(relative(appSource, path));
      }
    }
    expect(offenders).toEqual([]);
  });
});
