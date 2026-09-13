import { expect, test } from "bun:test";
import { QualificationDaemonAdmission } from "./daemon-process";

test("withdrawal cancels already captured transport signals and refuses escaped requests", async () => {
  const owner = new QualificationDaemonAdmission();
  const caller = new AbortController();
  const captured = owner.signal(caller.signal);
  let dispatched = 0;
  const queued = Promise.resolve().then(() => { captured.throwIfAborted(); dispatched += 1; });
  owner.close();
  expect(captured.aborted).toBeTrue();
  await expect(queued).rejects.toThrow();
  expect(dispatched).toBe(0);
  expect(() => owner.assertOpen()).toThrow();
  expect(() => owner.signal()).toThrow();
  owner.close();
  expect(caller.signal.aborted).toBeFalse();
});

test("caller cancellation remains local while owner withdrawal reaches every request", () => {
  const owner = new QualificationDaemonAdmission();
  const caller = new AbortController();
  const first = owner.signal(caller.signal); const second = owner.signal();
  caller.abort();
  expect(first.aborted).toBeTrue(); expect(second.aborted).toBeFalse();
  expect(() => owner.assertOpen()).not.toThrow();
  owner.close(); expect(second.aborted).toBeTrue();
});
