import { z } from "zod";
import { EventTypeSchema, IdSchema, TimestampSchema } from "./common.js";

/** BCP-47-ish locale tag: `en`, `sr`, `sr-Latn`, `de-AT`. */
export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "locale must look like en, sr or sr-Latn");

/** The template used when an event type has none of its own, in any locale. */
export const GENERIC_TEMPLATE = "_generic";

/** What a template is for: an event type, or `_generic`. */
export const TemplateEventTypeSchema = z.union([EventTypeSchema, z.literal(GENERIC_TEMPLATE)]);

/**
 * Event types whose `rendered` text is the free text of the event (`payload.text`) and
 * that are never run through a template or translated.
 */
export const FREE_TEXT_EVENT_TYPES: readonly string[] = ["NOTE"];

export const TEMPLATE_BODY_MAX = 10_000;

/** A per-tenant Handlebars template for an event type in a locale. */
export const TemplateSchema = z.object({
  id: IdSchema,
  event_type: TemplateEventTypeSchema,
  locale: LocaleSchema,
  body: z.string().min(1).max(TEMPLATE_BODY_MAX),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type Template = z.infer<typeof TemplateSchema>;

/** What creates or replaces a tenant template. */
export const TemplateInputSchema = TemplateSchema.pick({
  event_type: true,
  locale: true,
  body: true,
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;
