import { expect, test } from "bun:test";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = fileURLToPath(new URL("presentation.stylex.ts", import.meta.url));
const source = await readFile(path, "utf8");
const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const slots = new Map<string, string>();
for (const statement of parsed.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "sitePresentationStyles") continue;
    const initializer = declaration.initializer;
    if (initializer === undefined || !ts.isCallExpression(initializer)) throw new Error("Expected the literal site recipe collection");
    const object = initializer.arguments[0];
    if (object === undefined || !ts.isObjectLiteralExpression(object)) throw new Error("Expected literal site slots");
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error("Site slots must be finite identifiers");
      slots.set(property.name.text, property.getText(parsed));
    }
  }
}
const prefix = source.slice(0, source.indexOf("export const sitePresentationStyles"));
const compiled = new Map<string, Promise<string>>();
function cssFor(slot: string): Promise<string> {
  const recipe = slots.get(slot);
  if (recipe === undefined) throw new Error(`Missing presentation slot ${slot}`);
  let result = compiled.get(slot);
  if (result === undefined) {
    // Extract the actual authored slot, preserving its literal constants. The
    // production public compiler, not a mock class or source regex, decides
    // whether those declarations and native conditions are emitted.
    result = createStylexTransformCollector(root).transform(`${prefix}\nexport const isolated = stylex.create({${recipe}});`, path)
      .then(({ rules }) => rules.map(([, value]) => value.ltr).join("\n"));
    compiled.set(slot, result);
  }
  return result;
}

const compact = (value: string): string => value.replaceAll(/\s+/gu, "");
async function declares(slot: string, declarations: readonly string[]): Promise<void> {
  const css = compact(await cssFor(slot));
  for (const declaration of declarations) expect(css).toContain(compact(declaration));
}

test("site preload preserves Vite loading after public StyleX transforms", async () => {
  expect(Bun.version).toBe("1.3.14");
  const collector = createStylexTransformCollector(root);
  const fixturePath = fileURLToPath(new URL("__vite_import_order_regression__.stylex.ts", import.meta.url));
  const fixture = [
    'import * as stylex from "@stylexjs/stylex";',
    'const styles = stylex.create({ probe: { color: "#112233", display: "block" } });',
    'export const className = stylex.props(styles.probe).className;',
  ].join("\n");
  const result = await collector.transform(fixture, fixturePath);
  expect(result.rules).toHaveLength(2);
  expect(collector.seal()).toHaveLength(2);
  expect(result.code).not.toContain("stylex.create(");
  expect(result.code).not.toContain("stylex.inject(");
  expect(result.code).not.toContain("@stylexjs/stylex/lib/stylex-inject");
  const vite = await import("vite");
  expect(vite.version).toBe("7.3.6");
  expect(typeof vite.build).toBe("function");
});

test("all finite site slots compile through the public collector without runtime injection", async () => {
  const collector = createStylexTransformCollector(root);
  const result = await collector.transform(source, path);
  expect(result.rules.length).toBeGreaterThan(150);
  expect(collector.seal().length).toBeGreaterThan(150);
  expect(result.code).not.toContain("stylex.create(");
  expect(result.code).not.toContain("stylex.inject(");
  expect(result.code).not.toContain("@stylexjs/stylex/lib/stylex-inject");
  expect(result.code).not.toContain(root);
  expect([...slots.keys()]).toEqual([
    "marketingPage", "topicIcon", "shellTranscript", "installNote", "resourceFrame", "askAi",
    "reference", "referenceIntro", "referenceHeading", "referenceH2", "proseH3", "referenceText", "proseMeasure", "proseLink", "focusable",
    "inlineCode", "codeBlock", "codeContent", "installCommand", "notice", "noticeStrong", "sectionNav", "sectionNavLink",
    "documentationSection", "documentationHeading", "documentationBody", "documentationH3", "spacedListItem", "heroNotes", "heroNotesParagraph", "commandList",
    "narrowPage", "privacySection", "privacyH2", "resources", "resourcesParagraph", "resourcesNav", "skipLink",
    "previewPage", "previewShell", "previewCard", "previewEyebrow", "previewHeading", "previewSummary", "previewCapabilities", "previewCapability",
    "previewCapabilityFollowing", "previewCapabilityStrong", "previewCapabilityDetail", "previewStatus",
  ]);
});

test("product marketing overrides do not copy the shared marketing component grammar", async () => {
  await declares("marketingPage", ["padding-block-end:clamp(2rem,6vw,4rem)"]);
  for (const slot of ["marketingPage"]) {
    expect(await cssFor(slot)).not.toMatch(/display:|grid-template|font-size:/u);
  }
});

