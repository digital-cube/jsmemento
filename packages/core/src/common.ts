import { z } from "zod";

/** Event types are SCREAMING_SNAKE_CASE verbs: `USER_LOGIN`, `CHAT_MESSAGE_SENT`. */
export const EventTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z][A-Z0-9_]*$/, "event_type must be SCREAMING_SNAKE_CASE (e.g. USER_LOGIN)");

/** Instance types are lower snake_case nouns: `user`, `ticket`, `chat`. */
export const InstanceTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "instance_type must be lower snake_case (e.g. user, chat)");

/** An external identifier; numbers are accepted on input and stored as strings. */
const externalId = (max: number) =>
  z
    .union([z.string(), z.number().int()])
    .transform((value) => String(value))
    .pipe(z.string().trim().min(1).max(max));

export const InstanceIdSchema = externalId(200);
export const ActorIdSchema = externalId(200);

/** Tenant slugs: lowercase words joined by single dashes, 2–63 chars. */
export const SlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters/digits joined by dashes");

/** ISO-8601 timestamp with an explicit offset (`Z` or `+02:00`). */
export const TimestampSchema = z.iso.datetime({ offset: true });

export const IdSchema = z.uuid();

/** Arbitrary JSON object carried by an event. */
export const PayloadSchema = z.record(z.string(), z.unknown());
