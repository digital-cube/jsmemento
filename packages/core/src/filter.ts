import { z } from "zod";

/** Event fields a filter may reference. */
export const EVENT_FILTER_FIELDS = [
  "event_type",
  "instance_type",
  "instance_id",
  "actor_id",
  "occurred_at",
  "received_at",
] as const;
export const FilterFieldSchema = z.enum(EVENT_FILTER_FIELDS);
export type FilterField = z.infer<typeof FilterFieldSchema>;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** One comparison. `value`'s shape depends on `op`. */
export const ConditionSchema = z.discriminatedUnion("op", [
  z.strictObject({
    field: FilterFieldSchema,
    op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "prefix", "contains"]),
    value: Scalar,
  }),
  z.strictObject({
    field: FilterFieldSchema,
    op: z.enum(["in", "nin"]),
    value: z.array(Scalar).min(1).max(500),
  }),
  z.strictObject({
    field: FilterFieldSchema,
    op: z.literal("between"),
    value: z.tuple([Scalar, Scalar]),
  }),
  z.strictObject({ field: FilterFieldSchema, op: z.literal("is_null"), value: z.boolean() }),
]);
export type Condition = z.infer<typeof ConditionSchema>;
export type FilterOp = Condition["op"];
export const FILTER_OPS: readonly FilterOp[] = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "prefix",
  "contains",
  "in",
  "nin",
  "between",
  "is_null",
];

/** Boolean tree of conditions. */
export type Filter = Condition | { and: Filter[] } | { or: Filter[] } | { not: Filter };

export const FilterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    ConditionSchema,
    z.strictObject({ and: z.array(FilterSchema).min(1) }),
    z.strictObject({ or: z.array(FilterSchema).min(1) }),
    z.strictObject({ not: FilterSchema }),
  ]),
);

/**
 * Exact match, or a prefix match when the value ends in `*`
 * (`CHAT_MESSAGE_*`, `igor-*`). A lone `*` matches everything (no condition).
 */
export function matchCondition(field: FilterField, value: string): Condition | null {
  if (value === "*") return null;
  if (value.endsWith("*")) return { field, op: "prefix", value: value.slice(0, -1) };
  return { field, op: "eq", value };
}

/** Combines conditions with AND; `null` when there is nothing to filter on. */
export function and(...parts: (Filter | null | undefined)[]): Filter | null {
  const kept = parts.filter((part): part is Filter => part != null);
  if (kept.length === 0) return null;
  return kept.length === 1 ? (kept[0] as Filter) : { and: kept };
}
