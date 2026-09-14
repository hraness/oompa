import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { bindOompaAppearanceMenus, oompaAppearanceStorageKey, initializeOompaAppearance } from "../appearance";
import { AppearanceButton, AppearanceHeader } from "./appearance";
import { NativeAppearanceMenu } from "./appearance-menu";

const names = ["document", "Document", "DocumentFragment", "Element", "Event", "HTMLElement", "Node", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"] as const;
const globals = globalThis as unknown as Record<string, unknown>;
const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let roots: Root[] = [];
let bootstrap: ReturnType<typeof initializeOompaAppearance> | undefined;
let stopStatic: (() => void) | undefined;
let values: Map<string, string>;
let writes: number;
let systemDark = false;
let systemListeners: Set<() => void>;
let selectPrototype: object;
let selectValue: PropertyDescriptor | undefined;

beforeEach(() => {
  const parsed = parseHTML('<!doctype html><html><head></head><body><div id="static"></div><div id="root"></div><div id="other"></div><button id="outside">Outside</button></body></html>');
  const record = parsed.window as unknown as Record<string, unknown>;
  for (const name of names) globals[name] = name === "window" ? parsed.window : name === "document" ? parsed.document : record[name];
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  values = new Map([[oompaAppearanceStorageKey, JSON.stringify({ palette: "gruvbox", mode: "light" })]]);
  writes = 0;
  systemDark = false;
  systemListeners = new Set();
  Object.defineProperty(parsed.window, "localStorage", { configurable: true, value: {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes += 1; values.set(key, value); },
  } });
  Object.defineProperty(parsed.window, "matchMedia", { configurable: true, value: () => ({
    get matches() { return systemDark; },
    addEventListener(_type: string, listener: () => void) { systemListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { systemListeners.delete(listener); },
  }) });
  // Linkedom's select.value has a getter only; mirror the browser's setter.
  selectPrototype = parsed.window.HTMLSelectElement.prototype;
  selectValue = Object.getOwnPropertyDescriptor(selectPrototype, "value");
  Object.defineProperty(selectPrototype, "value", {
    configurable: true,
    get(this: HTMLSelectElement) { return this.querySelector<HTMLOptionElement>("option[selected]")?.value ?? ""; },
    set(this: HTMLSelectElement, value: string) {
      for (const option of this.options) {
        if (option.value === value) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      }
    },
  });
});

afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots = [];
  stopStatic?.();
  stopStatic = undefined;
  bootstrap?.dispose();
  bootstrap = undefined;
  if (selectValue === undefined) Reflect.deleteProperty(selectPrototype, "value");
  else Object.defineProperty(selectPrototype, "value", selectValue);
  for (const name of names) {
    const descriptor = originals.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

function mount(id: string): HTMLElement {
  const container = document.getElementById(id)!;
  const root = createRoot(container);
  roots.push(root);
  act(() => { root.render(<StrictMode><AppearanceButton /></StrictMode>); });
  return container;
}
function choose(container: ParentNode, selector: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(selector)!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function assertMenu(container: ParentNode, palette: string, mode: string): void {
  expect(container.querySelector<HTMLSelectElement>("[data-oompa-palette]")?.value).toBe(palette);
  expect(container.querySelector<HTMLSelectElement>("[data-oompa-mode]")?.value).toBe(mode);
  expect(container.querySelector("details")?.getAttribute("data-ready")).toBe("true");
}

test("the app header renders one last native control without a React palette provider", () => {
  const { document } = parseHTML(renderToStaticMarkup(<AppearanceHeader />));
  const menu = document.querySelector("details[data-oompa-appearance]")!;
  expect(menu.closest("header")).not.toBeNull();
  expect(menu.parentElement?.nextElementSibling).toBeNull();
  expect(document.querySelectorAll("details").length).toBe(1);
  expect(menu.getAttribute("data-ready")).toBe("false");
  expect(menu.querySelector("summary")?.getAttribute("aria-disabled")).toBe("true");
  expect(menu.querySelectorAll("select[disabled]").length).toBe(2);
  expect(document.querySelectorAll("[style],style,script").length).toBe(0);
});

test("a new app visit stores Paper System and follows the OS without fixing the resolved appearance", () => {
  values.clear();
  bootstrap = initializeOompaAppearance(document);
  const host = mount("root");
  assertMenu(host, "paper", "system");
  expect(document.documentElement.dataset.palette).toBe("paper");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(writes).toBe(1);
  expect(JSON.parse(values.get(oompaAppearanceStorageKey)!)).toEqual({ palette: "paper", mode: "system" });
  systemDark = true;
  for (const listener of systemListeners) listener();
  assertMenu(host, "paper", "system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(writes).toBe(1);
  expect(JSON.parse(values.get(oompaAppearanceStorageKey)!)).toEqual({ palette: "paper", mode: "system" });
  choose(host, "[data-oompa-mode]", "light");
  expect(JSON.parse(values.get(oompaAppearanceStorageKey)!)).toEqual({ palette: "paper", mode: "light" });
});

test("mounted native menus adopt first-paint preferences and release only their own references", () => {
  bootstrap = initializeOompaAppearance(document);
  const staticHost = document.getElementById("static")!;
  staticHost.innerHTML = renderToStaticMarkup(<NativeAppearanceMenu />);
  const first = mount("root");
  // Parsing may finish after React mounts. The static binder must skip app menus.
  stopStatic = bindOompaAppearanceMenus(document, bootstrap);
  assertMenu(first, "gruvbox", "light");
  expect(document.documentElement.dataset.palette).toBe("gruvbox");
  const before = writes;
  choose(first, "[data-oompa-palette]", "rose-pine");
  expect(writes - before).toBe(1);
  assertMenu(staticHost, "rose-pine", "light");
  const second = mount("other");
  assertMenu(second, "rose-pine", "light");
  expect(document.querySelectorAll('meta[name="theme-color"]:not([media])').length).toBe(1);
  expect(systemListeners.size).toBe(1);

  const oldSelect = first.querySelector<HTMLSelectElement>("[data-oompa-palette]")!;
  const firstRoot = roots.shift()!;
  act(() => { firstRoot.unmount(); });
  expect(oldSelect.disabled).toBe(true);
  oldSelect.value = "tokyo-night";
  oldSelect.dispatchEvent(new Event("change", { bubbles: true }));
  expect(bootstrap.getSnapshot().preference.palette).toBe("rose-pine");
  expect(systemListeners.size).toBe(1);
  choose(second, "[data-oompa-mode]", "system");
  systemDark = true;
  for (const listener of systemListeners) listener();
  expect(document.documentElement.dataset.theme).toBe("dark");
  assertMenu(second, "rose-pine", "system");
  assertMenu(mount("root"), "rose-pine", "system");

  values.set(oompaAppearanceStorageKey, JSON.stringify({ palette: "tokyo-night", mode: "light" }));
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: oompaAppearanceStorageKey });
  window.dispatchEvent(event);
  assertMenu(second, "tokyo-night", "light");
  assertMenu(staticHost, "tokyo-night", "light");
  expect(document.documentElement.dataset.theme).toBe("light");

  act(() => { for (const root of roots) root.unmount(); });
  roots = [];
  stopStatic(); stopStatic = undefined;
  bootstrap.dispose(); bootstrap = undefined;
  expect(systemListeners.size).toBe(0);
});

test("outside focus and Escape close the mounted menu while restoring its trigger", () => {
  const host = mount("root");
  const menu = host.querySelector<HTMLDetailsElement>("details")!;
  const summary = menu.querySelector("summary")!;
  let focused = false;
  summary.focus = () => { focused = true; };
  menu.open = true;
  const escape = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  menu.querySelector("select")!.dispatchEvent(escape);
  expect(menu.open).toBe(false);
  expect(escape.defaultPrevented).toBe(true);
  expect(focused).toBe(true);
  menu.open = true;
  const focus = new Event("focusout", { bubbles: true });
  Object.defineProperty(focus, "relatedTarget", { value: document.getElementById("outside") });
  menu.dispatchEvent(focus);
  expect(menu.open).toBe(false);
});
