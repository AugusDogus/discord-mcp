import { expect, test } from "bun:test";
import { PollFailures } from "./poll-failures";

test("failures while the page is hidden never end the login", () => {
  let failures: PollFailures = PollFailures.none;
  for (const at of [0, 30_000, 120_000]) failures = PollFailures.record(failures, at, "hidden").failures;
  expect(PollFailures.record(failures, 300_000, "hidden").giveUp).toBe(false);
});

test("failures while visible give up only after 20 seconds of failing", () => {
  const first = PollFailures.record(PollFailures.none, 1_000, "visible");
  expect(first.giveUp).toBe(false);
  expect(PollFailures.record(first.failures, 20_000, "visible").giveUp).toBe(false);
  expect(PollFailures.record(first.failures, 21_000, "visible").giveUp).toBe(true);
});

test("coming back from the background starts the 20 seconds over", () => {
  const hidden = PollFailures.record(PollFailures.none, 0, "hidden").failures;
  // Back on the page 60 s later: the time spent hidden does not count.
  const back = PollFailures.record(hidden, 60_000, "visible");
  expect(back.giveUp).toBe(false);
  expect(PollFailures.record(back.failures, 75_000, "visible").giveUp).toBe(false);
});

test("after a successful poll (failures back to none), the next failure starts a fresh 20 seconds", () => {
  expect(PollFailures.record(PollFailures.none, 30_000, "visible").giveUp).toBe(false);
});
