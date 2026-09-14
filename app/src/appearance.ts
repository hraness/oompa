import { designPaletteLabels, designPalettes, designThemes, parseDesignPalettePreference } from "@hraness/design-kit";
import { initDesignPalette } from "@hraness/design-kit/browser";

export const oompaAppearanceStorageKey = "hraness-design-palette-v1";
const maximumPreferenceLength = 256;
type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

/** This adapter can persist only the bounded, non-sensitive appearance key. */
export function oompaAppearanceStorage(storage: AppearanceStorage | null): AppearanceStorage | null {
  if (storage === null) return null;
  return {
    getItem(key) {
      if (key !== oompaAppearanceStorageKey) return null;
      const value = storage.getItem(key);
      if (value === null || value.length > maximumPreferenceLength) return null;
      const preference = parseDesignPalettePreference(value);
      return preference === null ? null : JSON.stringify(preference);
    },
    setItem(key, value) {
      if (key !== oompaAppearanceStorageKey || value.length > maximumPreferenceLength) return;
      const preference = parseDesignPalettePreference(value);
      if (preference !== null) storage.setItem(key, JSON.stringify(preference));
    },
  };
}

export function initializeOompaAppearance(document: Document) {
  let storage: AppearanceStorage | null = null;
  try { storage = document.defaultView?.localStorage ?? null; } catch { /* Appearance remains available in memory. */ }
  return initDesignPalette({
    document,
    defaultPreference: { palette: "paper", mode: "system" },
    legacyStorageKey: null,
    storage: oompaAppearanceStorage(storage),
    storageKey: oompaAppearanceStorageKey,
  });
}

/** Static controls are bound once after parsing; React owns its mounted menus. */
export function bindOompaAppearanceMenus(
  document: Document,
  controller: ReturnType<typeof initializeOompaAppearance>,
  mountedMenu?: HTMLDetailsElement,
): () => void {
  const view = document.defaultView;
  if (view === null) return () => undefined;
  const menus = mountedMenu === undefined
    ? [...document.querySelectorAll<HTMLDetailsElement>("details[data-oompa-appearance]:not([data-oompa-managed])")]
    : [mountedMenu];
  if (menus.some((menu) => menu.ownerDocument !== document)) throw new Error("Appearance menu belongs to another document.");
  if (menus.length === 0) return () => undefined;
  const update = (): void => {
    const { preference } = controller.getSnapshot();
    const modeLabel = preference.mode === "system" ? "System" : preference.mode === "dark" ? "Dark" : "Light";
    for (const menu of menus) {
      const palette = menu.querySelector<HTMLSelectElement>("select[data-oompa-palette]");
      const mode = menu.querySelector<HTMLSelectElement>("select[data-oompa-mode]");
      if (palette !== null) palette.value = preference.palette;
      if (mode !== null) mode.value = preference.mode;
      const summary = menu.querySelector("summary");
      summary?.setAttribute("aria-label", `Appearance: ${designPaletteLabels[preference.palette]}, ${modeLabel}`);
    }
  };
  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof view.HTMLSelectElement) || target.disabled) return;
    if (!menus.some((menu) => menu.contains(target))) return;
    const { preference } = controller.getSnapshot();
    const palette = designPalettes.find((value) => value === target.value);
    const mode = designThemes.find((value) => value === target.value);
    if (target.hasAttribute("data-oompa-palette") && palette !== undefined) controller.setPreference({ ...preference, palette });
    if (target.hasAttribute("data-oompa-mode") && mode !== undefined) controller.setPreference({ ...preference, mode });
  };
  const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof view.Node)) return;
    for (const menu of menus) if (!menu.contains(target)) menu.open = false;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const target = event.target;
    if (!(target instanceof view.Node)) return;
    for (const menu of menus) {
      if (!menu.open || !menu.contains(target)) continue;
      event.preventDefault();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  };
  const onFocusOut = (event: FocusEvent): void => {
    const target = event.relatedTarget;
    if (!(target instanceof view.Node)) return;
    for (const menu of menus) if (!menu.contains(target)) menu.open = false;
  };
  update();
  const unsubscribe = controller.subscribe(update);
  document.addEventListener("change", onChange);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusout", onFocusOut);
  for (const menu of menus) {
    menu.setAttribute("data-ready", "true");
    const summary = menu.querySelector("summary");
    summary?.removeAttribute("aria-disabled");
    summary?.removeAttribute("tabindex");
    for (const select of menu.querySelectorAll("select")) select.disabled = false;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    document.removeEventListener("change", onChange);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusout", onFocusOut);
    for (const menu of menus) {
      menu.open = false;
      menu.setAttribute("data-ready", "false");
      menu.querySelector("summary")?.setAttribute("aria-disabled", "true");
      menu.querySelector("summary")?.setAttribute("tabindex", "-1");
      for (const select of menu.querySelectorAll("select")) select.disabled = true;
    }
  };
}

/** Own one controller reference for exactly the lifetime of a mounted menu. */
export function mountOompaAppearanceMenu(menu: HTMLDetailsElement): () => void {
  const controller = initializeOompaAppearance(menu.ownerDocument);
  let unbind: () => void;
  try { unbind = bindOompaAppearanceMenus(menu.ownerDocument, controller, menu); }
  catch (error) { controller.dispose(); throw error; }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unbind();
    controller.dispose();
  };
}
