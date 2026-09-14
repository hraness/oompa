import { expect, test } from "bun:test";

function occurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

test("physical safe-area padding pairs the left and right viewport exclusions", async () => {
  const cases = [
    {
      counts: { "0.5rem": 0, "1rem": 1 },
      path: new URL("../components/scheduled-tasks-badge.stylex.ts", import.meta.url),
    },
    {
      counts: { "0.5rem": 0, "1rem": 2 },
      path: new URL("./grid-screen.stylex.ts", import.meta.url),
    },
    {
      counts: { "0.5rem": 0, "1rem": 2 },
      path: new URL("./settings-screen.stylex.ts", import.meta.url),
    },
  ] as const;

  for (const { counts, path } of cases) {
    const source = await Bun.file(path).text();
    expect(source, path.pathname).not.toMatch(
      /paddingRight:\s*"max\([^"\n]*env\(safe-area-inset-left\)\)"/u,
    );
    for (const [minimum, count] of Object.entries(counts)) {
      expect(
        occurrences(source, `paddingLeft: "max(${minimum}, env(safe-area-inset-left))"`),
        `${path.pathname} left ${minimum}`,
      ).toBe(count);
      expect(
        occurrences(source, `paddingRight: "max(${minimum}, env(safe-area-inset-right))"`),
        `${path.pathname} right ${minimum}`,
      ).toBe(count);
    }
  }
});

test("sticky screen headers retain the top viewport exclusion while scrolling", async () => {
  for (const path of [
    new URL("./grid-screen.stylex.ts", import.meta.url),
    new URL("./settings-screen.stylex.ts", import.meta.url),
  ]) {
    const source = await Bun.file(path).text();

    expect(source, path.pathname).toContain(
      'paddingTop: "calc(0.75rem + env(safe-area-inset-top))"',
    );
    expect(source, path.pathname).not.toContain('paddingTop: "env(safe-area-inset-top)"');
  }
});

test("session choices align labels to the logical inline start", async () => {
  const source = await Bun.file(new URL("../components/session-card.stylex.ts", import.meta.url)).text();
  expect(source).toContain('textAlign: "start"');
  expect(source).not.toContain('textAlign: "left"');
});
