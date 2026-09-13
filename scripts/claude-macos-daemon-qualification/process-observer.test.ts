import { expect, test } from "bun:test";
import { DaemonQualificationAttemptLedger } from "./process-observer";

test("a refused C resolver or launch attempt poisons qualification without dispatch", () => {
  for (const method of ["runtimeRequested", "launchAttempted"] as const) {
    const ledger = new DaemonQualificationAttemptLedger("C");
    expect(() => ledger[method]()).toThrow();
    expect(ledger.snapshot().observationViolation).toBeTrue();
    expect(ledger.snapshot()[method === "runtimeRequested" ? "runtimeRequestAttempts" : "providerLaunchAttempts"]).toBe(1);
    expect(() => ledger.runtimeRequested()).toThrow();
  }
});

test("normal stages permit one launch but record a forbidden second attempt", () => {
  const ledger = new DaemonQualificationAttemptLedger("B");
  ledger.runtimeRequested(); ledger.launchAttempted(); ledger.runtimeRequested();
  expect(ledger.snapshot()).toEqual({ runtimeRequestAttempts: 2, providerLaunchAttempts: 1, observationViolation: false });
  expect(() => ledger.launchAttempted()).toThrow();
  expect(ledger.snapshot()).toEqual({ runtimeRequestAttempts: 2, providerLaunchAttempts: 2, observationViolation: true });
});
