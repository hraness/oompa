import { createHash } from "node:crypto";

import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { ClaudeAuthHelpError, inspectClaudeAuthLoginHelp, parseClaudeAuthLoginHelp, parseClaudeAuthLogoutHelp } from "./claude-auth-help";

const help = "Usage: claude auth logout [options]\n\nLog out from your Anthropic account\n\nOptions:\n  -h, --help  Display help for command\n";
const output = (stdout = help) => ({ exitCode: 0, stderr: "", stdout });
// Synthetic prose/placeholder bytes; only the closed observed layout is reproduced.
const loginLines = ["Usage: claude auth login [options]", "", "Synthetic login description", "", "Options:",
  "  --claudeai".padEnd(19) + "Synthetic browser login", "  --console".padEnd(19) + "Synthetic console login",
  " ".repeat(19) + "Continuation", "  --email <value>".padEnd(19) + "Synthetic email",
  "  -h, --help".padEnd(19) + "Synthetic command help", "  --sso".padEnd(19) + "Synthetic SSO", ""];
const loginHelp = loginLines.join("\n");

test("strict login capability admits the five declarations and only the observed wrapped layout", () => {
  const variants = [loginHelp,
    ["", loginLines[0], loginLines[2], "", ...loginLines.slice(4)].join("\n"),
    [loginLines[0], "", loginLines[2], "Options:", loginLines[5], "", ...loginLines.slice(6)].join("\n"),
    [loginLines[0], "", loginLines[2], "Options:", loginLines[5], loginLines[6], "", ...loginLines.slice(7)].join("\n")];
  for (const stdout of variants) {
    expect(parseClaudeAuthLoginHelp(output(stdout))).toBe(createHash("sha256").update(stdout, "utf8").digest("hex"));
    // The existing diagnostic continues to refuse capability and retain its sole rejection.
    expect(inspectClaudeAuthLoginHelp(output(stdout))).toMatchObject({ admitted: false, reason: "login_help_unverified",
      projectionComplete: false, diagnostics: { lineCount: 12, candidateCount: 6, acceptedCount: 5,
        rejections: [{ line: 8, reason: "non_option_line", indentCodeUnits: 19, precedingOptionOrdinal: 2, precedingDescriptionRelation: "at" }] } });
  }
});

test("strict login refuses unknown, missing, duplicate or altered declarations without relaxing the diagnostic", () => {
  const variants = [loginHelp.replace("--sso", "--unknown"), loginHelp.replace("--sso", "--claudeai"),
    loginHelp.replace("--claudeai", "--claudeai <value>"), loginHelp.replace("--console", "--console=value"),
    loginHelp.replace("--email <value>", "--email [value]"), loginHelp.replace("--email <value>", "--email"),
    loginHelp.replace("--email <value>", "--email <bad.value>"), loginHelp.replace("-h, --help", "-H, --help"),
    loginHelp.replace("-h, --help", "--help"), loginHelp.replace("--sso", "--sso --extra"),
    loginHelp.replace("Synthetic login description", "--extra  Additional flag"),
    loginHelp.replace("Synthetic email", "Synthetic email --extra"),
    loginHelp.replace("Usage: claude auth login [options]", "Usage: claude auth login [arguments]"),
    loginHelp.replace("Options:", "Commands:"), loginHelp.replace("Synthetic login description", "Options:"),
    loginHelp.replace("Synthetic login description", "Additional options:"),
    loginHelp.replace("Synthetic login description", "Additional section: unexpected prose"),
    loginHelp.replace("Continuation", "Commands:"), loginHelp.replace("Continuation", "--unknown"),
    loginLines.filter((_, index) => index !== 10).join("\n"),
    [...loginLines.slice(0, -1), "  --extra  Additional flag", ""].join("\n")];
  for (const stdout of variants) expect(() => parseClaudeAuthLoginHelp(output(stdout))).toThrow(ClaudeAuthHelpError);
});

