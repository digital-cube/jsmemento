import { z } from "zod";
import { ActorIdSchema } from "./common.js";

/**
 * A person or system acting in a producer application. Memento does not own users:
 * `id` is the producer's identifier, the same value that lands in `actor_id`.
 */
export const UserSchema = z.object({
  id: ActorIdSchema,
  display_name: z.string().min(1).max(200).optional(),
  email: z.email().optional(),
  locale: z.string().min(2).max(35).optional(),
});
export type User = z.infer<typeof UserSchema>;
