import { z } from "zod";
import { ActorIdSchema, IdSchema, InstanceIdSchema, TimestampSchema } from "./common.js";

/** A chat is an instance (`instance_type = "chat"`) whose messages are ordinary events. */
export const ChatSchema = z.object({
  id: IdSchema,
  instance_id: InstanceIdSchema,
  title: z.string().max(200).nullable(),
  participants: z.array(ActorIdSchema),
  created_at: TimestampSchema,
  archived_at: TimestampSchema.nullable(),
});
export type Chat = z.infer<typeof ChatSchema>;
