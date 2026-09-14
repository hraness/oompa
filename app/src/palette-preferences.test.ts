import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { designPalettes, designThemes } from "@hraness/design-kit";
import { parseHTML } from "linkedom";

import { bindOompaAppearanceMenus, oompaAppearanceStorage, oompaAppearanceStorageKey, initializeOompaAppearance } from "./appearance";

function memoryStorage() {
  const values = new Map<string, string>();
  const reads: string[] = [];
  return {
    reads, values,
    getItem(key: string) { reads.push(key); return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

describe("bounded appearance persistence", () => {
  test("round trips every palette and mode without persisting additional data", () => {
    fc.assert(fc.property(
      fc.constantFrom(...designPalettes),
      fc.constantFrom(...designThemes),
      fc.string({ maxLength: 16 }),
      (palette, mode, unrecognized) => {
        const storage = memoryStorage();
        const adapter = oompaAppearanceStorage(storage)!;
        adapter.setItem(oompaAppearanceStorageKey, JSON.stringify({ palette, mode, unrecognized }));
        expect(storage.values.size).toBe(1);
        expect(JSON.parse(storage.values.get(oompaAppearanceStorageKey)!)).toEqual({ palette, mode });
        expect(JSON.parse(adapter.getItem(oompaAppearanceStorageKey)!)).toEqual({ palette, mode });
      },
    ), { numRuns: 60 });
  });

  test("never reads or writes another browser key", () => {
    const storage = memoryStorage();
    const adapter = oompaAppearanceStorage(storage)!;
    const preference = JSON.stringify({ palette: "catppuccin", mode: "dark" });
    for (const key of ["auth-token", "hraness-design-theme-v1", "", `${oompaAppearanceStorageKey}-other`]) {
      adapter.setItem(key, preference);
      expect(adapter.getItem(key)).toBeNull();
    }
    expect(storage.values.size).toBe(0);
    expect(storage.reads).toEqual([]);
  });

  test("refuses malformed, partial, and oversized records", () => {
    const storage = memoryStorage();
    const adapter = oompaAppearanceStorage(storage)!;
    for (const value of [
      "invalid", "null", "[]", '{"palette":"catppuccin"}',
      '{"palette":"unknown","mode":"dark"}',
      '{"palette":"catppuccin","mode":"unknown"}',
      JSON.stringify({ palette: "catppuccin", mode: "dark", extra: "x".repeat(256) }),
    ]) {
      adapter.setItem(oompaAppearanceStorageKey, value);
      expect(storage.values.size).toBe(0);
      storage.values.set(oompaAppearanceStorageKey, value);
      expect(adapter.getItem(oompaAppearanceStorageKey)).toBeNull();
      storage.values.clear();
    }
    expect(oompaAppearanceStorage(null)).toBeNull();
  });
});

test("native menus change the shared preference, follow external changes, and release their listeners", () => {
  const parsed = parseHTML(`<!doctype html><html><head></head><body><details data-oompa-appearance><summary>Appearance</summary><select data-oompa-palette>${designPalettes.map((value) => `<option value="${value}">${value}</option>`).join("")}</select><select data-oompa-mode>${designThemes.map((value) => `<option value="${value}">${value}</option>`).join("")}</select></details><div id="outside"></div></body></html>`);
  const document = parsed.document as unknown as Document;
  const storage = memoryStorage();
  Object.defineProperty(parsed.window, "localStorage", { configurable: true, value: storage });
  // Linkedom omits the browser's writable select.value descriptor.
  for (const select of document.querySelectorAll("select")) {
    let value = [...select.options].find((option) => option.selected)?.value ?? "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get() { return value; },
      set(next: string) { value = next; },
    });
  }
  const controller = initializeOompaAppearance(document);
  const unbind = bindOompaAppearanceMenus(document, controller);
  const menu = document.querySelector<HTMLDetailsElement>("details")!;
  const palette = document.querySelector<HTMLSelectElement>("[data-oompa-palette]")!;
  const mode = document.querySelector<HTMLSelectElement>("[data-oompa-mode]")!;
  try {
    expect(palette.value).toBe("paper");
    expect(mode.value).toBe("system");
    palette.value = "gruvbox";
    palette.dispatchEvent(new parsed.window.Event("change", { bubbles: true }));
    mode.value = "light";
    mode.dispatchEvent(new parsed.window.Event("change", { bubbles: true }));
    expect(controller.getSnapshot().preference).toEqual({ palette: "gruvbox", mode: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(JSON.parse(storage.values.get(oompaAppearanceStorageKey)!)).toEqual({ palette: "gruvbox", mode: "light" });

    controller.setPreference({ palette: "rose-pine", mode: "system" });
    expect(palette.value).toBe("rose-pine");
    expect(mode.value).toBe("system");
    expect(menu.querySelector("summary")?.getAttribute("aria-label")).toBe("Appearance: Rosé Pine, System");

    menu.open = true;
    document.getElementById("outside")!.dispatchEvent(new parsed.window.Event("pointerdown", { bubbles: true }));
    expect(menu.open).toBe(false);
    menu.open = true;
    const escape = new parsed.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    menu.dispatchEvent(escape);
    expect(menu.open).toBe(false);

    unbind();
    palette.value = "tokyo-night";
    palette.dispatchEvent(new parsed.window.Event("change", { bubbles: true }));
    expect(controller.getSnapshot().preference.palette).toBe("rose-pine");
  } finally {
    unbind();
    controller.dispose();
  }
});
