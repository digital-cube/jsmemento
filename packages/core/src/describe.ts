import { z } from "zod";
import { EventInputSchema, EventSchema } from "./event.js";
import { EVENT_FILTER_FIELDS, FILTER_OPS } from "./filter.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./query.js";
import { SCOPES } from "./scopes.js";
import { DEFAULT_EVENT_VIEW, type ViewConfig } from "./view.js";

export const PROTOCOL_VERSION = "1";

export const CapabilitiesSchema = z.object({
  push: z.boolean(),
  query: z.boolean(),
  entity_history: z.boolean(),
  realtime: z.boolean(),
  templates: z.boolean(),
  seen: z.boolean(),
  star: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export interface Describe {
  name: "memento";
  protocol_version: string;
  collection: "events";
  tenant: { slug: string; name: string };
  capabilities: Capabilities;
  scopes: readonly string[];
  schema: { event_input: unknown; event: unknown };
  filter: { fields: readonly string[]; ops: readonly string[] };
  pagination: { default_limit: number; max_limit: number; style: "cursor" };
  view: ViewConfig;
}

/** The `GET /memento/describe` document for a tenant. */
export function buildDescribe(
  tenant: { slug: string; name: string },
  capabilities: Partial<Capabilities> = {},
): Describe {
  return {
    name: "memento",
    protocol_version: PROTOCOL_VERSION,
    collection: "events",
    tenant,
    capabilities: {
      push: true,
      query: true,
      entity_history: true,
      realtime: false,
      templates: true,
      seen: false,
      star: false,
      ...capabilities,
    },
    scopes: SCOPES,
    schema: {
      event_input: z.toJSONSchema(EventInputSchema, { io: "input", unrepresentable: "any" }),
      event: z.toJSONSchema(EventSchema, { unrepresentable: "any" }),
    },
    filter: { fields: EVENT_FILTER_FIELDS, ops: FILTER_OPS },
    pagination: { default_limit: DEFAULT_PAGE_SIZE, max_limit: MAX_PAGE_SIZE, style: "cursor" },
    view: DEFAULT_EVENT_VIEW,
  };
}
