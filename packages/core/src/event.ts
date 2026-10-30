import { z } from "zod";
import {
  ActorIdSchema,
  EventTypeSchema,
  IdSchema,
  InstanceIdSchema,
  InstanceTypeSchema,
  PayloadSchema,
  TimestampSchema,
} from "./common.js";

/** What a producer pushes: `POST /memento/events`. */
export const EventInputSchema = z.strictObject({
  event_type: EventTypeSchema,
  instance_type: InstanceTypeSchema,
  instance_id: InstanceIdSchema,
  actor_id: ActorIdSchema.nullish(),
  payload: PayloadSchema.default({}),
  /** When it happened at the producer; defaults to the time memento received it. */
  occurred_at: TimestampSchema.optional(),
  /** Pre-rendered text; Phase 2 renders it from the tenant's templates when absent. */
  rendered: z.string().max(10_000).nullish(),
});
export type EventInput = z.input<typeof EventInputSchema>;
export type EventCreate = z.output<typeof EventInputSchema>;

/** A stored event as it comes back over the wire. Events are immutable. */
export const EventSchema = z.object({
  id: IdSchema,
  occurred_at: TimestampSchema,
  received_at: TimestampSchema,
  event_type: EventTypeSchema,
  instance_type: InstanceTypeSchema,
  instance_id: z.string(),
  actor_id: z.string().nullable(),
  payload: PayloadSchema,
  rendered: z.string().nullable(),
  archived_at: TimestampSchema.nullable(),
});
export type MementoEvent = z.infer<typeof EventSchema>;

/** The `{ instance_type, instance_id }` pair every event belongs to. */
export const EntityRefSchema = z.object({
  instance_type: InstanceTypeSchema,
  instance_id: InstanceIdSchema,
});
export type EntityRef = z.infer<typeof EntityRefSchema>;
