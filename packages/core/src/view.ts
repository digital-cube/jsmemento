import { z } from "zod";
import { FilterFieldSchema } from "./filter.js";

export const ColumnTypeSchema = z.enum(["text", "datetime", "badge", "json", "entity"]);

export const ViewColumnSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  type: ColumnTypeSchema.default("text"),
  sortable: z.boolean().default(false),
  filterable: z.boolean().default(false),
  width: z.number().int().positive().optional(),
});
export type ViewColumn = z.infer<typeof ViewColumnSchema>;

/** How a client should present a collection (table columns, default order, page size). */
export const ViewConfigSchema = z.object({
  collection: z.string().min(1),
  title: z.string().min(1),
  columns: z.array(ViewColumnSchema).min(1),
  default_sort: z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) }),
  page_size: z.number().int().min(1).max(500),
  filters: z.array(FilterFieldSchema),
});
export type ViewConfig = z.infer<typeof ViewConfigSchema>;

export const DEFAULT_EVENT_VIEW: ViewConfig = ViewConfigSchema.parse({
  collection: "events",
  title: "Events",
  columns: [
    { field: "occurred_at", label: "When", type: "datetime", sortable: true },
    { field: "event_type", label: "Event", type: "badge", filterable: true },
    { field: "instance_type", label: "Type", filterable: true },
    { field: "instance_id", label: "Instance", type: "entity", filterable: true },
    { field: "actor_id", label: "Actor", filterable: true },
    { field: "rendered", label: "Story" },
    { field: "payload", label: "Payload", type: "json" },
  ],
  default_sort: { field: "occurred_at", dir: "desc" },
  page_size: 50,
  filters: ["event_type", "instance_type", "instance_id", "actor_id", "occurred_at"],
});