test("strict login refuses other continuation positions, alignment and line or byte limits", () => {
  for (const indent of [0, 2, 18, 20, 256, 257]) {
    expect(() => parseClaudeAuthLoginHelp(output(loginHelp.replace(" ".repeat(19) + "Continuation", " ".repeat(indent) + "Continuation"))))
      .toThrow(ClaudeAuthHelpError);
  }
  const variants = [loginHelp.replace("  --console".padEnd(19), "  --console".padEnd(20)),
    loginHelp.replace("  --console".padEnd(19), "--console  "),
    [...loginLines.slice(0, 6), loginLines[7], loginLines[6], ...loginLines.slice(8)].join("\n"),
    [...loginLines.slice(0, 7), loginLines[8], loginLines[7], ...loginLines.slice(9)].join("\n"),
    [loginLines[0], "", "Options:", loginLines[5], loginLines[6], loginLines[7],
      " ".repeat(19) + "Another continuation", ...loginLines.slice(8), ""].join("\n"),
    loginHelp.replace("Synthetic email", "Synthetic email\n" + " ".repeat(19) + "Another continuation"),
    loginHelp.replace(" ".repeat(19) + "Continuation", ""), loginHelp + "\n", loginHelp.slice(0, -1),
    loginHelp.replace("  --email <value>", `  --email <${"x".repeat(257)}>`),
    loginHelp.replace("Synthetic email", "界".repeat(6000)),
    loginHelp.replace("Continuation", "\u2028Continuation"), loginHelp.replace("Continuation", "Continuation\u2029")];
  for (const stdout of variants) expect(() => parseClaudeAuthLoginHelp(output(stdout))).toThrow(ClaudeAuthHelpError);
});

test("strict login bounds unknown inputs and never accepts a caller-supplied inspection result", () => {
  for (const input of [null, {}, { ...output(loginHelp), exitCode: 1 }, { ...output(loginHelp), stderr: "unexpected" },
    { ...output(loginHelp), admitted: true }, inspectClaudeAuthLoginHelp(output(loginHelp)), output("")]) {
    expect(() => parseClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
  }
  fc.assert(fc.property(fc.integer({ min: 0, max: 127 }).filter((value) => (value < 32 || value === 127) && value !== 10), (control) => {
    expect(() => parseClaudeAuthLoginHelp(output(loginHelp.replace("Continuation", `Continuation${String.fromCharCode(control)}`))))
      .toThrow(ClaudeAuthHelpError);
  }));
});

test("strict login digests bounded prose and placeholder variation but rejects every unknown flag", () => {
  const word = fc.array(fc.constantFrom("a", "b", "C", "d"), { minLength: 1, maxLength: 64 }).map((letters) => letters.join(""));
  fc.assert(fc.property(word, word, (placeholder, description) => {
    const stdout = loginHelp.replace("<value>", `<${placeholder}>`).replace("Synthetic email", description);
    expect(parseClaudeAuthLoginHelp(output(stdout))).toBe(createHash("sha256").update(stdout, "utf8").digest("hex"));
    expect(() => parseClaudeAuthLoginHelp(output(stdout.replace("--sso", `--unknown-${placeholder.toLowerCase()}`))))
      .toThrow(ClaudeAuthHelpError);
  }));
});

test("shared logout grammar retains exact-byte digests, descriptive prose and supported help spacing", () => {
  for (const stdout of [help, help.slice(0, -1), help.replace("Log out from your Anthropic account", "Updated descriptive prose"),
    "\nUsage: claude auth logout [options]\n\nOptions:\n    -h,   --help      Render command help\n"]) {
    expect(parseClaudeAuthLogoutHelp(output(stdout))).toBe(createHash("sha256").update(stdout, "utf8").digest("hex"));
  }
});

test("logout capability refuses changed usage, option grammar, extra flags and output ambiguity", () => {
  const bad: unknown[] = [null, {}, { ...output(), exitCode: 1 }, { ...output(), stderr: "diagnostic" }, { ...output(), extra: true },
    output(""), output(help.replace("logout", "login")), output(help.replace("[options]", "[arguments]")),
    output(help.replace("Options:", "Options:\nOptions:")), output(help.replace("  -h, --help", "  -h, --help <value>")),
    output(`${help}  --token <value>  Token\n`), output(`${help}  -h, --help  duplicate\n`), output(help.replace("--help", "--helpful")),
    output(`${help}${"x".repeat(16 * 1024)}`)];
  for (const input of bad) expect(() => parseClaudeAuthLogoutHelp(input)).toThrow(ClaudeAuthHelpError);
});

test("every ASCII control except LF is refused at the shared help boundary", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 127 }).filter((value) => (value < 32 || value === 127) && value !== 10), (control) => {
    const input = output(help.replace("Log out", `Log${String.fromCharCode(control)}out`));
    expect(() => parseClaudeAuthLogoutHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(() => inspectClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
  }));
});

