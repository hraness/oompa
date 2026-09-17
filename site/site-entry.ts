import { isProductScene, parsePreviewMessage, productScenes, type ProductScene } from "./product-scenes.ts";
import { createPreviewLoading } from "./preview-loading.ts";
import { initWonkaArtifact } from "./wonka-renderer.ts";

for (const artifact of document.querySelectorAll<HTMLElement>("[data-wonka-artifact]")) {
  const dispose = initWonkaArtifact(artifact);
  window.addEventListener("pagehide", (event) => { if (!event.persisted) dispose(); });
}

const previewUrl = (view: ProductScene): string => `/examples/app/index.html?view=${view}`;
const loadingFor = (status: HTMLElement) => createPreviewLoading({
  publish: (state) => { status.textContent = state === "ready" ? "" : state === "failed"
    ? "The example could not load. You can still read the guide or choose another screen."
    : "Loading the example interface…"; },
  schedule: (callback) => setTimeout(callback, 35_000),
  cancel: (timer) => clearTimeout(timer),
});

for (const figure of document.querySelectorAll<HTMLElement>("[data-product-preview]")) {
  const frame = figure.querySelector<HTMLIFrameElement>("[data-preview-frame]");
  const dialog = figure.querySelector<HTMLDialogElement>("[data-preview-dialog]");
  const expanded = figure.querySelector<HTMLElement>("[data-preview-expanded]");
  const enlarge = figure.querySelector<HTMLButtonElement>("[data-preview-enlarge]");
  const status = figure.querySelector<HTMLElement>("[data-preview-status]");
  const expandedStatus = figure.querySelector<HTMLElement>("[data-preview-expanded-status]");
  if (frame === null || dialog === null || expanded === null || enlarge === null || status === null || expandedStatus === null) continue;
  for (const button of figure.querySelectorAll<HTMLButtonElement>("[data-preview-view],[data-preview-enlarge]")) button.disabled = false;
  const scriptNotice = figure.querySelector<HTMLElement>("[data-preview-script-notice]");
  if (scriptNotice !== null) scriptNotice.hidden = true;
  let current: ProductScene = isProductScene(figure.dataset.view) ? figure.dataset.view : "overview";
  let enlargedFrame: HTMLIFrameElement | undefined;
  let enlargedLoading: ReturnType<typeof loadingFor> | undefined;
  const loading = loadingFor(status);
  const select = (view: ProductScene): void => {
    current = view;
    figure.dataset.view = view;
    const scene = productScenes[view];
    for (const button of figure.querySelectorAll<HTMLButtonElement>("[data-preview-view]")) button.setAttribute("aria-pressed", String(button.dataset.previewView === view));
    const description = figure.querySelector("[data-preview-description]");
    if (description !== null) description.textContent = scene.description;
    const guide = figure.querySelector<HTMLAnchorElement>("[data-preview-guide]");
    if (guide !== null) guide.href = scene.guide;
    const title = figure.querySelector("[data-preview-dialog-title]");
    if (title !== null) title.textContent = scene.label;
    frame.title = `Oompa example: ${scene.label}`;
    loading.reset();
    loading.begin();
    frame.src = previewUrl(view);
    if (enlargedFrame !== undefined) {
      enlargedLoading?.reset();
      enlargedLoading?.begin();
      enlargedFrame.src = previewUrl(view);
    }
  };
  for (const button of figure.querySelectorAll<HTMLButtonElement>("[data-preview-view]")) button.addEventListener("click", () => {
    if (isProductScene(button.dataset.previewView) && button.dataset.previewView !== current) select(button.dataset.previewView);
  });
  enlarge.addEventListener("click", () => {
    enlargedLoading?.reset();
    enlargedLoading = loadingFor(expandedStatus);
    enlargedLoading.begin();
    enlargedFrame = frame.cloneNode(false) as HTMLIFrameElement;
    enlargedFrame.removeAttribute("data-preview-frame");
    enlargedFrame.loading = "eager";
    enlargedFrame.src = previewUrl(current);
    expanded.replaceChildren(enlargedFrame);
    dialog.showModal();
  });
  figure.querySelector("[data-preview-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    enlargedLoading?.reset();
    enlargedLoading = undefined;
    expandedStatus.textContent = "";
    expanded.replaceChildren();
    enlargedFrame = undefined;
    enlarge.focus();
  });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    // The script-only sandbox deliberately gives these public frames an opaque
    // origin. Never accept messages from a same-origin page or another window.
    if (event.origin !== "null" || (event.source !== frame.contentWindow && event.source !== enlargedFrame?.contentWindow)) return;
    const data = parsePreviewMessage(event.data);
    if (data === undefined || data.view !== current) return;
    if (event.source === frame.contentWindow) loading.complete(data.type === "oompa-preview-ready");
    else enlargedLoading?.complete(data.type === "oompa-preview-ready");
  });
  // A lazy frame should not time out before it approaches the viewport.
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) { loading.begin(); observer.disconnect(); }
  }, { rootMargin: "200px" });
  observer.observe(frame);
  // The server already set the selected URL. Reassigning even the same value
  // can abort the initial document while progressive enhancement is loading.
  // Request an already-settled observation after installing our listener. If
  // the child is not listening yet, its ordinary completion message arrives later.
  frame.contentWindow?.postMessage({ type: "oompa-preview-status", view: current }, "*");
}

const search = document.querySelector<HTMLInputElement>("#docs-search");
const results = document.querySelector<HTMLElement>("#docs-search-results");
if (search !== null && results !== null) {
  const entries = [...document.querySelectorAll<HTMLAnchorElement>("a[data-doc-search]")];
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase().slice(0, 120);
    results.replaceChildren();
    results.hidden = query.length === 0;
    if (query.length === 0) return;
    const words = query.split(/\s+/u);
    const matches = entries.filter((entry) => words.every((word) => (entry.dataset.docSearch ?? "").toLocaleLowerCase().includes(word)));
    for (const match of matches) {
      const link = match.cloneNode(true) as HTMLAnchorElement;
      link.removeAttribute("aria-current");
      link.removeAttribute("data-doc-search");
      results.append(link);
    }
    if (matches.length === 0) results.textContent = "No matching guide. Try “login”, “usage”, or “recovery”.";
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { search.value = ""; search.dispatchEvent(new Event("input")); }
  });
}

function revealAnchor(): void {
  let id: string;
  try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
  if (id.length === 0 || id.length > 500) return;
  const moved = [...document.querySelectorAll<HTMLAnchorElement>("a[data-moved-section]")]
    .find((link) => id === link.dataset.movedSection || id.startsWith(`${link.dataset.movedSection}-`));
  if (moved !== undefined) {
    const target = new URL(moved.href);
    if (target.origin === window.location.origin) {
      target.hash = id;
      window.location.replace(target.href);
    }
    return;
  }
  const element = document.getElementById(id);
  if (element === null) return;
  let parent: HTMLElement | null = element;
  while (parent !== null) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  element.scrollIntoView({ block: "start" });
}
window.addEventListener("hashchange", revealAnchor);
revealAnchor();
