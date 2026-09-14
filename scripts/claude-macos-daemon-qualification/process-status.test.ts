import { expect, test } from "bun:test";
import fc from "fast-check";

import { personalClaudeAcceptanceStatus } from "./process-status";

test("the acceptance status copies only its three bounded fields", () => {
  const value = { userWriteAttempts: 2, acceptedUserWrites: 2, acknowledgmentWithheld: true };
  const status = personalClaudeAcceptanceStatus(value);
  value.userWriteAttempts = 3;
  expect(status).toEqual({ userWriteAttempts: 2, acceptedUserWrites: 2, acknowledgmentWithheld: true });
  expect(Object.isFrozen(status)).toBeTrue();
  for (const invalid of [undefined, null, [], {}, { ...value, userWriteAttempts: 4 }, { ...value, acceptedUserWrites: 3 },
    { ...value, userWriteAttempts: 1 }, { ...value, userWriteAttempts: NaN }, { ...value, extra: "private" },
    { ...value, acknowledgmentWithheld: "true" }, { ...value, acceptedUserWrites: -1 }, { ...value, userWriteAttempts: 0.5 }]) {
    expect(() => personalClaudeAcceptanceStatus(invalid)).toThrow("status was refused");
  }
});

test("finite acceptance status bounds and retained ambiguity stay independent", () => {
  fc.assert(fc.property(fc.integer({ min: -5, max: 8 }), fc.integer({ min: -5, max: 8 }), fc.boolean(),
    (userWriteAttempts, acceptedUserWrites, acknowledgmentWithheld) => {
      const value = { userWriteAttempts, acceptedUserWrites, acknowledgmentWithheld };
      if (userWriteAttempts >= 0 && userWriteAttempts <= 3 && acceptedUserWrites >= 0
        && acceptedUserWrites <= 2 && acceptedUserWrites <= userWriteAttempts) {
        expect(personalClaudeAcceptanceStatus(value)).toEqual(value);
      } else expect(() => personalClaudeAcceptanceStatus(value)).toThrow("status was refused");
    }), { numRuns: 150, seed: 20260913 });
});