test("reference and privacy keep separate measures, typography, and logical spacing", async () => {
  await declares("reference", ["inline-size:min(100%,72rem)", "margin-inline-start:auto", "margin-inline-end:auto", "padding-block-start:clamp(3rem,7vw,5rem)", "border-block-start-width:1px", "scroll-margin-block-start:4rem"]);
  await declares("referenceIntro", ["display:grid", "gap:.75rem", "max-inline-size:62ch"]);
  await declares("referenceHeading", ["font-size:clamp(1.75rem,3vw,2.5rem)", "font-weight:500", "letter-spacing:-0.012em", "line-height:1.15", "text-wrap:balance"]);
  await declares("referenceH2", ["font-size:1.5rem", "margin-block-start:0", "margin-block-end:1.25rem"]);
  await declares("proseH3", ["font-size:1rem", "font-weight:600", "margin-block-start:2rem", "margin-block-end:.5rem"]);
  await declares("referenceText", ["font-size:1rem"]);
  await declares("proseMeasure", ["max-width:72ch"]);
  await declares("narrowPage", ["inline-size:min(100%,68rem)", "margin-inline-start:auto", "padding-top:clamp(2rem,6vw,4rem)"]);
  await declares("privacySection", ["border-top-width:0", "padding-block-start:0"]);
  await declares("privacyH2", ["font-size:clamp(1.75rem,3vw,2.5rem)", "margin-block-end:1.25rem"]);
});

test("documentation explicit child slots retain the grid and narrow collapse without reaching nested prose", async () => {
  await declares("documentationSection", ["display:grid", "grid-template-columns:minmax(12rem,.65fr) minmax(0,1.35fr)", "scroll-margin-block-start:4rem"]);
  const section = compact(await cssFor("documentationSection"));
  expect(section).toContain(":first-of-type{border-top-width:0}");
  expect(section).toMatch(/@media\(max-width:48rem\).*display:block/u);
  await declares("documentationHeading", ["grid-column:1", "margin-bottom:1.5rem"]);
  expect(compact(await cssFor("documentationHeading"))).toContain("@media(max-width:48rem)");
  await declares("documentationBody", ["grid-column:2"]);
  await declares("documentationH3", ["margin-top:1.2rem"]);
  expect(compact(await cssFor("documentationH3"))).toContain(":is(h3)");
  await declares("spacedListItem", ["margin-top:.85rem"]);
  await declares("heroNotes", ["max-width:72ch"]);
  await declares("heroNotesParagraph", ["margin-block-start:.75rem", "margin-block-end:0"]);
});

test("code and notice slots preserve renderer variables, overflow, and explicit element overrides", async () => {
  await declares("codeBlock", ["--foreground:var(--code-foreground)", "--danger:var(--code-danger)", "--info:var(--code-info)", "--muted:var(--code-muted)", "--success:var(--code-success)", "--warning:var(--code-warning)", "background-color:var(--code-background)", "color:var(--code-foreground)", "font-size:.85rem", "line-height:1.6", "margin-block-start:.75rem", "overflow-x:auto", "white-space:pre"]);
  await declares("codeContent", ["font-family:ui-monospace", "background-color:transparent", "padding-top:0"]);
  await declares("inlineCode", ["background-color:color-mix(in srgb,var(--foreground) 7%,transparent)", "font-size:.88em", "overflow-wrap:anywhere"]);
  await declares("shellTranscript", ["margin-block-start:0", "margin-block-end:0", "border-top-left-radius:0"]);
  await declares("installCommand", ["font-size:.8rem", "margin-top:0"]);
  expect(compact(await cssFor("installCommand"))).toContain(":is(pre)");
  await declares("commandList", ["font-size:.82rem", "max-height:34rem"]);
  await declares("installNote", ["margin-top:.25rem", "font-size:.95rem", "line-height:1.5"]);
  await declares("notice", ["border-inline-start-width:3px", "border-inline-start-color:var(--link)", "margin-block-start:1.5rem", "color:var(--muted)"]);
  await declares("noticeStrong", ["color:var(--foreground)"]);
});