test("oversized unknown help refuses before allocating or scanning normalized text", () => {
  const replace = spyOn(String.prototype, "replaceAll").mockImplementation(() => { throw new Error("oversized text was processed"); });
  try {
    const input = output("x".repeat(16_385));
    expect(() => parseClaudeAuthLogoutHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(() => parseClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(() => inspectClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(replace).not.toHaveBeenCalled();
  } finally { replace.mockRestore(); }
});

test("login help yields private diagnostic evidence only, never capability admission", () => {
  for (const stdout of ["Usage: claude auth login [options]\n\nOptions:\n  --claudeai\n  -h, --help\n", "unreviewed future help text\n"]) {
    expect(inspectClaudeAuthLoginHelp(output(stdout))).toMatchObject({ admitted: false, reason: "login_help_unverified",
      helpSha256: createHash("sha256").update(stdout, "utf8").digest("hex") });
  }
  for (const input of [output(" \n"), { ...output(), exitCode: 1 }, { ...output(), stderr: "unexpected" }, output("\u001b[32mhelp"), output("x".repeat(16_385))]) {
    expect(() => inspectClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
  }
});

test("unverified option projection returns only flag tokens and argument kind", () => {
  const stdout = "Usage: claude auth login [options]\n\nPrivate description\n\nOptions:\n"
    + "  --claudeai  Use a browser\n  --email <privatePlaceholder>  Private description\n"
    + "  --organization [privatePlaceholder]  Private description\n  -h, --help  Display help\n";
  const value = inspectClaudeAuthLoginHelp(output(stdout));
  expect(value).toMatchObject({ admitted: false, projectionComplete: true, optionRows: [
    { flags: ["--claudeai"], argument: "none" }, { flags: ["--email"], argument: "required" },
    { flags: ["--organization"], argument: "optional" }, { flags: ["-h", "--help"], argument: "none" },
  ] });
  expect(JSON.stringify(value)).not.toContain("Private"); expect(JSON.stringify(value)).not.toContain("privatePlaceholder");
  expect(Object.isFrozen(value.optionRows)).toBeTrue(); expect(Object.isFrozen(value.optionRows[0]?.flags)).toBeTrue();
});

test("duplicate, malformed, unknown and excess option rows remain explicitly incomplete", () => {
  const prefix = "Usage: claude auth login [options]\nOptions:\n  --claudeai  description\n";
  for (const suffix of ["  --claudeai  duplicate\n", "  --unknown=value  unsupported spelling\n", "  unexpected description continuation\n",
    "Options:\n  --another\n", `  --${"x".repeat(65)}\n`, `  --flag <${"x".repeat(256)}>\n`, "\n".repeat(256),
    Array.from({ length: 33 }, (_, index) => `  --flag-${index}\n`).join("")]) {
    const value = inspectClaudeAuthLoginHelp(output(prefix + suffix));
    expect(value.admitted).toBeFalse(); expect(value.projectionComplete).toBeFalse(); expect(value.optionRows.length).toBeLessThanOrEqual(32);
    expect(value).not.toHaveProperty("stdout");
  }
});

test("unverified projection has fixed token and row bounds for arbitrary help text", () => {
  fc.assert(fc.property(fc.string({ maxLength: 2000 }), (suffix) => {
    const stdout = `Usage: claude auth login [options]\nOptions:\n${suffix.replace(/\p{Cc}/gu, " ")}`;
    const value = inspectClaudeAuthLoginHelp(output(stdout));
    expect(value.admitted).toBeFalse(); expect(value.optionRows.length).toBeLessThanOrEqual(32);
    expect(value.diagnostics.rejections.length).toBeLessThanOrEqual(32);
    expect(value.diagnostics.lineCount).toBeLessThanOrEqual(16_385);
    expect(value.diagnostics.acceptedCount).toBe(value.optionRows.length);
    for (const rejected of value.diagnostics.rejections) {
      expect(rejected.line).toBeGreaterThan(0); expect(rejected.line).toBeLessThanOrEqual(256);
      expect(rejected.indentCodeUnits).toBeLessThanOrEqual(256);
      expect(rejected.lineBytes).toBeLessThanOrEqual(65_536); expect(rejected.declarationBytes).toBeLessThanOrEqual(rejected.lineBytes);
      expect(["candidate_limit", "declaration_limit", "duplicate_flag", "malformed_flag_declaration", "non_option_line"]).toContain(rejected.reason);
    }
    for (const row of value.optionRows) {
      expect(row.flags.length).toBeLessThanOrEqual(2); expect(["none", "required", "optional"]).toContain(row.argument);
      for (const flag of row.flags) expect(flag).toMatch(/^(?:-[A-Za-z0-9]|--[a-z][a-z0-9-]{0,63})$/u);
    }
  }));
});

test("closed diagnostics distinguish five synthetic rejection causes without retaining rejected content", () => {
  const prefix = "Usage: claude auth login [options]\nOptions:\n  --claudeai  PRIVATE_PROSE\n";
  const suffixes = [
    { suffix: "  --claudeai  PRIVATE_DUPLICATE\n", reason: "duplicate_flag", beginsWithFlag: true },
    { suffix: "  --bad=PRIVATE_ARGUMENT\n", reason: "malformed_flag_declaration", beginsWithFlag: true },
    { suffix: `  --flag <${"P".repeat(257)}>\n`, reason: "declaration_limit", beginsWithFlag: true },
    { suffix: "  PRIVATE_CONTINUATION\n", reason: "non_option_line", beginsWithFlag: false },
  ] as const;
  for (const { suffix, reason, beginsWithFlag } of suffixes) {
    const value = inspectClaudeAuthLoginHelp(output(prefix + suffix));
    expect(value).toMatchObject({ admitted: false, projectionComplete: false, diagnostics: { version: 1, usage: "exact", scan: "scanned",
      lineCount: 5, optionsHeadingCount: 1, candidateCount: 2, acceptedCount: 1, candidateLimitExceeded: false, rejectionsTruncated: false } });
    expect(value.diagnostics.rejections).toEqual([{ line: 4, reason, beginsWithFlag, indentCodeUnits: 2, indentClamped: false,
      lineBytes: new TextEncoder().encode(suffix.slice(0, -1)).byteLength,
      declarationBytes: new TextEncoder().encode(suffix.trim().split(/ {2,}/u)[0]).byteLength,
      precedingOptionOrdinal: 1, precedingDescriptionRelation: "before" }]);
    expect(JSON.stringify(value)).not.toContain("PRIVATE_"); expect(JSON.stringify(value)).not.toContain("P".repeat(257));
    expect(Object.isFrozen(value.diagnostics)).toBeTrue(); expect(Object.isFrozen(value.diagnostics.rejections)).toBeTrue();
    expect(Object.isFrozen(value.diagnostics.rejections[0])).toBeTrue();
  }
  const many = Array.from({ length: 80 }, (_, index) => `  --flag-${index}\n`).join("");
  const value = inspectClaudeAuthLoginHelp(output("Usage: claude auth login [options]\nOptions:\n" + many));
  expect(value).toMatchObject({ admitted: false, projectionComplete: false, diagnostics: { candidateCount: 80, acceptedCount: 32,
    candidateLimitExceeded: true, rejectionsTruncated: true } });
  expect(value.diagnostics.rejections).toHaveLength(32);
  expect(value.diagnostics.rejections.every((entry) => entry.reason === "candidate_limit")).toBeTrue();
});

test("synthetic continuation layout reports code-unit relations without accepting prose or copying placeholders", () => {
  const declaration = "  --email <PRIVATE_PLACEHOLDER>  ";
  for (const offset of [-1, 0, 1]) {
    const spaces = declaration.length + offset;
    const value = inspectClaudeAuthLoginHelp(output("Usage: claude auth login [options]\nOptions:\n"
      + declaration + "PRIVATE_DESCRIPTION\n" + " ".repeat(spaces) + "PRIVATE_CONTINUATION\n"));
    expect(value).toMatchObject({ admitted: false, projectionComplete: false, diagnostics: { candidateCount: 2, acceptedCount: 1 } });
    expect(value.diagnostics.rejections[0]).toMatchObject({ line: 4, reason: "non_option_line", indentCodeUnits: spaces,
      precedingOptionOrdinal: 1, precedingDescriptionRelation: offset < 0 ? "before" : offset === 0 ? "at" : "after" });
    expect(JSON.stringify(value)).not.toContain("PRIVATE_");
  }
  const clamped = inspectClaudeAuthLoginHelp(output("Options:\n" + " ".repeat(300) + "PRIVATE_CONTINUATION\n"));
  expect(clamped.diagnostics.rejections[0]).toMatchObject({ indentCodeUnits: 256, indentClamped: true,
    precedingOptionOrdinal: null, precedingDescriptionRelation: "unavailable" });
});

test("usage and heading or line limits are explicit while extraction never grants capability", () => {
  const complete = "Usage: other command [options]\nOptions:\n  --claudeai\n";
  expect(inspectClaudeAuthLoginHelp(output(complete))).toMatchObject({ admitted: false, projectionComplete: true, diagnostics: { usage: "different" } });
  expect(inspectClaudeAuthLoginHelp(output("PRIVATE_PROSE\n"))).toMatchObject({ admitted: false, projectionComplete: false,
    diagnostics: { usage: "missing", optionsHeadingCount: 0, candidateCount: null, scan: "missing_options_heading" } });
  expect(inspectClaudeAuthLoginHelp(output("Options:\nOptions:\n  --claudeai\n"))).toMatchObject({ admitted: false, projectionComplete: false,
    diagnostics: { optionsHeadingCount: 2, candidateCount: null, scan: "multiple_options_headings" } });
  expect(inspectClaudeAuthLoginHelp(output("Usage: claude auth login [options]\nOptions:\n  --claudeai\n" + "\n".repeat(253)))).toMatchObject({
    admitted: false, projectionComplete: false, optionRows: [], diagnostics: { lineCount: 257, candidateCount: 1, acceptedCount: 0, scan: "line_limit" } });
});
