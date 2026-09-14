import { installDirectBrowser } from "@hraness/direct/web";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceHeader } from "../../src/components/appearance";
import { ErrorBoundary } from "../../src/components/error-boundary";
import { GridScreen } from "../../src/screens/grid-screen";
import { SessionCard } from "../../src/components/session-card";
import { useSessionHead } from "../../src/data/session-heads";
import { SettingsScreen } from "../../src/screens/settings-screen";
import { createProductPreviewSession, parseProductPreviewSelection, type ProductPreviewSession, type ProductPreviewView } from "./definition";
import { PRODUCT_SESSION_IDS } from "./fixtures";
import { installProductPreviewHarness } from "./io";
import { createPreviewStatusRelay } from "../../../site/product-scenes";
import "@hraness/design-kit/compiler-palettes.css";
import "../../src/index.css";

export type ProductPreviewStatusMessage = Readonly<{
  type: "oompa-preview-ready" | "oompa-preview-failed";
  view: ProductPreviewView | null;
}>;

let statusRelay: ReturnType<typeof createPreviewStatusRelay> | undefined;

function notify(message: ProductPreviewStatusMessage): void {
  // The iframe has an opaque origin. The payload is public and contains no
  // authority; the parent must match contentWindow and its expected view.
  if (statusRelay !== undefined && message.view !== null) statusRelay.publish(message.type);
  else window.parent.postMessage(message, "*");
}

function Screen({ session }: Readonly<{ session: ProductPreviewSession }>) {
  const { view } = session.harness;
  useEffect(() => {
    let frame = 0;
    let disposed = false;
    let previous: string | null = null;
    let fontsReady = false;
    const deadline = performance.now() + 30_000;
    void document.fonts.ready.then(() => { fontsReady = true; });
    const settle = () => {
      if (disposed) return;
      const probe = session.probe.snapshot();
      const clean = probe.ok && probe.value.isQuiescent
        && Object.values(probe.value.violations).every((count) => count === 0);
      const screen = document.querySelector(`[data-product-preview="${view}"]`);
      const snapshot = clean && screen !== null ? `${JSON.stringify(probe.value)}\n${screen.innerHTML}` : null;
      const rendered = view === "overview" ? document.querySelectorAll("[data-session-id]").length === 3
        : view === "question" ? document.querySelector('[aria-label="Pending interaction"]') !== null
          : view === "conversation" ? document.querySelectorAll("[data-session-id]").length === 1
            : document.querySelector("h1") !== null;
      // A resource failure can precede the bundle's error listeners. Both
      // sealed stylesheets must actually load, not merely appear in the DOM.
      const stylesheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
      const stylesReady = stylesheets.length === 2
        && stylesheets.every((link) => link.sheet !== null && !link.disabled);
      if (rendered && stylesReady && fontsReady && snapshot !== null && snapshot === previous) {
        document.documentElement.dataset.previewReady = "true";
        notify({ type: "oompa-preview-ready", view });
      } else if (performance.now() >= deadline) {
        document.documentElement.dataset.previewFailed = "true";
        notify({ type: "oompa-preview-failed", view });
      } else {
        previous = snapshot;
        frame = requestAnimationFrame(settle);
      }
    };
    frame = requestAnimationFrame(settle);
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, [session, view]);
  return <div data-product-preview={view} inert>
    {view === "overview" ? <GridScreen />
      : view === "settings" ? <SettingsScreen onBack={() => undefined} />
        : <SingleCard sessionPublicId={PRODUCT_SESSION_IDS[view]} />}
  </div>;
}

const noOrdering = {
  arranged: false,
  canMoveLeft: false,
  canMoveRight: false,
  dragging: false,
  dropTarget: false,
  onDragStart: () => undefined,
  onMove: () => undefined,
  onReset: () => undefined,
} as const;

/**
 * One conversation card on its own, as the site's conversation scenes show it,
 * under the same appearance header every screen carries.
 */
function SingleCard({ sessionPublicId }: Readonly<{ sessionPublicId: string }>) {
  const head = useSessionHead(sessionPublicId);
  if (head === null) throw new Error("Unknown product example session.");
  return <>
    <AppearanceHeader />
    <SessionCard head={head} onSummary={() => undefined} ordering={noOrdering} />
  </>;
}

const container = document.getElementById("root");
if (container === null) throw new Error("Missing product example root.");
const root = createRoot(container);
let selected: ProductPreviewView | null = null;
let session: ProductPreviewSession | null = null;
const parentOrigin = new URL(window.location.href).origin;
const replayStatus = (event: MessageEvent<unknown>): void => {
  if (event.source === window.parent && event.origin === parentOrigin) statusRelay?.replay(event.data);
};
window.addEventListener("message", replayStatus);
window.addEventListener("pagehide", () => { window.removeEventListener("message", replayStatus); }, { once: true });
const failed = () => {
  session?.harness.recordBrowserActivityError();
  document.documentElement.dataset.previewFailed = "true";
  delete document.documentElement.dataset.previewReady;
  notify({ type: "oompa-preview-failed", view: selected });
};

try {
  selected = parseProductPreviewSelection(window.location.search);
  statusRelay = createPreviewStatusRelay(selected, (message) => window.parent.postMessage(message, parentOrigin));
  const result = createProductPreviewSession(selected);
  if (!result.ok) throw new Error(result.error.message);
  const admitted = result.value;
  session = admitted;
  const releaseIo = installProductPreviewHarness(admitted.harness);
  const registeredIo = admitted.onDispose(releaseIo);
  if (!registeredIo.ok) { releaseIo(); throw new Error("Could not own product example IO."); }
  const originalNow = Date.now;
  const fixedNow = admitted.harness.now;
  Date.now = fixedNow;
  const registeredClock = admitted.onDispose(() => { if (Date.now === fixedNow) Date.now = originalNow; return undefined; });
  if (!registeredClock.ok) { Date.now = originalNow; throw new Error("Could not own the product example clock."); }
  const browser = installDirectBrowser({ session: admitted, reset: admitted.harness.refuse, firewall: {
    onBlocked: admitted.harness.recordBlockedFetch, onActivityError: admitted.harness.recordBrowserActivityError,
  } });
  if (!browser.ok) throw new Error("Could not isolate the product example.");
  window.addEventListener("error", failed, true);
  window.addEventListener("unhandledrejection", failed);
  document.addEventListener("securitypolicyviolation", failed);
  window.addEventListener("pagehide", () => {
    root.unmount();
    window.removeEventListener("error", failed, true);
    window.removeEventListener("unhandledrejection", failed);
    document.removeEventListener("securitypolicyviolation", failed);
    admitted.dispose();
  }, { once: true });
  root.render(<StrictMode><ErrorBoundary onError={failed} fallback={() => <p role="alert">This product example could not be displayed.</p>}>
    <Screen session={admitted} />
  </ErrorBoundary></StrictMode>);
} catch {
  session?.dispose();
  root.render(<p role="alert">This product example is unavailable. Choose overview, conversation, question, or settings.</p>);
  failed();
}
