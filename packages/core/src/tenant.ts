import { z } from "zod";
import { IdSchema, SlugSchema, TimestampSchema } from "./common.js";

export const TenantSchema = z.object({
  id: IdSchema,
  slug: SlugSchema,
  name: z.string().min(1).max(200),
  is_active: z.boolean(),
  created_at: TimestampSchema,
});
export type Tenant = z.infer<typeof TenantSchema>;

export const TenantCreateSchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1).max(200),
});
export type TenantCreate = z.infer<typeof TenantCreateSchema>;
