import { expect, test } from "bun:test";
import ts from "typescript";

async function recipes(path: string, name: string): Promise<Map<string, Map<string, string>>> {
  const source = ts.createSourceFile(path, await Bun.file(new URL(path, import.meta.url)).text(), ts.ScriptTarget.Latest, true);
  const result = new Map<string, Map<string, string>>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const call = declaration.initializer;
      if (call === undefined || !ts.isCallExpression(call) || call.expression.getText(source) !== "stylex.create") throw new Error("Expected static StyleX recipes");
      const object = call.arguments[0];
      if (object === undefined || !ts.isObjectLiteralExpression(object)) throw new Error("Expected recipe object");
      for (const recipe of object.properties) {
        if (!ts.isPropertyAssignment(recipe) || !ts.isIdentifier(recipe.name) || !ts.isObjectLiteralExpression(recipe.initializer)) throw new Error("Expected named static recipe");
        const properties = new Map<string, string>();
        for (const property of recipe.initializer.properties) {
          if (!ts.isPropertyAssignment(property)) throw new Error("Expected static property");
          properties.set(property.name.getText(source), property.initializer.getText(source));
        }
        result.set(recipe.name.text, properties);
      }
    }
  }
  if (result.size === 0) throw new Error(`Missing recipe collection ${name}`);
  return result;
}

test("dropdown start and end follow the inline axis", async () => {
  const styles = await recipes("./ui/primitives.stylex.ts", "dropdownMenuStyles");
  expect([...styles.get("listStart") ?? []]).toEqual([["insetInlineStart", "0"]]);
  expect([...styles.get("listEnd") ?? []]).toEqual([["insetInlineEnd", "0"]]);
  expect(styles.get("item")?.get("textAlign")).toBe('"start"');
});

test("switch travel uses the logical inline axis without physical translation", async () => {
  const styles = await recipes("./ui/primitives.stylex.ts", "switchStyles");
  expect(styles.get("knob")?.get("position")).toBe('"relative"');
  expect(styles.get("knob")?.get("transitionProperty")).toBe('"inset-inline-start"');
  expect([...styles.get("knobChecked") ?? []]).toEqual([
    ["backgroundColor", '"var(--color-accent-ink)"'],
    ["insetInlineStart", '"1.5rem"'],
  ]);
  expect([...styles.get("knobUnchecked") ?? []]).toEqual([["insetInlineStart", '"0.25rem"']]);
  for (const style of styles.values()) expect(style.has("transform")).toBe(false);
});

test("session and transcript labels align to inline start", async () => {
  const card = await recipes("./session-card.stylex.ts", "sessionCardStyles");
  const transcript = await recipes("./transcript-view.stylex.ts", "transcriptStyles");
  expect(card.get("choice")?.get("textAlign")).toBe('"start"');
  expect(transcript.get("thinkingButton")?.get("textAlign")).toBe('"start"');
  expect(transcript.get("userText")?.get("borderStartEndRadius")).toBe('"0.125rem"');
  expect(transcript.get("userText")?.has("borderTopRightRadius")).toBe(false);
});

test("Markdown quote and list gutters follow inline start", async () => {
  const styles = await recipes("../markdown/markdown.stylex.ts", "markdownStyles");
  const quote = styles.get("blockquote");
  expect(quote?.get("borderInlineStartColor")).toBe('"var(--color-line)"');
  expect(quote?.get("borderInlineStartStyle")).toBe('"solid"');
  expect(quote?.get("borderInlineStartWidth")).toBe('"2px"');
  expect(quote?.get("paddingInlineStart")).toBe('"0.75rem"');
  for (const property of ["borderLeftColor", "borderLeftStyle", "borderLeftWidth", "paddingLeft"]) expect(quote?.has(property)).toBe(false);
  expect(styles.get("list")?.get("paddingInlineStart")).toBe('"1.25rem"');
  expect(styles.get("list")?.has("paddingLeft")).toBe(false);
  expect(styles.get("tableHeader")?.get("textAlign")).toBe('"start"');
});

test("right sheet retains its physical edge and safe-area contract", async () => {
  const styles = await recipes("./ui/primitives.stylex.ts", "sheetStyles");
  const right = styles.get("right");
  expect(right?.get("marginLeft")).toBe('"auto"');
  expect(right?.get("marginRight")).toBe("0");
  expect(right?.get("paddingRight")).toBe('"calc(1rem + env(safe-area-inset-right))"');
  expect(right?.get("width")).toBe('"min(28rem, 100vw)"');
  // Native modal dialogs otherwise clamp the viewport dimensions by UA gutters.
  expect(right?.get("maxWidth")).toBe('"none"');
  expect(right?.get("height")).toBe('"100%"');
  expect(right?.get("maxHeight")).toBe('"none"');
});
