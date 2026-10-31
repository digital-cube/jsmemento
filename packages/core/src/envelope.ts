import { z } from "zod";

/** Machine-readable error codes; each maps to one HTTP status. */
export const ERROR_CODES = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const ErrorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const PageMetaSchema = z.object({
  limit: z.number().int(),
  count: z.number().int(),
  next_cursor: z.string().nullable(),
  /** Offset pagination only: where this page starts and where the next one does. */
  offset: z.number().int().optional(),
  next_offset: z.number().int().nullable().optional(),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
  request_id: z.string().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Schema of a successful response carrying `data` of the given shape. */
export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({
    ok: z.literal(true),
    data,
    meta: PageMetaSchema.optional(),
  });
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: PageMeta;
}

export function ok<T>(data: T, meta?: PageMeta): SuccessEnvelope<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  options: { details?: unknown; request_id?: string } = {},
): ErrorEnvelope {
  const error: ErrorEnvelope["error"] = { code, message };
  if (options.details !== undefined) error.details = options.details;
  const body: ErrorEnvelope = { ok: false, error };
  if (options.request_id) body.request_id = options.request_id;
  return body;
}
