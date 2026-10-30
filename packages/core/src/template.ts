import { z } from "zod";
import { EventTypeSchema, IdSchema, TimestampSchema } from "./common.js";

/** BCP-47-ish locale tag: `en`, `sr`, `sr-Latn`, `de-AT`. */
export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "locale must look like en, sr or sr-Latn");

/** Per-tenant override of how an event type renders in a locale (rendering is Phase 2). */
export const TemplateSchema = z.object({
  id: IdSchema,
  event_type: EventTypeSchema,
  locale: LocaleSchema,
  body: z.string().min(1).max(10_000),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type Template = z.infer<typeof TemplateSchema>;
