import { describe, expect, test } from "bun:test";

import { presetSchema } from "./presets";
import {
  decideModelRouting,
  modelRoutingCandidateIdSchema,
  modelRoutingDecisionSchema,
  modelRoutingInputSchema,
} from "./model-routing";

const CODEX_INPUT = {
  schemaVersion: 1,
  boundary: "new",
  selection: "implicit_default",
  effective: { provider: "codex", preset: "ultra", fast: false },
  taskShape: "well_defined",
  taskRule: "well_defined_scope_and_outcome",
  safety: "declared_local",
} as const;

describe("model routing shadow decisions", () => {
  test("preserves the effective Codex default and exposes only disabled studies", () => {
    const result = decideModelRouting(CODEX_INPUT);

    expect(result).toEqual({
      schemaVersion: 1,
      mode: "shadow",
      runtimeMutationAllowed: false,
      effective: CODEX_INPUT.effective,
      rule: "study_codex_default",
      reason:
        "The effective Codex default is preserved while disabled alternatives are studied.",
      candidates: [
        {
          id: "codex_terra_ultra",
          status: "disabled_unlicensed",
          blockers: [
            "canonical_profile_absent",
            "capability_unproven",
            "private_non_inferiority_missing",
          ],
        },
        {
          id: "codex_fast_for_terra",
          status: "disabled_unlicensed",
          blockers: [
            "canonical_profile_absent",
            "capability_unproven",
            "private_non_inferiority_missing",
            "latency_evidence_missing",
            "price_evidence_missing",
          ],
        },
      ],
    });
    expect(result.effective).not.toBe(CODEX_INPUT.effective);
    expect(modelRoutingDecisionSchema.parse(result)).toEqual(result);
  });

  test("adds the effect-class blocker when safety is unknown", () => {
    const result = decideModelRouting({ ...CODEX_INPUT, safety: "unknown" });

    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.blockers).toContain("effect_class_unproven");
    }
  });

  test("allows an explicit Claude family default study without enabling it", () => {
    const result = decideModelRouting({
      ...CODEX_INPUT,
      selection: "explicit_family_default",
      effective: { provider: "claude", preset: "fable-max", fast: false },
    });

    expect(result.rule).toBe("study_claude_family_default");
    expect(result.effective).toEqual({
      provider: "claude",
      preset: "fable-max",
      fast: false,
    });
    expect(result.candidates).toEqual([
      {
        id: "claude_opus_effort_study",
        status: "disabled_unlicensed",
        blockers: [
          "canonical_profile_absent",
          "capability_unproven",
          "private_non_inferiority_missing",
          "effort_evidence_missing",
        ],
      },
    ]);
  });

  test("preserves a historical Devin Astra route only for an established session", () => {
    const input = {
      ...CODEX_INPUT,
      boundary: "established",
      selection: "existing",
      effective: { provider: "devin", preset: "astra", fast: false },
    } as const;

    expect(modelRoutingInputSchema.safeParse(input).success).toBe(true);
    expect(decideModelRouting(input)).toEqual({
      schemaVersion: 1,
      mode: "shadow",
      runtimeMutationAllowed: false,
      effective: input.effective,
      rule: "preserve_established_route",
      reason: "Established sessions retain their admitted effective route.",
      candidates: [],
    });
  });

  test.each([
    {
      name: "established",
      input: {
        ...CODEX_INPUT,
        boundary: "established",
        selection: "existing",
      },
      rule: "preserve_established_route",
    },
    {
      name: "explicit preset",
      input: {
        ...CODEX_INPUT,
        selection: "explicit_preset",
        effective: { provider: "codex", preset: "high", fast: true },
      },
      rule: "preserve_explicit_preset",
    },
    {
      name: "mechanical",
      input: {
        ...CODEX_INPUT,
        taskShape: "mechanical",
        taskRule: "mechanical_command_only",
      },
      rule: "task_shape_ineligible",
    },
    {
      name: "open ended",
      input: {
        ...CODEX_INPUT,
        taskShape: "open_ended",
        taskRule: "open_ended_research",
      },
      rule: "task_shape_ineligible",
    },
    {
      name: "conflicting requirements",
      input: {
        ...CODEX_INPUT,
        taskShape: "open_ended",
        taskRule: "conflicting_requirements",
      },
      rule: "task_shape_ineligible",
    },
    {
      name: "uncertain",
      input: {
        ...CODEX_INPUT,
        taskShape: "uncertain",
        taskRule: "default_uncertain",
      },
      rule: "task_shape_ineligible",
    },
    {
      name: "strong required",
      input: { ...CODEX_INPUT, safety: "strong_required" },
      rule: "strong_profile_required",
    },
  ] as const)("gives $name work no candidate", ({ input, rule }) => {
    const result = decideModelRouting(input);
    expect(result.rule).toBe(rule);
    expect(result.candidates).toEqual([]);
    expect(result.effective).toEqual(input.effective);
  });

  test.each([
    {
      ...CODEX_INPUT,
      effective: { provider: "codex", preset: "high", fast: false },
    },
    {
      ...CODEX_INPUT,
      effective: { provider: "claude", preset: "fable-max", fast: false },
    },
    {
      ...CODEX_INPUT,
      boundary: "established",
      selection: "implicit_default",
    },
    { ...CODEX_INPUT, selection: "existing" },
    {
      ...CODEX_INPUT,
      selection: "explicit_family_default",
      effective: { provider: "codex", preset: "ultra", fast: true },
    },
    {
      ...CODEX_INPUT,
      selection: "explicit_preset",
      effective: { provider: "claude", preset: "ultra", fast: false },
    },
    {
      ...CODEX_INPUT,
      selection: "explicit_preset",
      effective: { provider: "claude", preset: "fable-max", fast: true },
    },
    {
      ...CODEX_INPUT,
      selection: "explicit_family_default",
      effective: { provider: "devin", preset: "high", fast: false },
    },
    {
      ...CODEX_INPUT,
      selection: "explicit_preset",
      effective: { provider: "devin", preset: "high", fast: false },
    },
    {
      ...CODEX_INPUT,
      boundary: "established",
      selection: "existing",
      effective: { provider: "devin", preset: "astra", fast: true },
    },
    {
      ...CODEX_INPUT,
      taskShape: "well_defined",
      taskRule: "mechanical_command_only",
    },
    { ...CODEX_INPUT, privateTaskText: "do not accept this" },
  ])("rejects incoherent or expanded input %#", (input) => {
    expect(modelRoutingInputSchema.safeParse(input).success).toBe(false);
    expect(() => decideModelRouting(input)).toThrow();
  });

  test("candidate identifiers cannot be admitted preset values", () => {
    for (const candidateId of modelRoutingCandidateIdSchema.options) {
      expect(presetSchema.safeParse(candidateId).success).toBe(false);
    }
  });

  test("the exported decision schema rejects incoherent study records", () => {
    const codexDecision = decideModelRouting(CODEX_INPUT);
    expect(
      modelRoutingDecisionSchema.safeParse({
        ...codexDecision,
        effective: { provider: "claude", preset: "fable-max", fast: false },
      }).success,
    ).toBe(false);
    expect(
      modelRoutingDecisionSchema.safeParse({
        ...codexDecision,
        candidates: codexDecision.candidates.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      modelRoutingDecisionSchema.safeParse({
        ...codexDecision,
        reason: "A structurally valid but false explanation.",
      }).success,
    ).toBe(false);
    expect(
      modelRoutingDecisionSchema.safeParse({
        ...codexDecision,
        candidates: codexDecision.candidates.map((candidate, index) =>
          index === 0
            ? { ...candidate, blockers: ["capability_unproven"] }
            : candidate,
        ),
      }).success,
    ).toBe(false);
    expect(
      modelRoutingDecisionSchema.safeParse({
        ...codexDecision,
        effective: { provider: "devin", preset: "high", fast: false },
        rule: "preserve_explicit_preset",
        reason: "Explicit preset choices retain their admitted effective route.",
        candidates: [],
      }).success,
    ).toBe(false);
  });
});
