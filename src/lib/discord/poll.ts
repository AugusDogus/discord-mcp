import { z } from "zod";

/**
 * Discord's native poll (https://discord.com/developers/docs/resources/poll):
 * the request sent with a message, and the poll on a message Discord returns.
 */

const id = z.string().regex(/^\d+$/);
const emoji = z.object({ id: id.nullable().optional(), name: z.string().nullable().optional() });
const media = z.object({ text: z.string().optional(), emoji: emoji.optional() });
const schema = z.object({
  question: media,
  answers: z.array(z.object({ answer_id: z.number().int(), poll_media: media })),
  expiry: z.string().nullable(),
  allow_multiselect: z.boolean(),
  layout_type: z.number().int().optional(),
  // Absent means Discord did not include the results, not that there are no votes.
  results: z
    .object({
      is_finalized: z.boolean(),
      answer_counts: z.array(z.object({ id: z.number().int(), count: z.number().int(), me_voted: z.boolean() })),
    })
    .optional(),
});

export type PollAnswerInput = { readonly text: string; readonly emoji?: string };
export type PollInput = {
  readonly question: string;
  readonly answers: readonly PollAnswerInput[];
  readonly durationHours: number;
  readonly allowMultiselect: boolean;
};

/** `<:name:id>`, `<a:name:id>` or `name:id` is a custom emoji, sent by id; anything else is a Unicode emoji. */
const emojiRequest = (value: string) => {
  const custom = value.trim().match(/^(?:<a?:)?[\w~]+:(\d+)>?$/);
  return custom?.[1] ? { id: custom[1] } : { name: value.trim() };
};

const request = (input: PollInput) => ({
  question: { text: input.question },
  answers: input.answers.map((answer) => ({
    poll_media: { text: answer.text, ...(answer.emoji?.trim() ? { emoji: emojiRequest(answer.emoji) } : {}) },
  })),
  duration: input.durationHours,
  allow_multiselect: input.allowMultiselect,
  layout_type: 1,
});

const emojiText = (value: z.infer<typeof emoji> | undefined): string | null =>
  value === undefined ? null : value.id ? `${value.name ?? ""}:${value.id}` : (value.name ?? null);

/** `votes` and `meVoted` are null when Discord sent no results for the poll. */
const serialize = (poll: z.infer<typeof schema>) => ({
  question: poll.question.text ?? "",
  answers: poll.answers.map((answer) => {
    const counted = poll.results?.answer_counts.find((count) => count.id === answer.answer_id);
    return {
      answerId: answer.answer_id,
      text: answer.poll_media.text ?? "",
      emoji: emojiText(answer.poll_media.emoji),
      votes: poll.results ? (counted?.count ?? 0) : null,
      meVoted: poll.results ? (counted?.me_voted ?? false) : null,
    };
  }),
  allowMultiselect: poll.allow_multiselect,
  expiresAt: poll.expiry,
  resultsFinalized: poll.results?.is_finalized ?? false,
});

export type SerializedPoll = ReturnType<typeof serialize>;
export const DiscordPoll = { schema, request, serialize } as const;