test("prose focus is explicit and navigation hover and skip focus remain native", async () => {
  await declares("proseLink", ["color:var(--link)", "text-decoration-thickness:1px", "text-underline-offset:.16em"]);
  const focus = compact(await cssFor("focusable"));
  for (const declaration of ["outline-color:var(--focus)", "outline-style:solid", "outline-width:2px", "outline-offset:.2rem"]) expect(focus).toContain(declaration);
  expect(focus).toContain(":focus-visible");
  expect(focus).not.toContain("forced-color-adjust:none");
  await declares("sectionNav", ["border-block-start-width:1px", "border-block-end-width:1px", "display:flex", "flex-wrap:wrap", "margin-block-start:2.5rem", "font-size:.92rem"]);
  const nav = compact(await cssFor("sectionNavLink"));
  expect(nav).toContain(":hover{color:var(--foreground)}");
  expect(nav).toContain("text-decoration-line:none");
  expect(nav).toContain("text-decoration-thickness:auto");
  expect(nav).toContain("text-decoration-style:solid");
  await declares("skipLink", ["left:1rem", "top:1rem", "position:fixed", "transform:translateY(-180%)", "z-index:50"]);
  expect(compact(await cssFor("skipLink"))).toContain(":focus{transform:translateY(0)}");
});

test("Ask AI and resources have their own bounded palette and layout", async () => {
  await declares("resourceFrame", ["max-width:72rem", "margin-inline-start:auto", "padding-inline-start:clamp(1.25rem,4vw,3rem)"]);
  await declares("askAi", ["--ui-border:var(--rule)", "--ui-primary:var(--primary)", "--ui-ring:var(--focus)", "padding-block-start:1.25rem", "border-top-width:1px"]);
  await declares("resources", ["display:flex", "flex-wrap:wrap", "justify-content:space-between", "padding-block-start:2rem", "padding-block-end:4rem", "font-size:.92rem"]);
  await declares("resourcesParagraph", ["margin-top:0", "margin-right:0", "margin-bottom:0", "margin-left:0"]);
  await declares("resourcesNav", ["font-family:var(--font-sans)", "row-gap:.75rem", "column-gap:1.25rem"]);
});

test("inert preview keeps all fifteen rule groups and its finite narrow separators", async () => {
  await declares("previewPage", ["radial-gradient(circle at 16% 12%", "linear-gradient(145deg", "min-height:100svh"]);
  await declares("previewShell", ["display:flex", "align-items:center", "min-height:100svh"]);
  const card = compact(await cssFor("previewCard"));
  for (const declaration of ["position:relative", "width:min(100%,58rem)", "overflow-x:hidden", "border-top-width:1px", "box-shadow:0 1.5rem 5rem"]) expect(card).toContain(compact(declaration));
  for (const declaration of ["content:\"\"", "position:absolute", "left:0", "width:.32rem"]) expect(card).toContain(compact(declaration));
  expect(card).toContain("::before");
  await declares("previewEyebrow", ["color:var(--muted)", "font-weight:500", "margin-block-start:0"]);
  await declares("previewHeading", ["font-size:clamp(4.5rem,17vw,10rem)", "line-height:.95", "letter-spacing:-0.04em"]);
  await declares("previewSummary", ["font-size:clamp(1.1rem,2.7vw,1.65rem)", "max-width:42rem", "line-height:1.35"]);
  await declares("previewCapabilities", ["grid-template-columns:repeat(3,minmax(0,1fr))", "list-style-type:none", "max-width:none"]);
  expect(compact(await cssFor("previewCapabilities"))).toMatch(/@media\(max-width:48rem\).*grid-template-columns:1fr/u);
  await declares("previewCapability", ["display:grid", "gap:.25rem", "padding-top:1rem", "margin-top:0"]);
  expect(compact(await cssFor("previewCapabilityFollowing"))).toMatch(/@media\(max-width:48rem\).*border-top-width:1px/u);
  await declares("previewCapabilityStrong", ["font-size:.9rem", "font-weight:600"]);
  await declares("previewCapabilityDetail", ["font-size:clamp(.78rem,1.7vw,.95rem)", "color:var(--muted)"]);
  await declares("previewStatus", ["margin-top:0", "font-weight:500", "color:var(--muted)"]);
});

test("negative controls expose physical-axis aliasing and a missing native focus condition", async () => {
  const logicalRegression = source.replace('"margin-block-start": "2rem"', 'marginBlockStart: "2rem"');
  expect(logicalRegression).not.toBe(source);
  const physical = await createStylexTransformCollector(root).transform(logicalRegression, path);
  const physicalCss = compact(physical.rules.map(([, value]) => value.ltr).join("\n"));
  expect(physicalCss).not.toContain("margin-block-start:2rem");
  expect(physicalCss).toContain("margin-top:2rem");
  const focusRegression = source.replaceAll('":focus-visible"', '":hover"');
  expect(focusRegression).not.toBe(source);
  const hover = await createStylexTransformCollector(root).transform(focusRegression, path);
  expect(hover.rules.map(([, value]) => value.ltr).join("\n")).not.toContain(":focus-visible");
});
