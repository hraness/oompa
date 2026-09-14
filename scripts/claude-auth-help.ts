import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

const outputSchema = z.strictObject({ exitCode: z.literal(0), stderr: z.literal(""), stdout: z.string().max(16 * 1024)
  .refine((value) => value.length <= 16 * 1024 && !/\p{Cc}/u.test(value.replaceAll("\n", ""))) });

export class ClaudeAuthHelpError extends Error {
  constructor() { super("CLAUDE_AUTH_HELP_REFUSED"); this.name = "ClaudeAuthHelpError"; }
}

function parseOutput(input: unknown): string {
  const parsed = outputSchema.safeParse(input);
  if (!parsed.success) throw new ClaudeAuthHelpError();
  return parsed.data.stdout;
}
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Preserves the existing logout acceptance grammar, including bounded descriptive prose. */
export function parseClaudeAuthLogoutHelp(input: unknown): string {
  const stdout = parseOutput(input);
  const normalized = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const nonempty = normalized.split("\n").map((line, index) => ({ index, value: line.trim() })).filter((line) => line.value.length > 0);
  const usage = nonempty[0];
  const options = nonempty.filter((line) => line.value === "Options:");
  const optionsLine = options[0];
  const optionLines = optionsLine === undefined ? [] : nonempty.filter((line) => line.index > optionsLine.index);
  if (usage?.value !== "Usage: claude auth logout [options]" || options.length !== 1 || optionsLine === undefined
    || optionLines.length !== 1 || !/^-h, +--help(?: {2,}[^\r\n]+)?$/u.test(optionLines[0]?.value ?? "")) throw new ClaudeAuthHelpError();
  return digest(stdout);
}

/** Capability grammar only; neither account identity nor authority to dispatch login. */
export function parseClaudeAuthLoginHelp(input: unknown): string {
  const stdout = parseOutput(input);
  // The native collector bounds bytes; keep that bound for unknown direct callers too.
  if (Buffer.byteLength(stdout, "utf8") > 16 * 1024) throw new ClaudeAuthHelpError();
  const lines = stdout.split("\n");
  const prose = (value: string | undefined): value is string => value !== undefined && value.length > 0
    && value.trim() === value && !/(?:^|\s)-|:/u.test(value)
    && !/[\p{Zl}\p{Zp}]/u.test(value);
  if (lines.length !== 12) throw new ClaudeAuthHelpError();
  const nonempty = lines.map((line, index) => ({ line, index, trimmed: line.trim() })).filter((row) => row.trimmed !== "");
  const headings = nonempty.filter((row) => row.trimmed === "Options:"); const heading = headings[0];
  if (nonempty[0]?.trimmed !== "Usage: claude auth login [options]" || headings.length !== 1 || heading === undefined
    || nonempty.slice(1).filter((row) => row.index < heading.index).some((row) => !prose(row.trimmed))) throw new ClaudeAuthHelpError();
  const candidates = nonempty.filter((row) => row.index > heading.index);
  if (candidates.length !== 6) throw new ClaudeAuthHelpError();
  const expected = [/^--claudeai$/u, /^--console$/u, /^--email +<[A-Za-z][A-Za-z0-9_-]{0,63}>$/u, /^-h, +--help$/u, /^--sso$/u];
  let consoleDescriptionColumn: number | null = null;
  for (const [ordinal, declarationPattern] of expected.entries()) {
    const row = candidates[ordinal < 2 ? ordinal : ordinal + 1];
    if (row === undefined) throw new ClaudeAuthHelpError();
    const indent = row.line.length - row.line.trimStart().length;
    if (indent > 256 || row.line.slice(0, indent) !== " ".repeat(indent)) throw new ClaudeAuthHelpError();
    const separator = / {2,}/u.exec(row.trimmed);
    const declaration = separator === null ? row.trimmed : row.trimmed.slice(0, separator.index);
    const description = separator === null ? null : row.trimmed.slice(separator.index + separator[0].length);
    const descriptionColumn = separator === null ? null : indent + separator.index + separator[0].length;
    if (declaration.length > 256 || (descriptionColumn !== null && descriptionColumn > 256)
      || !declarationPattern.test(declaration) || (description !== null && !prose(description))) throw new ClaudeAuthHelpError();
    if (ordinal === 1) consoleDescriptionColumn = descriptionColumn;
  }
  // The reviewed observation has exactly one nonflag continuation on line 8,
  // at column 19, following the console option in the nonempty row order. No general wrapping
  // or unknown section grammar is admitted, and no prose is retained.
  const continuation = candidates[2];
  if (consoleDescriptionColumn !== 19 || continuation?.index !== 7
    || !continuation.line.startsWith(" ".repeat(19)) || !prose(continuation.line.slice(19))) throw new ClaudeAuthHelpError();
  return digest(stdout);
}

