import assert from "node:assert/strict"
import { transform } from "lightningcss"

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** Inspect the pinned parser's AST without rewriting captured bytes. Dependency
 * relocation rejects relative URLs in custom properties; this graph publishes
 * its captured CSS/assets together, so it needs the original URL inventory. */
export function inspectSiteCssResources(source: string, filename: string): readonly string[] {
  assert.ok(Buffer.byteLength(source) <= 16 * 1024 * 1024)
  const urls: string[] = []
  let visited = 0
  function add(url: string): void {
    assert.ok(urls.length < 64, "Site foundation has excessive resource references")
    urls.push(url)
  }
  function inspect(value: unknown, depth = 0): void {
    assert.ok(depth <= 64 && ++visited <= 1_000_000, "Site stylesheet AST exceeds its inspection bound")
    if (Array.isArray(value)) {
      for (const child of value) inspect(child, depth + 1)
      return
    }
    if (!record(value)) return
    assert.notEqual(value.type, "import", "Site foundation has an unresolved stylesheet import")
    // Url nodes appear beneath both token values and typed image/font values.
    if (typeof value.url === "string" && record(value.loc)) {
      add(value.url)
      return
    }
    if (value.type === "unquoted-url" && typeof value.value === "string") {
      add(value.value)
      return
    }
    if (value.type === "function" && record(value.value) && typeof value.value.name === "string") {
      const fn = value.value
      const name = value.value.name.toLowerCase()
      if (name === "image-set" || name === "-webkit-image-set") {
        assert.ok(Array.isArray(fn.arguments))
        // In an unparsed value, image-set remains a token function. Admit only
        // literal image/descriptor forms: var/env could turn an unseen string
        // into a URL after CSS substitution. type("image/avif") is not a URL.
        for (const argument of fn.arguments) {
          assert.ok(record(argument), "Unsupported image-set argument")
          if (argument.type === "url" || argument.type === "resolution") continue
          if (argument.type === "token" && record(argument.value)) {
            if (argument.value.type === "string" && typeof argument.value.value === "string") {
              add(argument.value.value)
              continue
            }
            if (argument.value.type === "white-space" || argument.value.type === "comma") continue
          }
          if (argument.type === "function" && record(argument.value)
            && typeof argument.value.name === "string" && argument.value.name.toLowerCase() === "type"
            && Array.isArray(argument.value.arguments)) {
            const tokens = argument.value.arguments.filter(token => !(record(token) && token.type === "token"
              && record(token.value) && token.value.type === "white-space"))
            assert.ok(tokens.length === 1 && record(tokens[0]) && tokens[0].type === "token"
              && record(tokens[0].value) && tokens[0].value.type === "string", "Image-set type must be a literal MIME string")
            continue
          }
          throw new Error("Image-set requires literal resources; unresolved substitutions and unknown functions are not admitted")
        }
      }
      assert.ok(name !== "image" && name !== "cross-fade" && name !== "-webkit-cross-fade",
        "Site foundation has an unsupported unparsed image function")
    }
    for (const child of Object.values(value)) inspect(child, depth + 1)
  }
  const result = transform({ code: Buffer.from(source), filename, minify: false,
    visitor: { StyleSheet(stylesheet) { inspect(stylesheet) } },
  })
  assert.equal(result.warnings.length, 0, "Site CSS parser emitted warnings")
  return urls
}
