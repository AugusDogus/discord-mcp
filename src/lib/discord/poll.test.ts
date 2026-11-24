import { expect, test } from "bun:test";
import { message, serviceHarness } from "./testing/fake-service";

const poll = {
  question: { text: "Activities Interest" },
  answers: [
    { answer_id: 1, poll_media: { text: "Hiking", emoji: { id: null, name: "🥾" } } },
    { answer_id: 2, poll_media: { text: "Board games", emoji: { id: "111", name: "meeple" } } },
    { answer_id: 3, poll_media: { text: "Movies" } },
  ],
  expiry: "2026-11-27T12:00:00.000Z",
  allow_multiselect: true,
  layout_type: 1,
};
const pollMessage = { ...message, content: "", poll };
const withResults = (finalized: boolean) => ({
  ...pollMessage,
  poll: {
    ...poll,
    results: {
      is_finalized: finalized,
      answer_counts: [
        { id: 1, count: 2, me_voted: true },
        { id: 2, count: 1, me_voted: false },
      ],
    },
  },
});
const voter = (id: string) => ({ id, username: `user${id}`, global_name: null });

test("creating a poll sends Discord's poll object with mentions off and returns the poll message", async () => {
  const h = serviceHarness([pollMessage]);
  const created = await h.service.createPoll("789", {
    question: "Activities Interest",
    answers: [{ text: "Hiking", emoji: "🥾" }, { text: "Board games", emoji: "<:meeple:111>" }, { text: "Movies" }],
    durationHours: 72,
    allowMultiselect: true,
  });
  expect(h.calls[0]).toEqual({
    path: "/channels/789/messages",
    method: "POST",
    body: {
      allowed_mentions: { parse: [], replied_user: false },
      poll: {
        question: { text: "Activities Interest" },
        answers: [
          { poll_media: { text: "Hiking", emoji: { name: "🥾" } } },
          { poll_media: { text: "Board games", emoji: { id: "111" } } },
          { poll_media: { text: "Movies" } },
        ],
        duration: 72,
        allow_multiselect: true,
        layout_type: 1,
      },
    },
  });
  expect(created.unwrap()).toMatchObject({
    id: "456",
    poll: {
      question: "Activities Interest",
      allowMultiselect: true,
      expiresAt: "2026-11-27T12:00:00.000Z",
      answers: [
        { answerId: 1, text: "Hiking", emoji: "🥾", votes: null },
        { answerId: 2, text: "Board games", emoji: "meeple:111", votes: null },
        { answerId: 3, text: "Movies", emoji: null, votes: null },
      ],
    },
  });
  expect(h.statuses).toEqual([]);
});

test("a poll sends its optional message text and goes online first when the account opted in", async () => {
  const h = serviceHarness([pollMessage], true);
  await h.service.createPoll("789", { question: "Q", answers: [{ text: "A" }], durationHours: 24, allowMultiselect: false, content: "Vote below" });
  expect(h.calls[0]?.body).toMatchObject({ content: "Vote below" });
  expect(h.statuses).toEqual(["online"]);
});

test("a message Discord saved without a poll is reported as an error naming the message", async () => {
  const h = serviceHarness([message]);
  const created = await h.service.createPoll("789", { question: "Q", answers: [{ text: "A" }], durationHours: 24, allowMultiselect: false });
  expect(created.isErr() && created.error.message).toContain("456");
  expect(created.isErr() && created.error.message).toContain("without a poll");
});

test("results give per-answer counts, with zero for answers nobody picked", async () => {
  const h = serviceHarness([withResults(false)]);
  const results = (await h.service.getPollResults("789", "456", false)).unwrap();
  expect(results).toMatchObject({
    messageId: "456",
    question: "Activities Interest",
    resultsFinalized: false,
    answers: [
      { answerId: 1, text: "Hiking", votes: 2, meVoted: true },
      { answerId: 2, text: "Board games", votes: 1, meVoted: false },
      { answerId: 3, text: "Movies", votes: 0, meVoted: false },
    ],
  });
  expect(h.calls).toHaveLength(1);
});

test("results with voters page through each answer's voters", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => voter(String(1000 + i)));
  const h = serviceHarness([withResults(true), { users: hundred }, { users: [voter("2000")] }, { users: [voter("3000")] }, { users: [] }]);
  const results = (await h.service.getPollResults("789", "456", true)).unwrap();
  expect(h.calls.map((call) => call.path)).toEqual([
    "/channels/789/messages/456",
    "/channels/789/polls/456/answers/1?limit=100",
    "/channels/789/polls/456/answers/1?limit=100&after=1099",
    "/channels/789/polls/456/answers/2?limit=100",
    "/channels/789/polls/456/answers/3?limit=100",
  ]);
  expect(results.answers.map((answer) => answer.voters?.length)).toEqual([101, 1, 0]);
  expect(results.answers[1]?.voters?.[0]).toEqual({ id: "3000", username: "user3000", globalName: null });
});

test("results for a message without a poll are an error", async () => {
  const h = serviceHarness([message]);
  const results = await h.service.getPollResults("789", "456", false);
  expect(results.isErr() && results.error.message).toContain("no poll");
});

test("ending a poll needs confirm, only works on your own poll, and returns the ended poll", async () => {
  const other = { ...pollMessage, author: { id: "999", username: "other" } };
  const h = serviceHarness([other, message, pollMessage, withResults(true)]);
  expect((await h.service.endPoll("789", "456", false)).isErr()).toBe(true);
  expect(h.calls).toEqual([]);
  expect((await h.service.endPoll("789", "456", true)).isErr()).toBe(true);
  const plain = await h.service.endPoll("789", "456", true);
  expect(plain.isErr() && plain.error.message).toContain("no poll");
  const ended = (await h.service.endPoll("789", "456", true)).unwrap();
  expect(h.calls.at(-1)).toEqual({ path: "/channels/789/polls/456/expire", method: "POST", body: null });
  expect(ended.poll?.resultsFinalized).toBe(true);
});