type UnverifiedOptionRow = Readonly<{ flags: readonly string[]; argument: "none" | "required" | "optional" }>;
type RejectionReason = "candidate_limit" | "declaration_limit" | "duplicate_flag" | "malformed_flag_declaration" | "non_option_line";
type RejectedOptionLine = Readonly<{
  line: number; reason: RejectionReason; indentCodeUnits: number; indentClamped: boolean;
  lineBytes: number; declarationBytes: number; beginsWithFlag: boolean;
  precedingOptionOrdinal: number | null; precedingDescriptionRelation: "before" | "at" | "after" | "unavailable";
}>;
type LoginHelpDiagnostics = Readonly<{
  version: 1; usage: "exact" | "different" | "missing";
  scan: "scanned" | "line_limit" | "missing_options_heading" | "multiple_options_headings";
  lineCount: number; optionsHeadingCount: number; candidateCount: number | null; acceptedCount: number;
  candidateLimitExceeded: boolean; rejectionsTruncated: boolean; rejections: readonly RejectedOptionLine[];
}>;
type UnverifiedProjection = Readonly<{
  optionRows: readonly UnverifiedOptionRow[]; projectionComplete: boolean; diagnostics: LoginHelpDiagnostics;
}>;

function unverifiedOptionRows(stdout: string): UnverifiedProjection {
  const lines = stdout.split("\n");
  const headings = lines.flatMap((line, index) => line.trim() === "Options:" ? [index] : []);
  const heading = headings[0];
  const first = lines.find((line) => line.trim() !== "")?.trim();
  const usage = first === "Usage: claude auth login [options]" ? "exact" : first?.startsWith("Usage:") ? "different" : "missing";
  const candidateCount = headings.length === 1 && heading !== undefined
    ? lines.slice(heading + 1).filter((line) => line.trim() !== "").length : null;
  const rows: UnverifiedOptionRow[] = []; const seen = new Set<string>(); let candidates = 0;
  const rejections: RejectedOptionLine[] = []; let rejectionsTruncated = false; let descriptionColumn: number | null = null;
  const finish = (scan: LoginHelpDiagnostics["scan"], projectionComplete: boolean): UnverifiedProjection => Object.freeze({
    optionRows: Object.freeze(rows), projectionComplete,
    diagnostics: Object.freeze({ version: 1, usage, scan, lineCount: lines.length, optionsHeadingCount: headings.length,
      candidateCount, acceptedCount: rows.length, candidateLimitExceeded: candidateCount !== null && candidateCount > 32,
      rejectionsTruncated, rejections: Object.freeze(rejections) }),
  });
  if (lines.length > 256) return finish("line_limit", false);
  if (headings.length !== 1 || heading === undefined) return finish(headings.length === 0 ? "missing_options_heading" : "multiple_options_headings", false);
  for (const [index, line] of lines.entries()) {
    if (index <= heading) continue;
    if (line.trim() === "") continue;
    candidates += 1;
    // Descriptions and placeholder names are never projected. The declaration
    // grammar only classifies bounded flag tokens and an argument's shape.
    const trimmed = line.trim(); const declaration = trimmed.split(/ {2,}/u)[0] ?? "";
    const indent = line.length - line.trimStart().length;
    const reject = (reason: RejectionReason): void => {
      if (rejections.length === 32) { rejectionsTruncated = true; return; }
      rejections.push(Object.freeze({ line: index + 1, reason, indentCodeUnits: Math.min(indent, 256), indentClamped: indent > 256,
        lineBytes: Buffer.byteLength(line, "utf8"), declarationBytes: Buffer.byteLength(declaration, "utf8"), beginsWithFlag: trimmed.startsWith("-"),
        precedingOptionOrdinal: rows.length === 0 ? null : rows.length,
        precedingDescriptionRelation: descriptionColumn === null ? "unavailable" : indent < descriptionColumn ? "before" : indent === descriptionColumn ? "at" : "after" }));
    };
    if (candidates > 32) { reject("candidate_limit"); continue; }
    if (declaration.length > 256) { reject("declaration_limit"); continue; }
    const matched = /^(?:(-[A-Za-z0-9]), +)?(--[a-z][a-z0-9-]{0,63})(?: +(<[A-Za-z][A-Za-z0-9_-]{0,63}>|\[[A-Za-z][A-Za-z0-9_-]{0,63}\]))?$/u.exec(declaration);
    const long = matched?.[2];
    if (matched === null || long === undefined) { reject(trimmed.startsWith("-") ? "malformed_flag_declaration" : "non_option_line"); continue; }
    const flags = matched[1] === undefined ? [long] : [matched[1], long];
    if (flags.some((flag) => seen.has(flag))) { reject("duplicate_flag"); continue; }
    for (const flag of flags) seen.add(flag);
    const argument = matched[3] === undefined ? "none" : matched[3].startsWith("<") ? "required" : "optional";
    rows.push(Object.freeze({ flags: Object.freeze(flags), argument }));
    const separator = / {2,}/u.exec(trimmed);
    // Offsets measure UTF-16 code units, not terminal display width or prose meaning.
    descriptionColumn = separator === null ? null : indent + declaration.length + separator[0].length;
  }
  return finish("scanned", rejections.length === 0 && rows.length > 0);
}

/** Private bounded diagnostic only. Projection completeness is extraction, never capability acceptance. */
export function inspectClaudeAuthLoginHelp(input: unknown): Readonly<{ admitted: false; reason: "login_help_unverified"; helpSha256: string;
  optionRows: readonly UnverifiedOptionRow[]; projectionComplete: boolean; diagnostics: LoginHelpDiagnostics }> {
  const stdout = parseOutput(input);
  if (stdout.trim().length === 0) throw new ClaudeAuthHelpError();
  return Object.freeze({ admitted: false, reason: "login_help_unverified", helpSha256: digest(stdout), ...unverifiedOptionRows(stdout) });
}
