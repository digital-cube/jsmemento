import { z } from "zod";
import { ActorIdSchema, IdSchema, TimestampSchema } from "./common.js";

/** Read marker: `user_id` has seen `event_id`. */
export const SeenSchema = z.object({
  event_id: IdSchema,
  user_id: ActorIdSchema,
  seen_at: TimestampSchema,
});
export type Seen = z.infer<typeof SeenSchema>;

/** Bookmark: `user_id` starred `event_id`, optionally with a note. */
export const StarSchema = z.object({
  event_id: IdSchema,
  user_id: ActorIdSchema,
  note: z.string().max(1000).nullable().default(null),
  starred_at: TimestampSchema,
});
export type Star = z.infer<typeof StarSchema>;
